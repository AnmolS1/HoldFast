// The scanning interface: message shapes, the stub scanner, sending, rescans and the
// suspected-CSAM handler. The consumer has its own file.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hashBlocklist, reports, shareLinks, uploadIps, user } from "../../../src/worker/db/schema";
import { AppError } from "../../../src/worker/services/errors";
import {
  enqueueRescan,
  enqueueScan,
  getScanner,
  lockSuspectedCsam,
  normalizeScanMessage,
  scanSmallObject,
  STUB_SCAN_MAX_BYTES,
  stubEnabled,
} from "../../../src/worker/services/scanning";
import { eicarBytes, nestedEicarZipBytes } from "../../setup/fixture-bytes";
import { makeLink } from "../auth/helpers";
import {
  ADMIN_EMAIL,
  auditRows,
  mailTo,
  makeFile,
  makeFolder,
  makeUser,
  nodeById,
  putObject,
  rand,
  serviceDeps,
  testDb,
} from "./helpers";

const OWNER = "o".repeat(32);
const NODE = "0199d3c2-7a10-7000-8000-0000000000a1";
const KEY = `u/${OWNER}/${NODE}/0199d3c2-7a10-7000-8000-0000000000c3`;
// One body exactly as it was read off the dev queue (ids are not secrets).
const RECORDED_R2_BODY =
  '{"account":"9668af964b3bf13cc286ae6b73097a35","bucket":"holdfast-files-dev","eventTime":"2026-10-12T23:12:27.740Z","action":"CompleteMultipartUpload","object":{"key":"u/spike-s8/mpu-2.bin","size":11534336,"eTag":"dce1c18393acbef2580b54a3b321765d-3"}}';

const STUB_ON = { SCAN_STUB: "1", SENTRY_ENVIRONMENT: "test" };

function streamOf(bytes: Uint8Array, chunk = 65_536): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(at, at + chunk));
      at += chunk;
    },
  });
}

/** A ServiceDeps whose queue records what is sent instead of delivering it. */
function recordingDeps() {
  const sent: unknown[] = [];
  const made = serviceDeps({ SCAN_QUEUE: { send: async (body: unknown) => void sent.push(body) } });
  return { ...made, sent };
}

describe("normalizeScanMessage", () => {
  it("accepts the explicit message, dropping fields it does not know", () => {
    expect(normalizeScanMessage({ v: 1, key: KEY })).toEqual({ v: 1, key: KEY });
    expect(normalizeScanMessage({ v: 1, nodeId: NODE, key: KEY, force: true })).toEqual({
      v: 1,
      nodeId: NODE,
      key: KEY,
      force: true,
    });
    expect(
      normalizeScanMessage({ v: 1, nodeId: NODE, key: KEY, etag: "abc", force: false, extra: 1 }),
    ).toEqual({
      v: 1,
      nodeId: NODE,
      key: KEY,
      etag: "abc",
      force: false,
    });
  });

  it("turns the recorded store event into { v: 1, key, etag }", () => {
    expect(normalizeScanMessage(JSON.parse(RECORDED_R2_BODY))).toEqual({
      v: 1,
      key: "u/spike-s8/mpu-2.bin",
      etag: "dce1c18393acbef2580b54a3b321765d-3",
    });
  });

  it("accepts PutObject and CopyObject events; never takes a nodeId or force from an event", () => {
    const event = (action: string, extra: object = {}) => ({
      account: "a",
      bucket: "b",
      eventTime: "2026-10-12T23:12:27.740Z",
      action,
      object: { key: KEY, size: 5, eTag: "0cc175b9c0f1b6a831c399e269772661" },
      ...extra,
    });
    const expected = { v: 1, key: KEY, etag: "0cc175b9c0f1b6a831c399e269772661" };
    expect(normalizeScanMessage(event("PutObject"))).toEqual(expected);
    expect(normalizeScanMessage(event("CopyObject", { copySource: { bucket: "b", object: "x" } }))).toEqual(
      expected,
    );
    expect(
      normalizeScanMessage(event("PutObject", { nodeId: NODE, force: true, v: 1, key: "u/other" })),
    ).toEqual(expected);
    // An event without an eTag still names its object.
    expect(normalizeScanMessage({ action: "PutObject", object: { key: KEY } })).toEqual({ v: 1, key: KEY });
  });

  it("is null for another action, a missing object key, and a key outside u/", () => {
    const base = JSON.parse(RECORDED_R2_BODY) as { action: string; object: Record<string, unknown> };
    for (const action of ["DeleteObject", "LifecycleDeletion", "putobject", "", 7, undefined]) {
      expect(normalizeScanMessage({ ...base, action }), String(action)).toBeNull();
    }
    expect(normalizeScanMessage({ ...base, object: { size: 1, eTag: "x" } })).toBeNull();
    expect(normalizeScanMessage({ ...base, object: null })).toBeNull();
    expect(normalizeScanMessage({ ...base, object: "u/x" })).toBeNull();
    expect(normalizeScanMessage({ action: base.action })).toBeNull();
    for (const key of [
      "t/n/v/160.webp",
      "a/user/x",
      "b/db/2026/x",
      "U/x",
      " u/x",
      "",
      "x",
      7,
      null,
      `u/${"k".repeat(1100)}`,
    ]) {
      expect(normalizeScanMessage({ ...base, object: { ...base.object, key } }), String(key)).toBeNull();
      expect(normalizeScanMessage({ v: 1, key }), String(key)).toBeNull();
    }
  });

  it("is null for garbage and for an explicit message with a wrong field", () => {
    for (const body of [
      null,
      undefined,
      "",
      "u/x",
      7,
      true,
      [],
      [{ v: 1, key: KEY }],
      {},
      { harness: "x" },
    ]) {
      expect(normalizeScanMessage(body)).toBeNull();
    }
    for (const body of [
      { key: KEY },
      { v: 2, key: KEY },
      { v: "1", key: KEY },
      { v: 1, key: KEY, nodeId: "not-a-uuid" },
      { v: 1, key: KEY, nodeId: 7 },
      { v: 1, key: KEY, force: "yes" },
      { v: 1, key: KEY, etag: 7 },
    ]) {
      expect(normalizeScanMessage(body), JSON.stringify(body)).toBeNull();
    }
  });
});

