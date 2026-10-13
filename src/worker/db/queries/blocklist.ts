// The SHA-256 blocklist. A `csam` entry is never downgraded or removed by a weaker write.
//
// AN ENTRY'S STATES, and who moves it between them:
//   - listed for a reason other than `csam` (`upsert`): `sourceNodeId` is the node whose verdict
//     or takedown listed it, or null;
//   - CREATED by a suspected-CSAM lock (`moderation.lockSuspectedCsam`): `csam`, `sourceNodeId`
//     the locked node — a clear of the last locked node with that content deletes it;
//   - RAISED by a lock: it was listed for another reason and is `csam` while the lock stands —
//     `raisedFrom` is what it was, `raisedByNodeId` whose lock raised it; a clear puts it back;
//   - CONFIRMED (`confirmCsam`, or an explicit `csam` `upsert`): `csam` with no source and
//     nothing raised. Permanent to every clear of a lock.
// `moderation.clearSuspectedCsam` is the only way a lock's entry is undone; `remove` here is an
// admin's delete, and its `onlyIfSourceNodeId` form refuses the raised and the confirmed states.
//
// LOCK ORDER: the entry's row comes AFTER the `nodes` row and BEFORE the node's `reports` rows
// (queries/moderation.ts). `confirmCsam` and `upsert` take the entry's row lock: a filing calls
// `confirmCsam` after it has the node row and before it updates the report.

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
 * Removes an entry. Without options: an admin's outright delete, whatever the entry is.
 * With `onlyIfReason` — only when the entry's reason is STILL that one ("remove what I listed
 * as malware" must not delete an entry a lock has since raised to `csam`); with
 * `onlyIfSourceNodeId` — only when that node's verdict added it. Through either option an
 * entry a suspected-CSAM lock RAISED (it has its own way back, `raisedFrom`) and a CONFIRMED
 * `csam` listing (no source, nothing raised) are never removed — and neither is a `csam` entry
 * while a node with that content is still locked as `suspected_csam` (the entry a lock
 * CREATED): the options are for undoing an entry of a given reason or source, not for
 * unblocking content that is locked right now.
 * This is not how a cleared CSAM lock undoes its entry — that is `moderation.clearSuspectedCsam`,
 * which knows the entry's whole state. True when a row went.
 */
export async function remove(
  db: Executor,
  sha256: string,
  opts: { onlyIfReason?: BlocklistReason; onlyIfSourceNodeId?: string } = {},
): Promise<boolean> {
  const conditional = opts.onlyIfReason !== undefined || opts.onlyIfSourceNodeId !== undefined;
  const rows = await db
    .delete(hashBlocklist)
    .where(
      and(
        eq(hashBlocklist.sha256, sha256),
        opts.onlyIfReason !== undefined ? eq(hashBlocklist.reason, opts.onlyIfReason) : undefined,
        opts.onlyIfSourceNodeId !== undefined
          ? eq(hashBlocklist.sourceNodeId, opts.onlyIfSourceNodeId)
          : undefined,
        conditional
          ? sql`(${hashBlocklist.raisedFrom} IS NULL AND NOT (${hashBlocklist.reason} = 'csam'
              AND ${hashBlocklist.sourceNodeId} IS NULL AND ${hashBlocklist.raisedByNodeId} IS NULL)
              AND NOT (${hashBlocklist.reason} = 'csam' AND EXISTS (
                SELECT 1 FROM nodes locked
                WHERE locked.sha256 = ${hashBlocklist.sha256} AND locked.scan_status = 'suspected_csam')))`
          : undefined,
      ),
    )
    .returning({ sha256: hashBlocklist.sha256 });
  return rows.length > 0;
}
