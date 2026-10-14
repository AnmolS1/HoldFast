// The scanning interface: message shapes, the stub scanner, sending, rescans and the
// suspected-CSAM handler. The consumer has its own file.
import { env } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { todayTotals, totalsOn } from "../../../src/worker/db/queries/ledger";
import {
  csamLocksWithoutReport,
  csamReportsToAnnounce,
  lockSuspectedCsam as lockRows,
  takedownNode,
} from "../../../src/worker/db/queries/moderation";
import {
  auditLog,
  downloadLedger,
  hashBlocklist,
  nodes,
  reports,
  scanJobs,
  shareLinks,
  uploadIps,
  user,
} from "../../../src/worker/db/schema";
import { testOutbound } from "../../../src/worker/auth/test-outbound";
import { CRITICAL_RETRY_WAITS_MS } from "../../../src/worker/services/email";
import { AppError } from "../../../src/worker/services/errors";
import {
  csamAlertMarker,
  csamLockMarker,
  enqueueRescan,
  enqueueScan,
  ensureCsamAlerted,
  getScanner,
  lockSuspectedCsam,
  NO_OPERATOR_MESSAGE,
  normalizeScanMessage,
  scanSmallObject,
  STUB_SCAN_MAX_BYTES,
  stubEnabled,
  sweepCsamAlerts,
  sweepUnrecordedCsamLocks,
} from "../../../src/worker/services/scanning";
import { eicarBytes, nestedEicarZipBytes } from "../../setup/fixture-bytes";
import { makeLink } from "../auth/helpers";
import {
  ADMIN_EMAIL,
  auditRows,
  backendPid,
  deliver,
  gate,
  jobsFor,
  mailTo,
  makeFile,
  makeFolder,
  makeUser,
  nodeById,
  putObject,
  rand,
  serviceDeps,
  testDb,
  untilBlockedBy,
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

/** A database handle that runs `after` once, right after the first plain read made through it. */
function staleFirstRead<T extends object>(db: T, after: () => PromiseLike<unknown>): T {
  let pending = true;
  return new Proxy(db, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      const bound = (value as (...args: unknown[]) => unknown).bind(target);
      if (property !== "select" || !pending) return bound;
      return (...args: unknown[]) => {
        const builder = bound(...args) as { from: (...a: unknown[]) => unknown };
        return {
          from: (...fromArgs: unknown[]) => {
            const query = builder.from(...fromArgs) as {
              where: (...a: unknown[]) => { limit: (n: number) => Promise<unknown> };
            };
            return {
              where: (...whereArgs: unknown[]) => ({
                limit: async (n: number) => {
                  const rows = await query.where(...whereArgs).limit(n);
                  if (pending) {
                    pending = false;
                    await after();
                  }
                  return rows;
                },
              }),
            };
          },
        };
      };
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
  it("any other status: back to pending, a forced message, { queued: true }", async () => {
    const owner = await makeUser();
    for (const status of ["clean", "infected", "skipped", "error", "pending"] as const) {
      const file = await makeFile(owner.id, null, {
        scanStatus: status,
        scannedAt: new Date(),
        scanDetail: { engine: "stub" },
        mimeSniffed: "image/png",
      });
      const { deps, sent, settle } = recordingDeps();
      expect(await enqueueRescan(deps, file.id, { by: "owner" }), status).toEqual({ queued: true });
      await settle();
      const after = await nodeById(file.id);
      expect(after, status).toMatchObject({ scanStatus: "pending", scannedAt: null, scanDetail: null });
      expect(sent, status).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
      expect(await auditRows({ action: "scan.rescan_requested", targetId: file.id })).toMatchObject([
        { meta: { by: "owner" } },
      ]);
    }
    // There is no unforced rescan: the option does not exist, and one smuggled past the type is ignored.
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const { deps, sent } = recordingDeps();
    // @ts-expect-error a rescan has no force option
    await enqueueRescan(deps, file.id, { by: "admin", force: false });
    expect(sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
  });

  it("taken down, whatever the status: nothing changes, nothing is sent, { queued: false, reason: 'taken_down' }", async () => {
    const owner = await makeUser();
    const down = { takedownAt: new Date(), takedownReason: "dmca" as const, scannedAt: new Date() };
    for (const status of ["clean", "infected", "pending", "under_review", "suspected_csam"] as const) {
      const before = await makeFile(owner.id, null, { scanStatus: status, ...down });
      const { deps, sent, settle } = recordingDeps();
      expect(await enqueueRescan(deps, before.id, { by: "admin" }), status).toEqual({
        queued: false,
        reason: "taken_down",
      });
      await settle();
      expect(await nodeById(before.id), status).toEqual(before);
      expect(sent, status).toEqual([]);
      expect(await auditRows({ action: "scan.rescan_requested", targetId: before.id })).toEqual([]);
    }
  });

  it("suspected_csam: nothing changes, nothing is sent, { queued: false, reason: 'locked' }", async () => {
    const owner = await makeUser();
    const before = await makeFile(owner.id, null, {
      scanStatus: "suspected_csam",
      legalHold: true,
      scannedAt: new Date(),
    });
    const { deps, sent, settle } = recordingDeps();
    expect(await enqueueRescan(deps, before.id, { by: "admin" })).toEqual({
      queued: false,
      reason: "locked",
    });
    await settle();
    expect(await nodeById(before.id)).toEqual(before);
    expect(sent).toEqual([]);
    expect(await auditRows({ action: "scan.rescan_requested", targetId: before.id })).toEqual([]);
  });

  it("an owner never learns why: taken down, suspected_csam and an unknown id are the same 404", async () => {
    const owner = await makeUser();
    const down = await makeFile(owner.id, null, {
      scanStatus: "clean",
      scannedAt: new Date(),
      takedownAt: new Date(),
      takedownReason: "dmca",
    });
    const locked = await makeFile(owner.id, null, { scanStatus: "suspected_csam", legalHold: true });
    const folder = await makeFolder(owner.id);
    const errors: AppError[] = [];
    for (const id of [down.id, locked.id, crypto.randomUUID(), folder.id]) {
      const { deps, sent, settle } = recordingDeps();
      const error = await enqueueRescan(deps, id, { by: "owner" }).catch((thrown: unknown) => thrown);
      await settle();
      expect(error).toBeInstanceOf(AppError);
      errors.push(error as AppError);
      expect(sent).toEqual([]);
      expect(await auditRows({ action: "scan.rescan_requested", targetId: id })).toEqual([]);
    }
    // Identical in everything a route could pass on.
    const shape = (error: AppError) => ({
      code: error.code,
      status: error.status,
      message: error.message,
      details: error.details,
      headers: error.headers,
      name: error.name,
    });
    for (const error of errors) expect(shape(error)).toEqual(shape(errors[2]!));
    expect(shape(errors[0]!)).toMatchObject({ code: "not_found", status: 404, message: "Not found." });
    // Nothing was reset.
    expect(await nodeById(down.id)).toEqual(down);
    expect(await nodeById(locked.id)).toEqual(locked);
    // The control: an admin asking about the same two nodes IS told, and tells them apart.
    expect(await enqueueRescan(recordingDeps().deps, down.id, { by: "admin" })).toEqual({
      queued: false,
      reason: "taken_down",
    });
    expect(await enqueueRescan(recordingDeps().deps, locked.id, { by: "admin" })).toEqual({
      queued: false,
      reason: "locked",
    });
  });

  it("under_review: every column kept, and a message IS sent, { queued: true }", async () => {
    const owner = await makeUser();
    const before = await makeFile(owner.id, null, {
      scanStatus: "under_review",
      scanStatusPrev: "clean",
      scannedAt: new Date(),
      scanDetail: { engine: "stub" },
    });
    const { deps, sent, settle } = recordingDeps();
    expect(await enqueueRescan(deps, before.id, { by: "admin" })).toEqual({ queued: true });
    await settle();
    expect(await nodeById(before.id)).toEqual(before);
    expect(sent).toEqual([{ v: 1, nodeId: before.id, key: before.r2Key, force: true }]);
    expect(await auditRows({ action: "scan.rescan_requested", targetId: before.id })).toHaveLength(1);
  });

  it("a takedown that lands while the rescan runs is seen: verdict kept, not pending, nothing sent", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, {
      scanStatus: "infected",
      scanReason: null,
      scanDetail: { engine: "clamav", signatures: ["Made.Up.Signature"] },
      scannedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const { deps, sent, settle } = recordingDeps();
    const lockHeld = gate<number>();

    // Transaction A takes the node down and holds the row's lock until the rescan is waiting for it.
    const takedown = testDb().transaction(async (tx) => {
      await tx
        .update(nodes)
        .set({ takedownAt: new Date(), takedownReason: "abuse" })
        .where(eq(nodes.id, file.id));
      const pid = Number(
        (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid,
      );
      lockHeld.open(pid);
      await untilBlockedBy(pid);
    });
    await lockHeld.opened;
    const rescan = enqueueRescan(deps, file.id, { by: "admin" });
    const [, result] = await Promise.all([takedown, rescan]);
    await settle();
    expect(result).toEqual({ queued: false, reason: "taken_down" });

    const after = await nodeById(file.id);
    expect(after!.takedownAt).toBeInstanceOf(Date);
    expect(after).toMatchObject({
      scanStatus: "infected",
      scanDetail: { engine: "clamav", signatures: ["Made.Up.Signature"] },
      scannedAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    expect(sent).toEqual([]);
    expect(await auditRows({ action: "scan.rescan_requested", targetId: file.id })).toEqual([]);
  });

  it("a replace that lands before the rescan locks the row: the NEW version is the one enqueued", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const newVersion = crypto.randomUUID();
    const newKey = `u/${owner.id}/${file.id}/${newVersion}`;
    const { deps, sent } = recordingDeps();
    // The read inside enqueueRescan sees the old key; the row has the new one by the time it locks.
    const stale = {
      ...deps,
      db: staleFirstRead(deps.db, () =>
        testDb().update(nodes).set({ r2Key: newKey, versionId: newVersion }).where(eq(nodes.id, file.id)),
      ),
    };
    await enqueueRescan(stale, file.id, { by: "admin" });
    expect(sent).toEqual([{ v: 1, nodeId: file.id, key: newKey, force: true }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
  });

  // The reset commits before the queue is asked. A queue that refuses leaves the node `pending`
  // — fail closed, no earlier verdict is ever written back — and what makes that recoverable is
  // that a `pending` node with no scan under way may simply be asked for again.
  describe("a send that fails after the reset", () => {
    const VERDICT = {
      scanReason: "engine" as const,
      scanDetail: { engine: "clamav", error: "made up" },
      scannedAt: new Date("2026-10-01T00:00:00.000Z"),
    };
    /** Deps whose queue refuses; `beforeFailing` runs after the reset committed, before the send fails. */
    function failingDeps(beforeFailing: () => Promise<unknown> = async () => {}) {
      return serviceDeps({
        SCAN_QUEUE: {
          send: async () => {
            await beforeFailing();
            throw new Error("the queue is not taking messages");
          },
        },
      });
    }
    const job = (
      file: { id: string; r2Key: string | null },
      values: Partial<typeof scanJobs.$inferInsert> = {},
    ) =>
      testDb()
        .insert(scanJobs)
        .values({ nodeId: file.id, r2Key: file.r2Key!, status: "running", startedAt: new Date(), ...values });

    it("the node stays pending, nothing is recorded, and the owner's retry sends the message", async () => {
      const owner = await makeUser();
      for (const status of ["error", "skipped", "clean", "infected"] as const) {
        const file = await makeFile(owner.id, null, { scanStatus: status, ...VERDICT });
        const { deps, settle } = failingDeps();
        await expect(enqueueRescan(deps, file.id, { by: "owner" })).rejects.toThrow(
          "the queue is not taking",
        );
        await settle();
        // Fail closed: pending, the earlier verdict gone and NOT put back; no job, no audit row.
        expect(await nodeById(file.id), status).toMatchObject({
          scanStatus: "pending",
          scanReason: null,
          scanDetail: null,
          scannedAt: null,
        });
        expect(await jobsFor(file.r2Key!)).toEqual([]);
        expect(await auditRows({ action: "scan.rescan_requested", targetId: file.id })).toEqual([]);

        // The owner asks again — a `pending` file now, with no scan of it under way: sent, once.
        const again = recordingDeps();
        expect(await enqueueRescan(again.deps, file.id, { by: "owner" })).toEqual({ queued: true });
        await again.settle();
        expect(again.sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
        expect((await nodeById(file.id))!.scanStatus).toBe("pending");
        expect(await auditRows({ action: "scan.rescan_requested", targetId: file.id })).toHaveLength(1);
      }
    });

    it("a pending file WITH a scan under way: 409 for its owner, nothing sent; an admin's is sent as before", async () => {
      const owner = await makeUser();
      const busy = await makeFile(owner.id, null, { scanStatus: "pending" });
      await job(busy);
      const first = recordingDeps();
      const error = await enqueueRescan(first.deps, busy.id, { by: "owner" }).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("conflict");
      await first.settle();
      expect(first.sent).toEqual([]);
      expect(await auditRows({ action: "scan.rescan_requested", targetId: busy.id })).toEqual([]);
      const admin = recordingDeps();
      expect(await enqueueRescan(admin.deps, busy.id, { by: "admin" })).toEqual({ queued: true });
      expect(admin.sent).toEqual([{ v: 1, nodeId: busy.id, key: busy.r2Key, force: true }]);

      // Not "under way": a claim past the stale time (it will be taken over), a failed job, a
      // finished one, and a live job of ANOTHER key (the version before a replace).
      const notLive: Partial<typeof scanJobs.$inferInsert>[] = [
        { startedAt: new Date(Date.now() - 21 * 60_000) },
        { status: "failed", finishedAt: new Date() },
        { status: "done", finishedAt: new Date() },
        { r2Key: `u/${owner.id}/${crypto.randomUUID()}/${crypto.randomUUID()}` },
      ];
      for (const values of notLive) {
        const file = await makeFile(owner.id, null, { scanStatus: "pending" });
        await job(file, values);
        const { deps, sent } = recordingDeps();
        expect(await enqueueRescan(deps, file.id, { by: "owner" }), JSON.stringify(values)).toEqual({
          queued: true,
        });
        expect(sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
      }
      // 19 minutes old is still a live claim.
      const young = await makeFile(owner.id, null, { scanStatus: "pending" });
      await job(young, { startedAt: new Date(Date.now() - 19 * 60_000) });
      await expect(enqueueRescan(recordingDeps().deps, young.id, { by: "owner" })).rejects.toMatchObject({
        code: "conflict",
      });
    });

    // The sequence a put-back would get wrong: rescan A resets and its send fails; before A does
    // anything else, rescan B succeeds — the node is `pending` on the same key, for B's reason.
    // B's scan then finds the file infected. Had A written the old `clean` back, B's verdict
    // would have been dropped (the consumer writes only to a `pending` node) and the file served.
    it("a second rescan that got through while the first one's send failed: its verdict IS written", async () => {
      const owner = await makeUser();
      const file = await makeFile(owner.id, null, { name: "eicar.com.txt", scanStatus: "clean", ...VERDICT });
      await putObject(file.r2Key!, eicarBytes());
      const second = recordingDeps();
      const first = failingDeps(async () => {
        expect(await enqueueRescan(second.deps, file.id, { by: "admin" })).toEqual({ queued: true });
      });
      await expect(enqueueRescan(first.deps, file.id, { by: "admin" })).rejects.toThrow(
        "the queue is not taking",
      );
      expect(second.sent).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
      // Still pending when the first call has returned — nothing wrote `clean` back.
      expect((await nodeById(file.id))!.scanStatus).toBe("pending");

      expect(await deliver([{ body: second.sent[0] }])).toEqual([{ outcome: "ack" }]);
      expect(await nodeById(file.id)).toMatchObject({
        scanStatus: "infected",
        scanDetail: { engine: "stub", signatures: ["Stub.EICAR"] },
      });
    });

    it("two re-sends are one job and one verdict: the second delivery writes nothing to the node", async () => {
      const owner = await makeUser();
      const file = await makeFile(owner.id, null, { name: "notes.txt", scanStatus: "error", ...VERDICT });
      await putObject(file.r2Key!, "hello");
      const failed = failingDeps();
      await expect(enqueueRescan(failed.deps, file.id, { by: "owner" })).rejects.toThrow();
      const one = recordingDeps();
      const two = recordingDeps();
      await Promise.all([
        enqueueRescan(one.deps, file.id, { by: "owner" }),
        enqueueRescan(two.deps, file.id, { by: "admin" }),
      ]);
      expect([...one.sent, ...two.sent]).toHaveLength(2);

      expect(await deliver([{ body: one.sent[0] }])).toEqual([{ outcome: "ack" }]);
      const scanned = (await nodeById(file.id))!;
      expect(scanned).toMatchObject({ scanStatus: "clean", scanDetail: { engine: "stub" } });
      // The second message: the same job row is claimed again (forced), the bytes are read again,
      // and the node — no longer pending — is left exactly as the first verdict made it.
      await testDb()
        .update(nodes)
        .set({ scanDetail: { engine: "marker" } })
        .where(eq(nodes.id, file.id));
      expect(await deliver([{ body: two.sent[0] }])).toEqual([{ outcome: "ack" }]);
      expect(await nodeById(file.id)).toMatchObject({
        scanStatus: "clean",
        scanDetail: { engine: "marker" },
        scannedAt: scanned.scannedAt,
      });
      expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done", attempt: 2 }]);
    });
  });

  // Hidden is inherited: a file inside a taken-down folder is as taken down as one taken down itself.
  describe("a file inside a taken-down folder", () => {
    const DOWN = { takedownAt: new Date(), takedownReason: "abuse" as const };
    const VERDICT = {
      scanDetail: { engine: "clamav", signatures: ["Made.Up.Signature"] },
      scannedAt: new Date("2026-10-01T00:00:00.000Z"),
    };

    it("admin: { queued: false, reason: 'taken_down' }; owner: the unknown id's 404 — nothing reset, nothing sent, at any depth and status", async () => {
      const owner = await makeUser();
      const down = await makeFolder(owner.id, null, DOWN);
      const sub = await makeFolder(owner.id, down.id);
      for (const status of ["clean", "infected", "skipped", "error", "pending", "under_review"] as const) {
        for (const parent of [down, sub]) {
          const file = await makeFile(owner.id, parent.id, { scanStatus: status, ...VERDICT });
          const admin = recordingDeps();
          expect(await enqueueRescan(admin.deps, file.id, { by: "admin" }), status).toEqual({
            queued: false,
            reason: "taken_down",
          });
          const mine = recordingDeps();
          const error = await enqueueRescan(mine.deps, file.id, { by: "owner" }).catch(
            (thrown: unknown) => thrown,
          );
          const unknown = await enqueueRescan(mine.deps, crypto.randomUUID(), { by: "owner" }).catch(
            (thrown: unknown) => thrown,
          );
          expect(error).toBeInstanceOf(AppError);
          expect({ code: (error as AppError).code, message: (error as AppError).message }).toEqual({
            code: (unknown as AppError).code,
            message: (unknown as AppError).message,
          });
          await admin.settle();
          await mine.settle();
          expect([...admin.sent, ...mine.sent], status).toEqual([]);
          expect(await nodeById(file.id), status).toMatchObject({ scanStatus: status, ...VERDICT });
          expect(await auditRows({ action: "scan.rescan_requested", targetId: file.id })).toEqual([]);
        }
      }
    });

    it("the table's precedence is kept: taken down itself, then locked, then the folder above", async () => {
      const owner = await makeUser();
      const down = await makeFolder(owner.id, null, DOWN);
      const lockedInside = await makeFile(owner.id, down.id, {
        scanStatus: "suspected_csam",
        legalHold: true,
      });
      const bothInside = await makeFile(owner.id, down.id, {
        scanStatus: "suspected_csam",
        legalHold: true,
        ...DOWN,
      });
      const ownInside = await makeFile(owner.id, down.id, { scanStatus: "clean", ...DOWN });
      const by = { by: "admin" } as const;
      const answer = (id: string) => enqueueRescan(recordingDeps().deps, id, by);
      // A locked file answers "locked" wherever it lies — as it did before this rule.
      expect(await answer(lockedInside.id)).toEqual({ queued: false, reason: "locked" });
      expect(await answer(bothInside.id)).toEqual({ queued: false, reason: "taken_down" });
      expect(await answer(ownInside.id)).toEqual({ queued: false, reason: "taken_down" });
      // The control: once the folder is restored a file inside it is rescanned as any other.
      const plain = await makeFile(owner.id, down.id, { scanStatus: "clean" });
      expect(await answer(plain.id)).toEqual({ queued: false, reason: "taken_down" });
      await testDb()
        .update(nodes)
        .set({ takedownAt: null, takedownReason: null })
        .where(eq(nodes.id, down.id));
      const { deps, sent } = recordingDeps();
      expect(await enqueueRescan(deps, plain.id, by)).toEqual({ queued: true });
      expect(sent).toHaveLength(1);
    });

    it("a takedown of the folder above that lands while the rescan runs is seen: the rescan waits for the tree lock", async () => {
      const owner = await makeUser();
      const folder = await makeFolder(owner.id);
      const file = await makeFile(owner.id, folder.id, { scanStatus: "infected", ...VERDICT });
      const { deps, sent, settle } = recordingDeps();
      const lockHeld = gate<number>();
      // The takedown is written and holds the owner's tree lock until the rescan waits for it.
      const takedown = testDb().transaction(async (tx) => {
        expect(await takedownNode(tx, folder.id, { reason: "abuse", by: null })).toBe(true);
        const pid = await backendPid(tx);
        lockHeld.open(pid);
        await untilBlockedBy(pid);
      });
      await lockHeld.opened;
      const outcome = enqueueRescan(deps, file.id, { by: "owner" }).catch((thrown: unknown) => thrown);
      const [, error] = await Promise.all([takedown, outcome]);
      await settle();
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("not_found");
      expect(await nodeById(file.id)).toMatchObject({ scanStatus: "infected", ...VERDICT });
      expect(sent).toEqual([]);
    });
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

    // The alert has a row of its own: who was told is a count, never an address.
    const sentRows = await auditRows({ action: "scan.csam_alert_sent", targetId: file.id });
    expect(sentRows).toMatchObject([{ actorType: "system", meta: { reportId, via: "lock", recipients: 1 } }]);
    expect(JSON.stringify(sentRows[0]!.meta)).not.toContain("@");

    // Repeated (the upload route and the consumer may both see the hit): the same report, no
    // second alert, no second audit row of either kind.
    const again = serviceDeps();
    expect(await lockSuspectedCsam(again.deps, file.id, { source: "photodna" })).toEqual({ reportId });
    await again.settle();
    expect(mailTo(ADMIN_EMAIL).filter((mail) => String(mail.text).includes(reportId))).toHaveLength(1);
    expect(await auditRows({ action: "scan.suspected_csam", targetId: file.id })).toMatchObject([
      { meta: { source: "system", reportId } },
    ]);
    expect(await auditRows({ action: "scan.csam_alert_sent", targetId: file.id })).toHaveLength(1);
    expect(await testDb().select().from(reports).where(eq(reports.nodeId, file.id))).toHaveLength(1);
  });

  /** A locked node whose database half committed and whose invocation then died: nobody was told. */
  async function lockedButSilent(db: Db = testDb()) {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
    const locked = await lockRows(db, file.id, { source: "photodna" });
    return { owner, file, reportId: locked!.reportId };
  }
  const alertsFor = (reportId: string) =>
    mailTo(ADMIN_EMAIL).filter((mail) => String(mail.text).includes(reportId));
  const markerOf = (reportId: string) => todayTotals(testDb(), "notice", csamAlertMarker(reportId));
  const lockRowsOf = (nodeId: string) => auditRows({ action: "scan.suspected_csam", targetId: nodeId });
  const sentRowsOf = (nodeId: string) => auditRows({ action: "scan.csam_alert_sent", targetId: nodeId });
  const viaOf = async (nodeId: string) =>
    (await sentRowsOf(nodeId)).map((row) => (row.meta as { via: string }).via).sort();
  // THE SWEEP IS TABLE-WIDE: it settles the open csam reports of the whole database, oldest
  // first, up to its limit — and this database is shared with every other test file and every
  // earlier run. A test that swept with a large limit and then counted its OWN report's mails
  // depended on how many reports others had left waiting: past 200 the in-memory outbox
  // (OUTBOX_CAPACITY) had dropped the lock's mail, past 1,000 the sweep would not reach it.
  // `alone` and `oldestFirst` remove that without touching anybody else's rows:
  //   - the body runs in ONE transaction that is rolled back, and `deps.db` IS that transaction:
  //     the test's reports, markers and audit rows are never visible to a neighbour (no other
  //     sweep can announce them first) and never join the backlog;
  //   - the test's own reports are dated before every other (`oldestFirst`), and the sweep is
  //     given a limit of exactly as many: it reads the queue's head — this test's rows — and
  //     nothing else. No row of another file is read for update, locked or written.
  // What a neighbour running at the same moment can still do: nothing to these reports (it
  // cannot see them). Where a test sweeps once more than it has due reports (to show nothing is
  // announced twice), that sweep takes the ONE oldest waiting report of the shared database:
  // its mail goes to this isolate's outbox and its marker and audit row are rolled back.
  // Read through `db` inside the body: nothing written there is visible on another connection.
  const ROLLBACK = new Error("rollback");
  async function alone(
    body: (only: { db: Db; depsOn: () => ReturnType<typeof serviceDeps> }) => Promise<void>,
  ): Promise<void> {
    await testDb()
      .transaction(async (tx) => {
        const db = tx as unknown as Db;
        const depsOn = () => {
          const made = serviceDeps();
          made.deps.db = db;
          return made;
        };
        await body({ db, depsOn });
        throw ROLLBACK;
      })
      .catch((error: unknown) => {
        if (error !== ROLLBACK) throw error;
      });
  }
  /** Dates these reports before every other in the database, in the order given. */
  async function oldestFirst(db: Db, reportIds: string[]): Promise<void> {
    for (const [index, id] of reportIds.entries()) {
      await db
        .update(reports)
        .set({ createdAt: new Date(Date.UTC(1990, 0, 1, 0, 0, index)) })
        .where(eq(reports.id, id));
    }
  }
  const auditIn = (db: Db, action: string, targetId: string) =>
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));
  const viaIn = async (db: Db, nodeId: string) =>
    (await auditIn(db, "scan.csam_alert_sent", nodeId))
      .map((row) => (row.meta as { via: string }).via)
      .sort();
  /** "Tomorrow": today's alert marker of a report becomes yesterday's. */
  const ageAlertMarker = (reportId: string, db: Db = testDb()) =>
    db
      .update(downloadLedger)
      .set({ day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) })
      .where(
        and(
          eq(downloadLedger.subjectType, "notice"),
          eq(downloadLedger.subjectId, csamAlertMarker(reportId)),
        ),
      );
  /**
   * Deps whose mail goes to a stand-in for the mail API that accepts a message only for the
   * addresses in `reachable` (made-up addresses) and answers 500 for everyone else. `finish`
   * runs the deferred retries out under a fake timer.
   */
  function mailApiDeps(operators: string[], reachable: string[], fault: "500" | "throw" = "500") {
    const outbound = testOutbound()!;
    const accepted: string[] = [];
    outbound.answer("api.resend.com", async (request) => {
      const { to } = (await request.json()) as { to: string | string[] };
      const address = String(Array.isArray(to) ? to[0] : to);
      if (!reachable.includes(address) && fault === "throw")
        throw new Error("the mail API cannot be reached");
      if (!reachable.includes(address))
        return Response.json(
          { name: "internal_server_error", message: "down", statusCode: 500 },
          { status: 500 },
        );
      accepted.push(address);
      return Response.json({ id: "sent" });
    });
    const points: { blobs: string[] }[] = [];
    const made = serviceDeps({
      ADMIN_EMAILS: operators.join(","),
      EMAIL_TRANSPORT: "resend",
      // A made-up key: the stand-in above answers, nothing leaves the test.
      RESEND_API_KEY: "re_test_key",
      METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) },
    });
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    return {
      ...made,
      accepted,
      errors: () =>
        points.filter((point) => point.blobs[0] === "error").map((point) => point.blobs.slice(2, 4)),
      /**
       * Waits for the work handed to `defer` SO FAR (the lock's after-work) — an event, not a
       * time: once it has ended, the mail retries it started are waiting on their timers.
       */
      async started() {
        await Promise.allSettled([...made.deferred]);
      },
      async finish() {
        try {
          await vi.advanceTimersByTimeAsync(CRITICAL_RETRY_WAITS_MS[0] + CRITICAL_RETRY_WAITS_MS[1] + 100);
          vi.useRealTimers();
          await made.settle();
        } finally {
          vi.useRealTimers();
          outbound.answer("api.resend.com", null);
        }
      },
    };
  }

  it("the database half committed and the invocation died: the redelivery alerts", async () => {
    const { file, reportId } = await lockedButSilent();
    expect(alertsFor(reportId)).toHaveLength(0);
    expect(await auditRows({ action: "scan.suspected_csam", targetId: file.id })).toEqual([]);
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");

    // The message is delivered again: the node is ALREADY locked, and the operators are told now.
    const { deps, settle } = serviceDeps();
    expect(await lockSuspectedCsam(deps, file.id, { source: "photodna" })).toEqual({ reportId });
    await settle();
    expect(alertsFor(reportId)).toHaveLength(1);
    expect(alertsFor(reportId)[0]!.template).toBe("operatorCritical");
    // The lock's own row is written by the redelivery too, with the caller's real source.
    expect(await lockRowsOf(file.id)).toMatchObject([
      { actorType: "system", meta: { source: "photodna", reportId } },
    ]);
    expect(await viaOf(file.id)).toEqual(["lock"]);
    expect(await markerOf(reportId)).toEqual({ bytes: 0, count: 1 });
    expect(await todayTotals(testDb(), "notice", csamLockMarker(reportId))).toEqual({ bytes: 0, count: 1 });

    // Delivered a third time the same day: still one of each.
    const third = serviceDeps();
    await lockSuspectedCsam(third.deps, file.id, { source: "system" });
    await third.settle();
    expect(alertsFor(reportId)).toHaveLength(1);
    expect(await lockRowsOf(file.id)).toHaveLength(1);
    expect(await sentRowsOf(file.id)).toHaveLength(1);
  });

  it("two calls the same day are one mail; the next day the sweep announces the open report again — one lock row, two alert rows", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
    await alone(async ({ db, depsOn }) => {
      const first = depsOn();
      const { reportId } = await lockSuspectedCsam(first.deps, file.id, { source: "admin" });
      await first.settle();
      expect(await ensureCsamAlerted(first.deps, reportId, { via: "lock", nodeId: file.id })).toBe(false);
      expect(await lockSuspectedCsam(first.deps, file.id, { source: "system" })).toEqual({ reportId });
      await first.settle();
      expect(alertsFor(reportId)).toHaveLength(1);
      expect(await auditIn(db, "scan.suspected_csam", file.id)).toHaveLength(1);
      expect(await viaIn(db, file.id)).toEqual(["lock"]);

      await ageAlertMarker(reportId, db);
      await oldestFirst(db, [reportId]);
      const next = depsOn();
      const swept = await sweepCsamAlerts(next.deps, { limit: 1 });
      await next.settle();
      // Exactly this report: announced again, its lock (recorded yesterday) not recorded twice.
      expect(swept).toEqual({ checked: 1, alerted: 1, recorded: 0 });
      expect(alertsFor(reportId)).toHaveLength(2);
      // The re-announcement is not a second lock: the lock's row keeps its real source, alone.
      expect(await auditIn(db, "scan.suspected_csam", file.id)).toMatchObject([
        { meta: { source: "admin", reportId } },
      ]);
      expect(await viaIn(db, file.id)).toEqual(["lock", "sweep"]);
    });
  });

  it("a lock repeated on a node whose report is FILED or being reviewed mails nobody and writes no second lock row", async () => {
    /** Yesterday's markers: a repeat today WOULD record the lock and tell the operators again. */
    const ageMarkers = (reportId: string) =>
      testDb()
        .update(downloadLedger)
        .set({ day: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10) })
        .where(
          and(
            eq(downloadLedger.subjectType, "notice"),
            inArray(downloadLedger.subjectId, [csamAlertMarker(reportId), csamLockMarker(reportId)]),
          ),
        );
    const lockedYesterday = async () => {
      const owner = await makeUser();
      const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
      const first = serviceDeps();
      const { reportId } = await lockSuspectedCsam(first.deps, file.id, { source: "photodna" });
      await first.settle();
      expect(alertsFor(reportId)).toHaveLength(1);
      expect(await lockRowsOf(file.id)).toHaveLength(1);
      await ageMarkers(reportId);
      return { file, reportId };
    };
    const repeat = async (fileId: string) => {
      const again = serviceDeps();
      const result = await lockSuspectedCsam(again.deps, fileId, { source: "photodna" });
      await again.settle();
      expect(again.deferred).toHaveLength(0);
      return result;
    };

    for (const status of ["actioned", "reviewing"] as const) {
      const { file, reportId } = await lockedYesterday();
      await testDb().update(reports).set({ status }).where(eq(reports.id, reportId));
      // The same report comes back; nobody is mailed, nothing is recorded, no new report.
      expect(await repeat(file.id), status).toEqual({ reportId });
      expect(alertsFor(reportId), status).toHaveLength(1);
      expect(await lockRowsOf(file.id), status).toHaveLength(1);
      expect(await sentRowsOf(file.id), status).toHaveLength(1);
      expect(await testDb().select().from(reports).where(eq(reports.nodeId, file.id)), status).toHaveLength(
        1,
      );
    }

    // The control: the same repeat while the report is still OPEN records and announces again.
    const open = await lockedYesterday();
    expect(await repeat(open.file.id)).toEqual({ reportId: open.reportId });
    expect(alertsFor(open.reportId)).toHaveLength(2);
    expect(await lockRowsOf(open.file.id)).toHaveLength(2);
  });

  it("a FIRST lock is always recorded and announced — also when it finds a report already being reviewed, or filed; a repeat on an open report repairs a lost record", async () => {
    for (const status of ["reviewing", "actioned"] as const) {
      // The case was opened from a user's report; the node was never locked.
      const owner = await makeUser();
      const file = await makeFile(owner.id, null, { scanStatus: "clean", sha256: rand(32) });
      const [earlier] = await testDb()
        .insert(reports)
        .values({ nodeId: file.id, ownerId: owner.id, source: "user", category: "csam", status })
        .returning({ id: reports.id });
      const made = serviceDeps();
      expect(await lockSuspectedCsam(made.deps, file.id, { source: "admin" }), status).toEqual({
        reportId: earlier!.id,
      });
      await made.settle();
      expect((await nodeById(file.id))!.scanStatus, status).toBe("suspected_csam");
      expect(await lockRowsOf(file.id), status).toMatchObject([
        { meta: { source: "admin", reportId: earlier!.id } },
      ]);
      expect(alertsFor(earlier!.id), status).toHaveLength(1);
      // The control, same node: the repeat finds it locked and the report not open — nothing more.
      const again = serviceDeps();
      await lockSuspectedCsam(again.deps, file.id, { source: "admin" });
      await again.settle();
      expect(again.deferred, status).toHaveLength(0);
      expect(await lockRowsOf(file.id), status).toHaveLength(1);
      expect(alertsFor(earlier!.id), status).toHaveLength(1);
    }

    // A repeat on an OPEN report whose record was lost with its invocation: made good.
    const silent = await lockedButSilent();
    expect(await lockRowsOf(silent.file.id)).toHaveLength(0);
    expect(alertsFor(silent.reportId)).toHaveLength(0);
    const repair = serviceDeps();
    expect(await lockSuspectedCsam(repair.deps, silent.file.id, { source: "photodna" })).toEqual({
      reportId: silent.reportId,
    });
    await repair.settle();
    expect(await lockRowsOf(silent.file.id)).toHaveLength(1);
    expect(alertsFor(silent.reportId)).toHaveLength(1);
  });

  it("a mail that is only being retried reached nobody: unclaimed, false — and the lock is on record all the same", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
    // Made-up operator addresses; none of them can be reached.
    const operators = [1, 2, 3].map((n) => `op${n}-${rand(4)}@example.test`);
    const down = mailApiDeps(operators, []);
    let reportId: string;
    try {
      // Resolves although nobody can be told: the lock does not wait for the mail.
      ({ reportId } = await lockSuspectedCsam(down.deps, file.id, { source: "photodna" }));
      await down.started();
      expect(await ensureCsamAlerted(down.deps, reportId, { via: "lock", nodeId: file.id })).toBe(false);
    } finally {
      await down.finish();
    }
    expect(down.accepted).toEqual([]);
    expect(await markerOf(reportId), "unclaimed: the next call and the sweep try again").toEqual({
      bytes: 0,
      count: 0,
    });
    expect(down.errors().filter(([, reason]) => reason === "send_failed")).toEqual([
      ["csam_alert", "send_failed"],
      ["csam_alert", "send_failed"],
    ]);
    // The node is locked and the lock is recorded with its real source; no alert row exists.
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
    expect(await lockRowsOf(file.id)).toMatchObject([{ meta: { source: "photodna", reportId } }]);
    expect(await sentRowsOf(file.id)).toEqual([]);
    expect((await csamReportsToAnnounce(testDb(), 1000)).map((row) => row.reportId)).toContain(reportId);
  });

  it("the marker is read and claimed on ONE day — the day this call computed, not the database's", async () => {
    const { file, reportId } = await lockedButSilent();
    const { deps, settle } = serviceDeps();
    // The Worker's clock says a day the database's does not (as, for a moment, around 00:00 UTC).
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2031-03-04T23:59:59.900Z") });
    try {
      expect(await ensureCsamAlerted(deps, reportId, { nodeId: file.id })).toBe(true);
      // Read on the day it was claimed on: the second call finds the marker.
      expect(await ensureCsamAlerted(deps, reportId, { nodeId: file.id })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(alertsFor(reportId)).toHaveLength(1);
    expect(await totalsOn(testDb(), "2031-03-04", "notice", csamAlertMarker(reportId))).toEqual({
      bytes: 0,
      count: 1,
    });
  });

  it("resolves when the node is locked — before the mail is sent, and whatever the mail does", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
    // A made-up operator address; the stand-in for the mail API holds the request at a gate.
    const operator = `op-${rand(4)}@example.test`;
    const outbound = testOutbound()!;
    const reached = gate();
    const release = gate();
    let delivered = 0;
    outbound.answer("api.resend.com", async () => {
      reached.open();
      await release.opened;
      delivered += 1;
      return Response.json({ id: "sent" });
    });
    const { deps, settle } = serviceDeps({
      ADMIN_EMAILS: operator,
      EMAIL_TRANSPORT: "resend",
      // A made-up key: the stand-in above answers, nothing leaves the test.
      RESEND_API_KEY: "re_test_key",
    });
    let resolved: { reportId: string } | null = null;
    try {
      const locking = lockSuspectedCsam(deps, file.id, { source: "system" }).then(
        (value) => (resolved = value),
      );
      // The mail request is in flight and held — and the caller already has its answer.
      await reached.opened;
      expect(resolved, "the lock waited for the mail").not.toBeNull();
      expect(delivered).toBe(0);
      expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
      expect(await sentRowsOf(file.id)).toEqual([]);
      release.open();
      await locking;
      await settle();
    } finally {
      release.open();
      outbound.answer("api.resend.com", null);
    }
    expect(delivered).toBe(1);
    expect(await viaOf(file.id)).toEqual(["lock"]);
    expect(await lockRowsOf(file.id)).toMatchObject([{ meta: { source: "system" } }]);
  });

  it("a mail transport that throws does not reject the caller: the node is locked, the failure is counted", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
    const broken = mailApiDeps([`op-${rand(4)}@example.test`], [], "throw");
    let reportId: string;
    try {
      ({ reportId } = await lockSuspectedCsam(broken.deps, file.id, { source: "admin" }));
      await broken.started();
    } finally {
      await broken.finish();
    }
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
    expect(await lockRowsOf(file.id)).toMatchObject([{ meta: { source: "admin", reportId } }]);
    expect(await sentRowsOf(file.id)).toEqual([]);
    expect(broken.errors()).toContainEqual(["csam_alert", "send_failed"]);
    expect(await markerOf(reportId), "unclaimed: the sweep tries again").toEqual({ bytes: 0, count: 0 });
  });

  it("the after-lock work never rejects: a failure in it is captured and counted, and the caller has its answer", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256: rand(32) });
    const points: { blobs: string[] }[] = [];
    const made = serviceDeps({
      METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) },
    });
    // From the moment work is handed to `defer`, every plain read through this handle fails —
    // the alert's first step is such a read (today's marker).
    let broken = false;
    const db = new Proxy(made.deps.db, {
      get(target, property, receiver) {
        if (property === "select" && broken) {
          return () => {
            throw new Error("the database went away");
          };
        }
        const value: unknown = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    const handed: Promise<unknown>[] = [];
    const deps = {
      ...made.deps,
      db,
      defer: (promise: Promise<unknown>) => {
        broken = true;
        handed.push(promise);
      },
    };
    const { reportId } = await lockSuspectedCsam(deps, file.id, { source: "system" });
    expect(handed).toHaveLength(1);
    expect((await Promise.allSettled(handed)).map((result) => result.status)).toEqual(["fulfilled"]);
    await made.settle();
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
    expect(
      points.filter((point) => point.blobs[0] === "error").map((point) => point.blobs.slice(2, 4)),
    ).toContainEqual(["csam_alert", "alert"]);
    expect(alertsFor(reportId)).toHaveLength(0);
    // The lock's own record did not depend on the step that failed.
    expect(await lockRowsOf(file.id)).toMatchObject([{ meta: { source: "system", reportId } }]);
  });

  it("one operator reached and two not: claimed, true, and the row counts the one", async () => {
    const { file, reportId } = await lockedButSilent();
    const operators = [1, 2, 3].map((n) => `op${n}-${rand(4)}@example.test`);
    const partly = mailApiDeps(operators, [operators[1]!]);
    try {
      expect(await ensureCsamAlerted(partly.deps, reportId, { via: "lock", nodeId: file.id })).toBe(true);
    } finally {
      await partly.finish();
    }
    expect(partly.accepted).toEqual([operators[1]]);
    expect(await markerOf(reportId)).toEqual({ bytes: 0, count: 1 });
    expect(await sentRowsOf(file.id)).toMatchObject([{ meta: { reportId, via: "lock", recipients: 1 } }]);
    expect(partly.errors().filter(([, reason]) => reason === "send_failed")).toEqual([]);
  });

  it("the sweep finds a report nobody was told about, tells them once, and leaves handled reports alone", async () => {
    await alone(async ({ db, depsOn }) => {
      const silent = await lockedButSilent(db);
      const handled = await lockedButSilent(db);
      await db.update(reports).set({ status: "reviewing" }).where(eq(reports.id, handled.reportId));
      const closed = await lockedButSilent(db);
      await db.update(reports).set({ status: "dismissed" }).where(eq(reports.id, closed.reportId));
      // All three at the head of the queue; only the open one is due.
      await oldestFirst(db, [handled.reportId, closed.reportId, silent.reportId]);
      expect((await csamReportsToAnnounce(db, 1)).map((row) => row.reportId)).toEqual([silent.reportId]);

      const sweep = depsOn();
      const swept = await sweepCsamAlerts(sweep.deps, { limit: 1 });
      await sweep.settle();
      expect(swept).toEqual({ checked: 1, alerted: 1, recorded: 1 });
      expect(alertsFor(silent.reportId)).toHaveLength(1);
      // The lock's deferred work was lost with its invocation: the sweep records BOTH facts — the
      // lock, with the source the report carries, marked as recovered; and the alert.
      expect(await auditIn(db, "scan.suspected_csam", silent.file.id)).toMatchObject([
        {
          actorType: "system",
          meta: { source: "photodna", reportId: silent.reportId, recoveredBy: "sweep" },
        },
      ]);
      expect(await auditIn(db, "scan.csam_alert_sent", silent.file.id)).toMatchObject([
        { meta: { reportId: silent.reportId, via: "sweep", recipients: 1 } },
      ]);
      expect(alertsFor(handled.reportId)).toHaveLength(0);
      expect(alertsFor(closed.reportId)).toHaveLength(0);

      // Swept again the same day: it is no longer due, and nobody is told twice.
      const due = (await csamReportsToAnnounce(db, 1000)).map((row) => row.reportId);
      expect(due).not.toContain(silent.reportId);
      expect(due).not.toContain(handled.reportId);
      const again = depsOn();
      await sweepCsamAlerts(again.deps, { limit: 1 });
      await again.settle();
      expect(alertsFor(silent.reportId)).toHaveLength(1);
      expect(await auditIn(db, "scan.suspected_csam", silent.file.id)).toHaveLength(1);
    });
  });

  it("an empty operator list is not silent: an error line, a metric, and the marker stays unclaimed", async () => {
    const { file, reportId } = await lockedButSilent();
    const points: { blobs: string[] }[] = [];
    const nobody = serviceDeps({
      ADMIN_EMAILS: "",
      METRICS: { writeDataPoint: (point: { blobs: string[] }) => void points.push(point) },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await ensureCsamAlerted(nobody.deps, reportId, { nodeId: file.id })).toBe(false);
      expect(await lockSuspectedCsam(nobody.deps, file.id, { source: "system" })).toEqual({ reportId });
      await nobody.settle();
      expect(logged.mock.calls.map((call) => call[0])).toEqual([NO_OPERATOR_MESSAGE, NO_OPERATOR_MESSAGE]);
      // A fixed text: no address, no id.
      expect(NO_OPERATOR_MESSAGE).not.toMatch(/@|[0-9a-f]{8}-/);
    } finally {
      logged.mockRestore();
    }
    // blobs: [name, outcome, kind, reason, …]
    expect(
      points.filter((point) => point.blobs[0] === "error").map((point) => point.blobs.slice(2, 4)),
    ).toEqual([
      ["csam_alert", "no_recipient"],
      ["csam_alert", "no_recipient"],
    ]);
    expect(await markerOf(reportId), "unclaimed: the sweep keeps trying").toEqual({ bytes: 0, count: 0 });
    // Locked, and the lock is on record with its real source — with nobody to tell.
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
    expect(await lockRowsOf(file.id)).toMatchObject([{ meta: { source: "system", reportId } }]);
    expect(await sentRowsOf(file.id)).toEqual([]);
    expect((await csamReportsToAnnounce(testDb(), 1000)).map((row) => row.reportId)).toContain(reportId);

    // Once there is someone to tell, the very next call tells them.
    const fixed = serviceDeps();
    expect(await ensureCsamAlerted(fixed.deps, reportId, { nodeId: file.id })).toBe(true);
    await fixed.settle();
    expect(alertsFor(reportId)).toHaveLength(1);
    expect(await viaOf(file.id), "via defaults to the sweep").toEqual(["sweep"]);
    expect(await lockRowsOf(file.id)).toHaveLength(1);
  });

  // The upload route inserts a server-verified CSAM object's node ALREADY locked and calls the
  // lock right after. Until that call has run the node is hidden and held — and nothing else.
  describe("a node written locked, with no report", () => {
    /** A file as the upload route writes it: locked and held, nothing else done. */
    async function writtenLocked(db: Db = testDb()) {
      const owner = await makeUser();
      const sha256 = rand(32);
      // Inserted plain (committed), made locked through `db` — inside `alone` nobody else sees it.
      const file = await makeFile(owner.id, null, { scanStatus: "pending", sha256 });
      const link = await makeLink(file.id, owner.id);
      await db.insert(uploadIps).values({
        nodeId: file.id,
        versionId: file.versionId!,
        uploaderId: owner.id,
        ipEncrypted: new Uint8Array(20),
        iv: new Uint8Array(12),
        keyVersion: 1,
      });
      await db
        .update(nodes)
        .set({ scanStatus: "suspected_csam", legalHold: true })
        .where(eq(nodes.id, file.id));
      return { owner, file, link, sha256 };
    }
    async function expectCompleted(
      db: Db,
      made: Awaited<ReturnType<typeof writtenLocked>>,
      reportId: string,
    ) {
      const [ownerRow] = await db.select().from(user).where(eq(user.id, made.owner.id));
      expect(ownerRow).toMatchObject({ legalHold: true, suspendedAt: null });
      const [linkRow] = await db.select().from(shareLinks).where(eq(shareLinks.id, made.link.id));
      expect(linkRow!.pauseReasons).toEqual(["moderation"]);
      const ips = await db.select().from(uploadIps).where(eq(uploadIps.nodeId, made.file.id));
      expect(ips.map((row) => row.legalHold)).toEqual([true]);
      const [blocked] = await db.select().from(hashBlocklist).where(eq(hashBlocklist.sha256, made.sha256));
      expect(blocked).toMatchObject({ reason: "csam", sourceNodeId: made.file.id });
      expect(await db.select().from(reports).where(eq(reports.nodeId, made.file.id))).toMatchObject([
        { id: reportId, category: "csam", status: "open", ownerId: made.owner.id },
      ]);
    }

    it("one call does the whole job and is a FIRST lock: report, holds, pauses, one record, one alert; a repeat changes nothing", async () => {
      const made = await writtenLocked();
      expect(await csamLocksWithoutReport(testDb(), 1_000_000)).toContainEqual({ nodeId: made.file.id });
      const first = serviceDeps();
      const { reportId } = await lockSuspectedCsam(first.deps, made.file.id, { source: "system" });
      await first.settle();
      await expectCompleted(testDb(), made, reportId);
      expect(await lockRowsOf(made.file.id)).toMatchObject([{ meta: { source: "system", reportId } }]);
      expect((await lockRowsOf(made.file.id))[0]!.meta).not.toHaveProperty("recoveredBy");
      expect(await viaOf(made.file.id)).toEqual(["lock"]);
      expect(alertsFor(reportId)).toHaveLength(1);
      expect(await csamLocksWithoutReport(testDb(), 1_000_000)).not.toContainEqual({ nodeId: made.file.id });

      // The repeat: the same case, nothing new written, nobody told twice.
      const again = serviceDeps();
      expect(await lockSuspectedCsam(again.deps, made.file.id, { source: "system" })).toEqual({ reportId });
      await again.settle();
      expect(await lockRowsOf(made.file.id)).toHaveLength(1);
      expect(alertsFor(reportId)).toHaveLength(1);
      expect(await testDb().select().from(reports).where(eq(reports.nodeId, made.file.id))).toHaveLength(1);
    });

    it("the database half says so: alreadyLocked is false for the call that filed its report, true for the repeat", async () => {
      const made = await writtenLocked();
      expect(await lockRows(testDb(), made.file.id, { source: "system" })).toMatchObject({
        reportStatus: "open",
        alreadyLocked: false,
      });
      expect(await lockRows(testDb(), made.file.id, { source: "system" })).toMatchObject({
        reportStatus: "open",
        alreadyLocked: true,
      });
    });

    it("the call made to fail: the sweep completes it later — the whole job, one record marked recovered, exactly one alert", async () => {
      await alone(async ({ db, depsOn }) => {
        const made = await writtenLocked(db);
        // Older than every other node: the sweep's head is this one.
        await db
          .update(nodes)
          .set({ createdAt: new Date(Date.UTC(1990, 0, 1)) })
          .where(eq(nodes.id, made.file.id));
        const failing = depsOn();
        failing.deps.db = new Proxy(db, {
          get(target, property, receiver) {
            if (property === "transaction") {
              return () => Promise.reject(new Error("the database went away"));
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        await expect(lockSuspectedCsam(failing.deps, made.file.id, { source: "system" })).rejects.toThrow(
          "the database went away",
        );
        expect(await db.select().from(reports).where(eq(reports.nodeId, made.file.id))).toEqual([]);
        expect(await csamLocksWithoutReport(db, 1)).toEqual([{ nodeId: made.file.id }]);

        const sweep = depsOn();
        expect(await sweepUnrecordedCsamLocks(sweep.deps, { limit: 1 })).toEqual({
          checked: 1,
          completed: 1,
          failed: 0,
        });
        await sweep.settle();
        const [report] = await db.select().from(reports).where(eq(reports.nodeId, made.file.id));
        await expectCompleted(db, made, report!.id);
        expect(await auditIn(db, "scan.suspected_csam", made.file.id)).toMatchObject([
          { meta: { source: "system", reportId: report!.id, recoveredBy: "sweep" } },
        ]);
        expect(await viaIn(db, made.file.id)).toEqual(["sweep"]);
        expect(alertsFor(report!.id)).toHaveLength(1);

        // Completed: no longer due for this sweep, nor owed anything by the alert sweep.
        expect(await csamLocksWithoutReport(db, 1_000_000)).not.toContainEqual({ nodeId: made.file.id });
        await oldestFirst(db, [report!.id]);
        expect((await csamReportsToAnnounce(db, 1_000)).map((row) => row.reportId)).not.toContain(report!.id);
        const later = depsOn();
        await sweepUnrecordedCsamLocks(later.deps, { limit: 1 });
        await later.settle();
        expect(alertsFor(report!.id)).toHaveLength(1);
        expect(await auditIn(db, "scan.suspected_csam", made.file.id)).toHaveLength(1);
      });
    });

    it("one node that fails does not stop the rest: it is counted, captured, and found again next time", async () => {
      await alone(async ({ db, depsOn }) => {
        const broken = await writtenLocked(db);
        const fine = await writtenLocked(db);
        for (const [index, id] of [broken.file.id, fine.file.id].entries()) {
          await db
            .update(nodes)
            .set({ createdAt: new Date(Date.UTC(1990, 0, 1, 0, 0, index)) })
            .where(eq(nodes.id, id));
        }
        const sweep = depsOn();
        // The first lock's transaction fails; every later one goes through.
        let calls = 0;
        sweep.deps.db = new Proxy(db, {
          get(target, property, receiver) {
            if (property === "transaction" && calls++ === 0) {
              return () => Promise.reject(new Error("the database went away"));
            }
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
          },
        });
        expect(await sweepUnrecordedCsamLocks(sweep.deps, { limit: 2 })).toEqual({
          checked: 2,
          completed: 1,
          failed: 1,
        });
        await sweep.settle();
        expect(await db.select().from(reports).where(eq(reports.nodeId, broken.file.id))).toEqual([]);
        expect(await db.select().from(reports).where(eq(reports.nodeId, fine.file.id))).toHaveLength(1);
        expect(await csamLocksWithoutReport(db, 1)).toEqual([{ nodeId: broken.file.id }]);
      });
    });
  });

  it("ensureCsamAlerted for something that is not a report id does nothing", async () => {
    const { deps } = serviceDeps();
    for (const id of ["", "nope", "csam_alert:x", 7 as unknown as string]) {
      expect(await ensureCsamAlerted(deps, id)).toBe(false);
    }
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
