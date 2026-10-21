// The scan pipeline's own statements (T21): what only the consumer, its dead-letter half and the
// pending-scan sweep need, and T05 has no helper for. Everything else they use is T05's
// (`scan-jobs`, `nodes`, `blocklist`, `moderation`, `links`).
//
// THE JOB ROW IS THE PIPELINE'S LEDGER. There is one `scan_jobs` row per object key and it
// survives rescans, so `verdict.effects` (what was done once — a blocklist row, a strike, a mail)
// and `verdict.requeuedFromDlq` live on it. `scan-jobs.finish(…, 'done', verdict)` REPLACES the
// column: a caller reads the row FOR UPDATE first (`lockJob`) and carries both into the verdict
// it writes. `finish(…, 'failed')` keeps the column.
//
// `scannedAt` IS A PROMISE: once it is set, `nodes.sha256` is the SERVER's hash. So the two
// status writes made without a server hash (`markScanError`) never touch it, and `recordScan`
// writes the hash and the time together.

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type Node, nodes, type ScanDetail, type ScanJob, scanJobs, uploads, user } from "../schema";
import type { ScanReason } from "../schema";

/** The scan job of an object key, or null. `forUpdate` locks the row (after the node's row). */
export async function lockJob(
  db: Executor,
  r2Key: string,
  opts: { forUpdate?: boolean } = { forUpdate: true },
): Promise<ScanJob | null> {
  const query = db.select().from(scanJobs).where(eq(scanJobs.r2Key, r2Key)).limit(1);
  const [row] = opts.forUpdate ? await query.for("update") : await query;
  return row ?? null;
}

/** The scan job of an object key, unlocked. */
export const jobOf = (db: Executor, r2Key: string) => lockJob(db, r2Key, { forUpdate: false });

/**
 * The hash the client DECLARED at complete for this object: `uploads.expected_sha256` of the
 * session whose `r2_key` is the key (`uploads_r2_key_idx`), the newest if there were several.
 * `session: false` when no session row is left (trimmed after `FINISHED_TRIM_DAYS`); a session
 * that never recorded a declaration answers `sha256: null`.
 */
export async function declaredHashOf(
  db: Executor,
  r2Key: string,
): Promise<{ session: boolean; sha256: string | null }> {
  const [row] = await db
    .select({ sha256: uploads.expectedSha256 })
    .from(uploads)
    .where(eq(uploads.r2Key, r2Key))
    .orderBy(sql`${uploads.createdAt} DESC`)
    .limit(1);
  return row ? { session: true, sha256: row.sha256 } : { session: false, sha256: null };
}

/** True when an `aborted` upload session carries this key (its object is the orphan sweep's). */
export async function abortedUploadOf(db: Executor, r2Key: string): Promise<boolean> {
  const [row] = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(and(eq(uploads.r2Key, r2Key), eq(uploads.status, "aborted")))
    .limit(1);
  return row !== undefined;
}

/**
 * What the scanner saw, for a node whose STATUS this verdict does not change (locked, taken
 * down, already settled): the server hash, the sniffed type, the detail and the scan time —
 * none of which opens or closes access. Keyed like `setScanResult`: node id AND key, so a
 * replaced node is not written. A verdict with no server hash (the size guard) writes neither
 * the hash nor the time. Null when nothing was written.
 */
export async function recordScan(
  tx: Executor,
  nodeId: string,
  r2Key: string,
  seen: { sha256?: string; mimeSniffed: string; scanDetail: ScanDetail; scannedAt: Date },
): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  const [row] = await tx
    .update(nodes)
    .set({
      mimeSniffed: seen.mimeSniffed,
      scanDetail: seen.scanDetail,
      ...(seen.sha256 !== undefined ? { sha256: seen.sha256, scannedAt: seen.scannedAt } : {}),
    })
    .where(and(eq(nodes.id, nodeId), eq(nodes.r2Key, r2Key)))
    .returning();
  return row ?? null;
}

/**
 * `error` with a reason for a node that is still `pending` on this key — with no server hash:
 * `scannedAt` and `sha256` are left as they are. The caller has decided "not taken down" on the
 * locked row. False when the node was not `pending` on this key.
 */
export async function markScanError(
  tx: Executor,
  nodeId: string,
  r2Key: string,
  reason: Extract<ScanReason, "timeout" | "engine">,
): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await tx
    .update(nodes)
    .set({ scanStatus: "error", scanReason: reason })
    .where(and(eq(nodes.id, nodeId), eq(nodes.r2Key, r2Key), eq(nodes.scanStatus, "pending")))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/**
 * The dead-letter consumer's end of a job: `failed` with this error, whatever attempt holds it
 * (a stale `running` claim included). A `done` row is left alone. False when nothing changed.
 */
export async function failJob(tx: Executor, jobId: string, error: string): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  const rows = await tx
    .update(scanJobs)
    .set({ status: "failed", lastError: error, finishedAt: sql`now()` })
    .where(and(eq(scanJobs.id, jobId), sql`${scanJobs.status} <> 'done'`))
    .returning({ id: scanJobs.id });
  return rows.length > 0;
}

/**
 * Marks a `failed` job as re-enqueued once from the dead-letter queue: `verdict.requeuedFromDlq`.
 * A second dead letter for the key then ends the scan instead of looping. False when the row was
 * not `failed`.
 */
export async function markRequeuedFromDlq(db: Executor, jobId: string): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  const rows = await db
    .update(scanJobs)
    .set({
      verdict: sql`COALESCE(${scanJobs.verdict}, '{}'::jsonb) || '{"requeuedFromDlq": true}'::jsonb`,
    })
    .where(and(eq(scanJobs.id, jobId), eq(scanJobs.status, "failed")))
    .returning({ id: scanJobs.id });
  return rows.length > 0;
}

export type PendingScanCandidate = { nodeId: string; ownerId: string; r2Key: string };

/**
 * The pending-scan sweep's candidates, oldest first, at most `limit`: current file versions
 * under `u/` that are `pending`, not taken down themselves, and QUIET for more than
 * `olderThanMinutes` — measured from the latest of the node's own times and its key's job
 * (claimed, finished). `resetToPending` touches neither of the node's times, so the job's are
 * what keeps a rescan under way from looking old. A live job is younger than this by
 * construction; the caller still re-decides everything — `hasLiveScanJob` and a taken-down
 * folder above — under the row's lock.
 */
export async function pendingScanCandidates(
  db: Executor,
  olderThanMinutes: number,
  limit: number,
): Promise<PendingScanCandidate[]> {
  const quietSince = sql`GREATEST(${nodes.createdAt}, ${nodes.updatedAt}, ${scanJobs.startedAt}, ${scanJobs.finishedAt})`;
  return db
    .select({ nodeId: nodes.id, ownerId: nodes.ownerId, r2Key: sql<string>`${nodes.r2Key}` })
    .from(nodes)
    .leftJoin(scanJobs, eq(scanJobs.r2Key, nodes.r2Key))
    .where(
      and(
        eq(nodes.kind, "file"),
        eq(nodes.scanStatus, "pending"),
        sql`${nodes.takedownAt} IS NULL`,
        sql`starts_with(${nodes.r2Key}, 'u/')`,
        sql`${quietSince} < now() - make_interval(mins => ${olderThanMinutes})`,
      ),
    )
    .orderBy(asc(quietSince), asc(nodes.id))
    .limit(limit);
}

/** The addresses of these accounts, by id; an account that is gone is simply absent. */
export async function emailsOf(db: Executor, userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, ids));
  return new Map(rows.map((row) => [row.id, row.email]));
}
