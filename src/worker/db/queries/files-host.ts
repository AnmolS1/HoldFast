// The files host's own statements: what a served response adds to a link, the once-a-day claim
// of the "link paused" mail, the account behind a ceiling, and the takeover and give-back of a
// thumbnail's unit hold.
//
// Everything else the files host reads comes from the shared query modules (nodes, tree, users,
// links, ledger). Nothing here reads or writes `share_links.downloadCount`: the download cap is
// taken where a download URL is minted.

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { downloadLedger, shareLinks, user } from "../schema";

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

/**
 * Takes over a thumbnail's owner-unit hold that was ABANDONED — exactly the hold that was read:
 * the marker row (ledger subject `notice`) still holds `heldAt` (the hold's time, epoch seconds,
 * > 0), is not paid (`count` = 0), and `heldAt` is at or before `staleBefore`. ONE conditional
 * UPDATE: of any number of requests at once exactly one row update wins — the others re-check the
 * condition against the winner's new time and match nothing; a hold given back (`bytes` 0) and
 * taken again meanwhile has another time and is not this one.
 */
export async function takeOverStaleHold(
  db: Executor,
  day: string,
  marker: string,
  at: number,
  heldAt: number,
  staleBefore: number,
): Promise<boolean> {
  if (!(heldAt > 0) || heldAt > staleBefore) return false;
  const rows = await db
    .update(downloadLedger)
    .set({ bytes: at })
    .where(
      and(
        eq(downloadLedger.day, day),
        eq(downloadLedger.subjectType, "notice"),
        eq(downloadLedger.subjectId, marker),
        eq(downloadLedger.count, 0),
        eq(downloadLedger.bytes, heldAt),
      ),
    )
    .returning({ day: downloadLedger.day });
  return rows.length > 0;
}

/**
 * Gives a thumbnail's owner-unit hold back — only if it is still the hold of the request that
 * took it at `heldAt` and was not charged: ONE conditional UPDATE. A holder that comes back
 * after its hold was taken over (another time is in the row) changes nothing.
 */
export async function releaseHold(
  db: Executor,
  day: string,
  marker: string,
  heldAt: number,
): Promise<boolean> {
  if (!(heldAt > 0)) return false;
  const rows = await db
    .update(downloadLedger)
    .set({ bytes: 0 })
    .where(
      and(
        eq(downloadLedger.day, day),
        eq(downloadLedger.subjectType, "notice"),
        eq(downloadLedger.subjectId, marker),
        eq(downloadLedger.count, 0),
        eq(downloadLedger.bytes, heldAt),
      ),
    )
    .returning({ day: downloadLedger.day });
  return rows.length > 0;
}
