// Two repairs, both resumable over several nights through one cursor (`settings.reconcileCursor`).
//
// QUOTA. Every account's `used_bytes` is recomputed from its rows (queries/quota.ts: the user
// row is locked, and the value is written only when it differs). The formula counts trashed,
// hidden and held files, kept versions and the reservations of unfinished uploads — a formula
// without the reservations would wipe every upload in flight each night. A difference is drift:
// counted per account (the metric), and recorded once a run as `system.reconcile` (how many
// accounts, how many were off, the bytes corrected). This half is never gated.
//
// ORPHANS. Objects under `u/`, `t/` and `a/` that no row references and that are older than 48
// hours are deleted. That is the one place where a database that is OLDER than the bucket —
// after a point-in-time or backup restore — would erase every object uploaded since the restore
// point. Three guards, all required:
//   (a) it runs only while `settings.orphanDeleteEnabled` is not false. The restore runbook turns
//       it off as its FIRST step. The setting is read twice — as this run was given it, and fresh
//       from the table, past the 60 s cache — and either one saying "off" is off.
//   (b) a run lists first and deletes afterwards, and deletes NOTHING when the candidates exceed
//       max(500, 1 % of the objects it listed): it alerts (`orphan_threshold`) and keeps its
//       place, so it alerts again every night until someone has looked.
//   (c) the 48-hour floor, on the object's own upload time.
// AND A FOURTH THAT DOES NOT LIVE IN THE DATABASE — and it stops every job that destroys, not
// only this sweep. Guard (a) is a row of the very database a restore puts back (with the value it
// had then), and guard (b) only sees one run's window. So a GENERATION number is counted up every
// hour (the `restore-heartbeat` job, first in the hourly slot) and by every reconcile run that
// completes — in the database (inside the cursor value) and then in one small object,
// `sys/reconcile-generation`, outside the swept areas. The registry reads both once per slot,
// before any job of the slot destroys anything (`detectRollback`); a job run on its own reads them
// itself (`mayDestroy`):
//   object  >  database    the database has gone back in time: a ROLLBACK.
//   no object, database>0  the object was lost, or deleted to silence the alert: treated as a
//                          rollback, exactly.
//   unreadable object      proves nothing either way: a rollback too.
//   no object, database 0  the first run ever: the object is written; this sweep deletes nothing.
//   object  <= database    normal (the database ahead means an object write failed: it is
//                          written again at the next count).
//   cannot read either     `unknown`: nothing is destroyed this slot (no alert: it is no rollback).
// On a rollback it is recorded at every reading (`rollback_detected`, the report, a
// `system.database_rollback` audit row), the operators are mailed on the transition into it and
// then at most every 6 hours, and NOTHING is destroyed — purge, account purge, retention, stale uploads, orphans — by this
// slot or any later one — nor by a user's "delete forever", which takes the held path (marker,
// same answer; routes/trash.ts) — and the number is not counted up, until an operator brings the two
// numbers level, deliberately, after looking. The non-destructive jobs and the quota half run.
// Writers: the database is counted up by compare-and-set only (from the number that was read),
// then the object is written; both writers hold one job lock (`GENERATION_LOCK`), so two runs do
// not overlap. Readers read the object FIRST, then the database: a count in flight can then look
// "database ahead" (normal), never "object ahead".
// What it cannot see: a restore to a point after the last count (≤ one hour; the restore runbook
// pauses the jobs before restoring).
// Rows first, objects second everywhere else is what makes an unreferenced old object garbage:
// a purge deletes its rows and then its objects, an upload writes its session row first.

import type { Executor } from "../db/client";
import { getSettings } from "../db/queries/settings";
import { reconcileUsedBytes } from "../db/queries/quota";
import {
  advanceGenerationRow,
  clearRollbackMailed,
  knownVersions,
  markRollbackMailed,
  referencedKeys,
  saveReconcilePlace,
  userIdsAfter,
  withJobLock,
} from "../db/queries/trash-jobs";
import { captureError } from "../sentry";
import { auditInTx } from "../services/audit";
import { sendOperatorCritical } from "../services/email";
import { coreFor, type BackgroundContext } from "../services/request-context";
import { adminListOf } from "../services/signup-policy";
import { AVATAR_PREFIX, type ListedObject, storage, THUMB_PREFIX, UPLOAD_PREFIX } from "../services/storage";
import type { Job } from "./index";

