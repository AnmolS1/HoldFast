// Scan jobs: one row per object key (keys are immutable), claimed idempotently.
//
// Queue delivery is at-least-once, so the consumer contract is:
//   claimed                      → scan, then `finish`;
//   not claimed, status `done`   → ack (the work is finished);
//   not claimed, status `running`→ retry (another delivery owns it; never ack);
//   not claimed, status `failed` → cannot happen: a failed row is always claimable.
// A retry after an error works because `finish(…, 'failed')` makes the row claimable again.

import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid, uuidv7 } from "../ids";
import { scanJobs } from "../schema";

/** A `running` claim older than this is taken over. Must equal the shared constant. */
export const SCAN_CLAIM_STALE_MINUTES = 20;

export type ClaimResult =
  | { claimed: true; jobId: string; attempt: number }
  | { claimed: false; status: "running" | "done" | "failed" };

/**
 * Claims the scan of one object key. A first claim inserts the row; a later one takes it over
 * only when the previous attempt `failed`, has been `running` for more than 20 minutes, or —
 * with `force` (a rescan) — is not `running`. `force` never steals a live claim.
 * The stored verdict of an earlier attempt is kept until `finish` replaces it.
 */
export async function claim(
  db: Executor,
  job: { nodeId: string; r2Key: string; etag?: string | null; force?: boolean },
): Promise<ClaimResult> {
  const force = job.force === true;
  const result = await db.execute<{ id: string; attempt: number }>(sql`
    INSERT INTO scan_jobs (id, node_id, r2_key, etag, attempt, status, started_at)
    VALUES (${uuidv7()}, ${job.nodeId}, ${job.r2Key}, ${job.etag ?? null}, 1, 'running', now())
    ON CONFLICT (r2_key) DO UPDATE
      SET attempt = scan_jobs.attempt + 1,
          started_at = now(),
          status = 'running',
          finished_at = NULL,
          etag = COALESCE(EXCLUDED.etag, scan_jobs.etag)
      WHERE scan_jobs.status = 'failed'
         OR (scan_jobs.status = 'running'
             AND scan_jobs.started_at < now() - make_interval(mins => ${SCAN_CLAIM_STALE_MINUTES}))
         OR (${force}::boolean AND scan_jobs.status <> 'running')
    RETURNING id, attempt`);
  const row = result.rows[0];
  if (row) return { claimed: true, jobId: row.id, attempt: Number(row.attempt) };
  const [existing] = await db
    .select({ status: scanJobs.status })
    .from(scanJobs)
    .where(eq(scanJobs.r2Key, job.r2Key))
    .limit(1);
  // No row at all means the job was deleted between the two statements (its node was purged).
  return { claimed: false, status: existing?.status ?? "done" };
}

/**
 * Ends an attempt. `done` stores the verdict; `failed` stores the error and keeps whatever
 * verdict an earlier attempt stored. Only a `running` row changes: false = it was not running
 * (already finished, taken over and finished, or gone).
 */
export async function finish(
  db: Executor,
  jobId: string,
  status: "done" | "failed",
  verdict?: Record<string, unknown> | null,
  error?: string | null,
): Promise<boolean> {
  if (!isUuid(jobId)) return false;
  const engine = typeof verdict?.engine === "string" ? verdict.engine : undefined;
  const rows = await db
    .update(scanJobs)
    .set({
      status,
      finishedAt: sql`now()`,
      lastError: status === "failed" ? (error ?? "failed") : null,
      ...(verdict != null ? { verdict } : {}),
      ...(engine !== undefined ? { engine } : {}),
    })
    .where(sql`${scanJobs.id} = ${jobId} AND ${scanJobs.status} = 'running'`)
    .returning({ id: scanJobs.id });
  return rows.length > 0;
}

/** For the admin dashboard: how many scans are running and since when the oldest. */
export async function backlog(db: Executor): Promise<{ running: number; oldestStartedAt: Date | null }> {
  const [row] = await db
    .select({
      running: sql<number>`count(*)`.mapWith(Number),
      oldestStartedAt: sql<Date | null>`min(${scanJobs.startedAt})`.mapWith(scanJobs.startedAt),
    })
    .from(scanJobs)
    .where(eq(scanJobs.status, "running"));
  return { running: row?.running ?? 0, oldestStartedAt: row?.oldestStartedAt ?? null };
}
