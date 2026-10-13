// The reconcile job: the quota repair and the orphan sweep with its three guards.
//
// TABLE-WIDE: the job walks every account and every object. R2 is this file's own (isolated per
// test file), so the sweep sees only what is planted here; accounts are reached one at a time by
// starting the walk just before the test's own. `settings.reconcileCursor` is the ONE settings
// key this file writes (the job persists it); the value found is put back in `afterAll`.
//
// AN OBJECT'S AGE cannot be set — the store stamps `uploaded` itself. So "older than 48 hours" is
// tested by telling the sweep what time it is (`now`, the one comparison it reaches): 47 hours
// from now everything planted is still young, 49 hours from now it is old.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { trash as trashQuery } from "../../../src/worker/db/queries/trash";
import { nodes, settings as settingsTable } from "../../../src/worker/db/schema";
import { purgeRoot } from "../../../src/worker/jobs/purge";
import {
  job as reconcileJob,
  GENERATION_KEY,
  ORPHAN_AREAS,
  readCursor,
  reconcileQuotas,
  runReconcile,
  sweepOrphans,
} from "../../../src/worker/jobs/reconcile";
import { nameKeyOf } from "../../../src/worker/services/filename";
import { captureError } from "../../../src/worker/sentry";
import { registerCoreDeps } from "../../../src/worker/services/request-context";
import { avatarKey, keyFor, thumbKey } from "../../../src/worker/services/storage";
import { realCore } from "../auth/helpers";
import {
  audits,
  cronEvent,
  jobContext,
  keysUnder,
  makeDue,
  makeFile,
  makeFolder,
  makeUpload,
  makeVersion,
  member,
  objectExists,
  putObject,
  rand,
  setUsedBytes,
  storeFile,
  storeVersion,
  testDb,
  uploadRow,
  usedBytes,
} from "./helpers";

// What the job reports to the operator, counted (the report itself is the real one).
vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn(real.captureError) };
});

const HOUR = 3_600_000;
const FAR = Date.now() + 600_000;
const inHours = (hours: number) => new Date(Date.now() + hours * HOUR);
const START = { area: 0, object: null };
/** Sorts just before `id`, so a walk that starts after it reaches `id` first. */
const justBefore = (id: string) => id.slice(0, -1);

let found: unknown;
let hadCursor = false;
beforeAll(async () => {
  const stored = await getSettings(testDb(), { fresh: true });
  hadCursor = "reconcileCursor" in stored;
  found = stored.reconcileCursor;
});
afterEach(() => registerCoreDeps(realCore));
afterAll(async () => {
  if (hadCursor) await setSetting(testDb(), "reconcileCursor", found, null);
  else await testDb().delete(settingsTable).where(eq(settingsTable.key, "reconcileCursor"));
});

/**
 * An account whose rows add up to 1,200 bytes: a live file (100), a trashed file (60), a kept
 * old version (40) and an upload in flight (1,000) — beside rows that never count: an avatar, a
 * finished session, an avatar upload.
 */
async function consistent() {
  const owner = await member();
  const live = await makeFile(owner.id, null, { size: 100 });
  const trashed = await makeFile(owner.id, null, { size: 60 });
  await trashQuery(testDb(), trashed.id, owner.id);
  await makeVersion(live, { size: 40 });
  await makeUpload(owner.id, owner.id, { size: 1000 });
  await makeFile(owner.id, null, { size: 999, system: "avatar" });
  await makeUpload(owner.id, owner.id, { size: 500, status: "done", completedAt: new Date() });
  await makeUpload(owner.id, owner.id, { size: 70, purpose: "avatar" });
  await setUsedBytes(owner.id, 1200);
  return owner;
}

/**
 * The two generation numbers as a test wants them: the database's (inside the cursor) and the
 * object's (`null` = no object). Everything else of the cursor is the start, or `user`.
 */
async function generations(database: number, object: number | string | null, at: { user?: string } = {}) {
  await setSetting(
    testDb(),
    "reconcileCursor",
    { user: at.user ?? null, area: 0, object: null, generation: database },
    null,
  );
  if (object === null) await env.FILES.delete(GENERATION_KEY);
  else await env.FILES.put(GENERATION_KEY, String(object));
}
const databaseGeneration = async () =>
  readCursor((await getSettings(testDb(), { fresh: true })).reconcileCursor).generation;
const objectGeneration = async () => (await (await env.FILES.get(GENERATION_KEY))?.text()) ?? null;

