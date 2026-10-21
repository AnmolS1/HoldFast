// The dead-letter consumer (T21 step 3), row by row, and the acceptance line "a scanner that
// reports not_ready leaves nodes pending, retries with backoff, and after the DLQ the node is
// error — never clean".
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claim, SCAN_CLAIM_STALE_MINUTES } from "../../../src/worker/db/queries/scan-jobs";
import { scanJobs } from "../../../src/worker/db/schema";
import { DLQ_RUNNING_RETRY_SEC, SCAN_MAX_RETRIES, backoff } from "../../../src/worker/scan/consumer";
import { captureError } from "../../../src/worker/sentry";
import { metric } from "../../../src/worker/services/metrics";
import { keyFor } from "../../../src/worker/services/storage";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  cleanBytes,
  deliver,
  enc,
  explicit,
  jobsFor,
  makeFolder,
  makeUser,
  nodeById,
  putObject,
  r2Event,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn(real.metric) };
});
vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn(real.captureError) };
});
afterEach(() => {
  vi.mocked(metric).mockClear();
  vi.mocked(captureError).mockClear();
});

const DLQ = "holdfast-scan-dev-dlq";
const ack = [{ outcome: "ack" }];
const dlqMetrics = () =>
  vi
    .mocked(metric)
    .mock.calls.filter(([name, tags]) => name === "scan" && tags?.outcome === "dlq")
    .map(([, tags]) => tags?.reason);
const sentryCalls = () => vi.mocked(captureError).mock.calls.length;

/** A job row for the file in this state. */
async function jobIn(
  file: { id: string; r2Key: string | null },
  state: Partial<typeof scanJobs.$inferInsert>,
) {
  await claim(testDb(), { nodeId: file.id, r2Key: file.r2Key! });
  if (Object.keys(state).length > 0) {
    await testDb().update(scanJobs).set(state).where(eq(scanJobs.r2Key, file.r2Key!));
  }
}

