// The stub scan consumer. Two ways in: a real message on the local queue (delivery is
// asynchronous — the test polls the row), and `queue()` called directly with a constructed batch
// for every per-message branch.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { nodes, nodeVersions } from "../../../src/worker/db/schema";
import { enqueueScan } from "../../../src/worker/services/scanning";
import { keyFor } from "../../../src/worker/services/storage";
import { eicarBytes, pngBytes } from "../../setup/fixture-bytes";
import {
  deliver,
  eventually,
  jobsFor,
  makeFile,
  makeUpload,
  makeUser,
  nodeById,
  putObject,
  r2Event,
  serviceDeps,
  testDb,
} from "./helpers";

const MIME = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;
const explicit = (node: { id: string; r2Key: string | null }, force?: boolean) => ({
  v: 1,
  nodeId: node.id,
  key: node.r2Key,
  ...(force === undefined ? {} : { force }),
});

/** A pending file with its object in the store. */
async function pendingFile(bytes: Uint8Array | string, name = "notes.txt") {
  const owner = await makeUser();
  const file = await makeFile(owner.id, null, { name, scanStatus: "pending" });
  await putObject(file.r2Key!, bytes);
  return file;
}

describe("through the real local queue (SCAN_STUB=1)", () => {
  it("a pending file with an object becomes clean, with its detected type", async () => {
    const file = await pendingFile(pngBytes(16, 16), "picture.png");
    await enqueueScan(serviceDeps().deps, { nodeId: file.id, key: file.r2Key! });
    // `send()` has resolved; the consumer has not necessarily run. Wait for the row.
    const scanned = await eventually(async () => {
      const row = await nodeById(file.id);
      return row?.scanStatus === "pending" ? null : row;
    });
    expect(scanned).toMatchObject({
      scanStatus: "clean",
      mimeSniffed: "image/png",
      scanDetail: { engine: "stub" },
      scanReason: null,
    });
    expect(scanned.scannedAt).toBeInstanceOf(Date);
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done", attempt: 1, engine: "stub" }]);
  });

  it("the antivirus test file becomes infected", async () => {
    const file = await pendingFile(eicarBytes(), "eicar.com.txt");
    await env.SCAN_QUEUE.send({ v: 1, nodeId: file.id, key: file.r2Key });
    const scanned = await eventually(async () => {
      const row = await nodeById(file.id);
      return row?.scanStatus === "pending" ? null : row;
    });
    expect(scanned).toMatchObject({
      scanStatus: "infected",
      mimeSniffed: "text/plain",
      scanDetail: { engine: "stub", signatures: ["Stub.EICAR"] },
    });
  });
});