export const ORPHAN_MIN_AGE_MS = 48 * 3_600_000;
export const ORPHAN_THRESHOLD_FLOOR = 500;
export const ORPHAN_THRESHOLD_SHARE = 0.01;
/** The areas the sweep walks, in order. `b/` (backups) is not one of them. */
export const ORPHAN_AREAS = [UPLOAD_PREFIX, THUMB_PREFIX, AVATAR_PREFIX] as const;
/** List pages (1,000 objects each) one run reads at most. */
export const ORPHAN_MAX_PAGES = 200;
const USER_BATCH = 200;
const DEFAULT_SOFT_DEADLINE_MS = 120_000;

/** Where the next run continues. Each half starts over once it has reached its end. */
export type ReconcileCursor = {
  /** The last account reconciled; null = start from the first. */
  user: string | null;
  /** Index into `ORPHAN_AREAS`, and the store's list cursor inside that area (null = its start). */
  area: number;
  object: string | null;
  /** How many times the generation was counted up. Its twin is the object `GENERATION_KEY`. */
  generation: number;
};

const START: ReconcileCursor = { user: null, area: 0, object: null, generation: 0 };

/** Where the generation is kept outside the database: no swept area, and no upload prefix. */
export const GENERATION_KEY = "sys/reconcile-generation";

/** The stored cursor, or the start for anything that is not one (it is `unknown` in the table). */
export function readCursor(stored: unknown): ReconcileCursor {
  if (!stored || typeof stored !== "object") return { ...START };
  const value = stored as Partial<ReconcileCursor>;
  const area =
    typeof value.area === "number" && Number.isInteger(value.area) && value.area >= 0 ? value.area : 0;
  const inRange = area < ORPHAN_AREAS.length;
  return {
    user: typeof value.user === "string" && value.user !== "" ? value.user : null,
    area: inRange ? area : 0,
    object: inRange && typeof value.object === "string" && value.object !== "" ? value.object : null,
    generation: asGeneration(value.generation) ?? 0,
  };
}

/**
 * THE rule for a generation number, wherever it is read: a non-negative safe integer, else
 * null. The database's copy is read by this (above) and by its SQL twin
 * (trash-jobs.ts#storedGeneration: a jsonb number, integral, 0 … 2^53 − 1) — `7.0` is 7 in both,
 * `7.5` nothing in both. The object's text must be digits that pass it.
 */
export function asGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// ── the rollback detector ───────────────────────────────────────────────────────────────────

/** The job lock of everything that counts the generation up: this job and `restore-heartbeat`. */
export const GENERATION_LOCK = "generation";
/** How long the lock's idle transaction may stay open: past any run (a cron runs ≤ 15 min). */
export const GENERATION_LOCK_HOLD_MS = 15 * 60_000;

/**
 * What one reading found. `ok` / `first`: jobs may destroy (`first`: but this sweep deletes
 * nothing); `database` is the number read, the one a count starts from. `rollback`, `unknown`:
 * nothing is destroyed.
 */
export type Detection = { state: "ok" | "first"; database: number } | { state: "rollback" | "unknown" };
export type GenerationState = Detection["state"];

/** The object's number; null when there is no object; NaN when it holds anything but a number. */
async function storedGeneration(env: Env): Promise<number | null> {
  const found = await storage(env).get(GENERATION_KEY);
  if (found === null || found.kind !== "body") return null;
  const text = (await found.object.text()).trim();
  // Anything else proves nothing either way: an anomaly, read as a rollback.
  return (/^[0-9]+$/.test(text) ? asGeneration(Number(text)) : null) ?? Number.NaN;
}

async function writeGeneration(env: Env, generation: number): Promise<void> {
  const body = new TextEncoder().encode(String(generation));
  await storage(env).put(GENERATION_KEY, body, { size: body.byteLength, contentType: "text/plain" });
}

/**
 * How the two numbers read: the one rule for the jobs and for a request. `first`: nothing has
 * been counted yet — no object, or the "1" the very first count writes BEFORE it moves the
 * database 0 → 1 (an object write that failed leaves the database at 0, a database write that
 * failed leaves this: either way the next count simply tries again, and no transient failure
 * reads as a rollback). Accepted: a restore to before that first count is not seen.
 */
