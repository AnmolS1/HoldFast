// The registry and its dispatcher: which jobs a cron expression runs, in which order, and that
// the two jobs that ran before the registry existed still do their work.
//
// TABLE-WIDE: `runScheduled` with a real cron expression runs the real jobs. No other test file
// calls `scheduled()` or `runScheduled` with an expression a job listens to. The reconcile job
// persists `settings.reconcileCursor`; the value found is put back in `afterAll`.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sweepExpiredVerifications } from "../../../src/worker/db/queries/auth-lifecycle";
import { getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { downloadLedger, settings as settingsTable, verification } from "../../../src/worker/db/schema";
import {
  JOB_SOFT_DEADLINE_MS,
  jobNames,
  jobs,
  runJob,
  runScheduled,
  softDeadlineOf,
  type Job,
} from "../../../src/worker/jobs/index";
import { parts as abuseParts } from "../../../src/worker/jobs/abuse-hourly";
import { backupMissingAlarm } from "../../../src/worker/jobs/backup";
import { job as operatorDigests } from "../../../src/worker/jobs/operator-digests";
import { detectRollback } from "../../../src/worker/jobs/reconcile";
import { job as verificationSweep } from "../../../src/worker/jobs/verification-sweep";
import { HOURLY_CRON, NIGHTLY_CRON, scheduled } from "../../../src/worker/scheduled";
import { captureError } from "../../../src/worker/sentry";
import { flushOperatorDigests } from "../../../src/worker/services/email";
import { list as outbox } from "../../../src/worker/services/outbox";
import { cronEvent, gate, generationInStep, jobContext, makeUpload, member, rand, testDb } from "./helpers";

// The rollback detector reads "ok" for the guarded jobs this file runs.
beforeAll(generationInStep);

// The slot's one reading, made to throw once (m2-R5); and what the dispatcher reports.
vi.mock("../../../src/worker/jobs/reconcile", async (original) => {
  const real = await original<typeof import("../../../src/worker/jobs/reconcile")>();
  return { ...real, detectRollback: vi.fn(real.detectRollback) };
});
vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn(real.captureError) };
});

// The watchdog's alarm (R1 perfops-5), counted where the dispatcher calls it. The backup job's own
// tail calls the module-internal binding, which this does not see.
vi.mock("../../../src/worker/jobs/backup", async (original) => {
  const real = await original<typeof import("../../../src/worker/jobs/backup")>();
  return { ...real, backupMissingAlarm: vi.fn(real.backupMissingAlarm) };
});
vi.mock("../../../src/worker/services/email", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/email")>();
  return { ...real, flushOperatorDigests: vi.fn(real.flushOperatorDigests) };
});
vi.mock("../../../src/worker/db/queries/auth-lifecycle", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/auth-lifecycle")>();
  return { ...real, sweepExpiredVerifications: vi.fn(real.sweepExpiredVerifications) };
});

/** wrangler.jsonc `triggers.crons`, and what each runs — in this order. */
const SLOTS: Record<string, string[]> = {
  "17 */6 * * *": ["purge"],
  "3 * * * *": ["restore-heartbeat", "stale-uploads", "abuse-hourly", "operator-digests"],
  "5 0 * * *": ["retention", "unpause-midnight", "verification-sweep"],
  "0 2 * * *": ["backup", "user-purge", "reconcile"],
};
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
afterEach(() => vi.restoreAllMocks());

/** The jobs whose run threw, since the last `watch`. */
let threw: string[] = [];

/** Records every job that is run, in order (and in `threw`, those that threw). `stub`: do not run the job itself. */
function watch(stub: boolean) {
  const ran: string[] = [];
  threw = [];
  for (const job of jobs) {
    const real = job.run.bind(job);
    vi.spyOn(job, "run").mockImplementation(async (...args: Parameters<Job["run"]>) => {
      ran.push(job.name);
      if (stub) return;
      try {
        return await real(...args);
      } catch (error) {
        threw.push(job.name);
        throw error;
      }
    });
  }
  return ran;
}

