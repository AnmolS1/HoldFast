// The consumer's own tables (T21 step 2a, 2b, 2e and the Wave-3 standing checks): resolve, claim,
// every scanner error, the deploy reset, a refusal, replace-during-scan and a purge mid-scan.
// The container helpers are wrapped (`scanObject` keeps its real body until a test scripts it);
// a test that scripts them turns the stub off (`SCAN_STUB: "0"`), so the adapter calls them.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_FILE_BYTES_DEFAULT,
  SCAN_CLAIM_STALE_MINUTES as SHARED_STALE,
} from "../../../src/shared/constants";
import { uuidv7 } from "../../../src/worker/db/ids";
import { claim, SCAN_CLAIM_STALE_MINUTES } from "../../../src/worker/db/queries/scan-jobs";
import { nodes, nodeVersions, scanJobs, user } from "../../../src/worker/db/schema";
import {
  SCAN_MAX_BYTES,
  scanObject,
  ScannerBusyError,
  ScannerNotReadyError,
  ScannerRefusedError,
  ScannerTransportError,
  type ShimVerdict,
} from "../../../src/worker/scan/container";
import {
  backoff,
  DEPLOY_RESET_MESSAGE,
  NO_NODE_RETRY_SEC,
  SCAN_BACKOFF_SEC,
  SCAN_MAX_RETRIES,
} from "../../../src/worker/scan/consumer";
import { captureError } from "../../../src/worker/sentry";
import { metric } from "../../../src/worker/services/metrics";
import { keyFor } from "../../../src/worker/services/storage";
import wranglerConfig from "../../../wrangler.jsonc?raw";
import {
  cleanBytes,
  deliver,
  enc,
  explicit,
  infectedBytes,
  jobsFor,
  listAs,
  mailTo,
  makeFile,
  makeUpload,
  makeUser,
  nodeById,
  putObject,
  r2Event,
  sha256Of,
  strikesOf,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/scan/container", async (original) => {
  const real = await original<typeof import("../../../src/worker/scan/container")>();
  return { ...real, scanObject: vi.fn(real.scanObject), scanSmall: vi.fn(real.scanSmall) };
});
vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn(real.metric) };
});
vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn(real.captureError) };
});

afterEach(() => {
  vi.mocked(scanObject).mockClear();
  vi.mocked(metric).mockClear();
  vi.mocked(captureError).mockClear();
});

const ack = [{ outcome: "ack" }];
const OFF = { SCAN_STUB: "0" };
const metricsOf = (name: string) =>
  vi
    .mocked(metric)
    .mock.calls.filter(([n]) => n === name)
    .map(([, tags]) => tags);

/** A shim verdict for `bytes` as the container would answer it. */
async function shim(bytes: Uint8Array, overrides: Partial<ShimVerdict> = {}): Promise<ShimVerdict> {
  return {
    status: "clean",
    signatures: [],
    pua: [],
    sha256: await sha256Of(bytes),
    bytes: bytes.length,
    engine: "ClamAV 1.5.4",
    dbVersion: "28160",
    dbAgeHours: 2,
    durationMs: 7,
    ...overrides,
  };
}