/** The walk, for exactly one account: the first after `after`, with the deadline already past. */
const one = (ctx: ReturnType<typeof jobContext>, id: string) =>
  reconcileQuotas(ctx.bg, { after: justBefore(id), stopAt: 0 });

describe("reconcile: the quota half", () => {
  it("is a no-op on consistent rows — trashed files, versions and uploads in flight all count", async () => {
    const owner = await consistent();
    const ctx = jobContext();
    const pass = await one(ctx, owner.id);
    await ctx.settle();
    expect(pass).toMatchObject({ next: owner.id, done: false, accounts: 1, drifted: 0 });
    expect(await usedBytes(owner.id)).toBe(1200);
    expect(ctx.outcomes("reconcile")).toEqual([]);
    expect(await audits("system.reconcile", owner.id)).toEqual([]);
  });

  it("corrects planted drift and counts it, too low as well as too high", async () => {
    const owner = await consistent();
    await setUsedBytes(owner.id, 5000);
    const ctx = jobContext();
    const pass = await one(ctx, owner.id);
    expect(pass).toMatchObject({ accounts: 1, drifted: 1, delta: -3800 });
    expect(await usedBytes(owner.id)).toBe(1200);
    expect(ctx.outcomes("reconcile")).toEqual(["drift"]);
    // Nothing is deferred by the pass: its record is the run's one row (below).
    expect(ctx.bg.deferred).toHaveLength(0);
    await setUsedBytes(owner.id, 0);
    expect(await one(jobContext(), owner.id)).toMatchObject({ drifted: 1, delta: 1200 });
    expect(await usedBytes(owner.id)).toBe(1200);
  });

  it("a run leaves ONE record of its quota pass — counts — however many accounts were off, and whatever the defer limit", async () => {
    const owners = [await consistent(), await consistent(), await consistent()];
    for (const owner of owners) await setUsedBytes(owner.id, 1000);
    await generations(3, 3);
    // An invocation that can defer nothing more: what `defer` does past its hundredth task.
    const ctx = jobContext();
    ctx.bg.defer = (promise) => {
      promise.catch(() => {});
      throw new Error("too much deferred work in one invocation");
    };
    const since = new Date(Date.now() - 1000);
    await runReconcile(ctx.bg, { softDeadlineMs: 120_000 });
    for (const owner of owners) expect(await usedBytes(owner.id)).toBe(1200);
    const rows = (await audits("system.reconcile", "reconcile")).filter((row) => row.at >= since);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "system", actorUserId: null, targetType: "job" });
    const meta = rows[0]!.meta as { accounts: number; drifted: number; delta: number };
    expect(Object.keys(meta).sort()).toEqual(["accounts", "delta", "drifted"]);
    // The whole walk: this file's three and whatever else was off — never fewer.
    expect(meta.drifted).toBeGreaterThanOrEqual(3);
    expect(meta.accounts).toBeGreaterThanOrEqual(meta.drifted);
    // No row per account.
    for (const owner of owners) expect(await audits("system.reconcile", owner.id)).toEqual([]);
  });

  it("the job resumes where its cursor says, and keeps its place", async () => {
    const owner = await consistent();
    await setUsedBytes(owner.id, 7);
    await generations(3, 3, { user: justBefore(owner.id) });
    const ctx = jobContext();
    await reconcileJob.run(ctx.bg, env, cronEvent(reconcileJob.cron), { softDeadlineMs: 400 });
    await ctx.settle();
    expect(await usedBytes(owner.id)).toBe(1200);
    const cursor = readCursor((await getSettings(testDb(), { fresh: true })).reconcileCursor);
    // Either it reached the last account (and starts over), or it stopped at one past this one.
    // "Past" as the DATABASE orders ids (its collation, which the walk follows) — not as JS does.
    if (cursor.user !== null) {
      const order = await testDb().execute<{ past: boolean }>(
        sql`SELECT (${cursor.user}::text >= ${owner.id}::text) AS past`,
      );
      expect(order.rows[0]!.past).toBe(true);
    }
    expect(cursor.area).toBeLessThan(ORPHAN_AREAS.length);
  });

  it("anything that is not a cursor reads as the start", () => {
    for (const stored of [undefined, null, "x", 7, [], { user: 5, area: -1 }, { area: 99, object: "c" }]) {
      expect(readCursor(stored)).toEqual({ user: null, area: 0, object: null, generation: 0 });
    }
    expect(readCursor({ user: "u", area: 2, object: "c", generation: 4 })).toEqual({
      user: "u",
      area: 2,
      object: "c",
      generation: 4,
    });
    expect(readCursor({ generation: -1 }).generation).toBe(0);
    expect(readCursor({ generation: "7" }).generation).toBe(0);
  });
});

