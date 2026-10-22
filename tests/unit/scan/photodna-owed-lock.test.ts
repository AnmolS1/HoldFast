// OWEDLOCK, the file path: PhotoDNA runs on a FILE in the scan consumer, after its node exists.
// "The node write that fails" there is the lock itself — the shared handler that makes the node
// `suspected_csam` after the verdict's transaction committed. The verdict's transaction lists the
// SERVER hash `csam` the way the lock does (`listSuspectedCsam`, `sourceNodeId` the node) before
// that, so a redelivery on which PhotoDNA does not answer a match (switched off, skipped, down)
// still ends the file LOCKED — held, reported, the object kept — never clean. And when the lock
// keeps failing until the message dead-letters, the dead letter runs the lock — never `error`.
// PhotoDNA is switched on for the first delivery only, with a made-up key and a mocked Match API.
import { env } from "cloudflare:workers";
import { and, eq, ne } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { clearSuspectedCsam } from "../../../src/worker/db/queries/moderation";
import { nodes } from "../../../src/worker/db/schema";
import { PHOTODNA_MATCH_URL } from "../../../src/worker/scan/photodna";
import { lockJob } from "../../../src/worker/db/queries/scan";
import { lockOwnerTree } from "../../../src/worker/db/queries/tree";
import { keyFor } from "../../../src/worker/services/storage";
import { uuidv7 } from "../../../src/worker/db/ids";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { pngBytes } from "../../setup/fixture-bytes";
import { operators } from "../abuse/helpers";
import { userRow } from "../uploads/helpers";
import {
  auditRows,
  deliver,
  explicit,
  mailTo,
  makeUser,
  nodeById,
  reportsOf,
  sha256Of,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/db/queries/scan", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/scan")>();
  return { ...real, lockJob: vi.fn(real.lockJob) };
});
vi.mock("../../../src/worker/db/queries/tree", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/tree")>();
  return { ...real, lockOwnerTree: vi.fn(real.lockOwnerTree) };
});
vi.mock("../../../src/worker/services/scanning", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/scanning")>();
  return { ...real, lockSuspectedCsam: vi.fn(real.lockSuspectedCsam) };
});

// A made-up key: the request never leaves the test (fetch is mocked).
const ON = { PHOTODNA_ENABLED: "true", PHOTODNA_SUBSCRIPTION_KEY: "made-up-photodna-test-key" };
const realFetch = globalThis.fetch;
const DLQ = "holdfast-scan-dev-dlq";
/** Run when the Match API is asked — after the object was read, before the verdict is applied. */
let beforeAnswer: (() => Promise<void>) | null = null;

beforeEach(() => {
  beforeAnswer = null;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(PHOTODNA_MATCH_URL)) return realFetch(input, init);
    if (beforeAnswer) await beforeAnswer();
    return Response.json({ Status: { Code: 3000, Description: "OK" }, IsMatch: true });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(lockSuspectedCsam).mockClear();
  vi.mocked(lockJob).mockClear();
  vi.mocked(lockOwnerTree).mockClear();
});

/** The real shared handler, for a mock that does something first and then locks. */
const realScanning = () =>
  vi.importActual<typeof import("../../../src/worker/services/scanning")>(
    "../../../src/worker/services/scanning",
  );

/** The one node with these bytes that the uploader is on record for: the preserved one. */
const preservedOf = async (server: string, uploaderId: string, originalId?: string) =>
  testDb()
    .select()
    .from(nodes)
    .where(
      and(
        eq(nodes.sha256, server),
        eq(nodes.createdBy, uploaderId),
        originalId === undefined ? undefined : ne(nodes.id, originalId),
      ),
    );

/** A PNG with bytes of its own after its end: a match lists its hash, so it is unique per test. */
const png = () => {
  const base = pngBytes(32, 32);
  const out = new Uint8Array(base.length + 16);
  out.set(base, 0);
  crypto.getRandomValues(out.subarray(base.length));
  return out;
};

