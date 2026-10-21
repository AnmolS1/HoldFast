// The statements only the sharing routes make (PLAN §6 query-module rule): creating, changing,
// listing and withdrawing shares and links, the owner's link activity, and the reads those
// answers are built from. Lookups, the pause set, the download cap, the password throttle and
// pending-share activation stay in T05's `links.ts` / `shares.ts`.

import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { QueryError, pgError } from "../errors";
import { isUuid, uuidv7 } from "../ids";
import {
  downloadLedger,
  linkAccessLog,
  nodes,
  type Share,
  type ShareLink,
  shareLinks,
  shares,
  user,
  userPrefs,
} from "../schema";
import type { ShareRole } from "../../../shared/schemas/share";

const UNIQUE_VIOLATION = "23505";

// ── people ──────────────────────────────────────────────────────────────────────────────────

/**
 * The account behind an address, as a share decides on it — or null. ONE statement, the same for
 * every address, whether or not an account has it: the account, whether it is verified, and
 * whether it wants share mails (`user_prefs.emailShares`, true when it has no prefs row).
 * Addresses are stored lower case by the auth layer.
 */
export async function shareRecipient(
  db: Executor,
  email: string,
): Promise<{ id: string; name: string; emailVerified: boolean; emailShares: boolean } | null> {
  const [row] = await db
    .select({
      id: user.id,
      name: user.name,
      emailVerified: user.emailVerified,
      emailShares: sql<boolean>`COALESCE(${userPrefs.emailShares}, true)`,
    })
    .from(user)
    .leftJoin(userPrefs, eq(userPrefs.userId, user.id))
    .where(eq(user.email, email.toLowerCase()))
    .limit(1);
  return row ?? null;
}

