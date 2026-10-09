// The daily ledger behind every hard ceiling: bytes and counts per (UTC day, subject).
// Sign-up velocity subjects never share a row with download accounting: the subject type is
// part of the key.

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { downloadLedger, type LedgerSubject } from "../schema";

/** The UTC day of an instant, as `YYYY-MM-DD` — the form `addUsage` takes. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Adds to one day's row, creating it when needed. One atomic upsert; safe under concurrency.
 * `count` defaults to 1; pass 0 to record bytes only.
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
