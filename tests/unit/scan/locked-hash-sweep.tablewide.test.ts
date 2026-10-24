// R2 mod-2: an admin's lock of a file still `pending` lists nothing (safety-1, ruling Q8: the
// hash goes on the blocklist once the server has computed it). If that file's scan then
// dead-letters — the scanner down for longer than the queue's ladder — every dead-letter branch,
// the pending-scan sweep and Rescan pass it by (it is not `pending` any more), and the hash would
// never be listed. The hourly job's `locked_hash_sweep` re-sends such a node's scan, forced and
// HASH-ONLY: the verdict on a locked node records the scan and lists the server's hash as the
// lock's entry (`listLockedOnScan`); it never unlocks, releases or serves anything.
//
// TABLE-WIDE: the sweep lists every quiet locked node with no server hash, so this file runs alone
// (third step of `npm test`). Its candidates are dated far in the past (1990) and deleted at the end.
import { env } from "cloudflare:workers";
import { eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { claim } from "../../../src/worker/db/queries/scan-jobs";
import { nodes, scanJobs } from "../../../src/worker/db/schema";
import { job, parts } from "../../../src/worker/jobs/abuse-hourly";
import { sweepLockedUnhashed } from "../../../src/worker/services/scanning";
import { admin, adminCall, blocklistRow, operators, userRowOf } from "../admin/helpers";
import { cronEvent, jobContext } from "../trash/helpers";
import {
  cleanBytes,
  deliver,
  makeFolder,
  makeUser,
  nodeById,
  r2Event,
  serviceDeps,
  sha256Of,
  testDb,
  uploadedFile,
} from "./helpers";

const LONG_AGO = new Date("1990-01-01T00:00:00.000Z");
const DLQ = "holdfast-scan-dev-dlq";
const made: string[] = [];
const originals = { ...parts };

afterEach(() => {
  Object.assign(parts, originals);
});
afterAll(async () => {
  if (made.length > 0) await testDb().delete(nodes).where(inArray(nodes.id, made));
});

type Sent = { v: 1; nodeId: string; key: string; force: boolean };
const mine = (sent: { nodeId: string }[], ids: string[]) => sent.filter((m) => ids.includes(m.nodeId));

/** Every part of the hourly job a no-op but the locked-hash sweep. */
function onlyLockedSweep() {
  parts.sweepCsamAlerts = async () => ({ checked: 0, alerted: 0, recorded: 0 });
  parts.sweepUnrecordedCsamLocks = async () => ({
    checked: 0,
    completed: 0,
    repeated: 0,
    skipped: 0,
    failed: 0,
  });
  parts.sweepOwedNodes = async () => ({
    checked: 0,
    locked: 0,
    refused: 0,
    stale: 0,
    skipped: 0,
    held: 0,
    failed: 0,
  });
  parts.sweepOwedDetections = async () => ({ checked: 0, preserved: 0, locked: 0, failed: 0 });
  parts.sweepStrikeThresholds = async () => ({ checked: 0, suspended: 0, failed: 0 });
  parts.sweepPendingScans = async () => ({ checked: 0, requeued: 0 });
  parts.reportAnomalies = async () => [];
}

/** Mallory's upload (V2's chain): bytes X declaring the hash of an innocent file. `pending`. */
async function mallorysUpload(extra: Record<string, unknown> = {}) {
  const innocent = await sha256Of(cleanBytes("innocent"));
  const bytes = cleanBytes("mallory");
  const { file, owner } = await uploadedFile(bytes, { declared: innocent, ...extra });
  made.push(file.id);
  return { file, owner, innocent, server: await sha256Of(bytes) };
}

async function lockFromNotice(nodeId: string) {
  const who = await admin();
  const sent: unknown[] = [];
  const answer = await adminCall(who.as, "POST", "/moderation/lock-csam", {
    body: { reference: nodeId, reason: "An outside tip.", confirm: true },
    env: { ...operators().env, SCAN_QUEUE: { send: async (m: unknown) => void sent.push(m) } },
  });
  expect(answer.status, answer.text).toBe(200);
  // Still waiting for its own scan: the lock sends none.
  expect(sent).toEqual([]);
}

/** The scanner down past every retry: the node's own message dead-letters (its job `failed`). */
async function deadLetter(file: { id: string; r2Key: string | null }) {
  await claim(testDb(), { nodeId: file.id, r2Key: file.r2Key! });
  await testDb()
    .update(scanJobs)
    .set({ status: "failed", lastError: "engine", startedAt: LONG_AGO, finishedAt: LONG_AGO })
    .where(eq(scanJobs.r2Key, file.r2Key!));
  expect(await deliver([{ body: r2Event(file.r2Key!) }], {}, DLQ)).toEqual([{ outcome: "ack" }]);
}

/** Quiet since 1990: the node's own times (the lock touched them) and its job's (the dead letter's). */
async function quietSince1990(file: { id: string; r2Key: string | null }) {
  await testDb().update(nodes).set({ createdAt: LONG_AGO, updatedAt: LONG_AGO }).where(eq(nodes.id, file.id));
  await testDb()
    .update(scanJobs)
    .set({ startedAt: LONG_AGO, finishedAt: LONG_AGO })
    .where(eq(scanJobs.r2Key, file.r2Key!));
}

function recording() {
  const sent: Sent[] = [];
  const service = serviceDeps();
  service.deps.env = {
    ...service.deps.env,
    SCAN_QUEUE: { send: async (message: Sent) => void sent.push(message) },
  } as unknown as Env;
  return { deps: service.deps, sent };
}

describe("a locked file whose scan dead-lettered still gets its server hash listed (R2 mod-2)", () => {
  it("lock while pending → its scan dead-letters (nothing listed, still locked) → the hourly job re-sends it forced → the verdict lists the SERVER's hash as the lock's entry; still locked and held; a second run sends nothing", async () => {
    onlyLockedSweep();
    const t = await mallorysUpload();
    await lockFromNotice(t.file.id);
    await deadLetter(t.file);
    expect(await nodeById(t.file.id)).toMatchObject({ scanStatus: "suspected_csam", scannedAt: null });
    expect(await blocklistRow(t.server)).toBeNull();
    expect(await blocklistRow(t.innocent)).toBeNull();
    await quietSince1990(t.file);

    const sent: Sent[] = [];
    const ops = `ops-${crypto.randomUUID()}@example.test`;
    const ctx = jobContext({
      env: {
        ADMIN_EMAILS: ops,
        E2E_ADMIN_EMAILS: "",
        SCAN_QUEUE: { send: async (m: Sent) => void sent.push(m) },
      },
    });
    await job.run(ctx.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
    await ctx.settle();
    expect(mine(sent, [t.file.id])).toEqual([{ v: 1, nodeId: t.file.id, key: t.file.r2Key, force: true }]);
    expect(ctx.metric.mock.calls).toContainEqual([
      "job",
      { kind: "abuse-hourly", outcome: "ok", reason: "locked_hash_sweep" },
      expect.any(Number),
    ]);

    expect(await deliver(mine(sent, [t.file.id]).map((body) => ({ body })))).toEqual([{ outcome: "ack" }]);
    const after = await nodeById(t.file.id);
    expect(after).toMatchObject({ scanStatus: "suspected_csam", sha256: t.server, legalHold: true });
    expect(after!.scannedAt).not.toBeNull();
    expect(await blocklistRow(t.server)).toMatchObject({ reason: "csam", sourceNodeId: t.file.id });
    expect(await blocklistRow(t.innocent)).toBeNull();
    expect((await userRowOf(t.owner.id))!.legalHold).toBe(true);

    const again = recording();
    await sweepLockedUnhashed(again.deps);
    expect(mine(again.sent, [t.file.id])).toEqual([]);
  });

  it("a locked unhashed file under a TAKEN-DOWN folder is sent too; one with a live job, one young, one already hashed, one the scanner refused, and a merely pending one are not", async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
    made.push(folder.id);
    const lockedRow = {
      scanStatus: "suspected_csam" as const,
      legalHold: true,
      createdAt: LONG_AGO,
      updatedAt: LONG_AGO,
    };
    const hidden = await mallorysUpload({ ...lockedRow, owner, parentId: folder.id });
    const running = await mallorysUpload(lockedRow);
    await claim(testDb(), { nodeId: running.file.id, r2Key: running.file.r2Key! });
    const young = await mallorysUpload({ scanStatus: "suspected_csam", legalHold: true });
    const hashed = await mallorysUpload({ ...lockedRow, scannedAt: LONG_AGO });
    const pending = await mallorysUpload({ createdAt: LONG_AGO, updatedAt: LONG_AGO });
    // The scanner REFUSED its body (the same body always gets the same answer): re-sent never.
    const refused = await mallorysUpload(lockedRow);
    await claim(testDb(), { nodeId: refused.file.id, r2Key: refused.file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "failed", lastError: "refused", startedAt: LONG_AGO, finishedAt: LONG_AGO })
      .where(eq(scanJobs.r2Key, refused.file.r2Key!));
    const ids = [hidden, running, young, hashed, pending, refused].map((x) => x.file.id);

    const run = recording();
    const result = await sweepLockedUnhashed(run.deps);
    expect(mine(run.sent, ids)).toEqual([
      { v: 1, nodeId: hidden.file.id, key: hidden.file.r2Key, force: true },
    ]);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    // Hash-only: nothing about any of them changed.
    for (const x of [hidden, running, young, hashed, pending, refused]) {
      expect(await nodeById(x.file.id), x.file.id).toEqual(x.file);
    }
  });
});
