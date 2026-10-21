// The operator's pause switch (T25 section 11, R-a/R-b): one R2 object, `sys/destroy-paused`,
// read INSIDE the rollback detector's own reading — so every guarded job, the slot's one reading
// and every request path that asks `readsRolledBack` stop with no wiring of their own. Present =
// paused; absent = not paused; unreadable = paused. It is outside Postgres: a database put back
// to an earlier state still reads paused.
//
// TABLE-WIDE: real slots run real jobs over everything other files left behind. The switch and
// the generation object live in this file's OWN bucket (isolated per test file). The controls run
// the same jobs with the switch off; they count the generation up, so `settings.reconcileCursor`
// is put back in `afterAll` (and the one settings test restores the keys it writes).
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { clearSettingsCache, getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { trash as trashQuery } from "../../../src/worker/db/queries/trash";
import { auditLog, settings as settingsTable, uploads } from "../../../src/worker/db/schema";
import { runJob, runScheduled } from "../../../src/worker/jobs/index";
import {
  DESTROY_PAUSED_KEY,
  detectRollback,
  GENERATION_KEY,
  readsRolledBack,
  runReconcile,
} from "../../../src/worker/jobs/reconcile";
import { sendOperatorCritical } from "../../../src/worker/services/email";
import { keyFor } from "../../../src/worker/services/storage";
import {
  audits,
  cronEvent,
  databaseGeneration,
  generationInStep,
  jobContext,
  makeDue,
  makeFile,
  makeUpload,
  member,
  nodeById,
  objectExists,
  putObject,
  rand,
  scheduleDeletion,
  storeFile,
  testDb,
  userRow,
  type JobContext,
} from "../trash/helpers";

vi.mock("../../../src/worker/services/email", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/email")>();
  return { ...real, sendOperatorCritical: vi.fn(real.sendOperatorCritical) };
});

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SLOTS = ["17 */6 * * *", "3 * * * *", "5 0 * * *", "0 2 * * *"];
const GUARDED = ["purge", "restore-heartbeat", "stale-uploads", "retention", "user-purge", "reconcile"];
const DESTROYING = ["purge", "stale-uploads", "retention", "user-purge"];
const REAL_RUN_MS = 300_000;

const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

let found: unknown;
let hadCursor = false;
beforeAll(async () => {
  const stored = await getSettings(testDb(), { fresh: true });
  hadCursor = "reconcileCursor" in stored;
  found = stored.reconcileCursor;
});
afterAll(async () => {
  await env.FILES.delete(DESTROY_PAUSED_KEY);
  if (hadCursor) await setSetting(testDb(), "reconcileCursor", found, null);
  else await testDb().delete(settingsTable).where(eq(settingsTable.key, "reconcileCursor"));
});
beforeEach(() => {
  vi.mocked(sendOperatorCritical).mockClear();
});

const pauseOn = () => env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");
const pauseOff = () => env.FILES.delete(DESTROY_PAUSED_KEY);
const objectGeneration = async () => (await (await env.FILES.get(GENERATION_KEY))?.text()) ?? null;
const mails = () => vi.mocked(sendOperatorCritical).mock.calls.map(([, d]) => d.event);

/** This file's bucket, whose `get` of `key` fails (every other key and method works). */
const failingGet = (keys: string[]) =>
  new Proxy(env.FILES, {
    get: (target, name) =>
      name === "get"
        ? async (key: string, options?: R2GetOptions) => {
            if (keys.includes(key)) throw new Error("R2 is unavailable");
            return target.get(key, options);
          }
        : (Reflect.get(target, name, target) as () => unknown).bind(target),
  });

/** Something due for each destroyer, and how to tell whether it is still there. */
async function due() {
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const stored = await storeFile(file);
  await trashQuery(testDb(), file.id, owner.id);
  await makeDue(file.id);
  const leaving = await member();
  await scheduleDeletion(leaving.id, -1);
  const [audit] = await testDb()
    .insert(auditLog)
    .values({ actorType: "system", action: `test.paused.${rand()}`, at: new Date(Date.now() - 400 * DAY) })
    .returning({ id: auditLog.id });
  const session = await makeUpload(owner.id, owner.id, { expiresAt: new Date(Date.now() - HOUR) });
  const orphan = keyFor(owner.id, uuidv7(), uuidv7());
  await putObject(orphan, "nobody's");
  return {
    async state() {
      const [left] = await testDb().select().from(auditLog).where(eq(auditLog.id, audit!.id));
      const [upload] = await testDb()
        .select({ status: uploads.status })
        .from(uploads)
        .where(eq(uploads.id, session.id));
      return {
        purge: (await nodeById(file.id)) !== null && (await objectExists(stored.object)),
        "user-purge": (await userRow(leaving.id)) !== null,
        retention: left !== undefined,
        "stale-uploads": upload?.status === "open",
        orphans: await objectExists(orphan),
      };
    },
  };
}
const ALL_THERE = { purge: true, "user-purge": true, retention: true, "stale-uploads": true, orphans: true };
const ALL_GONE = { purge: false, "user-purge": false, retention: false, "stale-uploads": false, orphans: false };