describe("a PhotoDNA-matched file whose lock fails", () => {
  it("is listed csam before the verdict's transaction; the redelivery — PhotoDNA off — LOCKS it (held, reported, object kept), and a false-positive clear unlists it", async () => {
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file, owner } = await uploadedFile(bytes, { name: "p.png" });

    // Delivery 1: PhotoDNA matches; the lock (the write that makes the node suspected_csam) fails.
    vi.mocked(lockSuspectedCsam).mockRejectedValueOnce(new Error("test: the lock cannot be written"));
    expect(await deliver([{ body: explicit(file) }], ON)).toMatchObject([{ outcome: "retry" }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "pending", legalHold: false });
    // Listed before the lock — the entry the lock itself writes, naming the node.
    expect(await blocklist.lookup(testDb(), server)).toEqual({ reason: "csam", sourceNodeId: file.id });

    // Delivery 2: PhotoDNA does not answer a match (here: switched off). The list decides.
    expect(await deliver([{ body: explicit(file), attempts: 2 }])).toEqual([{ outcome: "ack" }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await reportsOf(file.id)).toMatchObject([{ category: "csam", status: "open" }]);
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true });
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();

    // A false positive: the clear takes the hash off the list — the entry is the lock's own.
    const cleared = await testDb().transaction((tx) => clearSuspectedCsam(tx, file.id));
    expect(cleared).toMatchObject({ cleared: true, blocklistRemoved: true, blocklistKept: null });
    expect(await blocklist.lookup(testDb(), server)).toBeNull();
  });

  it("whose lock fails on EVERY delivery until it dead-letters: the dead letter finds the verified hash listed csam and runs the lock — never `error`; a lock that fails there too is retried, the node left pending", async () => {
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file, owner } = await uploadedFile(bytes, { name: "p.png" });

    // The last delivery: PhotoDNA matches, the lock fails. The job ends `failed`; the queue then
    // hands the message to the dead-letter queue.
    vi.mocked(lockSuspectedCsam).mockRejectedValueOnce(new Error("test: the lock cannot be written"));
    expect(await deliver([{ body: explicit(file), attempts: 6 }], ON)).toMatchObject([{ outcome: "retry" }]);
    expect(await blocklist.lookup(testDb(), server)).toEqual({ reason: "csam", sourceNodeId: file.id });

    // The dead letter, the lock failing there too: retried — the node is NOT ended `error`.
    vi.mocked(lockSuspectedCsam).mockRejectedValueOnce(new Error("test: the lock cannot be written"));
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toMatchObject([{ outcome: "retry" }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "pending", legalHold: false });

    // The dead letter again: the lock runs.
    expect(await deliver([{ body: explicit(file), attempts: 2 }], {}, DLQ)).toEqual([{ outcome: "ack" }]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await reportsOf(file.id)).toMatchObject([{ category: "csam", status: "open" }]);
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true });
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();
  });
});