describe("the retry budget (a requirement, not a remark)", () => {
  it("the backoff over max_retries outlasts the 20-minute claim takeover; wrangler.jsonc agrees", () => {
    expect(SCAN_CLAIM_STALE_MINUTES).toBe(SHARED_STALE);
    expect(SCAN_BACKOFF_SEC).toEqual([30, 120, 300, 600, 900]);
    const total = Array.from({ length: SCAN_MAX_RETRIES }, (_, i) => backoff(i + 1)).reduce(
      (a, b) => a + b,
      0,
    );
    expect(total).toBeGreaterThan(SHARED_STALE * 60);
    expect(backoff(0)).toBe(30);
    expect(backoff(99)).toBe(900);
    // Both environments' main consumers: batch 1, concurrency 2, max_retries = SCAN_MAX_RETRIES.
    const consumers = [...wranglerConfig.matchAll(/\{\s*"queue":\s*"(holdfast-scan[^"]*)"([^}]*)\}/g)];
    const main = consumers.filter(([, name]) => !name!.endsWith("-dlq"));
    expect(main.map(([, name]) => name)).toEqual(["holdfast-scan-dev", "holdfast-scan"]);
    for (const [, , body] of main) {
      expect(body).toMatch(/"max_batch_size":\s*1\b/);
      expect(body).toMatch(new RegExp(`"max_retries":\\s*${SCAN_MAX_RETRIES}\\b`));
      expect(body).toMatch(/"max_concurrency":\s*2\b/);
    }
  });

  it("R2: the file cap never exceeds the scan cap, so the size guard stays unreachable in v1", () => {
    expect(MAX_FILE_BYTES_DEFAULT).toBeLessThanOrEqual(SCAN_MAX_BYTES);
  });
});

describe("resolve (step 2a)", () => {
  async function objectWithoutNode() {
    const owner = await makeUser();
    const upload = { ownerId: owner.id, nodeId: uuidv7(), versionId: uuidv7() };
    const key = keyFor(upload.ownerId, upload.nodeId, upload.versionId);
    await putObject(key, "bytes that arrived before their node");
    return { owner, key, ...upload };
  }

  it("the event before the row → retry in 10 s; superseded key → ack (orphan); aborted upload → ack (orphan); unknown key acked on the third attempt", async () => {
    const a = await objectWithoutNode();
    await makeUpload(a.owner.id, a.owner.id, {
      nodeId: a.nodeId,
      versionId: a.versionId,
      r2Key: a.key,
      status: "completing",
    });
    expect(await deliver([{ body: r2Event(a.key) }])).toEqual([
      { outcome: "retry", delaySeconds: NO_NODE_RETRY_SEC },
    ]);

    const b = await objectWithoutNode();
    const current = await makeFile(b.owner.id, null, { scanStatus: "clean" });
    await testDb()
      .insert(nodeVersions)
      .values({
        nodeId: current.id,
        versionId: b.versionId,
        r2Key: b.key,
        size: 10,
        purgeAfter: new Date(Date.now() + 86_400_000),
      });
    expect(await deliver([{ body: r2Event(b.key) }])).toEqual(ack);

    const c = await objectWithoutNode();
    await makeUpload(c.owner.id, c.owner.id, {
      nodeId: c.nodeId,
      versionId: c.versionId,
      r2Key: c.key,
      status: "aborted",
    });
    expect(await deliver([{ body: r2Event(c.key), attempts: 1 }])).toEqual(ack);

    const d = await objectWithoutNode();
    expect(await deliver([{ body: r2Event(d.key), attempts: 2 }])).toEqual([
      { outcome: "retry", delaySeconds: 10 },
    ]);
    expect(await deliver([{ body: r2Event(d.key), attempts: 3 }])).toEqual(ack);
    expect(metricsOf("scan").filter((t) => t?.outcome === "orphan")).toHaveLength(3);
    for (const key of [a.key, b.key, c.key, d.key]) {
      expect(await jobsFor(key)).toEqual([]);
      expect(await env.FILES.head(key)).not.toBeNull();
    }
  });

  it("an open upload's R2 event keeps retrying every 10 s until max_retries", async () => {
    const a = await objectWithoutNode();
    await makeUpload(a.owner.id, a.owner.id, {
      nodeId: a.nodeId,
      versionId: a.versionId,
      r2Key: a.key,
      status: "open",
    });
    for (let attempts = 1; attempts <= SCAN_MAX_RETRIES + 1; attempts++) {
      expect(await deliver([{ body: r2Event(a.key, "PutObject"), attempts }])).toEqual([
        { outcome: "retry", delaySeconds: 10 },
      ]);
    }
    // Past max_retries the queue moves it to the DLQ, which acks a key with no node silently.
    expect(await deliver([{ body: r2Event(a.key, "PutObject") }], {}, "holdfast-scan-dev-dlq")).toEqual(ack);
  });

  it("spike S8's order: the event first (no node) → retry; the node lands → the same event scans; the explicit message after → ack, one job, one set of effects", async () => {
    const owner = await makeUser();
    const nodeId = uuidv7();
    const versionId = uuidv7();
    const key = keyFor(owner.id, nodeId, versionId);
    const bytes = infectedBytes();
    await putObject(key, bytes);
    const session = await makeUpload(owner.id, owner.id, {
      nodeId,
      versionId,
      r2Key: key,
      status: "completing",
      size: bytes.length,
    });
    expect(await deliver([{ body: r2Event(key) }])).toEqual([{ outcome: "retry", delaySeconds: 10 }]);
    const declared = await sha256Of(bytes);
    await testDb().execute(
      sql`UPDATE uploads SET status = 'done', expected_sha256 = ${declared} WHERE id = ${session.id}`,
    );
    const file = await makeFile(owner.id, null, {
      id: nodeId,
      versionId,
      r2Key: key,
      sha256: declared,
      size: bytes.length,
    });
    expect(await deliver([{ body: r2Event(key), attempts: 2 }])).toEqual(ack);
    expect((await nodeById(file.id))!.scanStatus).toBe("infected");
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await jobsFor(key)).toMatchObject([{ status: "done", attempt: 1 }]);
    expect(await strikesOf(owner.id)).toHaveLength(1);
    expect(mailTo(owner.email, "quarantineNotice")).toHaveLength(1);
  });

  it("an R2 event for a node already suspected_csam (T12's blocklist path) leaves it so", async () => {
    const { file } = await uploadedFile(cleanBytes(), { scanStatus: "suspected_csam", legalHold: true });
    expect(await deliver([{ body: r2Event(file.r2Key!) }])).toEqual(ack);
    expect(await nodeById(file.id)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
  });
});

describe("claim (step 2b)", () => {
  it("fresh → claimed; duplicate while done → ack, no second effect; while running → retry with the backoff, not ack", async () => {
    const { file, owner } = await uploadedFile(infectedBytes());
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await strikesOf(owner.id)).toHaveLength(1);
    expect(mailTo(owner.email, "quarantineNotice")).toHaveLength(1);

    const other = await uploadedFile(cleanBytes());
    expect((await claim(testDb(), { nodeId: other.file.id, r2Key: other.file.r2Key! })).claimed).toBe(true);
    for (const attempts of [1, 2, 3, 4, 5]) {
      expect(await deliver([{ body: explicit(other.file), attempts }])).toEqual([
        { outcome: "retry", delaySeconds: backoff(attempts) },
      ]);
    }
    // force does not steal a live claim either.
    expect(await deliver([{ body: explicit(other.file, true) }])).toEqual([
      { outcome: "retry", delaySeconds: 30 },
    ]);
    expect((await nodeById(other.file.id))!.scanStatus).toBe("pending");
  });

  it("failed → reclaimed; stale running → taken over; force on done → rescanned", async () => {
    const a = await uploadedFile(cleanBytes());
    const claimed = await claim(testDb(), { nodeId: a.file.id, r2Key: a.file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "failed", lastError: "engine" })
      .where(eq(scanJobs.r2Key, a.file.r2Key!));
    expect(claimed.claimed).toBe(true);
    expect(await deliver([{ body: explicit(a.file) }])).toEqual(ack);
    expect(await jobsFor(a.file.r2Key!)).toMatchObject([{ status: "done", attempt: 2 }]);

    const b = await uploadedFile(cleanBytes());
    await claim(testDb(), { nodeId: b.file.id, r2Key: b.file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ startedAt: sql`now() - make_interval(mins => ${SCAN_CLAIM_STALE_MINUTES + 1})` })
      .where(eq(scanJobs.r2Key, b.file.r2Key!));
    expect(await deliver([{ body: explicit(b.file) }])).toEqual(ack);
    expect(await jobsFor(b.file.r2Key!)).toMatchObject([{ status: "done", attempt: 2 }]);
    expect((await nodeById(b.file.id))!.scanStatus).toBe("clean");

    await testDb().update(nodes).set({ scanStatus: "pending" }).where(eq(nodes.id, b.file.id));
    expect(await deliver([{ body: explicit(b.file, true) }])).toEqual(ack);
    expect(await jobsFor(b.file.r2Key!)).toMatchObject([{ status: "done", attempt: 3 }]);
    expect((await nodeById(b.file.id))!.scanStatus).toBe("clean");
  });
});