describe("the stub scanner", () => {
  it("is enabled only by SCAN_STUB=1 outside production", () => {
    expect(stubEnabled(STUB_ON)).toBe(true);
    expect(stubEnabled({ SCAN_STUB: "1", SENTRY_ENVIRONMENT: "dev" })).toBe(true);
    for (const off of [
      { SCAN_STUB: "0", SENTRY_ENVIRONMENT: "test" },
      { SCAN_STUB: "", SENTRY_ENVIRONMENT: "test" },
      { SCAN_STUB: "true", SENTRY_ENVIRONMENT: "test" },
      { SCAN_STUB: undefined as unknown as string, SENTRY_ENVIRONMENT: "test" },
      { SCAN_STUB: "1", SENTRY_ENVIRONMENT: "production" },
    ]) {
      expect(stubEnabled(off), JSON.stringify(off)).toBe(false);
      expect(() => getScanner(off), JSON.stringify(off)).toThrow("scanner unavailable");
    }
    expect(typeof getScanner(STUB_ON).scanBytes).toBe("function");
  });

  it("finds the antivirus test string and calls everything else clean", async () => {
    const scanner = getScanner(STUB_ON);
    expect(await scanner.scanBytes(eicarBytes())).toMatchObject({
      status: "infected",
      signatures: ["Stub.EICAR"],
      pua: [],
      engine: "stub",
      bytes: 68,
    });
    const clean = await scanner.scanBytes(new TextEncoder().encode("nothing to see"));
    expect(clean).toMatchObject({ status: "clean", signatures: [], pua: [], engine: "stub" });
    // The string anywhere in the bytes, also across stream chunks.
    const buried = new Uint8Array(200_000);
    buried.set(eicarBytes(), 65_500);
    expect((await scanner.scanBytes(buried)).status).toBe("infected");
    expect((await scanner.scanStream(streamOf(buried), { key: KEY, size: buried.length })).status).toBe(
      "infected",
    );
    // The archive around the test string holds it uncompressed.
    expect((await scanner.scanBytes(nestedEicarZipBytes())).status).toBe("infected");
    // All but the last character is not the string.
    expect((await scanner.scanBytes(eicarBytes().subarray(0, 67))).status).toBe("clean");
    expect((await scanner.scanBytes(new Uint8Array(0))).status).toBe("clean");
    expect((await scanner.scanStream(streamOf(new Uint8Array(0)), { key: KEY, size: 0 })).status).toBe(
      "clean",
    );
  });

  it("reads at most 1 MiB of an object", async () => {
    expect(STUB_SCAN_MAX_BYTES).toBe(1_048_576);
    const scanner = getScanner(STUB_ON);
    const late = new Uint8Array(STUB_SCAN_MAX_BYTES + 4096);
    late.set(eicarBytes(), STUB_SCAN_MAX_BYTES + 100);
    expect((await scanner.scanBytes(late)).status).toBe("clean");
    let pulled = 0;
    const counting = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(262_144));
      },
    });
    const verdict = await scanner.scanStream(counting, { key: KEY, size: 50_000_000 });
    expect(verdict).toMatchObject({ status: "clean", bytes: 50_000_000 });
    expect(pulled).toBeLessThanOrEqual(6);
  });

  it("scanSmallObject scans bytes with it, and fails where there is no scanner", async () => {
    expect((await scanSmallObject(STUB_ON, eicarBytes())).status).toBe("infected");
    expect((await scanSmallObject(STUB_ON, new Uint8Array(10))).status).toBe("clean");
    await expect(
      scanSmallObject({ SCAN_STUB: "0", SENTRY_ENVIRONMENT: "dev" }, new Uint8Array(10)),
    ).rejects.toThrow("scanner unavailable");
    await expect(
      scanSmallObject({ SCAN_STUB: "1", SENTRY_ENVIRONMENT: "production" }, new Uint8Array(10)),
    ).rejects.toThrow("scanner unavailable");
  });
});