// ── the orphan sweep ────────────────────────────────────────────────────────────────────────

/** Objects in all three areas: some referenced by rows, some by nothing. */
async function planted() {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const version = await makeVersion(file);
  const current = await storeFile(file);
  const old = await storeVersion(version);
  // An upload in flight: its object may be on its way.
  const session = await makeUpload(owner.id, owner.id, { r2UploadId: null });
  await putObject(session.r2Key, "arriving");
  const avatarNodeKey = avatarKey(owner.id, crypto.randomUUID());
  await makeFile(owner.id, null, { system: "avatar", r2Key: avatarNodeKey });
  await putObject(avatarNodeKey, "the avatar");

  const orphanObject = keyFor(owner.id, uuidv7(), uuidv7());
  const orphanThumb = thumbKey(file.id, uuidv7(), 320);
  const orphanAvatar = avatarKey(owner.id, crypto.randomUUID());
  const oddThumb = `t/not-a-thumbnail-${rand()}`;
  for (const key of [orphanObject, orphanThumb, orphanAvatar, oddThumb]) await putObject(key, "nobody's");
  return {
    referenced: [current.object, current.thumb, old.object, old.thumb, session.r2Key, avatarNodeKey],
    orphans: [orphanObject, orphanThumb, orphanAvatar],
    // Under `t/`, but not a thumbnail key: never deleted on a guess.
    odd: oddThumb,
  };
}

const present = async (keys: string[]) => {
  const out: string[] = [];
  for (const key of keys) if (await objectExists(key)) out.push(key);
  return out;
};