describe("scanner errors (step 2e): job failed, message retried with the delay for its attempt, node pending", () => {
  const cases: [string, () => Error, string, number][] = [
    ["not ready", () => new ScannerNotReadyError("signatures", 30, 30), "not_ready", 30],
    ["busy (an instance)", () => new ScannerBusyError(15), "busy", 15],
    [
      "busy (max_instances)",
      () => new ScannerBusyError(60, "no scanner instance could be started"),
      "busy",
      60,
    ],
    ["transport timeout", () => new ScannerTransportError("timeout", "no answer"), "timeout", 0],
    ["transport engine", () => new ScannerTransportError("engine", "scanner answered 502"), "engine", 0],
    [
      "a deploy's reset",
      () =>
        new ScannerTransportError("engine", "scanner call failed", {
          cause: new Error(DEPLOY_RESET_MESSAGE),
        }),
      "reset",
      0,
    ],
    [
      "a transport failure whose cause is not a reset",
      () =>
        new ScannerTransportError("engine", "scanner call failed", {
          cause: new Error("Network connection lost."),
        }),
      "engine",
      0,
    ],
  ];
  for (const [label, error, lastError, retryAfter] of cases) {
    it(label, async () => {
      const { file } = await uploadedFile(cleanBytes());
      for (const attempts of [1, 3]) {
        vi.mocked(scanObject).mockRejectedValueOnce(error());
        expect(await deliver([{ body: explicit(file), attempts }], OFF), label).toEqual([
          { outcome: "retry", delaySeconds: Math.max(backoff(attempts), retryAfter) },
        ]);
        expect(await jobsFor(file.r2Key!), label).toMatchObject([{ status: "failed", lastError }]);
        expect((await nodeById(file.id))!.scanStatus, label).toBe("pending");
      }
      expect(metricsOf("scan").filter((t) => t?.outcome === "retry" && t.reason === lastError)).toHaveLength(
        2,
      );
      // A later delivery scans the file.
      expect(await deliver([{ body: explicit(file), attempts: 4 }])).toEqual(ack);
      expect((await nodeById(file.id))!.scanStatus).toBe("clean");
    });
  }

  it("the reset is recognised on the CAUSE, never on the wrapper's message", async () => {
    const { file } = await uploadedFile(cleanBytes());
    vi.mocked(scanObject).mockRejectedValueOnce(new ScannerTransportError("engine", DEPLOY_RESET_MESSAGE));
    await deliver([{ body: explicit(file) }], OFF);
    expect((await jobsFor(file.r2Key!))[0]!.lastError).toBe("engine");
  });

  it("a verdict status error (MaxScanTime → timeout; a PUA match → engine) is retried, never written", async () => {
    for (const reason of ["timeout", "engine"] as const) {
      const bytes = cleanBytes();
      const { file } = await uploadedFile(bytes);
      vi.mocked(scanObject).mockResolvedValueOnce(await shim(bytes, { status: "error", reason }));
      expect(await deliver([{ body: explicit(file) }], OFF)).toEqual([
        { outcome: "retry", delaySeconds: 30 },
      ]);
      expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "failed", lastError: reason }]);
      expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    }
  });

  it("the stub's HF-STUB-NOT-READY marker: not_ready, retried, pending (no Docker needed)", async () => {
    const { file } = await uploadedFile(enc("HF-STUB-NOT-READY and nothing else"));
    expect(await deliver([{ body: explicit(file) }])).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "failed", lastError: "not_ready" }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
    expect(metricsOf("scan")).toContainEqual({ outcome: "retry", reason: "not_ready" });
    expect(vi.mocked(captureError)).not.toHaveBeenCalled();
  });

  it("the adapter's mapping reaches the node: limits_exceeded → skipped/limits, encrypted → skipped/encrypted, infected → infected", async () => {
    for (const [status, expected, reason] of [
      ["limits_exceeded", "skipped", "limits"],
      ["encrypted", "skipped", "encrypted"],
      ["infected", "infected", null],
    ] as const) {
      const bytes = cleanBytes(status);
      const { file } = await uploadedFile(bytes);
      vi.mocked(scanObject).mockResolvedValueOnce(
        await shim(bytes, { status, signatures: status === "infected" ? ["Win.Test.EICAR_HDB-1"] : [] }),
      );
      expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
      expect(await nodeById(file.id)).toMatchObject({
        scanStatus: expected,
        scanReason: reason,
        scanDetail: { engine: "ClamAV 1.5.4", dbVersion: "28160", durationMs: 7 },
      });
    }
  });

  it("R8: a refusal finishes the job failed/refused, the node error/engine (no scannedAt), a Sentry error — acked, not retried", async () => {
    const { file } = await uploadedFile(cleanBytes());
    vi.mocked(scanObject).mockRejectedValueOnce(new ScannerRefusedError(413, "too_large"));
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "failed", lastError: "refused" }]);
    expect(await nodeById(file.id)).toMatchObject({
      scanStatus: "error",
      scanReason: "engine",
      scannedAt: null,
      sha256: file.sha256,
    });
    expect(vi.mocked(captureError)).toHaveBeenCalledWith(
      expect.any(ScannerRefusedError),
      expect.objectContaining({ reason: "refused" }),
    );
    expect(metricsOf("scan")).toContainEqual({ outcome: "error", reason: "refused" });
  });

  it("production guard: SCAN_STUB=1 with SENTRY_ENVIRONMENT=production never uses the stub — nothing becomes clean", async () => {
    const { file } = await uploadedFile(cleanBytes());
    vi.mocked(scanObject).mockRejectedValueOnce(new ScannerTransportError("engine", "scanner call failed"));
    expect(
      await deliver([{ body: explicit(file) }], { SCAN_STUB: "1", SENTRY_ENVIRONMENT: "production" }),
    ).toEqual([{ outcome: "retry", delaySeconds: 30 }]);
    expect(vi.mocked(scanObject)).toHaveBeenCalledTimes(1);
    expect((await nodeById(file.id))!.scanStatus).toBe("pending");
  });
});