function classify(object: number | null, database: number): "ok" | "first" | "rollback" {
  if (database === 0 && (object === null || object === 1)) return "first";
  // A missing object while the database has counted, an unreadable one, or one ahead.
  return object !== null && object <= database ? "ok" : "rollback";
}

/** A rollback mails the operators at once, then at most this often while it lasts. */
export const ROLLBACK_MAIL_EVERY_MS = 6 * 3_600_000;

/** When the operators were last mailed about the rollback that is going on (cursor field). */
function lastMailed(stored: unknown): number | null {
  const at =
    stored && typeof stored === "object" ? (stored as { rollbackMailedAt?: unknown }).rollbackMailedAt : null;
  const time = typeof at === "string" ? Date.parse(at) : Number.NaN;
  return Number.isFinite(time) ? time : null;
}

/**
 * Compares the object's generation with the database's — the object FIRST: a writer counts the
 * database up first and the object after, so a count in flight reads "database ahead" (normal),
 * never "object ahead". Never throws: what cannot be read is `unknown` (reported and counted).
 * A rollback is recorded at every reading (the metric, the report, a `system.database_rollback`
 * audit row) and MAILED on the transition into it, then at most every 6 hours while it lasts.
 */
export async function detectRollback(bg: BackgroundContext): Promise<Detection> {
  let object: number | null;
  let stored: unknown;
  try {
    object = await storedGeneration(bg.env);
    stored = (await getSettings(bg.db, { fresh: true })).reconcileCursor;
  } catch (error) {
    captureError(error, { kind: "job", job: "reconcile", reason: "detector" });
    bg.metric("job", { kind: "reconcile", outcome: "detector_error" });
    return { state: "unknown" };
  }
  const database = readCursor(stored).generation;
  const mailed = lastMailed(stored);
  const state = classify(object, database);
  // A reading writes no number: only a count, under the lock, does.
  if (state === "first") return { state, database };
  if (state === "ok") {
    // Over: the next rollback is a transition again, and mails at once.
    if (mailed !== null) await clearRollbackMailed(bg.db);
    return { state, database };
  }
  bg.metric("job", { kind: "reconcile", outcome: "rollback_detected" });
  await recordRollback(bg, object, database);
  if (mailed === null || Date.now() - mailed >= ROLLBACK_MAIL_EVERY_MS) {
    if (await mailRollback(bg)) await markRollbackMailed(bg.db, new Date());
  }
  return { state: "rollback" };
}

/**
 * For a request (a user's "delete forever"): does the database read as rolled back? Read the
 * way `detectRollback` reads — the object first — and FAIL CLOSED: what cannot be read is a
 * rollback here. Writes, counts and alerts nothing (the jobs do); one settings statement.
 */
export async function readsRolledBack(env: Env, db: Executor): Promise<boolean> {
  try {
    const object = await storedGeneration(env);
    const database = readCursor((await getSettings(db, { fresh: true })).reconcileCursor).generation;
    return classify(object, database) === "rollback";
  } catch (error) {
    captureError(error, { kind: "purge_rollback_check" });
    return true;
  }
}

/**
 * The gate at the start of every job that destroys: true when it may. `given` is the slot's
 * reading (the registry's); without one the job reads for itself — never "allowed" by default.
 */
export async function mayDestroy(
  bg: BackgroundContext,
  given: Detection | undefined,
  job: string,
): Promise<boolean> {
  const detection = given ?? (await detectRollback(bg));
  if (detection.state === "ok" || detection.state === "first") return true;
  bg.metric("job", { kind: job, outcome: "rollback_stopped" });
  return false;
}

/**
 * Counts the generation up. Call it holding `GENERATION_LOCK`. It counts from a reading taken
 * HERE, under the lock, immediately before — never from the slot's earlier one: a restore that
 * landed since (back past a heartbeat that counted meanwhile) reads as a rollback now, and nothing
 * is counted (the rollback path: recorded, alerted). Then:
 *   first  the object "1" FIRST, then the database 0 → 1 by compare-and-set;
 *   ok     the database by compare-and-set, then — only if that moved it — the object (a failure
 *          in between leaves the database ahead of an object that exists: normal, repaired at
 *          the next count).
 * False when nothing was counted.
 */
export async function advanceGeneration(bg: BackgroundContext): Promise<boolean> {
  const reading = await detectRollback(bg);
  if (reading.state === "first") {
    await writeGeneration(bg.env, 1);
    return countRow(bg, 0);
  }
  if (reading.state !== "ok") return false;
  if (!(await countRow(bg, reading.database))) return false;
  await writeGeneration(bg.env, reading.database + 1);
  return true;
}

