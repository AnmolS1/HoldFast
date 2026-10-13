// Strikes: the statements the strikes service needs. Nothing else reads or writes the table.
//
// ONE UNLIFTED STRIKE PER VIOLATION is a property of the table (two unique partial indexes), not
// of each caller: the same file (`user, kind, node_id` — a redelivered verdict) and the same
// content (`user, kind, content_sha256` — the same bytes uploaded again as a new file) never
// strike twice. A strike with neither a node nor a hash is never de-duplicated.

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

/**
 * Inserts one strike — or, when an unlifted strike of this user and kind already exists for the
 * same node OR the same content, returns that one (`created: false`) and writes nothing. When the
 * node matches one existing strike and the content another, the older one is returned.
 * Safe under concurrency: of two inserts of the same key, one creates and the other finds it.
 */
export async function insert(tx: Executor, strike: StrikeInput): Promise<{ id: string; created: boolean }> {
  const nodeId = strike.nodeId ?? null;
  const sha256 = strike.sha256 ?? null;
  // A conflicting row can vanish between the two statements (it is lifted, or the transaction
  // that wrote it rolls back): then the insert is simply tried again.
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
    const [existing] = await tx
      .select({ id: strikes.id })
      .from(strikes)
      .where(
        and(
          eq(strikes.userId, strike.userId),
          eq(strikes.kind, strike.kind),
          isNull(strikes.liftedAt),
          or(...sameViolation),
        ),
      )
      .orderBy(strikes.at, strikes.id)
      .limit(1);
    if (existing) return { id: existing.id, created: false };
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

/**
 * Users who have at least `threshold` unlifted strikes in the window and whose account is NOT
 * suspended — the state the strikes service must never leave standing. Oldest first (by the
 * user's earliest counted strike), at most `limit`.
 */
export async function usersAtThreshold(
  db: Executor,
  windowDays: number,
  threshold: number,
  limit: number,
): Promise<string[]> {
  // `user.suspended_at` is only tested for NULL here: it is never compared with a time.
  const result = await db.execute<{ user_id: string }>(sql`
    SELECT s.user_id
    FROM strikes s
    JOIN "user" u ON u.id = s.user_id
    WHERE s.lifted_at IS NULL
      AND s.at > now() - make_interval(days => ${windowDays})
      AND u.suspended_at IS NULL
    GROUP BY s.user_id
    HAVING count(*) >= ${threshold}
    ORDER BY min(s.at), s.user_id
    LIMIT ${limit}`);
  return result.rows.map((row) => row.user_id);
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
