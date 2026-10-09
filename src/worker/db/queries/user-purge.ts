// Scheduled account deletion: the whole `pending_user_purges` lifecycle.
//
//   schedule → (cancel) → due → markStarted → … → markFinished
//                                        ↘ markFailed (stays due)   ↘ defer (held remnant)
//
// `user.delete_scheduled_at` is one of Better Auth's zone-less `timestamp` columns. It is
// written here through the Drizzle column (which sends the instant as UTC) and never compared
// with `now()` in SQL: whether a purge is due is decided on `pending_user_purges.scheduled_for`,
// a `timestamptz` of ours.

import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { type PendingUserPurge, pendingUserPurges, user } from "../schema";
import { pauseLinks, unpauseLinks } from "./links";

/**
 * Schedules the account's deletion. One transaction: `user.deleteScheduledAt`, the pending row,
 * and the account's links paused with `owner_deletion` — paused, not revoked. Safe to repeat: a
 * second call moves the date, as long as the purge has not started.
 * False — and nothing changes — when there is no such user, or once the purge has started (the
 * date on the `user` row must keep saying when the purge that is running was due).
 *
 * Lock order (shared with `cancel`): the `user` row first, then the pending row.
 */
export async function schedule(db: Executor, userId: string, scheduledFor: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [owner] = await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
    if (!owner) return false;
    const written = await tx
      .insert(pendingUserPurges)
      .values({ userId, scheduledFor })
      .onConflictDoUpdate({
        target: pendingUserPurges.userId,
        set: { scheduledFor, requestedAt: sql`now()` },
        setWhere: isNull(pendingUserPurges.startedAt),
      })
      .returning({ userId: pendingUserPurges.userId });
    // No row written = a pending row exists and its purge has started: leave everything as it is.
    if (written.length === 0) return false;
    await tx.update(user).set({ deleteScheduledAt: scheduledFor }).where(eq(user.id, userId));
    await pauseLinks(tx, { ownerId: userId }, "owner_deletion");
    return true;
  });
}

/**
 * Cancels a scheduled deletion: clears `deleteScheduledAt`, deletes the pending row and removes
 * the `owner_deletion` pause (a link that carries another reason stays paused).
 * False — and nothing changes — once the purge has started.
 *
 * Lock order (shared with `schedule`): the `user` row first, then the pending row. Taken the
 * other way round, a cancel beside a re-schedule deadlocks and one of them fails.
 */
export async function cancel(db: Executor, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
    const [row] = await tx
      .select({ startedAt: pendingUserPurges.startedAt })
      .from(pendingUserPurges)
      .where(eq(pendingUserPurges.userId, userId))
      .for("update");
    if (row && row.startedAt !== null) return false;
    await tx.delete(pendingUserPurges).where(eq(pendingUserPurges.userId, userId));
    await tx.update(user).set({ deleteScheduledAt: null }).where(eq(user.id, userId));
    await unpauseLinks(tx, { ownerId: userId }, "owner_deletion");
    return true;
  });
}

/**
 * Purges to run now: `scheduledFor` has passed and the row is not finished. Rows that were
 * started and failed are included (the job resumes). A user on legal hold is silently left
 * out — the request stays "scheduled". A row whose user no longer exists is included, so the
 * job can finish it.
 *
 * Ordered by `attempts` first (`markStarted` counts them), then by date: a row that keeps failing
 * goes to the back, so `limit` rows that can never finish do not stop every other account's
 * deletion.
 */
export async function due(db: Executor, limit: number): Promise<PendingUserPurge[]> {
  const rows = await db
    .select({ purge: pendingUserPurges })
    .from(pendingUserPurges)
    .leftJoin(user, eq(user.id, pendingUserPurges.userId))
    .where(
      and(
        lte(pendingUserPurges.scheduledFor, sql`now()`),
        isNull(pendingUserPurges.finishedAt),
        or(isNull(user.id), eq(user.legalHold, false)),
      ),
    )
    .orderBy(pendingUserPurges.attempts, pendingUserPurges.scheduledFor, pendingUserPurges.userId)
    .limit(limit);
  return rows.map((r) => r.purge);
}

/** The job picked the row up. From here on `cancel` refuses. */
export async function markStarted(db: Executor, userId: string): Promise<void> {
  await db
    .update(pendingUserPurges)
    .set({
      startedAt: sql`COALESCE(${pendingUserPurges.startedAt}, now())`,
      attempts: sql`${pendingUserPurges.attempts} + 1`,
    })
    .where(eq(pendingUserPurges.userId, userId));
}

export async function markFinished(db: Executor, userId: string): Promise<void> {
  await db
    .update(pendingUserPurges)
    .set({ finishedAt: sql`now()`, error: null })
    .where(eq(pendingUserPurges.userId, userId));
}

/** Records the error. The row stays due, so the next run resumes it. */
export async function markFailed(db: Executor, userId: string, error: string): Promise<void> {
  await db
    .update(pendingUserPurges)
    .set({ error: error.slice(0, 2000) })
    .where(eq(pendingUserPurges.userId, userId));
}

/**
 * For a user who is not on legal hold but still has held roots (an open report or notice): the
 * job has purged what it could; the rest and the user row wait. Pushes `scheduledFor` out
 * instead of failing every night. The account stays deletion-scheduled.
 */
export async function defer(db: Executor, userId: string, days: number = 7): Promise<void> {
  await db
    .update(pendingUserPurges)
    .set({ scheduledFor: sql`now() + make_interval(days => ${days})`, error: null })
    .where(eq(pendingUserPurges.userId, userId));
}