/** What a ceiling scales with, for a user: the quota and the account's age. Null: no such user. */
export async function ceilingAccount(
  db: Executor,
  userId: string,
): Promise<{ quotaBytes: number; createdAt: Date } | null> {
  const [row] = await db
    .select({ quotaBytes: user.quotaBytes, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

// ── shares ──────────────────────────────────────────────────────────────────────────────────

export type NewShare = {
  nodeId: string;
  grantedBy: string;
  email: string;
  /** Set only when a VERIFIED account has the address: the share is active from the start. */
  granteeUserId: string | null;
  role: ShareRole;
  canUpload: boolean;
};

/**
 * Inserts one share — at most `max` per node, pending ones included — in the caller's
 * transaction, in two statements whatever the answer:
 *   1. the node's row is locked (`FOR UPDATE`): creations on one node run one after the other,
 *      so the count below sees every share an earlier one inserted (LOCK ORDER: only the node);
 *   2. one conditional INSERT … SELECT: the row goes in only while the node has fewer than `max`.
 * A VERIFIED account that already holds a share on the node by account (it changed its address
 * since) gets the new row as a PENDING one (no `granteeUserId`): the answer and the work are those
 * of any address, and the row grants nothing it does not already have — a `409` here would tell
 * the owner that the new address is the account they shared with before.
 * `{ refused: "limit" }` at the cap; `{ refused: "gone" }` when the node is gone; `conflict` when
 * the node already has a share to that exact address.
 */
export async function insertShare(
  tx: Executor,
  share: NewShare,
  max: number,
): Promise<{ share: Share } | { refused: "limit" | "gone" }> {
  if (!isUuid(share.nodeId)) return { refused: "gone" };
  const locked = await tx.execute(sql`SELECT id FROM nodes WHERE id = ${share.nodeId} FOR UPDATE`);
  if (locked.rows.length === 0) return { refused: "gone" };
  const user = share.granteeUserId;
  try {
    const result = await tx.execute<Record<string, unknown>>(sql`
      INSERT INTO shares (id, node_id, granted_by, grantee_email, grantee_user_id, activated_at, role, can_upload)
      SELECT ${uuidv7()}::uuid, ${share.nodeId}, ${share.grantedBy}, ${share.email},
             CASE WHEN held.by_account THEN NULL ELSE ${user}::text END,
             CASE WHEN held.by_account OR ${user}::text IS NULL THEN NULL ELSE now() END,
             ${share.role}::share_role, ${share.canUpload}
      FROM (SELECT count(*) AS n,
                   bool_or(s.grantee_user_id IS NOT DISTINCT FROM ${user}::text AND ${user}::text IS NOT NULL) AS by_account
            FROM shares s WHERE s.node_id = ${share.nodeId}) held
      WHERE held.n < ${max}
      RETURNING id`);
    const id = result.rows[0]?.id;
    if (typeof id !== "string") return { refused: "limit" };
    const [row] = await tx.select().from(shares).where(eq(shares.id, id));
    return { share: row! };
  } catch (error) {
    if (pgError(error)?.code === UNIQUE_VIOLATION) throw new QueryError("conflict");
    throw error;
  }
}

export async function shareById(db: Executor, shareId: string): Promise<Share | null> {
  if (!isUuid(shareId)) return null;
  const [row] = await db.select().from(shares).where(eq(shares.id, shareId)).limit(1);
  return row ?? null;
}

/** Shares on the node itself (pending ones included), oldest first. */
export async function sharesOnNode(db: Executor, nodeId: string): Promise<Share[]> {
  if (!isUuid(nodeId)) return [];
  return db
    .select()
    .from(shares)
    .where(eq(shares.nodeId, nodeId))
    .orderBy(asc(shares.createdAt), asc(shares.id));
}

/** Changes the fields given; the row as stored after, or null when it is gone. */
export async function updateShare(
  db: Executor,
  shareId: string,
  patch: { role?: ShareRole; canUpload?: boolean; mutedByGrantee?: boolean },
): Promise<Share | null> {
  if (!isUuid(shareId)) return null;
  const [row] = await db.update(shares).set(patch).where(eq(shares.id, shareId)).returning();
  return row ?? null;
}

export async function deleteShare(db: Executor, shareId: string): Promise<boolean> {
  if (!isUuid(shareId)) return false;
  const rows = await db.delete(shares).where(eq(shares.id, shareId)).returning({ id: shares.id });
  return rows.length > 0;
}

/**
 * The nearest folder ABOVE the node (the node itself not included) that has a share to anyone,
 * pending or active: whose shares also reach this node. Null when none has.
 *
 * `within`: the outermost node the caller may see (`Access.viewRootId`) — the walk goes up to it
 * and NO FURTHER, so a folder above a share partner's view is never named to them. Null: the
 * owner, who sees the whole chain.
 */
export async function nearestSharedAncestor(
  db: Executor,
  nodeId: string,
  within: string | null,
): Promise<{ nodeId: string; name: string } | null> {
  if (!isUuid(nodeId) || (within !== null && !isUuid(within))) return null;
  // The walk does not climb from the boundary row: nothing above it is read.
  const stop = within === null ? sql`true` : sql`up.id <> ${within}`;
  const result = await db.execute<{ id: string; name: string }>(sql`
    WITH RECURSIVE up(id, parent_id, name, depth) AS (
      SELECT n.id, n.parent_id, n.name, 0 FROM nodes n WHERE n.id = ${nodeId}
      UNION ALL
      SELECT p.id, p.parent_id, p.name, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id
      WHERE ${stop}
    ) CYCLE id SET is_cycle USING path
    SELECT up.id, up.name FROM up
    WHERE up.depth > 0 AND NOT up.is_cycle AND EXISTS (SELECT 1 FROM shares s WHERE s.node_id = up.id)
    ORDER BY up.depth
    LIMIT 1`);
  const row = result.rows[0];
  return row ? { nodeId: row.id, name: row.name } : null;
}

// ── links ───────────────────────────────────────────────────────────────────────────────────

export type NewLink = {
  id: string;
  nodeId: string;
  createdBy: string;
  tokenHash: string;
  tokenEnc: Uint8Array;
  tokenIv: Uint8Array;
  tokenKeyVersion: number;
  passwordHash: string | null;
  expiresAt: Date | null;
  maxDownloads: number | null;
  allowPreview: boolean;
};

export async function insertLink(db: Executor, link: NewLink): Promise<ShareLink> {
  const [row] = await db
    .insert(shareLinks)
    .values({
      ...link,
      tokenEnc: Buffer.from(link.tokenEnc),
      tokenIv: Buffer.from(link.tokenIv),
    })
    .returning();
  return row!;
}

/** A link with what its owner is shown of its node. */
export type LinkWithNode = ShareLink & { nodeName: string; nodeKind: "file" | "folder" };

const linkWithNode = {
  link: shareLinks,
  nodeName: nodes.name,
  nodeKind: nodes.kind,
};

/** Links ON the node, newest first, revoked ones included. */
export async function linksOnNode(db: Executor, nodeId: string): Promise<LinkWithNode[]> {
  if (!isUuid(nodeId)) return [];
  const rows = await db
    .select(linkWithNode)
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(eq(shareLinks.nodeId, nodeId))
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  return rows.map(({ link, nodeName, nodeKind }) => ({ ...link, nodeName, nodeKind }));
}

/** Every link the user created, newest first, revoked ones included (system nodes never have one). */
export async function linksOfOwner(db: Executor, ownerId: string): Promise<LinkWithNode[]> {
  const rows = await db
    .select(linkWithNode)
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(and(eq(shareLinks.createdBy, ownerId), isNull(nodes.system)))
    .orderBy(desc(shareLinks.createdAt), desc(shareLinks.id));
  return rows.map(({ link, nodeName, nodeKind }) => ({ ...link, nodeName, nodeKind }));
}

export async function linkWithNodeById(db: Executor, linkId: string): Promise<LinkWithNode | null> {
  if (!isUuid(linkId)) return null;
  const [row] = await db
    .select(linkWithNode)
    .from(shareLinks)
    .innerJoin(nodes, eq(nodes.id, shareLinks.nodeId))
    .where(eq(shareLinks.id, linkId))
    .limit(1);
  return row ? { ...row.link, nodeName: row.nodeName, nodeKind: row.nodeKind } : null;
}

/**
 * Writes the owner's settings of a link — and nothing else: no session, grant or token is stored
 * anywhere, so a new password needs no revocation step (the password version does it).
 */
export async function updateLinkSettings(
  db: Executor,
  linkId: string,
  patch: {
    expiresAt?: Date | null;
    passwordHash?: string | null;
    maxDownloads?: number | null;
    allowPreview?: boolean;
  },
): Promise<void> {
  if (!isUuid(linkId) || Object.keys(patch).length === 0) return;
  await db.update(shareLinks).set(patch).where(eq(shareLinks.id, linkId));
}

/** Revokes the link (irreversible). False when it was revoked already or does not exist. */
export async function revokeLink(db: Executor, linkId: string): Promise<boolean> {
  if (!isUuid(linkId)) return false;
  const rows = await db
    .update(shareLinks)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(shareLinks.id, linkId), isNull(shareLinks.revokedAt)))
    .returning({ id: shareLinks.id });
  return rows.length > 0;
}

/** Today's `link` ledger rows (bytes, count) of these links, by link id. One statement. */
export async function linkTotalsOn(
  db: Executor,
  day: string,
  linkIds: string[],
): Promise<Map<string, { bytes: number; count: number }>> {
  const wanted = [...new Set(linkIds)];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: downloadLedger.subjectId, bytes: downloadLedger.bytes, count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, day),
        eq(downloadLedger.subjectType, "link"),
        inArray(downloadLedger.subjectId, wanted),
      ),
    );
  return new Map(rows.map((row) => [row.id, { bytes: Number(row.bytes), count: Number(row.count) }]));
}