async function countRow(bg: BackgroundContext, from: number): Promise<boolean> {
  if (await advanceGenerationRow(bg.db, from)) return true;
  bg.metric("job", { kind: "reconcile", outcome: "generation_conflict" });
  return false;
}

/**
 * The record of one rollback reading — every reading: the report and an audit row (in a
 * transaction of its own; a failure is reported, never thrown: the jobs stay stopped anyway).
 */
async function recordRollback(bg: BackgroundContext, object: number | null, database: number): Promise<void> {
  captureError(
    new Error("reconcile: the database is older than the object store; every destructive job is stopped"),
    { kind: "job", job: "reconcile", reason: "rollback_detected" },
  );
  try {
    await bg.db.transaction((tx) =>
      auditInTx(
        tx,
        bg,
        "system.database_rollback",
        { type: "job", id: "reconcile" },
        { database, object: object === null || Number.isNaN(object) ? null : object },
      ),
    );
  } catch (error) {
    captureError(error, { kind: "job", job: "reconcile" });
  }
}

/**
 * The critical mail to every operator, sent at once (never counted or coalesced). ONE call
 * site. Awaited: nothing a job starts may outlive it. True when at least one was handed over;
 * when none was, the next reading mails again.
 */
async function mailRollback(bg: BackgroundContext): Promise<boolean> {
  const operators = [...adminListOf(bg.env).addresses];
  const sent = await Promise.all(
    operators.map((to) =>
      sendOperatorCritical(bg, { to, event: "database_rollback" }).then(
        () => true,
        (error: unknown) => {
          captureError(error, { kind: "job", job: "reconcile" });
          return false;
        },
      ),
    ),
  );
  return sent.includes(true);
}

// ── quota ───────────────────────────────────────────────────────────────────────────────────

export type QuotaPass = {
  next: string | null;
  done: boolean;
  /**
   * Accounts looked at, how many were off, the sum of what was corrected (bytes, signed), and
   * how many could not be reconciled (skipped; the next pass tries them again).
   */
  accounts: number;
  drifted: number;
  delta: number;
  failed: number;
};

/** Accounts after `after`, in id order, until the end (`done`) or `stopAt`. */
export async function reconcileQuotas(
  bg: BackgroundContext,
  opts: { after: string | null; stopAt: number },
): Promise<QuotaPass> {
  let after = opts.after;
  let accounts = 0;
  let drifted = 0;
  let delta = 0;
  let failed = 0;
  for (;;) {
    const ids = await userIdsAfter(bg.db, after, USER_BATCH);
    if (ids.length === 0) return { next: null, done: true, accounts, drifted, delta, failed };
    for (const id of ids) {
      after = id;
      accounts += 1;
      try {
        const result = await reconcileUsedBytes(bg.db, id);
        if (result && result.delta !== 0) {
          drifted += 1;
          delta += result.delta;
          bg.metric("job", { kind: "reconcile", outcome: "drift" });
        }
      } catch (error) {
        // One account that cannot be reconciled — a deadlock, a timeout, a row that breaks the
        // formula — must not stop the night: it is skipped, and the next pass comes back to it.
        failed += 1;
        captureError(error, { kind: "job", job: "reconcile" });
        bg.metric("job", { kind: "reconcile", outcome: "error" });
      }
      if (Date.now() >= opts.stopAt) return { next: after, done: false, accounts, drifted, delta, failed };
    }
  }
}

/**
 * The record of one quota pass: ONE row a run, counts only — not a row per account. A night
 * after a restore can correct thousands of accounts, and an invocation defers at most a hundred
 * follow-ups (shared with the other jobs of the slot): a row per account through `audit()` was
 * dropped from the 101st on. This one is awaited, after the pass's own transactions.
 */
async function recordQuotaPass(bg: BackgroundContext, pass: QuotaPass): Promise<void> {
  try {
    await bg.db.transaction((tx) =>
      auditInTx(
        tx,
        bg,
        "system.reconcile",
        { type: "job", id: "reconcile" },
        { accounts: pass.accounts, drifted: pass.drifted, delta: pass.delta, failed: pass.failed },
      ),
    );
  } catch (error) {
    // The corrections stand, and the sweep must still run.
    captureError(error, { kind: "job", job: "reconcile" });
  }
}

