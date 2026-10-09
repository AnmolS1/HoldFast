// Account state as the permission checks see it.
//
// Every date read here comes from one of Better Auth's zone-less `timestamp` columns; they are
// read through Drizzle (which maps them as UTC) and compared in application code, never in SQL.

import { eq, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import { session, user } from "../schema";

export type UserState = {
  /** False once a temporary ban has expired. */
  banned: boolean;
  suspendedAt: Date | null;
  deleteScheduledAt: Date | null;
  legalHold: boolean;
};

/** `banned` honours `banExpires`. Null when no user has that id. */
export async function userState(db: Executor, userId: string): Promise<UserState | null> {
  const [row] = await db
    .select({
      banned: user.banned,
      banExpires: user.banExpires,
      suspendedAt: user.suspendedAt,
      deleteScheduledAt: user.deleteScheduledAt,
      legalHold: user.legalHold,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  if (!row) return null;
  const banned = row.banned === true && (row.banExpires === null || row.banExpires.getTime() > Date.now());
  return {
    banned,
    suspendedAt: row.suspendedAt,
    deleteScheduledAt: row.deleteScheduledAt,
    legalHold: row.legalHold,
  };
}

/**
 * An account other people's requests may still resolve against: it exists and is not banned,
 * suspended or scheduled for deletion. (A deletion-scheduled owner keeps access to their own
 * files; that is the caller's exception, not this function's.)
 */
export function isActive(state: UserState | null): boolean {
  return state !== null && !state.banned && state.suspendedAt === null && state.deleteScheduledAt === null;
}

/**
 * Deletes every session row of the user and returns how many there were. Effective at once:
 * every request reads the session row (the auth layer keeps no cookie cache).
 */
export async function revokeAllSessions(db: Executor, userId: string): Promise<number> {
  const rows = await db.delete(session).where(eq(session.userId, userId)).returning({ id: session.id });
  return rows.length;
}

/** One primary-key read of `user.termsVersion`. Null when unset or when no user has that id. */
export async function termsVersionOf(db: Executor, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ termsVersion: user.termsVersion })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row?.termsVersion ?? null;
}

/**
 * `isActive` as a SQL predicate, for queries that filter many rows by their owner. `ownerId` is
 * the outer query's owner column.
 *
 * `ban_expires` is one of Better Auth's zone-less `timestamp` columns: it holds UTC wall-clock
 * time and is compared with `now() AT TIME ZONE 'UTC'`, never with a bare `now()`. The table is
 * named in full (no alias) so that the source scan in tests/unit/db can see the column.
 */
export function ownerIsActive(ownerId: SQL): SQL {
  return sql`EXISTS (
    SELECT 1 FROM "user"
    WHERE "user".id = ${ownerId}
      AND "user".suspended_at IS NULL
      AND "user".delete_scheduled_at IS NULL
      AND ("user".banned IS NOT TRUE
           OR ("user".ban_expires IS NOT NULL AND "user".ban_expires <= (now() AT TIME ZONE 'UTC'))))`;
}