describe("reconcile: the orphan sweep", () => {
  it("deletes what no row references once it is older than 48 hours — and nothing younger, nothing referenced", async () => {
    const p = await planted();
    const young = jobContext();
    const kept = await sweepOrphans(young.bg, { from: START, stopAt: FAR, now: inHours(47) });
    expect(kept).toMatchObject({ outcome: "swept", candidates: 0, deleted: 0, done: true });
    expect(await present([...p.referenced, ...p.orphans, p.odd])).toHaveLength(10);

    const old = jobContext();
    const swept = await sweepOrphans(old.bg, { from: START, stopAt: FAR, now: inHours(49) });
    expect(swept).toMatchObject({
      outcome: "swept",
      candidates: 3,
      deleted: 3,
      done: true,
      area: 0,
      object: null,
    });
    expect(swept.listed).toBeGreaterThanOrEqual(10);
    expect(await present(p.orphans)).toEqual([]);
    expect(await present(p.referenced)).toEqual(p.referenced);
    expect(await objectExists(p.odd)).toBe(true);
    expect(old.outcomes("reconcile")).toEqual(["orphans"]);
    await env.FILES.delete(p.odd);
  });

  it("guard (a): with orphanDeleteEnabled off nothing is deleted, however old", async () => {
    const p = await planted();
    const off = jobContext({ settings: { orphanDeleteEnabled: false } });
    const result = await sweepOrphans(off.bg, { from: START, stopAt: FAR, now: inHours(1000) });
    expect(result).toMatchObject({ outcome: "disabled", listed: 0, deleted: 0, done: false });
    expect(await present(p.orphans)).toEqual(p.orphans);
    expect(off.outcomes("reconcile")).toEqual(["orphan_disabled"]);
    // The job as a whole, with the switch off: the quota half still runs, the sweep does not.
    await generations(3, 3);
    const viaJob = jobContext({ settings: { orphanDeleteEnabled: false } });
    await reconcileJob.run(viaJob.bg, env, cronEvent(reconcileJob.cron), { softDeadlineMs: 200 });
    expect(await present(p.orphans)).toEqual(p.orphans);
    expect(viaJob.outcomes("reconcile")).toContain("orphan_disabled");

    // Control: the same sweep with the switch on deletes them.
    const on = jobContext({ settings: { orphanDeleteEnabled: true } });
    expect(await sweepOrphans(on.bg, { from: START, stopAt: FAR, now: inHours(1000) })).toMatchObject({
      outcome: "swept",
      deleted: 3,
    });
    expect(await present(p.orphans)).toEqual([]);
    await env.FILES.delete(p.odd);
  });

  it("guard (a), the other reading: the TABLE says off while the run was given on — nothing is deleted", async () => {
    const p = await planted();
    // The run's own settings (read up to 60 s ago) still say on; the table, read now, says off:
    // the restore runbook switched it a moment ago.
    const stale = jobContext({ settings: { orphanDeleteEnabled: true } });
    registerCoreDeps({ ...realCore, getSettings: async () => ({ orphanDeleteEnabled: false }) });
    const result = await sweepOrphans(stale.bg, { from: START, stopAt: FAR, now: inHours(1000) });
    registerCoreDeps(realCore);
    expect(result).toMatchObject({ outcome: "disabled", deleted: 0 });
    expect(await present(p.orphans)).toEqual(p.orphans);
    expect(stale.outcomes("reconcile")).toEqual(["orphan_disabled"]);
    // Control: the table read saying on (as the real one does here), the same sweep deletes them.
    const on = jobContext({ settings: { orphanDeleteEnabled: true } });
    expect(await sweepOrphans(on.bg, { from: START, stopAt: FAR, now: inHours(1000) })).toMatchObject({
      outcome: "swept",
      deleted: 3,
    });
    await env.FILES.delete(p.odd);
  });

  it("continues over several runs: one area a run, and starts over after the last", async () => {
    const p = await planted();
    const step = (from: { area: number; object: string | null }) =>
      sweepOrphans(jobContext().bg, { from, stopAt: FAR, now: inHours(49), maxPages: 1 });
    const first = await step(START);
    expect(first).toMatchObject({ outcome: "swept", area: 1, object: null, done: false, deleted: 1 });
    expect(await present(p.orphans)).toEqual(p.orphans.slice(1));
    const second = await step(first);
    expect(second).toMatchObject({ area: 2, done: false, deleted: 1 });
    const third = await step(second);
    expect(third).toMatchObject({ area: 0, object: null, done: true, deleted: 1 });
    expect(await present(p.orphans)).toEqual([]);
    await env.FILES.delete(p.odd);
  });

  it("the single-PUT object a purge left behind is an orphan: swept after 48 hours, not before", async () => {
    const owner = await member();
    const folder = await makeFolder(owner.id);
    const session = await makeUpload(owner.id, owner.id, { parentId: folder.id, r2UploadId: null });
    await putObject(session.r2Key, "what the single PUT stored");
    await trashQuery(testDb(), folder.id, owner.id);
    await makeDue(folder.id);
    expect(await purgeRoot(jobContext().bg, folder.id, "cron")).toMatchObject({ outcome: "purged" });
    // The purge deleted the session row and no object for it.
    expect(await uploadRow(session.id)).toBeNull();
    expect(await objectExists(session.r2Key)).toBe(true);

    await sweepOrphans(jobContext().bg, { from: START, stopAt: FAR, now: inHours(47) });
    expect(await objectExists(session.r2Key)).toBe(true);
    await sweepOrphans(jobContext().bg, { from: START, stopAt: FAR, now: inHours(49) });
    expect(await objectExists(session.r2Key)).toBe(false);
  });

  describe("the rollback detector: a generation number in the database and in the object store", () => {
    const alerts = () =>
      vi.mocked(captureError).mock.calls.filter(([, tags]) => tags?.reason === "rollback_detected");
    beforeEach(() => vi.mocked(captureError).mockClear());
    const run = (ctx = jobContext()) => runReconcile(ctx.bg, { softDeadlineMs: 400, now: inHours(72) });

    it("a database that has gone back in time: no orphan is deleted, by this run or the next; an alert each run; until an operator moves the number", async () => {
      const p = await planted();
      const owner = await consistent();
      await setUsedBytes(owner.id, 9);
      // The object store saw run 7 complete; the restored database remembers run 5.
      await generations(5, 7, { user: justBefore(owner.id) });
      const ctx = jobContext();
      const first = await run(ctx);
      expect(first).toMatchObject({ generation: "rollback", sweep: null, done: false });
      expect(await present(p.orphans)).toEqual(p.orphans);
      expect(ctx.outcomes("reconcile")).toContain("rollback_detected");
      expect(ctx.outcomes("reconcile")).not.toContain("orphans");
      expect(alerts()).toHaveLength(1);
      // The job never counts a rolled-back database up by itself.
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([5, "7"]);
      // The quota half is not gated.
      expect(await usedBytes(owner.id)).toBe(1200);

      await run();
      expect(await present(p.orphans)).toEqual(p.orphans);
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([5, "7"]);
      expect(alerts()).toHaveLength(2);

      // The operator has looked, and moves the database's number up to the object's.
      await generations(7, 7);
      vi.mocked(captureError).mockClear();
      const after = await run();
      expect(after.generation).toBe("ok");
      expect(await present(p.orphans)).toEqual([]);
      expect(await present(p.referenced)).toEqual(p.referenced);
      expect(alerts()).toHaveLength(0);
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([8, "8"]);
      await env.FILES.delete(p.odd);
    });

    it("no object yet — the first run: it is written, and nothing is deleted that run", async () => {
      const p = await planted();
      await generations(0, null);
      const first = await run();
      expect(first).toMatchObject({ generation: "first", sweep: null });
      expect(await present(p.orphans)).toEqual(p.orphans);
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([1, "1"]);
      expect(alerts()).toHaveLength(0);
      // Control: the next run, with both numbers in step, deletes the same orphans.
      expect((await run()).generation).toBe("ok");
      expect(await present(p.orphans)).toEqual([]);
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([2, "2"]);
      await env.FILES.delete(p.odd);
    });

    it("the database ahead of the object (an object write failed): normal, and the object is brought up", async () => {
      const p = await planted();
      await generations(9, 7);
      expect((await run()).generation).toBe("ok");
      expect(await present(p.orphans)).toEqual([]);
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([10, "10"]);
      expect(alerts()).toHaveLength(0);
      await env.FILES.delete(p.odd);
    });

    it("an object that is not a number proves nothing: treated as a rollback", async () => {
      const p = await planted();
      await generations(4, "not a number");
      expect((await run()).generation).toBe("rollback");
      expect(await present(p.orphans)).toEqual(p.orphans);
      expect(alerts()).toHaveLength(1);
      await generations(4, 4);
      await env.FILES.delete([...p.orphans, p.odd]);
    });

    it("the generation object is outside every swept area", () => {
      for (const area of ORPHAN_AREAS) expect(GENERATION_KEY.startsWith(area)).toBe(false);
    });
  });

  it("guard (b): 600 orphans among 1,000 objects — nothing is deleted, and it alerts", async () => {
    const owner = await member();
    // Whatever earlier cases left in this file's bucket is cleared first: the count matters here.
    for (const area of ORPHAN_AREAS) {
      const keys = await keysUnder(area);
      for (let at = 0; at < keys.length; at += 500) await env.FILES.delete(keys.slice(at, at + 500));
    }
    const referenced = Array.from({ length: 400 }, () => {
      const id = uuidv7();
      const versionId = uuidv7();
      const name = `bulk-${id}.bin`;
      return {
        id,
        ownerId: owner.id,
        createdBy: owner.id,
        kind: "file" as const,
        name,
        nameKey: nameKeyOf(name),
        ext: "bin",
        size: 1,
        versionId,
        r2Key: keyFor(owner.id, id, versionId),
      };
    });
    await testDb().insert(nodes).values(referenced);
    const orphans = Array.from({ length: 600 }, () => keyFor(owner.id, uuidv7(), uuidv7()));
    const all = [...referenced.map((row) => row.r2Key), ...orphans];
    for (let at = 0; at < all.length; at += 50) {
      await Promise.all(all.slice(at, at + 50).map((key) => env.FILES.put(key, "x")));
    }

    const ctx = jobContext();
    const result = await sweepOrphans(ctx.bg, { from: START, stopAt: FAR, now: inHours(49) });
    expect(result).toMatchObject({
      outcome: "orphan_threshold",
      listed: 1000,
      candidates: 600,
      deleted: 0,
      // Its place is kept: the next run looks at the same objects again.
      area: 0,
      object: null,
      done: false,
    });
    expect(await keysUnder("u/")).toHaveLength(1000);
    expect(ctx.metric.mock.calls).toContainEqual([
      "job",
      { kind: "reconcile", outcome: "orphan_threshold" },
      600,
    ]);
    expect(ctx.outcomes("reconcile")).not.toContain("orphans");

    // Control: at 500 candidates — not over the threshold — the same sweep deletes them.
    await env.FILES.delete(orphans.slice(0, 100));
    const below = await sweepOrphans(jobContext().bg, { from: START, stopAt: FAR, now: inHours(49) });
    expect(below).toMatchObject({ outcome: "swept", listed: 900, candidates: 500, deleted: 500, done: true });
    expect(await keysUnder("u/")).toEqual(referenced.map((row) => row.r2Key).sort());
  }, 120_000);
});