/**
 * A link's access log since `since`, summed three ways. No address, no hash and no node: days
 * (successful downloads and their bytes), countries (successful downloads) and STORED outcomes —
 * which the route maps to what the owner may be told.
 */
export async function linkActivity(
  db: Executor,
  linkId: string,
  since: Date,
): Promise<{
  days: { day: string; downloads: number; bytes: number }[];
  countries: { country: string; downloads: number }[];
  outcomes: Record<string, number>;
}> {
  if (!isUuid(linkId)) return { days: [], countries: [], outcomes: {} };
  const where = and(eq(linkAccessLog.linkId, linkId), sql`${linkAccessLog.at} >= ${since}`);
  const day = sql<string>`to_char(${linkAccessLog.at} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const ok = sql`${linkAccessLog.outcome} = 'ok'`;
  const [days, countries, outcomes] = [
    await db
      .select({
        day,
        downloads: sql<number>`count(*) FILTER (WHERE ${ok})`.mapWith(Number),
        bytes: sql<number>`COALESCE(sum(${linkAccessLog.bytes}), 0)`.mapWith(Number),
      })
      .from(linkAccessLog)
      .where(where)
      .groupBy(day)
      .orderBy(day),
    await db
      .select({
        country: sql<string>`COALESCE(${linkAccessLog.country}, '')`,
        downloads: sql<number>`count(*)`.mapWith(Number),
      })
      .from(linkAccessLog)
      .where(and(where, ok))
      .groupBy(sql`1`)
      .orderBy(sql`2 DESC`, sql`1`),
    await db
      .select({ outcome: linkAccessLog.outcome, n: sql<number>`count(*)`.mapWith(Number) })
      .from(linkAccessLog)
      .where(where)
      .groupBy(linkAccessLog.outcome),
  ];
  return {
    days,
    countries: countries.filter((row) => row.country !== ""),
    outcomes: Object.fromEntries(outcomes.map((row) => [row.outcome, row.n])),
  };
}