describe("queue() called directly", () => {
  it("scans the explicit message and the store's event alike", async () => {
    const a = await pendingFile("hello");
    expect(await deliver([{ body: explicit(a) }])).toEqual([{ outcome: "ack" }]);
    expect(await nodeById(a.id)).toMatchObject({ scanStatus: "clean", mimeSniffed: "text/plain" });

    const b = await pendingFile(eicarBytes());
    expect(await deliver([{ body: r2Event(b.r2Key!, "PutObject") }])).toEqual([{ outcome: "ack" }]);
    expect(await nodeById(b.id)).toMatchObject({ scanStatus: "infected" });
    // The event's eTag is recorded with the job, and nothing else is done with it.
    expect(await jobsFor(b.r2Key!)).toMatchObject([
      { status: "done", etag: "dce1c18393acbef2580b54a3b321765d-3", nodeId: b.id },
    ]);
  });

  it("stores the detected type as a MIME string, never a Promise", async () => {
    const cases: [string, Uint8Array | string, string][] = [
      ["a.pdf", "%PDF-1.4\n%%EOF\n", "application/pdf"],
      [
        "drawing.svg",
        '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
        "image/svg+xml",
      ],
      ["README.md", "# title\n", "text/markdown"],
      ["empty.bin", new Uint8Array(0), "application/octet-stream"],
    ];
    for (const [name, bytes, expected] of cases) {
      const file = await pendingFile(bytes, name);
      await deliver([{ body: explicit(file) }]);
      const row = await nodeById(file.id);
      // The control half: the same message DID write — the node left `pending`.
      expect(row!.scanStatus, name).toBe("clean");
      expect(row!.mimeSniffed, name).toBe(expected);
      expect(row!.mimeSniffed, name).toMatch(MIME);
      expect(row!.mimeSniffed, name).not.toContain("Promise");
    }
  });

  it("a duplicate delivery is acknowledged and there is one job", async () => {
    const file = await pendingFile("hello");
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "ack" }]);
    const first = await nodeById(file.id);
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "ack" }]);
    expect(await deliver([{ body: r2Event(file.r2Key!) }])).toEqual([{ outcome: "ack" }]);
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done", attempt: 1 }]);
    expect(await nodeById(file.id)).toEqual(first);
  });

  it("a job another delivery is running is retried, not acknowledged", async () => {
    const file = await pendingFile("hello");
    const { claim } = await import("../../../src/worker/db/queries/scan-jobs");
    expect((await claim(testDb(), { nodeId: file.id, r2Key: file.r2Key! })).claimed).toBe(true);
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
  });

  it("a message that names another node than the key's is acknowledged and scans nothing", async () => {
    const file = await pendingFile("hello");
    expect(await deliver([{ body: { v: 1, nodeId: uuidv7(), key: file.r2Key } }])).toEqual([
      { outcome: "ack" },
    ]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    expect(await jobsFor(file.r2Key!)).toEqual([]);
  });

  it("garbage and keys outside u/ are acknowledged, alone or beside a real message", async () => {
    expect(await deliver([{ body: { n: 1 } }, { body: "text" }, { body: null }])).toEqual([
      { outcome: "ack" },
      { outcome: "ack" },
      { outcome: "ack" },
    ]);
    const file = await pendingFile("hello");
    const outcome = await deliver([
      { body: r2Event("t/0199d3c2-7a10-7000-8000-0000000000a1/v/160.webp") },
      { body: explicit(file) },
      { body: { ...r2Event(file.r2Key!), action: "DeleteObject" } },
    ]);
    expect(outcome).toEqual([{ outcome: "ack" }, { outcome: "ack" }, { outcome: "ack" }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
  });
});

describe("resolving a key that has no node (the normal case on a deployed queue)", () => {
  async function objectWithoutNode() {
    const owner = await makeUser();
    const upload = { ownerId: owner.id, nodeId: uuidv7(), versionId: uuidv7() };
    const key = keyFor(upload.ownerId, upload.nodeId, upload.versionId);
    await putObject(key, "bytes that arrived before their node");
    return { owner, key, ...upload };
  }
  const stillThere = async (key: string) => (await env.FILES.head(key)) !== null;

  it("an upload session that is completing: retry in 10 s", async () => {
    const { owner, key, nodeId, versionId } = await objectWithoutNode();
    await makeUpload(owner.id, owner.id, { nodeId, versionId, r2Key: key, status: "completing" });
    expect(await deliver([{ body: r2Event(key) }])).toEqual([{ outcome: "retry", delaySeconds: 10 }]);
    // However often it has been delivered: the session is the reason to wait.
    expect(await deliver([{ body: r2Event(key), attempts: 5 }])).toEqual([
      { outcome: "retry", delaySeconds: 10 },
    ]);
    expect(await jobsFor(key)).toEqual([]);
    expect(await stillThere(key)).toBe(true);
  });

  it("an upload session that is still open (a single PUT landed before complete): retry in 10 s", async () => {
    const { owner, key, nodeId, versionId } = await objectWithoutNode();
    await makeUpload(owner.id, owner.id, { nodeId, versionId, r2Key: key, status: "open" });
    expect(await deliver([{ body: r2Event(key, "PutObject") }])).toEqual([
      { outcome: "retry", delaySeconds: 10 },
    ]);
    expect(await stillThere(key)).toBe(true);
  });

  it("a finished or aborted session is not a reason to wait", async () => {
    const { owner, key, nodeId, versionId } = await objectWithoutNode();
    await makeUpload(owner.id, owner.id, { nodeId, versionId, r2Key: key, status: "aborted" });
    expect(await deliver([{ body: r2Event(key), attempts: 3 }])).toEqual([{ outcome: "ack" }]);
    expect(await stillThere(key)).toBe(true);
  });

  it("a superseded version: acknowledged at once", async () => {
    const { owner, key, versionId } = await objectWithoutNode();
    const current = await makeFile(owner.id, null, { scanStatus: "clean" });
    await testDb()
      .insert(nodeVersions)
      .values({
        nodeId: current.id,
        versionId,
        r2Key: key,
        size: 10,
        purgeAfter: new Date(Date.now() + 86_400_000),
      });
    expect(await deliver([{ body: r2Event(key), attempts: 1 }])).toEqual([{ outcome: "ack" }]);
    expect(await jobsFor(key)).toEqual([]);
    expect(await nodeById(current.id)).toEqual(current);
    expect(await stillThere(key)).toBe(true);
  });

  it("a key nothing references: retried twice, acknowledged on the third attempt, never deleted", async () => {
    const { key } = await objectWithoutNode();
    expect(await deliver([{ body: r2Event(key), attempts: 1 }])).toEqual([
      { outcome: "retry", delaySeconds: 10 },
    ]);
    expect(await deliver([{ body: r2Event(key), attempts: 2 }])).toEqual([
      { outcome: "retry", delaySeconds: 10 },
    ]);
    expect(await deliver([{ body: r2Event(key), attempts: 3 }])).toEqual([{ outcome: "ack" }]);
    expect(await deliver([{ body: r2Event(key), attempts: 4 }])).toEqual([{ outcome: "ack" }]);
    expect(await jobsFor(key)).toEqual([]);
    expect(await stillThere(key)).toBe(true);
  });

  it("the deployed order: the store's event first, then the node and the explicit message, then the event again", async () => {
    const { owner, key, nodeId, versionId } = await objectWithoutNode();
    await makeUpload(owner.id, owner.id, { nodeId, versionId, r2Key: key, status: "completing" });
    // 1. The event is in the queue before the upload's request has inserted the node.
    expect(await deliver([{ body: r2Event(key) }])).toEqual([{ outcome: "retry", delaySeconds: 10 }]);
    // 2. The request commits the node and sends its own message, which scans it.
    const file = await makeFile(owner.id, null, { id: nodeId, versionId, r2Key: key, scanStatus: "pending" });
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "ack" }]);
    const scanned = await nodeById(nodeId);
    expect(scanned!.scanStatus).toBe("clean");
    // 3. The redelivered event finds the job done.
    expect(await deliver([{ body: r2Event(key), attempts: 2 }])).toEqual([{ outcome: "ack" }]);
    expect(await jobsFor(key)).toMatchObject([{ status: "done", attempt: 1 }]);
    expect(await nodeById(nodeId)).toEqual(scanned);
  });
});