describe("enqueueScan", () => {
  it("sends { v: 1, nodeId, key, force } and nothing else, from a bare ServiceDeps", async () => {
    const { deps, sent } = recordingDeps();
    await enqueueScan(deps, { nodeId: NODE, key: KEY });
    await enqueueScan(deps, { nodeId: NODE, key: KEY, force: true });
    expect(sent).toEqual([
      { v: 1, nodeId: NODE, key: KEY, force: false },
      { v: 1, nodeId: NODE, key: KEY, force: true },
    ]);
    // What it sends is what the consumer accepts.
    for (const body of sent) expect(normalizeScanMessage(body)).toEqual(body);
    await expect(enqueueScan(deps, { nodeId: NODE, key: "t/not/an/upload" })).rejects.toThrow("scan message");
    await expect(enqueueScan(deps, { nodeId: "nope", key: KEY })).rejects.toThrow("scan message");
    expect(sent).toHaveLength(2);
  });

  it("the real queue accepts the message", async () => {
    const { deps } = serviceDeps();
    // A key nothing references: the consumer retries and gives up; nothing to assert but the send.
    await expect(enqueueScan(deps, { nodeId: NODE, key: `${KEY}-${rand()}` })).resolves.toBeUndefined();
  });
});

describe("enqueueRescan", () => {
  it("resets an unlocked file to pending and sends a forced message", async () => {
    const owner = await makeUser();
    for (const status of ["clean", "infected", "skipped", "error"] as const) {
      const file = await makeFile(owner.id, null, {
        scanStatus: status,
        scannedAt: new Date(),
        scanDetail: { engine: "stub" },
        mimeSniffed: "image/png",
      });
      const { deps, sent, settle } = recordingDeps();
      await enqueueRescan(deps, file.id, { by: "owner" });
      await settle();
      const after = await nodeById(file.id);
      expect(after, status).toMatchObject({ scanStatus: "pending", scannedAt: null, scanDetail: null });
      expect(sent, status).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
      expect(await auditRows({ action: "scan.rescan_requested", targetId: file.id })).toMatchObject([
        { meta: { by: "owner", force: true } },
      ]);
    }
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const { deps, sent } = recordingDeps();
    await enqueueRescan(deps, file.id, { by: "admin", force: false });
    expect(sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: false }]);
  });

  it("leaves under_review, suspected_csam and a taken-down file exactly as they are, and sends nothing", async () => {
    const owner = await makeUser();
    const locked = [
      await makeFile(owner.id, null, {
        scanStatus: "under_review",
        scanStatusPrev: "clean",
        scannedAt: new Date(),
      }),
      await makeFile(owner.id, null, {
        scanStatus: "suspected_csam",
        legalHold: true,
        scannedAt: new Date(),
      }),
      await makeFile(owner.id, null, {
        scanStatus: "clean",
        scannedAt: new Date(),
        takedownAt: new Date(),
        takedownReason: "dmca",
      }),
      await makeFile(owner.id, null, {
        scanStatus: "infected",
        takedownAt: new Date(),
        takedownReason: "abuse",
      }),
    ];
    for (const before of locked) {
      const { deps, sent, settle } = recordingDeps();
      await enqueueRescan(deps, before.id, { by: "admin", force: true });
      await settle();
      expect(await nodeById(before.id), before.scanStatus).toEqual(before);
      expect(sent, before.scanStatus).toEqual([]);
      expect(await auditRows({ action: "scan.rescan_requested", targetId: before.id })).toEqual([]);
    }
  });

  it("is a 404 for a folder and for an id that does not exist", async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner.id);
    for (const id of [folder.id, crypto.randomUUID(), "nope"]) {
      const { deps, sent } = recordingDeps();
      const error = await enqueueRescan(deps, id, { by: "owner" }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("not_found");
      expect(sent).toEqual([]);
    }
  });
});