describe("during the scan", () => {
  it("replaced during the scan: nothing is written to the node, the job is done, the message acked", async () => {
    const bytes = cleanBytes();
    const { file, owner } = await uploadedFile(bytes);
    const newVersion = uuidv7();
    vi.mocked(scanObject).mockImplementationOnce(async () => {
      await testDb()
        .update(nodes)
        .set({ r2Key: keyFor(owner.id, file.id, newVersion), versionId: newVersion })
        .where(eq(nodes.id, file.id));
      return shim(bytes);
    });
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
    const row = (await nodeById(file.id))!;
    expect(row).toMatchObject({
      scanStatus: "pending",
      sha256: file.sha256,
      scannedAt: null,
      scanDetail: null,
    });
    expect(await jobsFor(file.r2Key!)).toMatchObject([{ status: "done" }]);
  });

  it("(a) the uploader suspended and the owner's purge removing the node mid-scan: nothing written, no strike, no mail, acked", async () => {
    const owner = await makeUser();
    const uploader = await makeUser();
    const bytes = infectedBytes();
    const { file } = await uploadedFile(bytes, { owner, uploader });
    vi.mocked(scanObject).mockImplementationOnce(async () => {
      await testDb().update(user).set({ suspendedAt: new Date() }).where(eq(user.id, uploader.id));
      await testDb().delete(nodes).where(eq(nodes.id, file.id));
      return shim(bytes, { status: "infected", signatures: ["Win.Test.EICAR_HDB-1"] });
    });
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
    expect(await nodeById(file.id)).toBeNull();
    expect(await strikesOf(uploader.id)).toHaveLength(0);
    expect(mailTo(owner.email)).toHaveLength(0);
    expect(mailTo(uploader.email)).toHaveLength(0);
  });

  it("(a) an uploader who is already suspended: addStrike's existing behaviour — the strike row, no second suspension mail", async () => {
    const uploader = await makeUser({ suspendedAt: new Date(), suspendedReason: "strikes" });
    const { file } = await uploadedFile(infectedBytes(), { owner: uploader });
    expect(await deliver([{ body: explicit(file) }])).toEqual(ack);
    expect(await strikesOf(uploader.id)).toHaveLength(1);
    expect(mailTo(uploader.email, "accountSuspended")).toHaveLength(0);
  });

  it("a csam-listed hash found by the scan on a pending node: locked, object kept", async () => {
    const bytes = cleanBytes();
    await listAs(await sha256Of(bytes), "csam");
    const { file } = await uploadedFile(bytes);
    vi.mocked(scanObject).mockResolvedValueOnce(await shim(bytes));
    expect(await deliver([{ body: explicit(file) }], OFF)).toEqual(ack);
    expect((await nodeById(file.id))!.scanStatus).toBe("suspected_csam");
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();
  });
});
