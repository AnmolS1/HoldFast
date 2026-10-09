// The SHA-256 blocklist. A `csam` entry is never downgraded or removed by a weaker write.

import { and, eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { hashBlocklist } from "../schema";

export type BlocklistReason = (typeof hashBlocklist.reason.enumValues)[number];

export async function lookup(
  db: Executor,
  sha256: string,
): Promise<{ reason: BlocklistReason; sourceNodeId: string | null } | null> {
  const [row] = await db
    .select({ reason: hashBlocklist.reason, sourceNodeId: hashBlocklist.sourceNodeId })
    .from(hashBlocklist)
    .where(eq(hashBlocklist.sha256, sha256))
    .limit(1);
  return row ?? null;
}

/**
 * Adds a hash, or rewrites the entry that is there — except that an existing `csam` entry is
 * kept as it is. Safe to repeat: there is one row per hash.
 */
export async function upsert(
  db: Executor,
  entry: {
    sha256: string;
    reason: BlocklistReason;
    sourceNodeId?: string | null;
    addedBy?: string | null;
    note?: string | null;
  },
): Promise<void> {
  await db
    .insert(hashBlocklist)
    .values({
      sha256: entry.sha256,
      reason: entry.reason,
      sourceNodeId: entry.sourceNodeId ?? null,
      addedBy: entry.addedBy ?? null,
      note: entry.note ?? null,
    })
    .onConflictDoUpdate({
      target: hashBlocklist.sha256,
      set: {
        reason: sql`EXCLUDED.reason`,
        sourceNodeId: sql`EXCLUDED.source_node_id`,
        addedBy: sql`EXCLUDED.added_by`,
        note: sql`EXCLUDED.note`,
      },
      setWhere: sql`${hashBlocklist.reason} <> 'csam'`,
    });
}

/**
 * Removes an entry. With `onlyIfSourceNodeId`, only when that node's verdict added it (the
 * false-positive path must not remove an entry someone else added). True when a row went.
 */
export async function remove(
  db: Executor,
  sha256: string,
  opts: { onlyIfSourceNodeId?: string } = {},
): Promise<boolean> {
  const rows = await db
    .delete(hashBlocklist)
    .where(
      and(
        eq(hashBlocklist.sha256, sha256),
        opts.onlyIfSourceNodeId !== undefined
          ? eq(hashBlocklist.sourceNodeId, opts.onlyIfSourceNodeId)
          : undefined,
      ),
    )
    .returning({ sha256: hashBlocklist.sha256 });
  return rows.length > 0;
}