describe("the verdict guard: only a node that is still pending and not taken down is written", () => {
  it("a suspected_csam, an under_review and a taken-down pending node keep every column", async () => {
    const owner = await makeUser();
    const locked = [
      await makeFile(owner.id, null, { scanStatus: "suspected_csam", legalHold: true }),
      await makeFile(owner.id, null, { scanStatus: "under_review", scanStatusPrev: "pending" }),
      await makeFile(owner.id, null, {
        scanStatus: "pending",
        takedownAt: new Date(),
        takedownReason: "dmca",
      }),
      await makeFile(owner.id, null, {
        scanStatus: "infected",
        scanDetail: { engine: "clamav" },
        mimeSniffed: "x/y",
      }),
      await makeFile(owner.id, null, {
        scanStatus: "clean",
        mimeSniffed: "image/jpeg",
        scannedAt: new Date(0),
      }),
    ];
    // The control: a pending node, same owner, same bytes, same message shape — it IS written.
    const control = await makeFile(owner.id, null, { scanStatus: "pending" });
    for (const node of [...locked, control]) await putObject(node.r2Key!, "harmless bytes");

    // T21 (task 2g): the record of what the scanner saw — server sha256, scanDetail, scannedAt,
    // mimeSniffed — is written on every verdict; what opens or closes access is not. An
    // `under_review` node keeps its status and gets the verdict as the status to restore.
    const SERVER_SHA = "0e9a93f09abe34a03dc3c32d0ab6edd02c2298466a8b774825aa69d1b693bbc7"; // sha256("harmless bytes")
    const access = (row: typeof control | null) => ({
      scanStatus: row?.scanStatus,
      scanReason: row?.scanReason,
      takedownAt: row?.takedownAt,
      takedownReason: row?.takedownReason,
      legalHold: row?.legalHold,
      deletedAt: row?.deletedAt,
      r2Key: row?.r2Key,
    });
    for (const before of locked) {
      const label = `${before.scanStatus}${before.takedownAt ? " (taken down)" : ""}`;
      const prevAfter = before.scanStatus === "under_review" ? "clean" : before.scanStatusPrev;
      expect(await deliver([{ body: r2Event(before.r2Key!) }]), label).toEqual([{ outcome: "ack" }]);
      const after = await nodeById(before.id);
      expect(access(after), label).toEqual(access(before));
      expect(after!.scanStatusPrev, label).toBe(prevAfter);
      expect(after!.sha256, label).toBe(SERVER_SHA);
      // The job is finished all the same, so the message is not redelivered for ever.
      expect(await jobsFor(before.r2Key!), label).toMatchObject([{ status: "done" }]);
      // And a forced explicit message does not get through either.
      expect(await deliver([{ body: explicit(before, true) }]), label).toEqual([{ outcome: "ack" }]);
      expect(access(await nodeById(before.id)), label).toEqual(access(before));
    }

    expect(await deliver([{ body: r2Event(control.r2Key!) }])).toEqual([{ outcome: "ack" }]);
    const written = await nodeById(control.id);
    expect(written).toMatchObject({ scanStatus: "clean", mimeSniffed: "text/plain" });
    expect(written).not.toEqual(control);
  });

  it("a node locked between the claim and the verdict is left alone (the guard reads the locked row)", async () => {
    // The antivirus test file: the stub would mark it infected. It is locked first.
    const file = await pendingFile(eicarBytes());
    await testDb()
      .update(nodes)
      .set({ scanStatus: "suspected_csam", legalHold: true })
      .where(eq(nodes.id, file.id));
    const before = await nodeById(file.id);
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "ack" }]);
    // T21 (task 2g): the status is never downgraded; the record (server hash, detail) is written.
    const after = await nodeById(file.id);
    expect(after).toMatchObject({
      scanStatus: "suspected_csam",
      scanReason: before!.scanReason,
      legalHold: true,
      takedownAt: before!.takedownAt,
    });
    expect(after!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("fail closed", () => {
  it("without SCAN_STUB=1 nothing is ever marked clean: the job fails and the message is retried with the backoff", async () => {
    const file = await pendingFile("perfectly harmless");
    const closed: Record<string, unknown>[] = [
      { SCAN_STUB: "0" },
      { SCAN_STUB: "" },
      { SCAN_STUB: undefined },
      { SCAN_STUB: "true" },
      { SCAN_STUB: "1", SENTRY_ENVIRONMENT: "production" },
      { SCAN_STUB: "0", SENTRY_ENVIRONMENT: "production" },
    ];
    // T21: with the stub off the container adapter runs. Here no SCANNER binding answers (the
    // binding is left out: "scanner unavailable"), and once through the real binding with
    // containers off (it throws a transport error): the job fails, the message is retried with
    // backoff(1) = 30 s, and the node stays exactly as it was.
    for (const vars of [...closed.map((v) => ({ ...v, SCANNER: undefined })), { SCAN_STUB: "0" }]) {
      for (const body of [explicit(file), r2Event(file.r2Key!)]) {
        expect(await deliver([{ body }], vars), JSON.stringify(vars)).toEqual([
          { outcome: "retry", delaySeconds: 30 },
        ]);
        if ("SCANNER" in vars) continue;
        break; // the real binding takes seconds to refuse: once is enough
      }
      expect(await nodeById(file.id), JSON.stringify(vars)).toEqual(file);
      expect(await jobsFor(file.r2Key!), JSON.stringify(vars)).toMatchObject([{ status: "failed" }]);
    }
    // The control: the very same message with the stub on scans it.
    expect(await deliver([{ body: explicit(file) }], { SCAN_STUB: "1", SENTRY_ENVIRONMENT: "dev" })).toEqual([
      { outcome: "ack" },
    ]);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
  });

  it("dead letters are acknowledged whatever the stub flag says, and end a pending node error — never clean (T21 step 3)", async () => {
    const file = await pendingFile("harmless");
    for (const vars of [{ SCAN_STUB: "0" }, { SCAN_STUB: "1" }]) {
      expect(
        await deliver([{ body: explicit(file) }, { body: { n: 1 } }], vars, "holdfast-scan-dev-dlq"),
      ).toEqual([{ outcome: "ack" }, { outcome: "ack" }]);
      // Nothing scanned it: no job, and the node — pending, no job — is `error`, not `clean`.
      expect(await nodeById(file.id), JSON.stringify(vars)).toMatchObject({
        scanStatus: "error",
        scanReason: "engine",
        sha256: file.sha256,
        scannedAt: null,
      });
    }
    expect(await jobsFor(file.r2Key!)).toEqual([]);
  });
});

describe("failure", () => {
  it("marks the job failed and retries; the retry then succeeds", async () => {
    const owner = await makeUser();
    const file = await makeFile(owner.id, null, { scanStatus: "pending" });
    // No object yet: reading it fails.
    // T21: the retry waits backoff(attempts) — 30 s on the first delivery.
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect(await jobsFor(file.r2Key!)).toMatchObject([
      { status: "failed", attempt: 1, lastError: "scan: the object is gone" },
    ]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");

    await putObject(file.r2Key!, "now it is there");
    expect(await deliver([{ body: explicit(file), attempts: 2 }])).toEqual([{ outcome: "ack" }]);
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done", attempt: 2, lastError: null }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
  });
});