/** The jobs the dispatcher counted as having run to their end (`job{kind:"slot", outcome:"ran"}`). */
const ranJobs = (job: ReturnType<typeof jobContext>) =>
  job.metric.mock.calls
    .filter(([name, tags]) => name === "job" && (tags as { kind?: string }).kind === "slot")
    .map(
      ([, tags]) =>
        `${(tags as { outcome?: string }).outcome === "ran" ? "" : "?"}${(tags as { reason?: string }).reason}`,
    );

async function plantExpired(): Promise<string> {
  const id = `dispatch${rand(12)}`;
  const at = new Date();
  await testDb()
    .insert(verification)
    .values({
      id,
      identifier: `dispatcher-test:${id}`,
      value: "x",
      expiresAt: new Date(Date.now() - 40 * 3_600_000),
      createdAt: at,
      updatedAt: at,
    });
  return id;
}
const verificationLeft = async (id: string) =>
  (await testDb().select().from(verification).where(eq(verification.id, id))).length;

describe("the registry", () => {
  it("holds exactly the eleven jobs, each on its expression, in run order", () => {
    expect(jobs.map((job) => job.name)).toEqual(Object.values(SLOTS).flat());
    expect(jobNames).toEqual(jobs.map((job) => job.name));
    for (const [cron, names] of Object.entries(SLOTS)) {
      expect(
        jobs.filter((job) => job.cron === cron).map((job) => job.name),
        cron,
      ).toEqual(names);
    }
    // The two expressions other modules name are the hourly and the nightly slot.
    expect(operatorDigests.cron).toBe(HOURLY_CRON);
    expect(verificationSweep.cron).toBe(NIGHTLY_CRON);
    expect([HOURLY_CRON, NIGHTLY_CRON]).toEqual(["3 * * * *", "5 0 * * *"]);
    // Those that destroy, and those that count the rollback detector's generation up, read it.
    expect(jobs.filter((job) => job.guarded).map((job) => job.name)).toEqual([
      "purge",
      "restore-heartbeat",
      "stale-uploads",
      "retention",
      "user-purge",
      "reconcile",
    ]);
    // The two that walk every account get twice the time.
    expect(softDeadlineOf("purge")).toBe(JOB_SOFT_DEADLINE_MS);
    expect([softDeadlineOf("user-purge"), softDeadlineOf("reconcile")]).toEqual([120_000, 120_000]);
    // A whole-database export gets ten minutes (T27 R-4), not the default.
    expect(softDeadlineOf("backup")).toBe(600_000);
  });

  it.each(Object.entries(SLOTS))(
    "%s runs exactly its jobs, in order, each handed its deadline — and a guarded job the slot's one reading of the detector",
    async (cron, names) => {
      const ran = watch(true);
      const job = jobContext();
      await expect(runScheduled(cronEvent(cron), env, ctx, job.bg)).resolves.toBeUndefined();
      expect(ran).toEqual(names);
      const readings = new Set<unknown>();
      for (const candidate of jobs.filter((entry) => entry.cron === cron)) {
        const opts = vi.mocked(candidate.run).mock.calls[0]![3]!;
        const { detection, ...rest } = opts;
        expect(rest).toEqual({ softDeadlineMs: softDeadlineOf(candidate.name) });
        expect(detection === undefined, candidate.name).toBe(!candidate.guarded);
        if (detection) readings.add(detection);
      }
      // One reading, handed to every guarded job of the slot; this file's numbers are in step.
      expect(readings.size).toBe(1);
      expect([...readings][0]).toMatchObject({ state: "ok" });
      // Each job that returned is counted as having run (R1 perfops-5: a slot killed mid-way, or a
      // trigger that stopped firing, shows as a missing `ran` — alerts.md C10); its own outcomes untouched.
      expect(ranJobs(job)).toEqual(names);
      expect(job.outcomes(names[0]!)).toEqual([]);
    },
  );

  it("an expression no job listens to — and an empty one — runs nothing", async () => {
    const ran = watch(true);
    for (const cron of ["59 23 31 12 *", "", "3 * * * * "]) {
      await runScheduled(cronEvent(cron), env, ctx, jobContext().bg);
    }
    expect(ran).toEqual([]);
  });

  it("m2-R5: a slot whose reading of the detector THROWS is not skipped: recorded, read as unknown — the guarded jobs are handed `unknown` (and stop), the others run", async () => {
    const ran = watch(true);
    vi.mocked(detectRollback).mockRejectedValueOnce(new Error("connection lost after a good reading"));
    const reported = vi.mocked(captureError).mock.calls.length;
    const job = jobContext();
    await expect(runScheduled(cronEvent("3 * * * *"), env, ctx, job.bg)).resolves.toBeUndefined();
    expect(ran).toEqual(["restore-heartbeat", "stale-uploads", "abuse-hourly", "operator-digests"]);
    for (const candidate of jobs.filter((entry) => entry.cron === "3 * * * *")) {
      const opts = vi.mocked(candidate.run).mock.calls[0]![3]!;
      expect(opts.detection, candidate.name).toEqual(candidate.guarded ? { state: "unknown" } : undefined);
    }
    expect(job.metric.mock.calls).toContainEqual(["job", { kind: "reconcile", outcome: "detector_error" }]);
    expect(vi.mocked(captureError).mock.calls.slice(reported)).toContainEqual([
      expect.objectContaining({ message: "connection lost after a good reading" }),
      { kind: "job", job: "detector" },
    ]);
  });

  it("a job that throws is counted and reported, and the next one still runs", async () => {
    const ran = watch(true);
    vi.mocked(jobs.find((job) => job.name === "stale-uploads")!.run).mockRejectedValueOnce(
      new Error("stale-uploads failed"),
    );
    const job = jobContext();
    await expect(runScheduled(cronEvent("3 * * * *"), env, ctx, job.bg)).resolves.toBeUndefined();
    expect(ran).toEqual(["restore-heartbeat", "abuse-hourly", "operator-digests"]);
    expect(job.metric.mock.calls).toContainEqual(["job", { kind: "stale-uploads", outcome: "error" }]);
    expect(job.outcomes("abuse-hourly")).toEqual([]);
    // The one that threw did not run to its end: counted as an error, never as run.
    expect(ranJobs(job)).toEqual(["restore-heartbeat", "abuse-hourly", "operator-digests"]);
  });

  it("does not resolve before a slow job has finished, and starts the next only after it", async () => {
    const ran = watch(true);
    const slow = gate();
    const started = gate();
    vi.mocked(jobs.find((job) => job.name === "retention")!.run).mockImplementationOnce(async () => {
      ran.push("retention");
      started.open();
      await slow.opened;
    });
    let resolved = false;
    const running = runScheduled(cronEvent("5 0 * * *"), env, ctx, jobContext().bg).then(() => {
      resolved = true;
    });
    await started.opened;
    // Every microtask and timer that is ready has run: it is still waiting for the job.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    expect(ran).toEqual(["retention"]);
    slow.open();
    await running;
    expect(ran).toEqual(["retention", "unpause-midnight", "verification-sweep"]);
  });

  it("runJob: one pass of one named job, and nothing that is not in the registry", async () => {
    const job = jobContext();
    await expect(runJob("no-such-job", job.bg)).rejects.toThrow("unknown job");
    await expect(runJob("purge; drop", job.bg)).rejects.toThrow("unknown job");
    // A job stopped at its deadline says that more is left.
    expect(await runJob("retention", job.bg, { softDeadlineMs: 0 })).toEqual({ done: false });
    const ran = watch(true);
    // A job that returns nothing is done. (Stubbed: abuse-hourly was a placeholder when this was
    // written and is a real, table-wide job since T22 — run for real it outlived the test on CI.)
    expect(await runJob("abuse-hourly", job.bg)).toEqual({ done: true });
    await runJob("reconcile", job.bg);
    await runJob("purge", job.bg, { softDeadlineMs: 5 });
    expect(ran).toEqual(["abuse-hourly", "reconcile", "purge"]);
    const reconcile = vi.mocked(jobs.find((entry) => entry.name === "reconcile")!.run).mock.calls[0]!;
    expect(reconcile[2].cron).toBe("0 2 * * *");
    expect(reconcile[3]).toEqual({ softDeadlineMs: 120_000 });
    expect(vi.mocked(jobs[0]!.run).mock.calls[0]![3]).toEqual({ softDeadlineMs: 5 });
  });
});

