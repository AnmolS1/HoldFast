// `sweepPendingScans` (T21 step 5) and its wiring into abuse-hourly (R4). TABLE-WIDE: the sweep
// lists every quiet `pending` node, so this file runs alone (third step of `npm test`).
//
// Rows other runs left behind are still in the database. This file's candidates are dated far in
// the past (1990), so the oldest-first sweep reaches them before any leftover, and every node it
// made is deleted again when the file ends.
import { env } from "cloudflare:workers";
import { inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { claim } from "../../../src/worker/db/queries/scan-jobs";
import { nodes, scanJobs } from "../../../src/worker/db/schema";
import { ABUSE_HOURLY_LIMITS, job, parts } from "../../../src/worker/jobs/abuse-hourly";
import {
  PENDING_SCAN_SWEEP_DEFAULT_LIMIT,
  PENDING_SCAN_SWEEP_MINUTES,
  sweepPendingScans,
} from "../../../src/worker/services/scanning";
import { cronEvent, jobContext } from "../trash/helpers";
import {
  cleanBytes,
  deliver,
  infectedBytes,
  jobsFor,
  mailTo,
  makeFolder,
  makeUser,
  nodeById,
  serviceDeps,
  strikesOf,
  testDb,
  uploadedFile,
} from "./helpers";

const LONG_AGO = new Date("1990-01-01T00:00:00.000Z");
const made: string[] = [];
const originals = { ...parts };

afterEach(() => {
  Object.assign(parts, originals);
});
afterAll(async () => {
  if (made.length > 0) await testDb().delete(nodes).where(inArray(nodes.id, made));
});

type Sent = { v: 1; nodeId: string; key: string; force: boolean };

/** Deps whose queue records each send — and throws for the node ids in `failing`. */
function recording(failing: Set<string> = new Set()) {
  const sent: Sent[] = [];
  const attempts: string[] = [];
  const service = serviceDeps();
  service.deps.env = {
    ...service.deps.env,
    SCAN_QUEUE: {
      send: async (message: Sent) => {
        attempts.push(message.nodeId);
        if (failing.has(message.nodeId)) throw new Error("queue send failed");
        sent.push(message);
      },
    },
  } as unknown as Env;
  return { deps: service.deps, sent, attempts };
}

/** A pending file quiet since `since` (its node's times and no job). */
async function quiet(bytes = cleanBytes(), since = LONG_AGO, overrides: Record<string, unknown> = {}) {
  const { file, owner } = await uploadedFile(bytes, { createdAt: since, updatedAt: since, ...overrides });
  made.push(file.id);
  return { file, owner };
}

const mine = (sent: { nodeId: string }[], ids: string[]) => sent.filter((m) => ids.includes(m.nodeId));

describe("sweepPendingScans", () => {
  it("a pending node with no job, quiet > 30 min → re-sent, forced; 29 min, a live job, clean, taken down (itself or by a folder) → untouched", async () => {
    expect(PENDING_SCAN_SWEEP_MINUTES).toBe(30);
    const due = await quiet();
    const young = await quiet(cleanBytes(), new Date(Date.now() - 29 * 60_000));
    const running = await quiet();
    await claim(testDb(), { nodeId: running.file.id, r2Key: running.file.r2Key! });
    const clean = await quiet(cleanBytes(), LONG_AGO, { scanStatus: "clean" });
    const down = await quiet(cleanBytes(), LONG_AGO, { takedownAt: new Date(), takedownReason: "admin" });
    const owner = await makeUser();
    const folder = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
    made.push(folder.id);
    const inside = await quiet(cleanBytes(), LONG_AGO, { owner, parentId: folder.id });
    const ids = [due, young, running, clean, down, inside].map((x) => x.file.id);

    const run = recording();
    const result = await sweepPendingScans(run.deps);
    expect(mine(run.sent, ids)).toEqual([{ v: 1, nodeId: due.file.id, key: due.file.r2Key, force: true }]);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(result.checked).toBeLessThanOrEqual(PENDING_SCAN_SWEEP_DEFAULT_LIMIT);
    for (const untouched of [young, running, clean, down, inside]) {
      expect(await nodeById(untouched.file.id)).toEqual(untouched.file);
    }
  });

  it("Addendum 4 M1: pending files under a taken-down folder never use up the limit — a due node behind ≥ limit of them is still sent", async () => {
    const owner = await makeUser();
    const folder = await makeFolder(owner.id, null, { takedownAt: new Date(), takedownReason: "abuse" });
    made.push(folder.id);
    const LIMIT = 3;
    // The oldest pending files in the table: all hidden by the folder above them.
    for (let n = 0; n < LIMIT; n++) {
      await quiet(cleanBytes(), new Date(Date.UTC(1960, 0, 1, 0, 0, n)), { owner, parentId: folder.id });
    }
    const due = await quiet(cleanBytes(), new Date("1961-01-01T00:00:00.000Z"));
    for (let run = 0; run < 2; run++) {
      const sweep = recording();
      await sweepPendingScans(sweep.deps, { limit: LIMIT });
      expect(
        mine(sweep.sent, [due.file.id]).map((m) => m.nodeId),
        `run ${run}`,
      ).toEqual([due.file.id]);
    }
    // Settled, so this file's later oldest-first tests do not meet it.
    await testDb()
      .update(nodes)
      .set({ scanStatus: "clean" })
      .where(inArray(nodes.id, [due.file.id]));
  });

  it("an old job row counts as quiet too; a job claimed recently (rescan reset) keeps a long-quiet node out", async () => {
    const stale = await quiet();
    await claim(testDb(), { nodeId: stale.file.id, r2Key: stale.file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "failed", startedAt: LONG_AGO, finishedAt: LONG_AGO })
      .where(inArray(scanJobs.r2Key, [stale.file.r2Key!]));
    const recent = await quiet();
    await claim(testDb(), { nodeId: recent.file.id, r2Key: recent.file.r2Key! });
    await testDb()
      .update(scanJobs)
      .set({ status: "done", finishedAt: sql`now() - interval '5 minutes'` })
      .where(inArray(scanJobs.r2Key, [recent.file.r2Key!]));
    const run = recording();
    await sweepPendingScans(run.deps);
    expect(mine(run.sent, [stale.file.id, recent.file.id]).map((m) => m.nodeId)).toEqual([stale.file.id]);
  });

  it("limit is honoured, oldest first; a node whose send throws is counted and the next is still sent", async () => {
    const a = await quiet(cleanBytes(), new Date(LONG_AGO.getTime() - 3_000));
    const b = await quiet(cleanBytes(), new Date(LONG_AGO.getTime() - 2_000));
    const c = await quiet(cleanBytes(), new Date(LONG_AGO.getTime() - 1_000));
    const limited = recording();
    const two = await sweepPendingScans(limited.deps, { limit: 2 });
    expect(two).toEqual({ checked: 2, requeued: 2 });
    expect(limited.sent.map((m) => m.nodeId)).toEqual([a.file.id, b.file.id]);

    const failing = recording(new Set([a.file.id]));
    const three = await sweepPendingScans(failing.deps, { limit: 3 });
    expect(three).toEqual({ checked: 3, requeued: 2 });
    expect(failing.attempts).toEqual([a.file.id, b.file.id, c.file.id]);
    expect(failing.sent.map((m) => m.nodeId)).toEqual([b.file.id, c.file.id]);
  });

  it("two runs → one verdict, one set of effects: back-to-back sends are one job; after the verdict a run sends nothing", async () => {
    const { file, owner } = await quiet(infectedBytes());
    const first = recording();
    const second = recording();
    await sweepPendingScans(first.deps);
    await sweepPendingScans(second.deps);
    const messages = [...mine(first.sent, [file.id]), ...mine(second.sent, [file.id])];
    expect(messages).toHaveLength(2);
    for (const body of messages) expect(await deliver([{ body }])).toEqual([{ outcome: "ack" }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("infected");
    expect(await jobsFor(file.r2Key!)).toHaveLength(1);
    expect(await strikesOf(owner.id)).toHaveLength(1);
    expect(mailTo(owner.email, "quarantineNotice")).toHaveLength(1);
    const third = recording();
    await sweepPendingScans(third.deps);
    expect(mine(third.sent, [file.id])).toEqual([]);
  });

  it("(c) over a simulated 2 h with a node whose send keeps failing: at most one attempt per run for it, never more than limit per run", async () => {
    // The oldest of this file's candidates: inside every run's limit.
    const stuck = await quiet(cleanBytes(), new Date("1980-01-01T00:00:00.000Z"));
    for (let hour = 0; hour < 3; hour++) {
      const run = recording(new Set([stuck.file.id]));
      const result = await sweepPendingScans(run.deps, { limit: 5 });
      expect(
        run.attempts.filter((id) => id === stuck.file.id),
        `hour ${hour}`,
      ).toHaveLength(1);
      expect(run.attempts.length, `hour ${hour}`).toBeLessThanOrEqual(5);
      expect(result.checked, `hour ${hour}`).toBeLessThanOrEqual(5);
      expect((await nodeById(stuck.file.id))!.scanStatus).toBe("pending");
    }
  });
});

describe("abuse-hourly runs it (R4)", () => {
  const noops = () => {
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
    parts.sweepStrikeThresholds = async () => ({ checked: 0, suspended: 0, failed: 0 });
    // (R2 mod-2's locked-hash part would re-send what other runs left locked.)
    parts.sweepLockedUnhashed = async () => ({ checked: 0, requeued: 0 });
    parts.reportAnomalies = async () => [];
  };

  it("one run re-sends a pending node with no job and it reaches a verdict; a second run re-sends nothing for it", async () => {
    noops();
    expect(ABUSE_HOURLY_LIMITS.pendingScans).toBe(100);
    const { file } = await quiet();
    const sent: Sent[] = [];
    const queueEnv = { SCAN_QUEUE: { send: async (m: Sent) => void sent.push(m) } };
    const ctx = jobContext({ env: queueEnv });
    await job.run(ctx.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
    await ctx.settle();
    const mineSent = mine(sent, [file.id]);
    expect(mineSent).toHaveLength(1);
    expect(ctx.metric.mock.calls).toContainEqual([
      "job",
      { kind: "abuse-hourly", outcome: "ok", reason: "pending_scan_sweep" },
      expect.any(Number),
    ]);
    expect(await deliver([{ body: mineSent[0] }])).toEqual([{ outcome: "ack" }]);
    expect((await nodeById(file.id))!.scanStatus).toBe("clean");
    sent.length = 0;
    const again = jobContext({ env: queueEnv });
    await job.run(again.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
    expect(mine(sent, [file.id])).toEqual([]);
  });

  it("a throwing sweep stops neither the parts after it nor the digest", async () => {
    noops();
    const after: string[] = [];
    parts.sweepPendingScans = async () => {
      throw new Error("the sweep broke");
    };
    parts.reportAnomalies = async () => (after.push("anomaly_report"), [{ label: "a finding", value: 1 }]);
    const ops = `ops-${crypto.randomUUID()}@example.test`;
    const ctx = jobContext({ env: { ADMIN_EMAILS: ops, E2E_ADMIN_EMAILS: "" } });
    await job.run(ctx.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
    await ctx.settle();
    expect(after).toEqual(["anomaly_report"]);
    expect(ctx.metric.mock.calls).toContainEqual([
      "job",
      { kind: "abuse-hourly", outcome: "error", reason: "pending_scan_sweep" },
    ]);
    expect(ctx.metric.mock.calls).toContainEqual([
      "job",
      { kind: "abuse-hourly", outcome: "ok", reason: "digest" },
      expect.any(Number),
    ]);
    expect(mailTo(ops).length).toBeGreaterThanOrEqual(1);
  });
});
