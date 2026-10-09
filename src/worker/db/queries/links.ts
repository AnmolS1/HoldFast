// Public links: lookup, the download cap, the pause set, the access log and the password
// throttle.
//
// `share_links.pause_reasons` is a SET. A link is paused exactly when the set is non-empty;
// `pausedAt` is when it first became non-empty. `pauseLinks` adds one reason, `unpauseLinks`
// removes that one reason, and a link is live again only when its last reason is gone — so no
// reason ever overwrites or lifts another. Readers test `cardinality(pause_reasons) > 0` (or
// `pausedAt IS NOT NULL`), never one particular reason.

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import { QueryError } from "../errors";
import { isUuid } from "../ids";
import {
  linkAccessLog,
  linkPasswordAttempts,
  PAUSE_REASONS,
  type PauseReason,
  type ShareLink,
  shareLinks,
} from "../schema";

/** Failures that carry no delay. Must equal the shared constant of the same name. */
export const PASSWORD_FREE_ATTEMPTS = 3;
/** The longest lock, in seconds. Must equal the shared constant of the same name. */
export const PASSWORD_LOCK_MAX_SEC = 900;

/** The row for a token hash, whatever its state (revoked, expired, paused): the caller decides. */
export async function findByTokenHash(db: Executor, tokenHash: string): Promise<ShareLink | null> {
  const [row] = await db.select().from(shareLinks).where(eq(shareLinks.tokenHash, tokenHash)).limit(1);
  return row ?? null;
}

export async function getById(db: Executor, linkId: string): Promise<ShareLink | null> {
  if (!isUuid(linkId)) return null;
  const [row] = await db.select().from(shareLinks).where(eq(shareLinks.id, linkId)).limit(1);
  return row ?? null;
}

/** Links the user created since the start of the current UTC day (revoked ones included). */
export async function countCreatedToday(db: Executor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(shareLinks)
    .where(
      and(eq(shareLinks.createdBy, userId), sql`${shareLinks.createdAt} >= date_trunc('day', now(), 'UTC')`),
    );
  return row?.n ?? 0;
}

/** The user's links that are neither revoked nor expired (paused ones count). */
export async function countLive(db: Executor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(shareLinks)
    .where(
      and(
        eq(shareLinks.createdBy, userId),
        isNull(shareLinks.revokedAt),
        sql`(${shareLinks.expiresAt} IS NULL OR ${shareLinks.expiresAt} > now())`,
      ),
    );
  return row?.n ?? 0;
}

/** The one insert into `link_access_log`. */
export async function logAccess(
  db: Executor,
  entry: {
    linkId: string;
    nodeId: string | null;
    outcome: (typeof linkAccessLog.outcome.enumValues)[number];
    ipHashDaily: string | null;
    country: string | null;
    uaHash: string | null;
    bytes?: number;
  },
): Promise<void> {
  await db.insert(linkAccessLog).values({
    linkId: entry.linkId,
    nodeId: entry.nodeId,
    outcome: entry.outcome,
    ipHashDaily: entry.ipHashDaily,
    country: entry.country,
    uaHash: entry.uaHash,
    bytes: entry.bytes ?? 0,
  });
}

/**
 * Takes one download from the link's cap: an atomic conditional increment, so concurrent mints
 * can never exceed `maxDownloads`. False = the cap is reached (or no such link). Called when a
 * download URL is minted; the files host never increments.
 */
