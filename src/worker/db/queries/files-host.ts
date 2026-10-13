// The files host's own statements: what a served response adds to a link, the once-a-day claim
// of the "link paused" mail, and the account behind a ceiling.
//
// Everything else the files host reads comes from the shared query modules (nodes, tree, users,
// links, ledger). Nothing here reads or writes `share_links.downloadCount`: the download cap is
// taken where a download URL is minted.

import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { shareLinks, user } from "../schema";

/** What a daily ceiling scales with (`quotaBytes`, `createdAt`) and where a notice is sent. */
export type ServeAccount = {
  id: string;
  email: string;
  name: string;
  quotaBytes: number;
  createdAt: Date;
};

/** Null when no user has that id. */
export async function accountOf(db: Executor, userId: string): Promise<ServeAccount | null> {
  const [row] = await db
    .select({
      id: user.id,
      email: user.email,
      name: user.name,
      quotaBytes: user.quotaBytes,
      createdAt: user.createdAt,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}

/** `share_links.bytesServed += bytes` — the bytes a response actually sent. One atomic update. */
export async function addBytesServed(db: Executor, linkId: string, bytes: number): Promise<void> {
  if (!isUuid(linkId)) return;
  if (!Number.isSafeInteger(bytes) || bytes <= 0) return;
  await db
    .update(shareLinks)
    .set({ bytesServed: sql`${shareLinks.bytesServed} + ${bytes}::bigint` })
    .where(eq(shareLinks.id, linkId));
}

/**
 * Claims today's "link paused" mail for a link: `lastPauseEmailAt` is set to now only when it is
 * unset or lies before the start of the current UTC day. One conditional UPDATE, so of any number
 * of concurrent calls exactly one gets the row back.
 * Null = already claimed today (or no such link). Otherwise the link's node and its creator.
 */
export async function claimPauseEmail(
  db: Executor,
  linkId: string,
): Promise<{ nodeId: string; ownerId: string } | null> {
  if (!isUuid(linkId)) return null;
  const rows = await db
    .update(shareLinks)
    .set({ lastPauseEmailAt: sql`now()` })
    .where(
      sql`${shareLinks.id} = ${linkId} AND (${shareLinks.lastPauseEmailAt} IS NULL
        OR ${shareLinks.lastPauseEmailAt} < date_trunc('day', now(), 'UTC'))`,
    )
    .returning({ nodeId: shareLinks.nodeId, ownerId: shareLinks.createdBy });
  return rows[0] ?? null;
}