describe("the dead-letter table", () => {
  it("no node for the key: acked SILENTLY — the no_node metric, no Sentry error, no job row, nothing written", async () => {
    const owner = await makeUser();
    const key = keyFor(owner.id, uuidv7(), uuidv7());
    await putObject(key, "an abandoned single PUT");
    expect(await deliver([{ body: r2Event(key, "PutObject") }], {}, DLQ)).toEqual(ack);
    expect(dlqMetrics()).toEqual(["no_node"]);
    expect(sentryCalls()).toBe(0);
    expect(await jobsFor(key)).toEqual([]);
  });

  it("CONTROL: the same message with a pending node present raises the Sentry error and writes error", async () => {
    const { file } = await uploadedFile(cleanBytes());
    expect(await deliver([{ body: r2Event(file.r2Key!) }], {}, DLQ)).toEqual(ack);
    expect(dlqMetrics()).toEqual(["engine"]);
    expect(sentryCalls()).toBe(1);
    expect(vi.mocked(captureError).mock.calls[0]![1]).toMatchObject({ kind: "scan", key: file.r2Key });
    expect(await nodeById(file.id)).toMatchObject({
      scanStatus: "error",
      scanReason: "engine",
      scannedAt: null,
    });
  });

  it("done → ack, nothing changes", async () => {
    const { file } = await uploadedFile(cleanBytes());
    await deliver([{ body: explicit(file) }]);
    const before = await nodeById(file.id);
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
    expect(await nodeById(file.id)).toEqual(before);
    expect(sentryCalls()).toBe(0);
  });

  it("running, younger than 20 min → retry in 21 min; a stale running one → error", async () => {
    const { file } = await uploadedFile(cleanBytes());
    await jobIn(file, {});
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual([
      { outcome: "retry", delaySeconds: DLQ_RUNNING_RETRY_SEC },
    ]);
    expect(DLQ_RUNNING_RETRY_SEC).toBe((SCAN_CLAIM_STALE_MINUTES + 1) * 60);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    await testDb()
      .update(scanJobs)
      .set({ startedAt: sql`now() - make_interval(mins => ${SCAN_CLAIM_STALE_MINUTES + 1})` })
      .where(eq(scanJobs.r2Key, file.r2Key!));
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "error", scanReason: "engine" });
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "failed" }]);
  });

  it("failed with last error reset or busy, node pending: re-enqueued ONCE, stays pending, no Sentry error; a second arrival → error (no loop)", async () => {
    for (const lastError of ["reset", "busy"]) {
      const { file } = await uploadedFile(cleanBytes());
      await jobIn(file, { status: "failed", lastError });
      const sent: unknown[] = [];
      const queueSpy = { SCAN_QUEUE: { send: async (m: unknown) => void sent.push(m) } };
      expect(await deliver([{ body: explicit(file) }], queueSpy, DLQ), lastError).toEqual(ack);
      expect(sent, lastError).toEqual([{ v: 1, nodeId: file.id, key: file.r2Key, force: true }]);
      expect((await nodeById(file.id))!.scanStatus, lastError).toBe("pending");
      expect(dlqMetrics(), lastError).toEqual(["requeued"]);
      expect(sentryCalls(), lastError).toBe(0);
      expect((await jobsFor(file.r2Key!))[0]!.verdict, lastError).toMatchObject({ requeuedFromDlq: true });
      // The re-sent scan failed the same way and dead-lettered again.
      vi.mocked(metric).mockClear();
      expect(await deliver([{ body: explicit(file) }], queueSpy, DLQ), lastError).toEqual(ack);
      expect(sent, lastError).toHaveLength(1);
      expect(await nodeById(file.id), lastError).toMatchObject({ scanStatus: "error", scanReason: "engine" });
      expect(dlqMetrics(), lastError).toEqual(["engine"]);
      vi.mocked(metric).mockClear();
      vi.mocked(captureError).mockClear();
    }
  });

  it("CONTROL: failed with last error timeout → error/timeout at once, no re-enqueue", async () => {
    const { file } = await uploadedFile(cleanBytes());
    await jobIn(file, { status: "failed", lastError: "timeout" });
    const sent: unknown[] = [];
    expect(
      await deliver(
        [{ body: explicit(file) }],
        { SCAN_QUEUE: { send: async (m: unknown) => void sent.push(m) } },
        DLQ,
      ),
    ).toEqual(ack);
    expect(sent).toEqual([]);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "error", scanReason: "timeout" });
    expect(dlqMetrics()).toEqual(["timeout"]);
  });

  it("not_ready and busy map to engine; no job at all → engine", async () => {
    const a = await uploadedFile(cleanBytes());
    await jobIn(a.file, { status: "failed", lastError: "not_ready" });
    await deliver([{ body: explicit(a.file) }], {}, DLQ);
    expect((await nodeById(a.file.id))!.scanReason).toBe("engine");
    const b = await uploadedFile(cleanBytes());
    await deliver([{ body: explicit(b.file) }], {}, DLQ);
    expect((await nodeById(b.file.id))!.scanReason).toBe("engine");
    expect(await jobsFor(b.file.r2Key!)).toEqual([]);
  });

  it("a node that is suspected_csam, taken down (itself or by a folder above), or already settled keeps its status", async () => {
    const owner = await makeUser();
    const down = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
    for (const overrides of [
      { scanStatus: "suspected_csam" as const, legalHold: true },
      { takedownAt: new Date(), takedownReason: "dmca" as const },
      { parentId: down.id },
      { scanStatus: "clean" as const },
    ]) {
      const { file } = await uploadedFile(cleanBytes(), { owner, ...overrides });
      await jobIn(file, { status: "failed", lastError: "timeout" });
      expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
      expect((await nodeById(file.id))!.scanStatus, JSON.stringify(overrides)).toBe(file.scanStatus);
    }
  });
});

describe("acceptance: not_ready leaves the node pending, retries with backoff, and after the DLQ it is error — never clean", () => {
  it("every delivery up to max_retries, then the dead letter", async () => {
    const { file } = await uploadedFile(enc("HF-STUB-NOT-READY — the scanner never becomes ready"));
    for (let attempts = 1; attempts <= SCAN_MAX_RETRIES + 1; attempts++) {
      expect(await deliver([{ body: explicit(file), attempts }])).toEqual([
        { outcome: "retry", delaySeconds: Math.max(backoff(attempts), 30) },
      ]);
      expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    }
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
    const row = (await nodeById(file.id))!;
    expect(row).toMatchObject({ scanStatus: "error", scanReason: "engine" });
    expect(row.scanStatus).not.toBe("clean");
  });
});