describe("a PhotoDNA match on a file deleted before its verdict (the key is no longer a node's)", () => {
  it("the object still there: the bytes are COPIED to a key of their own and become a locked node of the UPLOADER's — held, reported (photodna), the hash listed naming it; a false-positive clear unlists it", async () => {
    const ops = operators();
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file } = await uploadedFile(bytes, { name: "p.png", owner, uploader });
    // The owner's purge commits while PhotoDNA is asked: the row goes, the object is still there
    // (the purge deletes it after its commit).
    beforeAnswer = async () => {
      await testDb().delete(nodes).where(eq(nodes.id, file.id));
    };
    expect(await deliver([{ body: explicit(file) }], { ...ON, ...ops.env })).toEqual([{ outcome: "ack" }]);
    expect(await nodeById(file.id)).toBeNull();

    const preserved = await testDb()
      .select()
      .from(nodes)
      .where(and(eq(nodes.sha256, server), eq(nodes.createdBy, uploader.id)));
    expect(preserved).toHaveLength(1);
    const node = preserved[0]!;
    expect(node).toMatchObject({
      ownerId: uploader.id,
      parentId: null,
      kind: "file",
      name: "p.png",
      scanStatus: "suspected_csam",
      legalHold: true,
    });
    expect(node.r2Key).not.toBe(file.r2Key);
    // The copy is the matched bytes.
    const copy = await env.FILES.get(node.r2Key!);
    expect(await sha256Of(new Uint8Array(await copy!.arrayBuffer()))).toBe(server);
    expect(await reportsOf(node.id)).toMatchObject([
      { category: "csam", source: "photodna", status: "open" },
    ]);
    expect(await userRow(uploader.id)).toMatchObject({ legalHold: true });
    expect(await blocklist.lookup(testDb(), server)).toEqual({ reason: "csam", sourceNodeId: node.id });
    expect(await auditRows({ action: "scan.csam_preserved", targetId: node.id })).toHaveLength(1);

    const cleared = await testDb().transaction((tx) => clearSuspectedCsam(tx, node.id));
    expect(cleared).toMatchObject({ cleared: true, blocklistRemoved: true, blocklistKept: null });
  });

  it("the object gone too: the listing stands, an audit row held from retention records the detection with its hash, and the operators get the critical alert — never a silent drop", async () => {
    const ops = operators();
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file, uploader } = await uploadedFile(bytes, { name: "p.png" });
    beforeAnswer = async () => {
      await testDb().delete(nodes).where(eq(nodes.id, file.id));
      await env.FILES.delete(file.r2Key!);
    };
    expect(await deliver([{ body: explicit(file) }], { ...ON, ...ops.env })).toEqual([{ outcome: "ack" }]);

    expect(await testDb().select().from(nodes).where(eq(nodes.sha256, server))).toHaveLength(0);
    expect((await blocklist.lookup(testDb(), server))?.reason).toBe("csam");
    const recorded = await auditRows({ action: "scan.csam_detection_unpreserved", targetId: file.id });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.meta).toMatchObject({
      sha256: server,
      source: "photodna",
      reason: "object_gone",
      uploaderId: uploader.id,
      legalHold: true,
    });
    expect(mailTo(ops.address)).toHaveLength(1);
  });

  it("the gone branch's own transaction fails: the detection was made durable BEFORE it (listed + held audit row), so the redelivery that finds no node preserves it — never acked as an orphan; a later one finds it settled", async () => {
    const ops = operators();
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file } = await uploadedFile(bytes, { name: "p.png", owner, uploader });
    beforeAnswer = async () => {
      await testDb().delete(nodes).where(eq(nodes.id, file.id));
    };
    vi.mocked(lockJob).mockRejectedValueOnce(new Error("test: the verdict's transaction fails"));
    expect(await deliver([{ body: explicit(file) }], { ...ON, ...ops.env })).toMatchObject([
      { outcome: "retry" },
    ]);
    // Durable already: listed, and the detection's held audit row.
    expect((await blocklist.lookup(testDb(), server))?.reason).toBe("csam");
    const detection = await auditRows({ action: "scan.photodna_detection", targetId: file.r2Key! });
    expect(detection).toHaveLength(1);
    expect(detection[0]!.meta).toMatchObject({ sha256: server, uploaderId: uploader.id, legalHold: true });

    // The redelivery — at the attempt where a key with no node is given up on as an orphan.
    beforeAnswer = null;
    expect(await deliver([{ body: explicit(file), attempts: 3 }], { ...ON, ...ops.env })).toEqual([
      { outcome: "ack" },
    ]);
    const preserved = await testDb()
      .select()
      .from(nodes)
      .where(and(eq(nodes.sha256, server), eq(nodes.createdBy, uploader.id)));
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatchObject({
      ownerId: uploader.id,
      scanStatus: "suspected_csam",
      legalHold: true,
    });
    expect(await reportsOf(preserved[0]!.id)).toMatchObject([{ category: "csam", source: "photodna" }]);
    expect(await userRow(uploader.id)).toMatchObject({ legalHold: true });
    expect(await blocklist.lookup(testDb(), server)).toEqual({
      reason: "csam",
      sourceNodeId: preserved[0]!.id,
    });

    // Settled: one more redelivery preserves nothing twice.
    expect(await deliver([{ body: explicit(file), attempts: 3 }], { ...ON, ...ops.env })).toEqual([
      { outcome: "ack" },
    ]);
    expect(await testDb().select().from(nodes).where(eq(nodes.sha256, server))).toHaveLength(1);
  });

  it("REVIEW 1 — the file purged between the verdict's commit and its lock (the lock answers not_found): the detection goes back to the caller and the bytes are preserved, never `gone` without it", async () => {
    const ops = operators();
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file } = await uploadedFile(bytes, { name: "p.png", owner, uploader });
    vi.mocked(lockSuspectedCsam).mockImplementationOnce(async (...args) => {
      await testDb().delete(nodes).where(eq(nodes.id, file.id));
      return (await realScanning()).lockSuspectedCsam(...args);
    });
    expect(await deliver([{ body: explicit(file) }], { ...ON, ...ops.env })).toEqual([{ outcome: "ack" }]);
    const preserved = await preservedOf(server, uploader.id);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await reportsOf(preserved[0]!.id)).toMatchObject([{ category: "csam", source: "photodna" }]);
    expect(await auditRows({ action: "scan.photodna_settled", targetId: file.r2Key! })).toHaveLength(1);
  });

  it("REVIEW 2 — the file replaced between any earlier read and the verdict's transaction: the bytes are preserved under a FRESH node id, the original id recorded, and the listing re-pointed at the node actually preserved", async () => {
    const ops = operators();
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file } = await uploadedFile(bytes, { name: "p.png", owner, uploader });
    // Just before the verdict's transaction takes its first lock: the file gets another version.
    const newVersion = uuidv7();
    vi.mocked(lockOwnerTree).mockImplementationOnce(async (tx, ownerId) => {
      await testDb()
        .update(nodes)
        .set({ r2Key: keyFor(owner.id, file.id, newVersion), versionId: newVersion })
        .where(eq(nodes.id, file.id));
      const real = await vi.importActual<typeof import("../../../src/worker/db/queries/tree")>(
        "../../../src/worker/db/queries/tree",
      );
      return real.lockOwnerTree(tx, ownerId);
    });
    expect(await deliver([{ body: explicit(file) }], { ...ON, ...ops.env })).toEqual([{ outcome: "ack" }]);
    const preserved = await preservedOf(server, uploader.id, file.id);
    expect(preserved).toHaveLength(1);
    const node = preserved[0]!;
    expect(node.id).not.toBe(file.id);
    expect(node).toMatchObject({ ownerId: uploader.id, scanStatus: "suspected_csam", legalHold: true });
    // The original file — another version now — is not locked.
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "pending", legalHold: false });
    expect(await blocklist.lookup(testDb(), server)).toEqual({ reason: "csam", sourceNodeId: node.id });
    const record = await auditRows({ action: "scan.csam_preserved", targetId: node.id });
    expect(record).toHaveLength(1);
    expect(record[0]!.meta).toMatchObject({ fromNodeId: file.id });
    const cleared = await testDb().transaction((tx) => clearSuspectedCsam(tx, node.id));
    expect(cleared).toMatchObject({ cleared: true, blocklistRemoved: true });
  });

  it("REVIEW 3 — an owed detection reaching the DEAD-LETTER queue on a key with no node: preserved there, never acked as no_node", async () => {
    const ops = operators();
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = png();
    const server = await sha256Of(bytes);
    const { file } = await uploadedFile(bytes, { name: "p.png", owner, uploader });
    beforeAnswer = async () => {
      await testDb().delete(nodes).where(eq(nodes.id, file.id));
    };
    vi.mocked(lockJob).mockRejectedValueOnce(new Error("test: the verdict's transaction fails"));
    expect(await deliver([{ body: explicit(file) }], { ...ON, ...ops.env })).toMatchObject([
      { outcome: "retry" },
    ]);
    expect(await deliver([{ body: explicit(file) }], ops.env, DLQ)).toEqual([{ outcome: "ack" }]);
    const preserved = await preservedOf(server, uploader.id);
    expect(preserved).toHaveLength(1);
    expect(preserved[0]).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await auditRows({ action: "scan.photodna_settled", targetId: file.r2Key! })).toHaveLength(1);
  });
});