// R1 perfops-5: a 02:00 pass that is killed (CPU or wall time) never reaches the backup's tail, so
// its own `backup_missing` alarm never runs — and a slot that dies every night reports nothing.
// The 00:05 slot (on dev and prod alike) asks the same question about the night before, after its
// own jobs; `claimDaily` keeps it to one mail a day with the 02:00 tail.
describe("the watchdog: the 00:05 slot asks whether last night's backup completed", () => {
  const OPERATOR = `p7-watchdog-${rand()}@example.test`; // made up, reserved domain
  const claimedDays: string[] = [];
  afterAll(async () => {
    for (const day of claimedDays) {
      await testDb()
        .delete(downloadLedger)
        .where(and(eq(downloadLedger.day, day), eq(downloadLedger.subjectId, "backup_missing")));
    }
  });

  it("only the 00:05 slot runs it, once, AFTER its own jobs, at the slot's scheduled time", async () => {
    const ran = watch(true);
    const alarm = vi.mocked(backupMissingAlarm);
    alarm.mockClear();
    alarm.mockImplementationOnce(async () => {
      ran.push("watchdog");
      return "quiet";
    });
    for (const cron of Object.keys(SLOTS)) {
      ran.length = 0;
      const event = cronEvent(cron);
      const job = jobContext();
      await runScheduled(event, env, ctx, job.bg);
      if (cron === "5 0 * * *") {
        expect(ran, cron).toEqual([...SLOTS[cron]!, "watchdog"]);
        expect(alarm).toHaveBeenCalledTimes(1);
        expect(alarm.mock.calls[0]![0]).toBe(job.bg);
        expect(alarm.mock.calls[0]![1]).toEqual(new Date(event.scheduledTime));
      } else {
        expect(ran, cron).toEqual(SLOTS[cron]);
      }
    }
    expect(alarm).toHaveBeenCalledTimes(1);
  });

  it("a watchdog that throws is reported and counted; the slot still resolves", async () => {
    watch(true);
    vi.mocked(backupMissingAlarm).mockRejectedValueOnce(new Error("bucket unreadable"));
    const reported = vi.mocked(captureError).mock.calls.length;
    const job = jobContext();
    await expect(runScheduled(cronEvent("5 0 * * *"), env, ctx, job.bg)).resolves.toBeUndefined();
    expect(job.metric.mock.calls).toContainEqual([
      "job",
      { kind: "watchdog", outcome: "error", reason: "backup_missing" },
    ]);
    expect(vi.mocked(captureError).mock.calls.slice(reported)).toContainEqual([
      expect.objectContaining({ message: "bucket unreadable" }),
      { kind: "job", job: "watchdog", reason: "backup_missing" },
    ]);
  });

  it("for real: a night with no backup set → the next 00:05 mails backup_missing once, and that day's 02:00 tail finds the day claimed", async () => {
    watch(true);
    // A far-future day this test owns (2100–2199; the alarm file draws 2200–2999): no backup set
    // exists for the day before it, and no marker for it.
    let at: Date;
    for (;;) {
      const year = 2100 + (crypto.getRandomValues(new Uint32Array(1))[0]! % 100);
      const day = 1 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 28);
      at = new Date(Date.UTC(year, 5, day, 0, 5, 0));
      const iso = at.toISOString().slice(0, 10);
      const [taken] = await testDb()
        .select({ day: downloadLedger.day })
        .from(downloadLedger)
        .where(eq(downloadLedger.day, iso))
        .limit(1);
      if (!taken) break;
    }
    claimedDays.push(at.toISOString().slice(0, 10));
    const criticals = () =>
      outbox({ to: OPERATOR }).filter(
        (mail) =>
          mail.template === "operatorCritical" && (mail.text ?? "").includes("backup did not complete"),
      );
    const job = jobContext({ env: { ADMIN_EMAILS: OPERATOR } });
    await runScheduled({ cron: "5 0 * * *", scheduledTime: at.getTime(), noRetry() {} }, env, ctx, job.bg);
    expect(criticals()).toHaveLength(1);
    // The same day's 02:00 tail: already said.
    const tail = new Date(at.getTime() + (2 * 60 - 5) * 60_000);
    expect(await backupMissingAlarm(jobContext({ env: { ADMIN_EMAILS: OPERATOR } }).bg, tail)).toBe(
      "claimed",
    );
    expect(criticals()).toHaveLength(1);
  });
});