async function runEverything(job: JobContext) {
  for (const cron of SLOTS) await runScheduled(cronEvent(cron), env, ctx, job.bg);
  await runReconcile(job.bg, { softDeadlineMs: 120_000, now: new Date(Date.now() + 72 * HOUR) });
  await job.settle();
}

describe("the pause switch stops every job that destroys", () => {
  it(
    "switch on: no slot and no runJob of any guarded job destroys anything; the generation is not counted; control: switch off, all five go",
    async () => {
      const plants = await due();
      const database = await generationInStep();
      await pauseOn();
      const rowsBefore = (await audits("system.database_rollback", "reconcile")).length;

      const job = jobContext();
      await runEverything(job);
      for (const name of GUARDED) await runJob(name, job.bg, { softDeadlineMs: 120_000 });
      await job.settle();
      expect(await plants.state()).toEqual(ALL_THERE);
      for (const name of DESTROYING) expect(job.outcomes(name), name).toContain("rollback_stopped");
      // One reading per slot with a guarded job, per runJob and the extra reconcile run: each "paused".
      expect(job.outcomes("reconcile").filter((o) => o === "paused").length).toBeGreaterThanOrEqual(
        SLOTS.length + GUARDED.length,
      );
      // The operator's own act: no rollback recorded, nobody mailed.
      expect(job.outcomes("reconcile")).not.toContain("rollback_detected");
      expect((await audits("system.database_rollback", "reconcile")).length).toBe(rowsBefore);
      expect(mails()).toEqual([]);
      // Nothing counted the generation while paused.
      expect(job.outcomes("restore-heartbeat")).not.toContain("counted");
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([database, String(database)]);

      // Control: the switch off — the same jobs delete all five.
      await pauseOff();
      await runEverything(jobContext());
      expect(await plants.state()).toEqual(ALL_GONE);
    },
    3 * SLOTS.length * REAL_RUN_MS,
  );

  it("the reading itself: on → `paused` (one metric), and `readsRolledBack` is true; off and in step → `ok` / false", async () => {
    await generationInStep();
    await pauseOn();
    const job = jobContext();
    expect(await detectRollback(job.bg)).toEqual({ state: "paused" });
    expect(job.outcomes("reconcile")).toEqual(["paused"]);
    expect(await readsRolledBack(env, testDb())).toBe(true);
    await pauseOff();
    const again = jobContext();
    expect((await detectRollback(again.bg)).state).toBe("ok");
    expect(again.outcomes("reconcile")).toEqual([]);
    expect(await readsRolledBack(env, testDb())).toBe(false);
  });

  it(
    "a switch that cannot be read is ON: runJob destroys nothing and the request predicate says rolled back; control: readable and absent, they go",
    async () => {
      await pauseOff();
      await generationInStep();
      const plants = await due();
      const broken = failingGet([DESTROY_PAUSED_KEY]);
      const job = jobContext({ env: { FILES: broken } });
      for (const name of DESTROYING) await runJob(name, job.bg, { softDeadlineMs: 120_000 });
      await job.settle();
      for (const name of DESTROYING) expect(job.outcomes(name), name).toEqual(["rollback_stopped"]);
      expect(await readsRolledBack({ ...env, FILES: broken } as unknown as Env, testDb())).toBe(true);
      const { orphans: _o, ...four } = await plants.state();
      void _o;
      expect(four).toEqual({ purge: true, "user-purge": true, retention: true, "stale-uploads": true });

      const again = jobContext();
      for (const name of DESTROYING) await runJob(name, again.bg, { softDeadlineMs: 120_000 });
      const { orphans: _p, ...after } = await plants.state();
      void _p;
      expect(after).toEqual({ purge: false, "user-purge": false, retention: false, "stale-uploads": false });
    },
    REAL_RUN_MS,
  );

  it("a store that cannot be read at all still raises the detector's own alert (S14): `unknown`, `detector_unreadable` mailed", async () => {
    const job = jobContext({ env: { FILES: failingGet([DESTROY_PAUSED_KEY, GENERATION_KEY]) } });
    expect((await detectRollback(job.bg)).state).toBe("unknown");
    expect(job.outcomes("reconcile")).toContain("detector_error");
    expect(mails()).toContain("detector_unreadable");
  });

  it("a database put back to before the switch went on still reads paused: the switch is not a setting", async () => {
    await generationInStep();
    const before = await getSettings(testDb(), { fresh: true });
    await pauseOn();
    // The restore: the settings rows back as they were before (and the keys a restore brings back).
    await setSetting(testDb(), "orphanDeleteEnabled", true, null);
    clearSettingsCache();
    expect(await readsRolledBack(env, testDb())).toBe(true);
    expect((await detectRollback(jobContext().bg)).state).toBe("paused");
    if (before.orphanDeleteEnabled !== undefined) {
      await setSetting(testDb(), "orphanDeleteEnabled", before.orphanDeleteEnabled, null);
    } else {
      await testDb().delete(settingsTable).where(eq(settingsTable.key, "orphanDeleteEnabled"));
    }
    clearSettingsCache();
    await pauseOff();
  });
});
