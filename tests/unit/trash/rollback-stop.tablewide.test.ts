// A database that has gone back in time destroys nothing: once the rollback detector reads
// "rollback", none of the five destroying paths — purge, the account purge, retention, stale
// uploads, the orphan sweep — deletes a row or an object, in any slot, or through "run job".
// The jobs that destroy nothing still run.
//
// TABLE-WIDE: real slots run real jobs over everything other files left behind. The rollback is
// made in this file's OWN bucket (isolated per test file): the generation object one ahead of the
// database's number — no setting is written for it. The control brings the two level and runs
// the same jobs again; they count the database's number up (the heartbeat, reconcile), so
// `settings.reconcileCursor` is put back in `afterAll`.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { trash as trashQuery } from "../../../src/worker/db/queries/trash";
import { auditLog, settings as settingsTable, uploads } from "../../../src/worker/db/schema";
import { runJob, runScheduled } from "../../../src/worker/jobs/index";
import { GENERATION_KEY, readCursor, runReconcile } from "../../../src/worker/jobs/reconcile";
import { keyFor } from "../../../src/worker/services/storage";
import {
  cronEvent,
  generationInStep,
  jobContext,
  makeFile,
  makeDue,
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
} from "./helpers";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SLOTS = ["17 */6 * * *", "3 * * * *", "5 0 * * *", "0 2 * * *"];
const DESTROYING = ["purge", "stale-uploads", "retention", "user-purge"];
/** A real slot runs real jobs over everything other files left behind. */
const REAL_RUN_MS = 300_000;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

let found: unknown;
let hadCursor = false;
beforeAll(async () => {
  const stored = await getSettings(testDb(), { fresh: true });
  hadCursor = "reconcileCursor" in stored;
  found = stored.reconcileCursor;
});
afterAll(async () => {
  if (hadCursor) await setSetting(testDb(), "reconcileCursor", found, null);
  else await testDb().delete(settingsTable).where(eq(settingsTable.key, "reconcileCursor"));
});

const databaseGeneration = async () =>
  readCursor((await getSettings(testDb(), { fresh: true })).reconcileCursor).generation;
const objectGeneration = async () => (await (await env.FILES.get(GENERATION_KEY))?.text()) ?? null;

/** Something due for each of the five, and how to tell whether it is still there. */
async function due() {
  // purge: a trashed file past its date, with its object.
  const owner = await member();
  const file = await makeFile(owner.id, null, { scanStatus: "clean" });
  const stored = await storeFile(file);
  await trashQuery(testDb(), file.id, owner.id);
  await makeDue(file.id);
  // user-purge: an account whose deletion date has passed.
  const leaving = await member();
  await scheduleDeletion(leaving.id, -1);
  // retention: an audit row past its period.
  const [audit] = await testDb()
    .insert(auditLog)
    .values({ actorType: "system", action: `test.rollback.${rand()}`, at: new Date(Date.now() - 400 * DAY) })
    .returning({ id: auditLog.id });
  // stale-uploads: an open session past its expiry.
  const session = await makeUpload(owner.id, owner.id, { expiresAt: new Date(Date.now() - HOUR) });
  // the orphan sweep: an object no row references.
  const orphan = keyFor(owner.id, uuidv7(), uuidv7());
  await putObject(orphan, "nobody's");

  const auditLeft = async () =>
    (await testDb().select().from(auditLog).where(eq(auditLog.id, audit!.id))).length === 1;
  const sessionStatus = async () =>
    (await testDb().select({ status: uploads.status }).from(uploads).where(eq(uploads.id, session.id)))[0]
      ?.status;
  return {
    async state() {
      return {
        purge: (await nodeById(file.id)) !== null && (await objectExists(stored.object)),
        "user-purge": (await userRow(leaving.id)) !== null,
        retention: await auditLeft(),
        "stale-uploads": (await sessionStatus()) === "open",
        orphans: await objectExists(orphan),
      };
    },
  };
}
const ALL_THERE = { purge: true, "user-purge": true, retention: true, "stale-uploads": true, orphans: true };

/** Every slot, then the sweep with objects old enough (an object's age cannot be set). */
async function runEverything(job: JobContext) {
  for (const cron of SLOTS) await runScheduled(cronEvent(cron), env, ctx, job.bg);
  await runReconcile(job.bg, { softDeadlineMs: 120_000, now: new Date(Date.now() + 72 * HOUR) });
  await job.settle();
}

describe("a detected rollback stops every job that destroys", () => {
  it(
    "the generation object ahead of the database: nothing of the five goes, in any slot or through runJob; the counts stay; control: in step, all five go",
    async () => {
      const plants = await due();
      const database = await generationInStep();
      await env.FILES.put(GENERATION_KEY, String(database + 1));

      const job = jobContext();
      await runEverything(job);
      for (const name of DESTROYING) {
        await runJob(name, job.bg, { softDeadlineMs: 120_000 });
      }
      expect(await plants.state()).toEqual(ALL_THERE);
      // Each destroying job said why, in every slot it ran and through runJob.
      for (const name of DESTROYING)
        expect(job.outcomes(name), name).toEqual(["rollback_stopped", "rollback_stopped"]);
      // One reading per slot (and one per runJob and the extra reconcile run), each alerting.
      expect(job.outcomes("reconcile").filter((o) => o === "rollback_detected")).toHaveLength(
        SLOTS.length + 1 + DESTROYING.length,
      );
      // Nothing counted a rolled-back database up; the jobs that destroy nothing ran.
      expect(job.outcomes("restore-heartbeat")).toEqual(["not_counted"]);
      expect([await databaseGeneration(), await objectGeneration()]).toEqual([
        database,
        String(database + 1),
      ]);

      // Control: the two numbers level again (the operator's step) — the same jobs delete all five.
      await env.FILES.put(GENERATION_KEY, String(database));
      await runEverything(jobContext());
      expect(await plants.state()).toEqual({
        purge: false,
        "user-purge": false,
        retention: false,
        "stale-uploads": false,
        orphans: false,
      });
    },
    3 * SLOTS.length * REAL_RUN_MS,
  );
});
