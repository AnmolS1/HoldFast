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
// AND A FOURTH THAT DOES NOT LIVE IN THE DATABASE. Guard (a) is a row of the very database a
// restore puts back (with the value it had then), and guard (b) only sees one run's window. So
// every run that completes counts a GENERATION up — in the database (inside the cursor value)
// and then in one small object, `sys/reconcile-generation`, outside the swept areas. A run
// starts by reading both, before any orphan decision:
//   object  >  database    the database has gone back in time. No orphan is deleted, by this
//                          run or any later one; the operator is alerted and it is counted
//                          (`rollback_detected`). It stays that way until an operator moves the
//                          database's number up to the object's — deliberately, after looking.
//   no object              the first run: the object is written and nothing is deleted.
//   object  <= database    normal (the database ahead means an object write failed: it is
//                          written again at the end of the run).
// What it cannot see: a restore to a point AFTER the last run that completed (the numbers are
// equal). The quota half is unaffected by any of this.
// Rows first, objects second everywhere else is what makes an unreferenced old object garbage:
// a purge deletes its rows and then its objects, an upload writes its session row first.

import { getSettings, setSetting } from "../db/queries/settings";
import { reconcileUsedBytes } from "../db/queries/quota";
import { knownVersions, referencedKeys, userIdsAfter } from "../db/queries/trash-jobs";
import { captureError } from "../sentry";
import { auditInTx } from "../services/audit";
import { coreFor, type BackgroundContext } from "../services/request-context";
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
  /** How many runs have completed. Its twin is the object `GENERATION_KEY`. */
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
    generation:
      typeof value.generation === "number" && Number.isSafeInteger(value.generation) && value.generation >= 0
        ? value.generation
        : 0,
  };
}

// ── the rollback detector ───────────────────────────────────────────────────────────────────

/** `ok` — sweep as usual; `first` — no object yet: nothing is deleted this run; `rollback`. */
export type GenerationState = "ok" | "first" | "rollback";

/** The object's number; null when there is no object; NaN when it holds anything but a number. */
async function storedGeneration(env: Env): Promise<number | null> {
  const found = await storage(env).get(GENERATION_KEY);
  if (found === null || found.kind !== "body") return null;
  const text = (await found.object.text()).trim();
  return /^\d{1,15}$/.test(text) ? Number(text) : Number.NaN;
}

async function writeGeneration(env: Env, generation: number): Promise<void> {
  const body = new TextEncoder().encode(String(generation));
  await storage(env).put(GENERATION_KEY, body, { size: body.byteLength, contentType: "text/plain" });
}

/**
 * Compares the database's generation with the object's, before any orphan decision. An object
 * that cannot be read as a number proves nothing either way: that is `rollback` too.
 */
export async function checkGeneration(bg: BackgroundContext, database: number): Promise<GenerationState> {
  const object = await storedGeneration(bg.env);
  if (object === null) {
    await writeGeneration(bg.env, database);
    return "first";
  }
  if (object <= database) return "ok";
  bg.metric("job", { kind: "reconcile", outcome: "rollback_detected" });
  alertRollback();
  return "rollback";
}

/** The operator's alert for a database that is older than the object store. ONE call site. */
function alertRollback(): void {
  captureError(
    new Error("reconcile: the database is older than the object store; orphan deletion is stopped"),
    {
      kind: "job",
      job: "reconcile",
      reason: "rollback_detected",
    },
  );
}

// ── quota ───────────────────────────────────────────────────────────────────────────────────

export type QuotaPass = {
  next: string | null;
  done: boolean;
  /** Accounts looked at, how many were off, and the sum of what was corrected (bytes, signed). */
  accounts: number;
  drifted: number;
  delta: number;
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
  for (;;) {
    const ids = await userIdsAfter(bg.db, after, USER_BATCH);
    if (ids.length === 0) return { next: null, done: true, accounts, drifted, delta };
    for (const id of ids) {
      const result = await reconcileUsedBytes(bg.db, id);
      after = id;
      accounts += 1;
      if (result && result.delta !== 0) {
        drifted += 1;
        delta += result.delta;
        bg.metric("job", { kind: "reconcile", outcome: "drift" });
      }
      if (Date.now() >= opts.stopAt) return { next: after, done: false, accounts, drifted, delta };
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
        { accounts: pass.accounts, drifted: pass.drifted, delta: pass.delta },
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

/**
 * One run. `now` is the sweep's (an object's age cannot be set: see `sweepOrphans`).
 * `completed`: the run got to its end — only then is the generation counted up.
 */
export async function runReconcile(
  bg: BackgroundContext,
  opts: { softDeadlineMs: number; now?: Date },
): Promise<{ done: boolean; generation: GenerationState; sweep: OrphanSweep | null }> {
  const startedAt = Date.now();
  const cursor = readCursor((await getSettings(bg.db, { fresh: true })).reconcileCursor);
  // Before any orphan decision: is this database older than the object store?
  const generation = await checkGeneration(bg, cursor.generation);

  // Half the budget each, so a long quota pass never starves the sweep (and the reverse).
  const quota = await reconcileQuotas(bg, {
    after: cursor.user,
    stopAt: startedAt + opts.softDeadlineMs / 2,
  });
  await recordQuotaPass(bg, quota);
  let sweep: OrphanSweep | null = null;
  let completed = false;
  try {
    if (generation === "ok") {
      sweep = await sweepOrphans(bg, {
        from: cursor,
        stopAt: startedAt + opts.softDeadlineMs,
        now: opts.now,
      });
    }
    completed = true;
  } finally {
    // Whatever the sweep did, the quota pass keeps its place. A rolled-back database's number is
    // never counted up by the job: only an operator moves it.
    const counted = completed && generation !== "rollback";
    const next: ReconcileCursor = {
      user: quota.next,
      area: sweep ? sweep.area : cursor.area,
      object: sweep ? sweep.object : cursor.object,
      generation: counted ? cursor.generation + 1 : cursor.generation,
    };
    await setSetting(bg.db, "reconcileCursor", next, null);
    // The database first, then the object: a failure in between leaves the database ahead,
    // which the next run reads as normal and repairs.
    if (counted) await writeGeneration(bg.env, next.generation);
  }
  return {
    done: quota.done && sweep !== null && sweep.outcome === "swept" && sweep.done,
    generation,
    sweep,
  };
}

export const job: Job = {
  name: "reconcile",
  cron: "0 2 * * *",
  async run(bg, _env, _event, opts) {
    const { done } = await runReconcile(bg, {
      softDeadlineMs: opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS,
    });
    return { done };
  },
};
