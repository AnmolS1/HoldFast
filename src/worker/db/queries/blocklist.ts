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
 * never rewritten to something else. Safe to repeat: there is one row per hash.
 *
 * Called with `reason: 'csam'` it is a CONFIRMATION, not a lock's write (`confirmCsam`): the
 * entry — new or existing, whatever it was — ends `csam` with its provenance DETACHED
 * (`sourceNodeId`, `raisedFrom`, `raisedByNodeId` all null; a `sourceNodeId` passed in is not
 * stored). Clearing a suspected-CSAM lock as a false positive never lowers or removes such an
 * entry. An entry that already was `csam` keeps its author and note.
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
  const confirming = entry.reason === "csam";
  const wasCsam = sql`${hashBlocklist.reason} = 'csam'`;
  await db
    .insert(hashBlocklist)
    .values({
      sha256: entry.sha256,
      reason: entry.reason,
      sourceNodeId: confirming ? null : (entry.sourceNodeId ?? null),
      addedBy: entry.addedBy ?? null,
      note: entry.note ?? null,
    })
    .onConflictDoUpdate({
      target: hashBlocklist.sha256,
      set: {
        reason: sql`EXCLUDED.reason`,
        sourceNodeId: sql`EXCLUDED.source_node_id`,
        addedBy: sql`CASE WHEN ${wasCsam} THEN ${hashBlocklist.addedBy} ELSE EXCLUDED.added_by END`,
        note: sql`CASE WHEN ${wasCsam} THEN ${hashBlocklist.note} ELSE EXCLUDED.note END`,
        // Whatever a lock recorded on the entry is over: it is rewritten, or confirmed.
        raisedFrom: null,
        raisedByNodeId: null,
      },
      setWhere: confirming ? undefined : sql`${hashBlocklist.reason} <> 'csam'`,
    });
}

/**
 * Makes the hash's entry a CONFIRMED `csam` listing: created if absent; otherwise its reason
 * becomes `csam` and its provenance is detached (`sourceNodeId`, `raisedFrom`, `raisedByNodeId`
 * null). For the moment a report is FILED, and for an admin listing a hash as CSAM by hand: the
 * fact then lives on the entry itself — not on a report or a node row that may be gone later —
 * and no clear of any lock lowers or removes it (queries/moderation.ts). Author and note of an
 * existing entry are kept. True when it wrote something; false when the entry already was one.
 */
export async function confirmCsam(tx: Executor, sha256: string): Promise<boolean> {
  const rows = await tx
    .insert(hashBlocklist)
    .values({ sha256, reason: "csam" })
    .onConflictDoUpdate({
      target: hashBlocklist.sha256,
      set: { reason: "csam", sourceNodeId: null, raisedFrom: null, raisedByNodeId: null },
      setWhere: sql`NOT (${hashBlocklist.reason} = 'csam' AND ${hashBlocklist.sourceNodeId} IS NULL
        AND ${hashBlocklist.raisedFrom} IS NULL AND ${hashBlocklist.raisedByNodeId} IS NULL)`,
    })
    .returning({ sha256: hashBlocklist.sha256 });
  return rows.length > 0;
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