describe("lockSuspectedCsam", () => {
  it("locks and holds, files a report, alerts the operator once — and touches nothing else", async () => {
    const owner = await makeUser();
    const sha256 = rand(32);
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256 });
    await putObject(file.r2Key!, "the evidence");
    const link = await makeLink(file.id, owner.id);
    await testDb()
      .insert(uploadIps)
      .values({
        nodeId: file.id,
        versionId: file.versionId!,
        uploaderId: owner.id,
        ipEncrypted: new Uint8Array(20),
        iv: new Uint8Array(12),
        keyVersion: 1,
      });

    const { deps, settle } = serviceDeps();
    const { reportId } = await lockSuspectedCsam(deps, file.id, { source: "system" });
    await settle();

    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    const [ownerRow] = await testDb().select().from(user).where(eq(user.id, owner.id));
    expect(ownerRow).toMatchObject({ legalHold: true, suspendedAt: null });
    const [linkRow] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, link.id));
    expect(linkRow!.pauseReasons).toEqual(["moderation"]);
    expect(linkRow!.revokedAt).toBeNull();
    const ips = await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, file.id));
    expect(ips.map((row) => row.legalHold)).toEqual([true]);
    const [blocked] = await testDb().select().from(hashBlocklist).where(eq(hashBlocklist.sha256, sha256));
    expect(blocked).toMatchObject({ reason: "csam", sourceNodeId: file.id });
    const [report] = await testDb().select().from(reports).where(eq(reports.id, reportId));
    expect(report).toMatchObject({ nodeId: file.id, ownerId: owner.id, category: "csam", source: "system" });

    // The object is still there, byte for byte.
    expect(await (await env.FILES.get(file.r2Key!))?.text()).toBe("the evidence");

    expect(await auditRows({ action: "scan.suspected_csam", targetId: file.id })).toMatchObject([
      { actorType: "system", meta: { source: "system", reportId } },
    ]);
    // One alert, to the operator, carrying the report id — and not one word to the owner.
    const alerts = mailTo(ADMIN_EMAIL).filter((mail) => String(mail.text).includes(reportId));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.template).toBe("operatorCritical");
    expect(String(alerts[0]!.text)).not.toContain(file.name);
    expect(String(alerts[0]!.text)).not.toContain(owner.email);
    expect(mailTo(owner.email)).toEqual([]);
    // No strike.
    expect(await auditRows({ action: "strike.added", targetId: owner.id })).toEqual([]);

    // Repeated (the upload route and the consumer may both see the hit): the same report, no
    // second alert, no second audit row.
    const again = serviceDeps();
    expect(await lockSuspectedCsam(again.deps, file.id, { source: "photodna" })).toEqual({ reportId });
    await again.settle();
    expect(mailTo(ADMIN_EMAIL).filter((mail) => String(mail.text).includes(reportId))).toHaveLength(1);
    expect(await auditRows({ action: "scan.suspected_csam", targetId: file.id })).toHaveLength(1);
    expect(await testDb().select().from(reports).where(eq(reports.nodeId, file.id))).toHaveLength(1);
  });

  it("is a 404 for an id that does not exist", async () => {
    const { deps } = serviceDeps();
    for (const id of [crypto.randomUUID(), "nope"]) {
      const error = await lockSuspectedCsam(deps, id, { source: "admin" }).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("not_found");
    }
  });
});
