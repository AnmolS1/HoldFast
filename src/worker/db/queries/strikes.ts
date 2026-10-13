// Strikes: the statements the strikes service needs. Nothing else reads or writes the table.
//
// ONE UNLIFTED STRIKE PER VIOLATION is a property of the table (two unique partial indexes), not
// of each caller: the same file (`user, kind, node_id` — a redelivered verdict) and the same
// content (`user, kind, content_sha256` — the same bytes uploaded again as a new file) never
// strike twice WHILE THE FIRST STRIKE STILL COUNTS. A strike with neither a node nor a hash is
// never de-duplicated.

import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { strikes } from "../schema";

export type StrikeKind = (typeof strikes.kind.enumValues)[number];

export type StrikeInput = {
  /** The uploader. */
  userId: string;
  kind: StrikeKind;
  reportId?: string | null;
  nodeId?: string | null;
  /** SHA-256 of the content, as `nodes.sha256` holds it. */
  sha256?: string | null;
  note?: string | null;
  /** Null = the system. */
  issuedBy?: string | null;
};

/** Appended to the `note` of a strike that was lifted because it had expired. */
export const EXPIRED_NOTE = "[expired: lifted when a new strike was issued for the same file or content]";

/**
 * Inserts one strike — or, when an unlifted strike of this user and kind already exists for the
 * same node OR the same content AND IS STILL INSIDE THE WINDOW, returns that one
 * (`created: false`) and writes nothing. When the node matches one such strike and the content
 * another, the older one is returned.
 *
 * A matching strike OUTSIDE the window has EXPIRED: it no longer counts, so it must not swallow a
 * new violation. It is lifted here, in the same transaction (`lifted_at = now()`, `lifted_by`
 * NULL = the system, `EXPIRED_NOTE` appended to its note), and the new strike is inserted.
 * "Outside the window" is decided by the database's clock, in the statement itself.
 *
 * Safe under concurrency: of two inserts of the same key, one creates and the other finds it.
 */
export async function insert(
  tx: Executor,
  strike: StrikeInput,
  windowDays: number,
): Promise<{ id: string; created: boolean }> {
  const nodeId = strike.nodeId ?? null;
  const sha256 = strike.sha256 ?? null;
  // A conflicting row can vanish between the statements (it is lifted, or the transaction that
  // wrote it rolls back), and an expired one is lifted below: then the insert is tried again.
  for (let attempt = 0; attempt < 5; attempt++) {
    // No conflict target: either unique index may refuse the row. A concurrent insert of the same
    // key makes this statement wait for that transaction to end.
    const [row] = await tx
      .insert(strikes)
      .values({
        userId: strike.userId,
        kind: strike.kind,
        reportId: strike.reportId ?? null,
        nodeId,
        contentSha256: sha256,
        note: strike.note ?? null,
        issuedBy: strike.issuedBy ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: strikes.id });
    if (row) return { id: row.id, created: true };

    const sameViolation = [];
    if (nodeId !== null) sameViolation.push(eq(strikes.nodeId, nodeId));
    if (sha256 !== null) sameViolation.push(eq(strikes.contentSha256, sha256));
    const matching = and(
      eq(strikes.userId, strike.userId),
      eq(strikes.kind, strike.kind),
      isNull(strikes.liftedAt),
      or(...sameViolation),
    );
    const expired = sql`${strikes.at} <= now() - make_interval(days => ${windowDays})`;
    const existing = await tx
      .select({ id: strikes.id, expired: sql<boolean>`${expired}` })
      .from(strikes)
      .where(matching)
      .orderBy(strikes.at, strikes.id);
    const live = existing.find((found) => !found.expired);
    if (live) return { id: live.id, created: false };
    if (existing.length > 0) {
      await tx
        .update(strikes)
        .set({
          liftedAt: sql`now()`,
          liftedBy: null,
          note: sql`concat_ws(' ', ${strikes.note}, ${EXPIRED_NOTE}::text)`,
        })
        .where(and(matching, expired));
    }
  }
  throw new Error("strikes: the insert kept conflicting with a row that could not be read");
}

/** The user's strikes that are not lifted and were issued in the last `windowDays` days. */
export async function countActive(db: Executor, userId: string, windowDays: number): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(strikes)
    .where(
      and(
        eq(strikes.userId, userId),
        isNull(strikes.liftedAt),
        sql`${strikes.at} > now() - make_interval(days => ${windowDays})`,
      ),
    );
  return row?.n ?? 0;
}

/** Where a page of `usersAtThreshold` ended: pass it back to get the next page. */
export type ThresholdCursor = { firstAt: string; userId: string };

/**
 * Users who have at least `threshold` unlifted strikes in the window and whose account is NOT
 * suspended — the state the strikes service must never leave standing. Oldest first (by the
 * user's earliest counted strike, then by id), at most `limit`, starting after `after`.
 *
 * Only `suspended_at` is looked at. A banned account, or one scheduled for deletion, that is not
 * suspended IS returned: suspension applies to it like to any other (it is not a no-op there),
 * and after it the account is no longer found. An account that no longer exists has no strikes
 * (they are deleted with it).
 */
export async function usersAtThreshold(
  db: Executor,
  windowDays: number,
  threshold: number,
  limit: number,
  after?: ThresholdCursor,
): Promise<ThresholdCursor[]> {
  // `user.suspended_at` is only tested for NULL here: it is never compared with a time.
  const page = after
    ? sql`AND (min(s.at), s.user_id) > (${after.firstAt}::timestamptz, ${after.userId}::text)`
    : sql``;
  const result = await db.execute<{ user_id: string; first_at: string }>(sql`
    SELECT s.user_id, min(s.at)::text AS first_at
    FROM strikes s
    JOIN "user" u ON u.id = s.user_id
    WHERE s.lifted_at IS NULL
      AND s.at > now() - make_interval(days => ${windowDays})
      AND u.suspended_at IS NULL
    GROUP BY s.user_id
    HAVING count(*) >= ${threshold} ${page}
    ORDER BY min(s.at), s.user_id
    LIMIT ${limit}`);
  return result.rows.map((row) => ({ userId: row.user_id, firstAt: row.first_at }));
}

/**
 * Lifts a strike. Returns whose it was, or null when there is no such strike or it is already
 * lifted (nothing is changed then).
 */
export async function lift(db: Executor, strikeId: string, by: string): Promise<{ userId: string } | null> {
  if (!isUuid(strikeId)) return null;
  const [row] = await db
    .update(strikes)
    .set({ liftedAt: sql`now()`, liftedBy: by })
    .where(and(eq(strikes.id, strikeId), isNull(strikes.liftedAt)))
    .returning({ userId: strikes.userId });
  return row ?? null;
}
