// OWEDLOCK round 4 (review item 3): the hourly pass over OWED PhotoDNA detections — recorded
// before a verdict transaction that never committed, never settled — so that nothing relies on a
// redelivery happening. TABLE-WIDE: the sweep takes every owed detection in the shared database.
// PhotoDNA is switched on for the delivery only, with a made-up key and a mocked Match API.
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { lockJob } from "../../../src/worker/db/queries/scan";
import { nodes } from "../../../src/worker/db/schema";
import { parts } from "../../../src/worker/jobs/abuse-hourly";
import { PHOTODNA_MATCH_URL } from "../../../src/worker/scan/photodna";
import { pngBytes } from "../../setup/fixture-bytes";
import { operators } from "../abuse/helpers";
import { jobContext } from "../trash/helpers";
import { userRow } from "../uploads/helpers";
import {
  auditRows,
  deliver,
  explicit,
  mailTo,
  makeUser,
  reportsOf,
  sha256Of,
  testDb,
  uploadedFile,
} from "./helpers";

vi.mock("../../../src/worker/db/queries/scan", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/scan")>();
  return { ...real, lockJob: vi.fn(real.lockJob) };
});

// A made-up key: the request never leaves the test (fetch is mocked).
const ON = { PHOTODNA_ENABLED: "true", PHOTODNA_SUBSCRIPTION_KEY: "made-up-photodna-test-key" };
const realFetch = globalThis.fetch;
let beforeAnswer: (() => Promise<void>) | null = null;
const HOURS = 3_600_000;

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
  vi.mocked(lockJob).mockClear();
});

const png = () => {
  const base = pngBytes(32, 32);
  const out = new Uint8Array(base.length + 16);
  out.set(base, 0);
  crypto.getRandomValues(out.subarray(base.length));
  return out;
};

/** A detection left OWED: the file deleted while PhotoDNA is asked, the verdict's transaction failing. */
async function owedDetection(ops: ReturnType<typeof operators>) {
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
  beforeAnswer = null;
  return { file, uploader, server };
}

describe("the hourly owed-detection sweep (abuse-hourly 0d)", () => {
  it("no redelivery ever comes: the sweep preserves the owed detection (locked node of the uploader's, reported, held), settles it, and a second run does nothing", async () => {
    const ops = operators();
    const { file, uploader, server } = await owedDetection(ops);
    const ctx = jobContext({ env: ops.env });

    // Younger than the sweep's age: left to its own deliveries.
    expect(await parts.sweepOwedDetections(ctx.bg, { limit: 1_000 })).toMatchObject({ preserved: 0 });

    const later = new Date(Date.now() + 3 * HOURS);
    const swept = await parts.sweepOwedDetections(ctx.bg, { limit: 1_000, now: later });
    await ctx.settle();
    expect(swept.preserved).toBeGreaterThanOrEqual(1);
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
    expect(await auditRows({ action: "scan.photodna_settled", targetId: file.r2Key! })).toHaveLength(1);

    await parts.sweepOwedDetections(ctx.bg, { limit: 1_000, now: later });
    await ctx.settle();
    expect(await testDb().select().from(nodes).where(eq(nodes.sha256, server))).toHaveLength(1);
  });

  it("the object gone too: the sweep records the detection (held audit row with the hash) and alerts the operators", async () => {
    const ops = operators();
    const { file, server } = await owedDetection(ops);
    const { env } = await import("cloudflare:workers");
    await env.FILES.delete(file.r2Key!);
    const ctx = jobContext({ env: ops.env });
    await parts.sweepOwedDetections(ctx.bg, { limit: 1_000, now: new Date(Date.now() + 3 * HOURS) });
    await ctx.settle();
    const recorded = await auditRows({ action: "scan.csam_detection_unpreserved", targetId: file.id });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.meta).toMatchObject({ sha256: server, reason: "object_gone", legalHold: true });
    expect(mailTo(ops.address)).toHaveLength(1);
  });
});