describe("the four cron expressions, with the real jobs", () => {
  it(
    "every slot runs its jobs without error — through runScheduled and through scheduled() alike",
    async () => {
      for (const entry of [runScheduled, scheduled]) {
        // A row the local store cannot settle: a stale session with a made-up multipart id.
        const owner = await member();
        await makeUpload(owner.id, owner.id, {
          status: "completing",
          completingAt: new Date(Date.now() - 2 * 3_600_000),
          r2UploadId: "made-up-multipart-id",
        });
        for (const [cron, names] of Object.entries(SLOTS)) {
          const ran = watch(false);
          // T21 (R4, Addendum 3 Q5): abuse-hourly runs for real here, but its pending-scan part
          // would send real scan messages for whatever pending nodes other runs left behind.
          vi.spyOn(abuseParts, "sweepPendingScans").mockResolvedValue({ checked: 0, requeued: 0 });
          const job = jobContext();
          await expect(entry(cronEvent(cron), env, ctx, job.bg)).resolves.toBeUndefined();
          await job.settle();
          expect(ran, `${entry.name} ${cron}`).toEqual(names);
          // No job of the slot failed. (A job counts an error of its own for ONE row it could not
          // settle and goes on — over whatever other files left behind, e.g. a session with a
          // made-up multipart id, which the local store refuses with an internal error where R2
          // answers "no such upload": the jobs' own files test that behaviour.)
          expect(threw, `${entry.name} ${cron}`).toEqual([]);
          vi.restoreAllMocks();
        }
      }
    },
    2 * 4 * REAL_RUN_MS,
  );

  it(
    "the hourly slot flushes the operator digests once and does not sweep; the nightly slot sweeps",
    async () => {
      const flush = vi.mocked(flushOperatorDigests);
      const sweep = vi.mocked(sweepExpiredVerifications);
      const expired = await plantExpired();
      flush.mockClear();
      sweep.mockClear();

      await runScheduled(cronEvent(HOURLY_CRON), env, ctx, jobContext().bg);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(sweep).not.toHaveBeenCalled();
      expect(await verificationLeft(expired)).toBe(1);

      await runScheduled(cronEvent(NIGHTLY_CRON), env, ctx, jobContext().bg);
      expect(sweep).toHaveBeenCalled();
      expect(flush).toHaveBeenCalledTimes(1);
      expect(await verificationLeft(expired)).toBe(0);

      // The other two slots do neither.
      flush.mockClear();
      sweep.mockClear();
      const later = await plantExpired();
      await runScheduled(cronEvent("17 */6 * * *"), env, ctx, jobContext().bg);
      await runScheduled(cronEvent("0 2 * * *"), env, ctx, jobContext().bg);
      expect(flush).not.toHaveBeenCalled();
      expect(sweep).not.toHaveBeenCalled();
      expect(await verificationLeft(later)).toBe(1);
    },
    4 * REAL_RUN_MS,
  );
});