// ── orphans ─────────────────────────────────────────────────────────────────────────────────

export type OrphanSweep = {
  outcome: "swept" | "disabled" | "orphan_threshold";
  listed: number;
  candidates: number;
  deleted: number;
  /** Where the next run continues (unchanged when nothing was deleted on purpose). */
  area: number;
  object: string | null;
  /** The sweep reached the end of the last area. */
  done: boolean;
};

/** `t/<nodeId>/<versionId>/<size>.webp` → its node and version; null for anything else. */
function thumbOwner(key: string): { nodeId: string; versionId: string } | null {
  const parts = key.slice(THUMB_PREFIX.length).split("/");
  if (parts.length !== 3) return null;
  const [nodeId, versionId] = parts as [string, string, string];
  return nodeId && versionId ? { nodeId, versionId } : null;
}

/** The objects of one page that no row references. */
async function unreferenced(bg: BackgroundContext, area: string, objects: ListedObject[]): Promise<string[]> {
  if (objects.length === 0) return [];
  if (area !== THUMB_PREFIX) {
    const referenced = await referencedKeys(
      bg.db,
      objects.map((object) => object.key),
    );
    return objects.filter((object) => !referenced.has(object.key)).map((object) => object.key);
  }
  // A thumbnail belongs to a version: it is garbage when that (node, version) no longer exists.
  // A key that does not read as a thumbnail is left alone.
  const owners = objects.map((object) => ({ key: object.key, owner: thumbOwner(object.key) }));
  const known = await knownVersions(
    bg.db,
    owners.flatMap((entry) => (entry.owner ? [entry.owner.nodeId] : [])),
  );
  return owners
    .filter((entry) => entry.owner && !known.has(`${entry.owner.nodeId}/${entry.owner.versionId}`))
    .map((entry) => entry.key);
}

/**
 * One bounded sweep from `from`. `now` is what an object's age is measured against — the store
 * stamps `uploaded` itself and it cannot be set, so this is the one clock a test can move; it
 * touches nothing but that comparison.
 */
