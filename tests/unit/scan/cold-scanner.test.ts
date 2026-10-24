// A cold scanner (R1 m17: perfops-1, safety-5, perfops-10). A container still loading clamd is
// waited out INSIDE the delivery — its health asked every few seconds — instead of the queue's
// 30 s / 2 min ladder; an outage longer than every retry leaves the file `pending` for the hourly
// sweep, never `error`; and a failure that is not the scanner's weather is reported to Sentry on a
// message's first delivery and at the dead letter, not on every retry.
import { createExecutionContext, createMessageBatch, getQueueResult } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { findByR2Key } from "../../../src/worker/db/queries/nodes";
import { claim } from "../../../src/worker/db/queries/scan-jobs";
import { scanJobs } from "../../../src/worker/db/schema";
import {
  scanObject,
  ScannerBusyError,
  ScannerNotReadyError,
  ScannerTransportError,
} from "../../../src/worker/scan/container";
import {
  backoff,
  queue,
  SCAN_MAX_RETRIES,
  SCANNER_COLD_WINDOW_MS,
  SCANNER_WAIT_MS,
  SCANNER_WAIT_POLL_MS,
  scannerWait,
} from "../../../src/worker/scan/consumer";
import { captureError } from "../../../src/worker/sentry";
import { metric } from "../../../src/worker/services/metrics";
import { runBackground } from "../../../src/worker/services/request-context";
import { realCore } from "../auth/helpers";
import {
  cleanBytes,
  deliver,
  enc,
  explicit,
  jobsFor,
  nodeById,
  rand,
  sha256Of,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/scan/container", async (original) => {
  const real = await original<typeof import("../../../src/worker/scan/container")>();
  return { ...real, scanObject: vi.fn(real.scanObject) };
});
vi.mock("../../../src/worker/db/queries/nodes", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/nodes")>();
  return { ...real, findByR2Key: vi.fn(real.findByR2Key) };
});
vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn(real.metric) };
});
vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn(real.captureError) };
});

const OFF = { SCAN_STUB: "0" };
const DLQ = "holdfast-scan-dev-dlq";
const ack = [{ outcome: "ack" }];
const real = { ...scannerWait };