export async function consumeDownload(db: Executor, linkId: string): Promise<boolean> {
  if (!isUuid(linkId)) return false;
  const rows = await db
    .update(shareLinks)
    .set({ downloadCount: sql`${shareLinks.downloadCount} + 1` })
    .where(
      and(
        eq(shareLinks.id, linkId),
        sql`(${shareLinks.maxDownloads} IS NULL OR ${shareLinks.downloadCount} < ${shareLinks.maxDownloads})`,
      ),
    )
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

// ── the pause set ───────────────────────────────────────────────────────────────────────────

export type LinkSelector = { linkId: string } | { nodeId: string } | { ownerId: string };

export type PauseChange = {
  linkId: string;
  nodeId: string;
  /** The link's creator — in v1 always the node's owner. */
  ownerId: string;
};

function assertReason(reason: PauseReason): void {
  if (!PAUSE_REASONS.includes(reason)) throw new QueryError("validation", "unknown pause reason");
}

function selector(where: LinkSelector | { all: true }, t: SQL): SQL | null {
  if ("all" in where) return sql`NOT ${t}.locked_by_admin`;
  if ("linkId" in where) return isUuid(where.linkId) ? sql`${t}.id = ${where.linkId}` : null;
  if ("nodeId" in where) return isUuid(where.nodeId) ? sql`${t}.node_id = ${where.nodeId}` : null;
  return sql`${t}.created_by = ${where.ownerId}`;
}

/**
 * Adds `reason` to every matching link that does not carry it yet, and sets `pausedAt` if the
 * link was not paused. A second call with the same reason changes nothing.
 * `{ nodeId }` matches links ON that node only, not links on its ancestors or descendants.
 * Returns the links that changed; `newlyPaused` marks those whose set was empty before — the
 * transition a "your link was paused" email hangs on.
 */
export async function pauseLinks(
  db: Executor,
  where: LinkSelector,
  reason: PauseReason,
): Promise<(PauseChange & { newlyPaused: boolean })[]> {
  assertReason(reason);
  const match = selector(where, sql`c`);
  if (!match) return [];
  // The subquery locks the rows and reads the set as it was; the UPDATE then appends.
  const result = await db.execute<{
    id: string;
    node_id: string;
    created_by: string;
    newly_paused: boolean;
  }>(sql`
    UPDATE share_links l
    SET pause_reasons = array_append(l.pause_reasons, ${reason}::text),
        paused_at = COALESCE(l.paused_at, now())
    FROM (
      SELECT c.id, cardinality(c.pause_reasons) = 0 AS was_live
      FROM share_links c
      WHERE ${match} AND NOT (${reason}::text = ANY(c.pause_reasons))
      FOR UPDATE
    ) prev
    WHERE l.id = prev.id
    RETURNING l.id, l.node_id, l.created_by, prev.was_live AS newly_paused`);
  return result.rows.map((r) => ({
    linkId: r.id,
    nodeId: r.node_id,
    ownerId: r.created_by,
    newlyPaused: r.newly_paused === true,
  }));
}

/**
 * Removes `reason` — and only that reason — from every matching link that carries it; `pausedAt`
 * is cleared only where the set became empty. A link without the reason is untouched.
 * `{ all: true }` matches every link carrying the reason, except rows with `lockedByAdmin`.
 * Returns the links that changed; `nowLive` marks those with no reason left.
 */
export async function unpauseLinks(
  db: Executor,
  where: LinkSelector | { all: true },
  reason: PauseReason,
): Promise<(PauseChange & { nowLive: boolean })[]> {
  assertReason(reason);
  const match = selector(where, sql`l`);
  if (!match) return [];
  const result = await db.execute<{ id: string; node_id: string; created_by: string; now_live: boolean }>(sql`
    UPDATE share_links l
    SET pause_reasons = array_remove(l.pause_reasons, ${reason}::text),
        paused_at = CASE WHEN cardinality(array_remove(l.pause_reasons, ${reason}::text)) = 0 THEN NULL ELSE l.paused_at END
    WHERE ${match} AND ${reason}::text = ANY(l.pause_reasons)
    RETURNING l.id, l.node_id, l.created_by, cardinality(l.pause_reasons) = 0 AS now_live`);
  return result.rows.map((r) => ({
    linkId: r.id,
    nodeId: r.node_id,
    ownerId: r.created_by,
    nowLive: r.now_live === true,
  }));
}

// ── the password throttle ───────────────────────────────────────────────────────────────────

/**
 * Records a wrong password for (link, IP). The first three failures carry no delay; failure
 * n > 3 locks the pair for min(2^(n-3), 900) seconds. A row idle for 24 hours starts again at
 * one. The link itself is never paused: nobody can lock a link for other people.
 */
export async function recordPasswordFailure(
  db: Executor,
  linkId: string,
  ipHashStable: string,
): Promise<{ failures: number; lockedUntil: Date | null }> {
  const failures = sql`(CASE WHEN ${linkPasswordAttempts.lastFailureAt} < now() - interval '24 hours'
    THEN 1 ELSE ${linkPasswordAttempts.failures} + 1 END)`;
  const [row] = await db
    .insert(linkPasswordAttempts)
    .values({ linkId, ipHashStable, failures: 1, lastFailureAt: sql`now()`, lockedUntil: null })
    .onConflictDoUpdate({
      target: [linkPasswordAttempts.linkId, linkPasswordAttempts.ipHashStable],
      set: {
        failures,
        lastFailureAt: sql`now()`,
        lockedUntil: sql`CASE WHEN ${failures} > ${PASSWORD_FREE_ATTEMPTS}
          THEN now() + make_interval(secs => LEAST(power(2, LEAST(${failures} - ${PASSWORD_FREE_ATTEMPTS}, 30)), ${PASSWORD_LOCK_MAX_SEC}))
          ELSE NULL END`,
      },
    })
    .returning({ failures: linkPasswordAttempts.failures, lockedUntil: linkPasswordAttempts.lockedUntil });
  return row!;
}

/**
 * The active lock for (link, IP), or null. Checked BEFORE the password is evaluated, so a
 * locked-out caller costs no hash.
 */
export async function passwordLock(
  db: Executor,
  linkId: string,
  ipHashStable: string,
): Promise<{ lockedUntil: Date; retryAfterSec: number } | null> {
  if (!isUuid(linkId)) return null;
  const [row] = await db
    .select({
      lockedUntil: linkPasswordAttempts.lockedUntil,
      retryAfterSec:
        sql<number>`CEIL(EXTRACT(EPOCH FROM ${linkPasswordAttempts.lockedUntil} - now()))`.mapWith(Number),
    })
    .from(linkPasswordAttempts)
    .where(
      and(
        eq(linkPasswordAttempts.linkId, linkId),
        eq(linkPasswordAttempts.ipHashStable, ipHashStable),
        sql`${linkPasswordAttempts.lockedUntil} > now()`,
      ),
    )
    .limit(1);
  if (!row || row.lockedUntil === null) return null;
  return { lockedUntil: row.lockedUntil, retryAfterSec: Math.max(1, row.retryAfterSec) };
}

/** A correct password deletes the pair's row. */
export async function clearPasswordFailures(
  db: Executor,
  linkId: string,
  ipHashStable: string,
): Promise<void> {
  if (!isUuid(linkId)) return;
  await db
    .delete(linkPasswordAttempts)
    .where(and(eq(linkPasswordAttempts.linkId, linkId), eq(linkPasswordAttempts.ipHashStable, ipHashStable)));
}
