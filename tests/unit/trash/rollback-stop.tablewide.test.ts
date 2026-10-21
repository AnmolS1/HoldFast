// A database that has gone back in time destroys nothing: once the rollback detector reads
// "rollback", none of the five destroying paths — purge, the account purge, retention, stale
// uploads, the orphan sweep — deletes a row or an object, in any slot, or through "run job".
// The jobs that destroy nothing still run.
//
// TABLE-WIDE: real slots run real jobs over everything other files left behind. The rollback is
// made in this file's OWN bucket (isolated per test file): the generation object two ahead of
// the database's number (one ahead of a database at 0 reads as an unfinished first count) — no
// setting is written for it. The control brings the two level and runs the same jobs again; they count the database's number up (the heartbeat, reconcile), so
// `settings.reconcileCursor` is put back in `afterAll`.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { trash as trashQuery } from "../../../src/worker/db/queries/trash";
import { auditLog, settings as settingsTable, uploads } from "../../../src/worker/db/schema";
import { runJob, runScheduled } from "../../../src/worker/jobs/index";
import { GENERATION_KEY, runReconcile } from "../../../src/worker/jobs/reconcile";
import { keyFor } from "../../../src/worker/services/storage";
import {
  api,
  audits,
  cronEvent,
  envelope,
  makeFolder,
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
  databaseGeneration,
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
      await env.FILES.put(GENERATION_KEY, String(database + 2));

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
        String(database + 2),
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

describe('a user\'s "delete forever" while the database reads as rolled back', () => {
  const DELETE = { method: "DELETE" } as const;
  /** An owner with a trashed file (100 bytes, its object stored) and a trashed empty folder. */
  async function trashed() {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const stored = await storeFile(file);
    const folder = await makeFolder(owner.id);
    for (const id of [file.id, folder.id]) await trashQuery(testDb(), id, owner.id);
    return { caller: { user: owner }, owner, file, stored, folder };
  }

  it(
    "takes the held path: nothing goes, the answer is an ordinary delete's, the request is recorded; levelled, the purge job finishes it",
    async () => {
      const database = await generationInStep();
      const rolled = await trashed();
      const normal = await trashed();
      const emptied = await trashed();

      await env.FILES.put(GENERATION_KEY, String(database + 2));
      const a = {
        file: await api(rolled.caller, `/nodes/${rolled.file.id}`, DELETE),
        folder: await api(rolled.caller, `/nodes/${rolled.folder.id}`, DELETE),
      };
      const all = await api(emptied.caller, "/trash", DELETE);
      await env.FILES.put(GENERATION_KEY, String(database));
      const b = {
        file: await api(normal.caller, `/nodes/${normal.file.id}`, DELETE),
        folder: await api(normal.caller, `/nodes/${normal.folder.id}`, DELETE),
      };

      // The un-held twin is gone; the rolled-back one is not.
      expect(await nodeById(normal.file.id)).toBeNull();
      expect(await objectExists(normal.stored.object)).toBe(false);
      for (const t of [rolled, emptied]) {
        expect(await nodeById(t.file.id)).not.toBeNull();
        expect(await nodeById(t.folder.id)).not.toBeNull();
        expect(await objectExists(t.stored.object)).toBe(true);
        expect((await audits("node.purge", t.file.id)).length).toBe(0);
        expect((await audits("node.purge_requested", t.file.id)).length).toBe(1);
        // To its owner it is deleted: not listed, an unknown id.
        expect((await api(t.caller, "/trash")).body).toEqual({ items: [], nextCursor: null });
      }
      expect(all.status).toBe(204);
      // The same answer as an ordinary delete: status, body, every header. The statement count
      // is pinned, not equal: the held path undoes the deletes with a savepoint (two statements)
      // and adds the marker (one), where an ordinary delete gives bytes back (one, when there
      // are any) and writes `node.purge` (one) — a file costs one more, an empty folder two. A
      // residual of the m10 kind; only response time carries it.
      for (const [rolledBack, ordinary, extra] of [
        [a.file, b.file, 1],
        [a.folder, b.folder, 2],
      ] as const) {
        expect(rolledBack.status).toBe(204);
        expect([envelope(rolledBack), rolledBack.headers]).toEqual([envelope(ordinary), ordinary.headers]);
        expect(rolledBack.statements - ordinary.statements).toBe(extra);
      }
      // Levelled (the operator's step): the purge job finishes both requests.
      const job = jobContext();
      await runJob("purge", job.bg, { softDeadlineMs: 120_000 });
      for (const t of [rolled, emptied]) {
        expect(await nodeById(t.file.id)).toBeNull();
        expect(await nodeById(t.folder.id)).toBeNull();
        expect(await objectExists(t.stored.object)).toBe(false);
      }
    },
    REAL_RUN_MS,
  );
});

describe("a detector that cannot read the object store (`unknown`) lets nothing be destroyed", () => {
  /** This file's bucket, whose `get` fails (every other method works, on the binding itself). */
  const unreadable = new Proxy(env.FILES, {
    get: (target, name) =>
      name === "get"
        ? async () => {
            throw new Error("R2 is unavailable");
          }
        : (Reflect.get(target, name, target) as () => unknown).bind(target),
  });

  it(
    "the four jobs stop (runJob reads for itself); a user's delete forever takes the held path; control: readable, all go",
    async () => {
      await generationInStep();
      const plants = await due();
      const owner = await member();
      const file = await makeFile(owner.id, null, { scanStatus: "clean" });
      const stored = await storeFile(file);
      await trashQuery(testDb(), file.id, owner.id);

      const job = jobContext({ env: { FILES: unreadable } });
      for (const name of DESTROYING) await runJob(name, job.bg, { softDeadlineMs: 120_000 });
      await job.settle();
      for (const name of DESTROYING) expect(job.outcomes(name), name).toEqual(["rollback_stopped"]);
      expect(job.outcomes("reconcile").filter((o) => o === "detector_error")).toHaveLength(DESTROYING.length);
      const answer = await api({ user: owner }, `/nodes/${file.id}`, {
        method: "DELETE",
        env: { FILES: unreadable },
      });
      expect(answer.status).toBe(204);
      const { orphans: _orphans, ...four } = await plants.state();
      void _orphans;
      expect(four).toEqual({ purge: true, "user-purge": true, retention: true, "stale-uploads": true });
      expect(await nodeById(file.id)).not.toBeNull();
      expect(await objectExists(stored.object)).toBe(true);
      expect((await audits("node.purge_requested", file.id)).length).toBe(1);

      // Control: the store readable again — the same jobs delete all four, and the requested root.
      const again = jobContext();
      for (const name of DESTROYING) await runJob(name, again.bg, { softDeadlineMs: 120_000 });
      const { orphans: _o, ...after } = await plants.state();
      void _o;
      expect(after).toEqual({ purge: false, "user-purge": false, retention: false, "stale-uploads": false });
      expect(await nodeById(file.id)).toBeNull();
    },
    REAL_RUN_MS,
  );
});