/** A virtual clock for the wait, and a scripted health: `ready` answers in turn (the last repeats). */
let clock = 0;
let slept: number[] = [];
let asked = 0;
function healthSays(...answers: (boolean | Error)[]) {
  scannerWait.ready = async () => {
    const answer = answers[Math.min(asked++, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

beforeEach(() => {
  clock = 1_000_000;
  slept = [];
  asked = 0;
  scannerWait.now = () => clock;
  scannerWait.sleep = async (ms) => {
    slept.push(ms);
    clock += ms;
  };
  healthSays(true);
});
afterEach(() => {
  Object.assign(scannerWait, real);
  vi.mocked(scanObject).mockReset();
  vi.mocked(metric).mockClear();
  vi.mocked(captureError).mockClear();
});

const loading = () => new ScannerNotReadyError("clamd_loading", null, 30);

async function verdictFor(bytes: Uint8Array) {
  return {
    status: "clean" as const,
    signatures: [],
    pua: [],
    sha256: await sha256Of(bytes),
    bytes: bytes.length,
    engine: "ClamAV 1.5.4",
    dbVersion: "28160",
    dbAgeHours: 2,
    durationMs: 7,
  };
}

/** One delivery of a message first sent `ageMs` ago, on its `attempts`-th delivery. */
async function deliverAged(body: unknown, ageMs: number, attempts: number, queueName = "holdfast-scan-dev") {
  const runEnv = { ...env, ...OFF } as unknown as Env;
  const batch = createMessageBatch(queueName, [
    { id: `m-${rand()}`, timestamp: new Date(Date.now() - ageMs), body, attempts },
  ]);
  const ctx = createExecutionContext();
  await runBackground(runEnv, ctx, (bg) => queue(batch, runEnv, ctx, bg), realCore);
  return getQueueResult(batch, ctx);
}

describe("perfops-1: a container loading clamd is waited out in the delivery", () => {
  it("not ready, health not ready twice, then ready: the scan is sent again and the verdict lands — no queue retry", async () => {
    const bytes = cleanBytes();
    const { file } = await uploadedFile(bytes);
    vi.mocked(scanObject)
      .mockRejectedValueOnce(loading())
      .mockResolvedValueOnce(await verdictFor(bytes));
    healthSays(false, false, true);
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
    expect(vi.mocked(scanObject)).toHaveBeenCalledTimes(2);
    expect(asked).toBe(3);
    // Health is asked at once, then every SCANNER_WAIT_POLL_MS.
    expect(slept).toEqual([SCANNER_WAIT_POLL_MS, SCANNER_WAIT_POLL_MS]);
    // The second scan read the object again (the first one's body was spent): it is the real bytes'.
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done" }]);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("still loading after SCANNER_WAIT_MS: the queue's retry as before (job failed/not_ready, node pending)", async () => {
    const { file } = await uploadedFile(cleanBytes());
    vi.mocked(scanObject).mockRejectedValueOnce(loading());
    healthSays(false);
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual([
      { outcome: "retry", delaySeconds: Math.max(backoff(1), 30) },
    ]);
    expect(vi.mocked(scanObject)).toHaveBeenCalledTimes(1);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(SCANNER_WAIT_MS);
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "failed", lastError: "not_ready" }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
  });

  it("the wait stays far inside the claim takeover and the queue's first retry is no longer what a cold start costs", () => {
    expect(SCANNER_WAIT_MS).toBeLessThanOrEqual(180_000);
    expect(SCANNER_WAIT_POLL_MS).toBeLessThanOrEqual(5_000);
  });

  it("a health call that fails is asked again like a 'not yet' (the instance restarting): ready later, the verdict lands", async () => {
    const bytes = cleanBytes();
    const { file } = await uploadedFile(bytes);
    vi.mocked(scanObject)
      .mockRejectedValueOnce(loading())
      .mockResolvedValueOnce(await verdictFor(bytes));
    healthSays(new ScannerTransportError("engine", "scanner health call failed"), true);
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
    expect(asked).toBe(2);
    expect(slept).toEqual([SCANNER_WAIT_POLL_MS]);
  });

  it("health failing throughout: the wait runs out, then the queue's retry", async () => {
    const { file } = await uploadedFile(cleanBytes());
    vi.mocked(scanObject).mockRejectedValueOnce(loading());
    healthSays(new ScannerTransportError("engine", "scanner health call failed"));
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect(slept.reduce((a, b) => a + b, 0)).toBe(SCANNER_WAIT_MS);
  });

  it("CONTROL: stale signatures, busy and transport failures are not waited for (they are no cold start)", async () => {
    for (const error of [
      new ScannerNotReadyError("signatures", 30, 30),
      new ScannerBusyError(15),
      new ScannerTransportError("timeout", "no answer"),
    ]) {
      const { file } = await uploadedFile(cleanBytes());
      vi.mocked(scanObject).mockRejectedValueOnce(error);
      const [result] = await deliver([{ body: explicit(file) }], OFF);
      expect(result!.outcome, error.message).toBe("retry");
      expect(asked, error.message).toBe(0);
    }
  });

  it("CONTROL: a message older than SCANNER_COLD_WINDOW_MS is an outage, not a cold start — not waited for", async () => {
    const { file } = await uploadedFile(cleanBytes());
    vi.mocked(scanObject).mockRejectedValueOnce(loading());
    const result = await deliverAged(explicit(file), SCANNER_COLD_WINDOW_MS + 1_000, 3);
    expect(result.retryMessages).toHaveLength(1);
    expect(asked).toBe(0);
  });

  it("CONTROL: the stub scanner has no health to wait on: its not-ready marker is the queue's retry", async () => {
    const { file } = await uploadedFile(enc(`HF-STUB-NOT-READY ${rand()}`));
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect(asked).toBe(0);
  });
});

describe("safety-5: an outage longer than every retry leaves the file pending, never error", () => {
  async function failedWith(lastError: string, requeued: boolean) {
    const { file } = await uploadedFile(cleanBytes());
    await claim(testDb(), { nodeId: file.id, r2Key: file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "failed", lastError, verdict: requeued ? { requeuedFromDlq: true } : {} })
      .where(eq(scanJobs.r2Key, file.r2Key!));
    return file;
  }

  it("a not_ready dead letter is sent again once, like busy", async () => {
    const file = await failedWith("not_ready", false);
    const send = vi.spyOn(env.SCAN_QUEUE, "send");
    try {
      expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: file.r2Key, force: true }));
    } finally {
      send.mockRestore();
    }
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("a not_ready dead letter already sent again: the node stays pending (the hourly sweep sends it), no Sentry error", async () => {
    const file = await failedWith("not_ready", true);
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "pending", scanReason: null });
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "failed", lastError: "not_ready" }]);
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
    expect(vi.mocked(metric).mock.calls).toContainEqual([
      "scan",
      { outcome: "dlq", reason: "scanner_not_ready" },
    ]);
  });

  it("CONTROL: an engine dead letter still ends error/engine (one crafted file can cause it)", async () => {
    const file = await failedWith("engine", true);
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "error", scanReason: "engine" });
  });
});

describe("perfops-10: an unexpected failure is reported on the first delivery and at the dead letter only", () => {
  it("the database refusing six deliveries in a row: one Sentry error, then one for the dead letter", async () => {
    const { file } = await uploadedFile(cleanBytes());
    const refusal = () => new Error(`connection terminated unexpectedly ${rand()}`);
    for (let attempts = 1; attempts <= SCAN_MAX_RETRIES + 1; attempts++) {
      vi.mocked(scanObject).mockRejectedValueOnce(refusal());
      const result = await deliverAged(explicit(file), attempts * 60_000, attempts);
      expect(result.retryMessages).toHaveLength(1);
    }
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
    // Every retry is still counted (the metric is not the Sentry quota).
    expect(
      vi.mocked(metric).mock.calls.filter(([name, tags]) => name === "scan" && tags?.outcome === "retry"),
    ).toHaveLength(SCAN_MAX_RETRIES + 1);
    expect(await deliver([{ body: explicit(file) }], {}, DLQ)).toEqual(ack);
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(2);
  });

  it("a failure before the claim (the outer catch) follows the same rule", async () => {
    const { file } = await uploadedFile(cleanBytes());
    for (const attempts of [1, 2, 3]) {
      vi.mocked(findByR2Key).mockRejectedValueOnce(new Error(`connection terminated unexpectedly ${rand()}`));
      const result = await deliverAged(explicit(file), attempts * 60_000, attempts);
      expect(result.retryMessages).toHaveLength(1);
    }
    expect(vi.mocked(captureError)).toHaveBeenCalledTimes(1);
  });
});