export async function sweepOrphans(
  bg: BackgroundContext,
  opts: { from: Pick<ReconcileCursor, "area" | "object">; stopAt: number; now?: Date; maxPages?: number },
): Promise<OrphanSweep> {
  const start = { area: opts.from.area, object: opts.from.object };
  const idle = { listed: 0, candidates: 0, deleted: 0, ...start, done: false };
  // Guard (a), read both ways: what this run was given, and the table as it is this instant.
  const given = await bg.settings();
  // (Through the injected reader, like every other setting: a test can then say what the table says.)
  const fresh = await coreFor(bg).getSettings(bg.db, { fresh: true });
  if (given.orphanDeleteEnabled === false || fresh.orphanDeleteEnabled === false) {
    bg.metric("job", { kind: "reconcile", outcome: "orphan_disabled" });
    return { outcome: "disabled", ...idle };
  }

  const store = storage(bg.env);
  const oldBefore = (opts.now ?? new Date()).getTime() - ORPHAN_MIN_AGE_MS;
  const maxPages = opts.maxPages ?? ORPHAN_MAX_PAGES;
  let { area, object } = start;
  let listed = 0;
  let done = false;
  const candidates: string[] = [];
  // What the run had counted when it entered the area it is in: an area that has to be started
  // again is counted once, not once more for every page already read.
  let entered = { listed: 0, candidates: 0 };

  // The dry run: list, and note what would go. Nothing is deleted in this loop.
  for (let pages = 0; pages < maxPages; pages++) {
    const prefix = ORPHAN_AREAS[area]!;
    let page: Awaited<ReturnType<typeof store.list>>;
    try {
      page = await store.list(prefix, object ?? undefined);
    } catch (error) {
      // A list cursor does not live for ever: the area is started again — from nothing.
      if (object === null) throw error;
      object = null;
      listed = entered.listed;
      candidates.length = entered.candidates;
      continue;
    }
    listed += page.objects.length;
    // Guard (c).
    const old = page.objects.filter((entry) => entry.uploaded.getTime() <= oldBefore);
    candidates.push(...(await unreferenced(bg, prefix, old)));
    object = page.cursor;
    if (object === null) {
      area += 1;
      entered = { listed, candidates: candidates.length };
      if (area >= ORPHAN_AREAS.length) {
        area = 0;
        done = true;
        break;
      }
    }
    if (Date.now() >= opts.stopAt) break;
  }

  // Guard (b).
  const threshold = Math.max(ORPHAN_THRESHOLD_FLOOR, ORPHAN_THRESHOLD_SHARE * listed);
  if (candidates.length > threshold) {
    bg.metric("job", { kind: "reconcile", outcome: "orphan_threshold" }, candidates.length);
    captureError(new Error("reconcile: orphan candidates exceed the threshold; nothing was deleted"), {
      kind: "job",
      job: "reconcile",
    });
    // Its place is kept: the same objects are looked at, and alerted on, until someone has looked.
    return { outcome: "orphan_threshold", ...idle, listed, candidates: candidates.length };
  }

  await store.delete(candidates);
  bg.metric("job", { kind: "reconcile", outcome: "orphans" }, candidates.length);
  return {
    outcome: "swept",
    listed,
    candidates: candidates.length,
    deleted: candidates.length,
    area,
    object,
    done,
  };
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────

export type ReconcileRun = {
  done: boolean;
  /** What the run read (`overlap`: another run held the lock, and this one did nothing). */
  generation: GenerationState | "overlap";
  sweep: OrphanSweep | null;
};

/**
 * One run, holding `GENERATION_LOCK` (a second run started meanwhile exits at once, counted).
 * `detection` is the slot's reading; without one the run reads for itself. `now` is the sweep's
 * (an object's age cannot be set: see `sweepOrphans`).
 */
export async function runReconcile(
  bg: BackgroundContext,
  opts: { softDeadlineMs: number; now?: Date; detection?: Detection },
): Promise<ReconcileRun> {
  const locked = await withJobLock(bg.db, GENERATION_LOCK, GENERATION_LOCK_HOLD_MS, () =>
    reconcileOnce(bg, opts),
  );
  if (locked.held) return locked.value;
  bg.metric("job", { kind: "reconcile", outcome: "overlap" });
  return { done: true, generation: "overlap", sweep: null };
}

async function reconcileOnce(
  bg: BackgroundContext,
  opts: { softDeadlineMs: number; now?: Date; detection?: Detection },
): Promise<ReconcileRun> {
  const startedAt = Date.now();
  const detection = opts.detection ?? (await detectRollback(bg));
  const place = readCursor((await getSettings(bg.db, { fresh: true })).reconcileCursor);

  let quota: QuotaPass | null = null;
  let sweep: OrphanSweep | null = null;
  // `completed`: the run got to its end — only then is the generation counted up.
  let completed = false;
  try {
    // The quota half is never gated, and its failure does not stop the sweep.
    try {
      // Half the budget each, so a long quota pass never starves the sweep (and the reverse).
      quota = await reconcileQuotas(bg, { after: place.user, stopAt: startedAt + opts.softDeadlineMs / 2 });
    } catch (error) {
      captureError(error, { kind: "job", job: "reconcile" });
      bg.metric("job", { kind: "reconcile", outcome: "error" });
    }
    if (quota) await recordQuotaPass(bg, quota);
    if (detection.state === "ok") {
      sweep = await sweepOrphans(bg, { from: place, stopAt: startedAt + opts.softDeadlineMs, now: opts.now });
    }
    completed = true;
  } finally {
    // Whatever happened, each half keeps its place; the generation in the same value is not
    // touched here.
    await saveReconcilePlace(bg.db, {
      user: quota ? quota.next : place.user,
      area: sweep ? sweep.area : place.area,
      object: sweep ? sweep.object : place.object,
    });
  }
  // A rolled-back (or unread) database is never counted up by the job: only an operator acts.
  // Counted from a reading taken now, under the lock (the slot's one only gated the sweep).
  if (completed && (detection.state === "ok" || detection.state === "first")) await advanceGeneration(bg);
  return {
    done: quota !== null && quota.done && sweep !== null && sweep.outcome === "swept" && sweep.done,
    generation: detection.state,
    sweep,
  };
}

export const job: Job = {
  name: "reconcile",
  cron: "0 2 * * *",
  guarded: true,
  async run(bg, _env, _event, opts) {
    const { done } = await runReconcile(bg, {
      softDeadlineMs: opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS,
      detection: opts?.detection,
    });
    return { done };
  },
};
