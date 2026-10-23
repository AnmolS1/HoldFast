// The registry of scheduled jobs: the only thing `scheduled.ts` knows, and the allow-list of the
// admin console's "run job".
//
//   17 */6 * * *   purge
//   3 * * * *      restore-heartbeat, stale-uploads, abuse-hourly, operator-digests
//   5 0 * * *      retention, unpause-midnight, verification-sweep   + watchdog: backup_missing
//   0 2 * * *      backup, user-purge, reconcile        (backup FIRST: that night's purges must
//                                                         still be in that night's export)
//
// A job is `export const job: Job` in jobs/<name>.ts. Three files here are placeholders (a no-op
// with the right cron): their owners replace the file's body and never touch this one.
//
// A job file imports from this module AS A TYPE ONLY. This module imports every job; a job that
// imported a value from here would close a cycle, and whichever of the two is loaded first would
// read the other's `const` before it exists.
//
// A DATABASE THAT HAS GONE BACK IN TIME (a restore) destroys nothing. A slot with a `guarded` job
// reads the rollback detector once, before its first job (reconcile.ts#detectRollback), and hands
// that reading to each guarded job, which checks it at its start (`mayDestroy`) — purge,
// user-purge, retention, stale-uploads and the orphan sweep stop; `restore-heartbeat` and
// reconcile do not count the generation up. The other jobs run as usual. `runJob` hands no
// reading: a guarded job then reads for itself.
//
// WATCHDOGS. A slot that is killed (CPU or wall time) runs no `finally`, so an alarm in a job's
// own tail never fires on the night it is needed — and a slot that dies every night says nothing.
// A watchdog is that alarm, run by ANOTHER slot after its jobs (R1 perfops-5): today one, the
// 00:05 slot asking whether the 02:00 backup of the night before completed (`backup_missing`,
// one mail per UTC day shared with the backup's tail). It is not a job: "run job" does not list
// it. A cron that never fires at all is not seen from inside — that check is external
// (runbooks/alerts.md).
//
// BUDGET. Every job works in bounded batches, looks at the clock after each and stops at the
// soft deadline it is handed, leaving the rest — which is still due — for the next tick. Nothing
// a job starts is left running when it returns: the database client is closed once the handler
// resolves, and deferred work is cancelled 30 s after it.

import { captureError } from "../sentry";
import type { BackgroundContext } from "../services/request-context";
import { job as abuseHourly } from "./abuse-hourly";
import { backupMissingAlarm, job as backup } from "./backup";
import { job as operatorDigests } from "./operator-digests";
import { job as purge } from "./purge";
import { detectRollback, job as reconcile, type Detection } from "./reconcile";
import { job as restoreHeartbeat } from "./restore-heartbeat";
import { job as retention } from "./retention";
import { job as staleUploads } from "./stale-uploads";
import { job as unpauseMidnight } from "./unpause-midnight";
import { job as userPurge } from "./user-purge";
import { job as verificationSweep } from "./verification-sweep";

export type JobRunOptions = {
  /** Stop starting new batches this long after the run began. */
  softDeadlineMs?: number;
  /** The slot's reading of the rollback detector — for a `guarded` job only. */
  detection?: Detection;
};

/** `done: false` — the job stopped at its deadline with work left; the next tick continues. */
export type JobResult = { done: boolean };

export type Job = {
  name: string;
  /** One of the four expressions of wrangler.jsonc `triggers.crons`, exactly. */
  cron: string;
  /** It destroys, or counts the rollback detector's generation up: it reads the detector. */
  guarded?: true;
  /** Returning nothing means done. */
  run(
    bg: BackgroundContext,
    env: Env,
    event: ScheduledController,
    opts?: JobRunOptions,
  ): Promise<void | JobResult>;
};

/** A job's soft deadline, unless it is named below. */
export const JOB_SOFT_DEADLINE_MS = 60_000;
/** The two that walk every account. */
const LONG_SOFT_DEADLINE_MS = 120_000;
const SOFT_DEADLINES: Record<string, number> = {
  "user-purge": LONG_SOFT_DEADLINE_MS,
  reconcile: LONG_SOFT_DEADLINE_MS,
  // A whole-database export: 10 minutes, not the 60 s default it was getting (T27 R-4).
  backup: 600_000,
};

export const softDeadlineOf = (name: string): number => SOFT_DEADLINES[name] ?? JOB_SOFT_DEADLINE_MS;

/** In run order. The jobs of one cron expression run in the order they have here. */
export const jobs: Job[] = [
  purge,
  restoreHeartbeat,
  staleUploads,
  abuseHourly,
  operatorDigests,
  retention,
  unpauseMidnight,
  verificationSweep,
  backup,
  userPurge,
  reconcile,
];

/** Per cron expression: the other slots' alarms it runs after its own jobs, in this order. */
const WATCHDOGS: Record<
  string,
  Array<{ name: string; run(bg: BackgroundContext, at: Date): Promise<unknown> }>
> = {
  "5 0 * * *": [{ name: "backup_missing", run: (bg, at) => backupMissingAlarm(bg, at) }],
};

/** What "run job" may name. */
export const jobNames: string[] = jobs.map((job) => job.name);

/**
 * The cron entry's whole body: the jobs whose `cron` is this event's, one after the other, each
 * awaited — after one reading of the rollback detector when the slot has a guarded job — then the
 * slot's watchdogs. A job or watchdog that throws is reported and counted, and the next one still
 * runs.
 */
export async function runScheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  void ctx;
  const slot = jobs.filter((job) => job.cron === event.cron);
  // Once per slot, before any job of it runs. It is not meant to throw (what it cannot read is
  // `unknown`); should it all the same, the slot goes on as `unknown` — recorded — so the jobs
  // that destroy stop and the others still run.
  let detection: Detection | undefined;
  if (slot.some((job) => job.guarded)) {
    try {
      detection = await detectRollback(bg);
    } catch (error) {
      captureError(error, { kind: "job", job: "detector" });
      bg.metric("job", { kind: "reconcile", outcome: "detector_error" });
      detection = { state: "unknown" };
    }
  }
  for (const job of slot) {
    try {
      await job.run(bg, env, event, {
        softDeadlineMs: softDeadlineOf(job.name),
        ...(job.guarded ? { detection } : {}),
      });
    } catch (error) {
      captureError(error, { kind: "job", job: job.name });
      bg.metric("job", { kind: job.name, outcome: "error" });
    }
  }
  // At the slot's own time: a run that started late still asks about the night before it.
  for (const watchdog of WATCHDOGS[event.cron] ?? []) {
    try {
      await watchdog.run(bg, new Date(event.scheduledTime));
    } catch (error) {
      captureError(error, { kind: "job", job: "watchdog", reason: watchdog.name });
      bg.metric("job", { kind: "watchdog", outcome: "error", reason: watchdog.name });
    }
  }
}

/**
 * One bounded pass of one job, outside its schedule — for the admin console, and nothing else.
 * An unknown name throws; so does the job's own failure (the caller reports it).
 */
export async function runJob(
  name: string,
  bg: BackgroundContext,
  opts: JobRunOptions = {},
): Promise<JobResult> {
  const job = jobs.find((candidate) => candidate.name === name);
  if (!job) throw new Error("unknown job");
  const event: ScheduledController = { cron: job.cron, scheduledTime: Date.now(), noRetry() {} };
  const result = await job.run(bg, bg.env, event, {
    softDeadlineMs: opts.softDeadlineMs ?? softDeadlineOf(name),
  });
  return { done: result ? result.done : true };
}
