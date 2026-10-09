// Shares to people. A share to an address with no account is a real row with no
// `granteeUserId`: it is PENDING and grants nothing until the address is verified by an account.

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type Node, nodes, type Share, shares } from "../schema";
import { notEffectivelyTrashed } from "./tree";
import { ownerIsActive } from "./users";

/** The ACTIVATED share of that user on that node itself (not on an ancestor), or null. */
export async function findShare(
  db: Executor,
  where: { nodeId: string; granteeUserId: string },
): Promise<Share | null> {
  if (!isUuid(where.nodeId)) return null;
  const [row] = await db
    .select()
    .from(shares)
    .where(
      and(
        eq(shares.nodeId, where.nodeId),
        eq(shares.granteeUserId, where.granteeUserId),
        isNotNull(shares.activatedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * True when the two accounts have an active share relationship in either direction: one owns a
 * node that is shared, activated, with the other. Pending rows do not count. (Avatar visibility.)
 */
export async function hasShareBetween(db: Executor, userA: string, userB: string): Promise<boolean> {
  if (userA === userB) return true;
  const result = await db.execute<{ found: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM shares s JOIN nodes n ON n.id = s.node_id
      WHERE s.activated_at IS NOT NULL
        AND ((n.owner_id = ${userA} AND s.grantee_user_id = ${userB})
          OR (n.owner_id = ${userB} AND s.grantee_user_id = ${userA}))
    ) AS found`);
  return result.rows[0]?.found === true;
}

/** Share rows on the node, pending ones included (the per-node grantee limit counts both). */
export async function countGrantees(db: Executor, nodeId: string): Promise<number> {
  if (!isUuid(nodeId)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(shares)
    .where(eq(shares.nodeId, nodeId));
  return row?.n ?? 0;
}

/**
 * Turns the pending shares addressed to `email` into active shares of `userId`. Called when an
 * address becomes verified: at sign-up and after an email change.
 * Where the user already holds a share on the same node, the pending row is dropped instead
 * (one share per user and node). Returns the shares that became active.
 */
export async function activatePendingShares(db: Executor, userId: string, email: string): Promise<Share[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`
      DELETE FROM shares p
      WHERE p.grantee_user_id IS NULL AND p.grantee_email = ${email}::citext
        AND EXISTS (SELECT 1 FROM shares d WHERE d.node_id = p.node_id AND d.grantee_user_id = ${userId})`);
    return tx
      .update(shares)
      .set({ granteeUserId: userId, activatedAt: sql`now()` })
      .where(and(isNull(shares.granteeUserId), sql`${shares.granteeEmail} = ${email}::citext`))
      .returning();
  });
}

/**
 * What other people share with the user: active shares only, on nodes that are live (not
 * trashed, taken down or system) and whose owner is active (not banned, suspended or scheduled
 * for deletion).
 */
export async function sharedWithMe(db: Executor, userId: string): Promise<{ share: Share; node: Node }[]> {
  return db
    .select({ share: shares, node: nodes })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(
      and(
        eq(shares.granteeUserId, userId),
        isNotNull(shares.activatedAt),
        isNull(nodes.system),
        isNull(nodes.takedownAt),
        notEffectivelyTrashed(),
        ownerIsActive(sql`${nodes.ownerId}`),
      ),
    )
    .orderBy(sql`${shares.createdAt} DESC`, shares.id);
}

/** Every share on the user's own nodes, pending ones included, newest first. */
export async function sharedByMe(db: Executor, userId: string): Promise<{ share: Share; node: Node }[]> {
  return db
    .select({ share: shares, node: nodes })
    .from(shares)
    .innerJoin(nodes, eq(nodes.id, shares.nodeId))
    .where(eq(nodes.ownerId, userId))
    .orderBy(sql`${shares.createdAt} DESC`, shares.id);
}
