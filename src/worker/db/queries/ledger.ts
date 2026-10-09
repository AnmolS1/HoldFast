// The daily ledger behind every hard ceiling: bytes and counts per (UTC day, subject).
// Sign-up velocity subjects never share a row with download accounting: the subject type is
// part of the key.

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { QueryError } from "../errors";
import { downloadLedger, type LedgerSubject } from "../schema";

/** The UTC day of an instant, as `YYYY-MM-DD` — the form `addUsage` takes. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Adds to one day's row, creating it when needed. One atomic upsert; safe under concurrency.
 * `count` defaults to 1; pass 0 to record bytes only. It enforces nothing: for a hard ceiling use
 * `addUsageIfUnder`.
 */
export async function addUsage(
  db: Executor,
  day: string,
  subjectType: LedgerSubject,
  subjectId: string,
  bytes: number,
  count: number = 1,
): Promise<void> {
  await db
    .insert(downloadLedger)
    .values({ day, subjectType, subjectId, bytes, count })
    .onConflictDoUpdate({
      target: [downloadLedger.day, downloadLedger.subjectType, downloadLedger.subjectId],
      set: {
        bytes: sql`${downloadLedger.bytes} + EXCLUDED.bytes`,
        count: sql`${downloadLedger.count} + EXCLUDED.count`,
      },
    });
}

/**
 * Adds to one day's row ONLY IF the row stays within the ceiling: the check and the add are one
 * statement, so concurrent requests can never take a counter past its ceiling. Use this, not
 * `todayTotals` → compare → `addUsage`, wherever a ceiling is a hard limit (that sequence lets
 * every concurrent request through on the same stale total).
 * `ceiling.bytes` and `ceiling.count` are each optional; a missing one is not limited.
 * True = recorded. False = it would exceed a ceiling, and nothing was written.
 */
export async function addUsageIfUnder(
  db: Executor,
  day: string,
  subjectType: LedgerSubject,
  subjectId: string,
  add: { bytes: number; count?: number },
  ceiling: { bytes?: number; count?: number },
): Promise<boolean> {
  const bytes = add.bytes;
  const count = add.count ?? 1;
  for (const value of [bytes, count, ceiling.bytes ?? 0, ceiling.count ?? 0]) {
    if (!Number.isSafeInteger(value) || value < 0)
      throw new QueryError("validation", "invalid ledger amount");
  }
  const maxBytes = ceiling.bytes ?? null;
  const maxCount = ceiling.count ?? null;
  const result = await db.execute<{ day: string }>(sql`
    INSERT INTO download_ledger (day, subject_type, subject_id, bytes, count)
    SELECT ${day}::date, ${subjectType}::ledger_subject, ${subjectId}, ${bytes}::bigint, ${count}::integer
    WHERE (${maxBytes}::bigint IS NULL OR ${bytes}::bigint <= ${maxBytes}::bigint)
      AND (${maxCount}::bigint IS NULL OR ${count}::bigint <= ${maxCount}::bigint)
    ON CONFLICT (day, subject_type, subject_id) DO UPDATE
      SET bytes = download_ledger.bytes + EXCLUDED.bytes,
          count = download_ledger.count + EXCLUDED.count
      WHERE (${maxBytes}::bigint IS NULL OR download_ledger.bytes + EXCLUDED.bytes <= ${maxBytes}::bigint)
        AND (${maxCount}::bigint IS NULL OR download_ledger.count + EXCLUDED.count <= ${maxCount}::bigint)
    RETURNING day`);
  return result.rows.length > 0;
}

/** Today's totals (the database's clock, UTC day). Zeros when there is no row. */
export async function todayTotals(
  db: Executor,
  subjectType: LedgerSubject,
  subjectId: string,
): Promise<{ bytes: number; count: number }> {
  const [row] = await db
    .select({ bytes: downloadLedger.bytes, count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        // Explicitly UTC: no session time zone is ever set.
        eq(downloadLedger.day, sql`(now() AT TIME ZONE 'UTC')::date`),
        eq(downloadLedger.subjectType, subjectType),
        eq(downloadLedger.subjectId, subjectId),
      ),
    )
    .limit(1);
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}
