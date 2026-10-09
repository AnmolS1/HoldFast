// Trash, restore, and the ONE gate for permanent deletion.
//
// Trash marks only the trashed root; descendants are trashed by ancestry (queries/tree.ts).
// Permanent deletion of rows happens in exactly two functions here, `deleteSubtreeRows` and
// `deleteVersionRows`, and both call `assertPurgeable` themselves — no caller can bypass it.
//
// Order of work for a caller: rows first (inside one transaction, with `quota.release` for the
// returned `freedBytes`), objects second (after commit). A crash in between leaves unreferenced
// objects, which the reconcile job removes; the reverse order would leave rows that point at
// missing objects.

import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { extOf, nameKeyOf } from "../../services/filename";
import type { Executor } from "../client";
import { decodeCursor, encodeCursor, isCursorTimestamp } from "../cursor";
import { type HoldCause, isUniqueViolation, LegalHoldError, QueryError } from "../errors";
import { isUuid } from "../ids";
import { type Node, nodes, nodeVersions, uploads, user } from "../schema";
import { effectiveTrashed } from "./tree";

export { LegalHoldError };

/** How long a trashed root stays restorable. */
export const TRASH_RETENTION_DAYS = 30;

const uuidArray = (ids: readonly string[]): SQL =>
  ids.length === 0
    ? sql`'{}'::uuid[]`
    : sql`ARRAY[${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `,
      )}]::uuid[]`;

// ── trash and restore ───────────────────────────────────────────────────────────────────────

/**
 * Moves a node to the trash: `deletedAt`, `trashedRoot`, `trashedBy` and `purgeAfter` on that
 * row only. Null when there is no such node, it is a system node, or it is already a trashed
 * root. Never consults holds: trashing destroys nothing.
 */
export async function trash(
  db: Executor,
  nodeId: string,
  actorId: string,
  opts: { retentionDays?: number } = {},
): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  const days = opts.retentionDays ?? TRASH_RETENTION_DAYS;
  const [row] = await db
    .update(nodes)
    .set({
      deletedAt: sql`now()`,
      trashedRoot: true,
      trashedBy: actorId,
      purgeAfter: sql`now() + make_interval(days => ${days})`,
    })
    .where(and(eq(nodes.id, nodeId), isNull(nodes.deletedAt), isNull(nodes.system)))
    .returning();
  return row ?? null;
}

/** "report.pdf" → "report (restored).pdf", then "report (restored 2).pdf", … */
function restoredName(name: string, attempt: number): string {
  const suffix = attempt === 1 ? " (restored)" : ` (restored ${attempt})`;
  const ext = extOf(name);
  return ext === ""
    ? name + suffix
    : name.slice(0, name.length - ext.length - 1) + suffix + name.slice(-ext.length - 1);
}

/**
 * Takes a trashed root out of the trash, in place — or, with `toRoot`, at the owner's top level
 * (the caller passes it when the parent is itself trashed). When the name is taken there, the
 * node comes back as "<name> (restored)".
 * Null when the node is not a restorable trashed root (not trashed, purge already requested);
 * `conflict` when the parent is in the trash and `toRoot` was not passed.
 */
export async function restore(
  db: Executor,
  nodeId: string,
  opts: { toRoot?: boolean } = {},
): Promise<Node | null> {
  if (!isUuid(nodeId)) return null;
  return db.transaction(async (tx) => {
    const [node] = await tx.select().from(nodes).where(eq(nodes.id, nodeId)).for("update");
    if (!node || node.deletedAt === null || !node.trashedRoot || node.purgeRequestedAt !== null) return null;
    const parentId = opts.toRoot ? null : node.parentId;
    if (parentId !== null && (await effectiveTrashed(tx, parentId))) {
      throw new QueryError("conflict", "the parent folder is in the trash");
    }
    for (let attempt = 0; ; attempt++) {
      const name = attempt === 0 ? node.name : restoredName(node.name, attempt);
      try {
        // A savepoint per attempt: a unique violation would otherwise abort the transaction.
        return await tx.transaction(async (sp) => {
          const [row] = await sp
            .update(nodes)
            .set({
              deletedAt: null,
              trashedRoot: false,
              trashedBy: null,
              purgeAfter: null,
              parentId,
              name,
              nameKey: nameKeyOf(name),
              updatedAt: sql`now()`,
            })
            .where(eq(nodes.id, nodeId))
            .returning();
          return row!;
        });
      } catch (error) {
        if (!isUniqueViolation(error) || attempt >= 20) throw error;
      }
    }
  });
}

type TrashCursor = { at: string; id: string };
const isTrashCursor = (v: unknown): v is TrashCursor =>
  !!v && typeof v === "object" && isCursorTimestamp((v as TrashCursor).at) && isUuid((v as TrashCursor).id);

/**
 * The owner's trashed roots, most recently trashed first. Never a root whose purge was
 * requested (it is hidden until the hold lifts), a system node, a taken-down node or
 * `suspected_csam`.
 */
export async function listTrash(
  db: Executor,
  ownerId: string,
  opts: { cursor?: string | null; limit?: number } = {},
): Promise<{ items: Node[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
  const deletedKey = sql<string>`to_char(${nodes.deletedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const conditions: SQL[] = [
    eq(nodes.ownerId, ownerId),
    eq(nodes.trashedRoot, true),
    isNotNull(nodes.deletedAt),
    isNull(nodes.purgeRequestedAt),
    isNull(nodes.system),
    isNull(nodes.takedownAt),
    sql`${nodes.scanStatus} <> 'suspected_csam'`,
  ];
  if (opts.cursor) {
    const after = decodeCursor(`trash:${ownerId}`, opts.cursor, isTrashCursor);
    conditions.push(sql`(${nodes.deletedAt}, ${nodes.id}) < (${after.at}::timestamptz, ${after.id}::uuid)`);
  }
  const rows = await db
    .select({ node: nodes, deletedKey })
    .from(nodes)
    .where(and(...conditions))
    .orderBy(desc(nodes.deletedAt), desc(nodes.id))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => r.node),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(`trash:${ownerId}`, { at: last.deletedKey, id: last.node.id } satisfies TrashCursor)
        : null,
  };
}

/** An open DMCA notice names the node aliased `n` (the same test as `assertPurgeable`). */
const OPEN_NOTICE_ON_N = sql`EXISTS (
  SELECT 1 FROM dmca_notice_nodes dn JOIN dmca_notices d ON d.id = dn.notice_id
  WHERE dn.node_id = n.id AND d.status IN ('received', 'incomplete', 'actioned', 'counter_received'))`;

/**
 * What `assertPurgeable` would refuse because of the node aliased `n` ITSELF or its owner `u`.
 * The gate stays the authority (it also looks inside the subtree, under locks); this only keeps
 * rows that cannot be purged now out of the queues, so they cannot fill a batch.
 */
const HELD_AT_N = sql`(u.legal_hold OR n.legal_hold
  OR n.scan_status IN ('under_review', 'suspected_csam') OR ${OPEN_NOTICE_ON_N})`;

/**
 * Roots the purge job should try now: trashed roots past `purgeAfter`, and every root whose
 * purge was requested while it was held — as soon as the hold is gone.
 *
 * Two rules keep rows that cannot be purged from stopping the rows that can (each failing row
 * would otherwise be returned first, on every run, forever):
 *  - a root that is held ITSELF, or whose owner is, is not returned at all;
 *  - a root that is held by something deeper in its subtree is returned, the gate refuses it, and
 *    the job records that with `markPurgeAttempted` — the order is never-tried roots first, then
 *    the ones tried longest ago, so a refused root goes to the back of the queue.
 */
export async function purgeDue(db: Executor, limit: number): Promise<{ id: string; ownerId: string }[]> {
  const result = await db.execute<{ id: string; owner_id: string }>(sql`
    SELECT n.id, n.owner_id
    FROM nodes n JOIN "user" u ON u.id = n.owner_id
    WHERE ((n.trashed_root AND n.deleted_at IS NOT NULL AND n.purge_after <= now())
           OR n.purge_requested_at IS NOT NULL)
      AND NOT ${HELD_AT_N}
    ORDER BY n.purge_attempted_at ASC NULLS FIRST, n.purge_after ASC NULLS FIRST, n.id
    LIMIT ${limit}`);
  return result.rows.map((row) => ({ id: row.id, ownerId: row.owner_id }));
}

/**
 * The purge job calls this for every root `deleteSubtreeRows` refused with `LegalHoldError`:
 * it stamps the attempt, which moves the root behind every root not tried since (`purgeDue`).
 * Returns how many rows were stamped.
 */
export async function markPurgeAttempted(db: Executor, rootIds: readonly string[]): Promise<number> {
  const ids = [...new Set(rootIds.filter(isUuid))];
  if (ids.length === 0) return 0;
  const rows = await db
    .update(nodes)
    .set({ purgeAttemptedAt: sql`now()` })
    .where(inArray(nodes.id, ids))
    .returning({ id: nodes.id });
  return rows.length;
}

/**
 * Old versions past their `purgeAfter`, except those the gate would refuse: the gate for a
 * version looks at its node alone (a file has no subtree), so every cause is known here and a
 * held node's versions are simply not returned until the hold is gone.
 */
export async function versionsDue(
  db: Executor,
  limit: number,
): Promise<{ nodeId: string; versionId: string; ownerId: string }[]> {
  const result = await db.execute<{ node_id: string; version_id: string; owner_id: string }>(sql`
    SELECT v.node_id, v.version_id, n.owner_id
    FROM node_versions v JOIN nodes n ON n.id = v.node_id JOIN "user" u ON u.id = n.owner_id
    WHERE v.purge_after <= now() AND NOT ${HELD_AT_N}
    ORDER BY v.purge_after, v.node_id, v.version_id
    LIMIT ${limit}`);
  return result.rows.map((row) => ({
    nodeId: row.node_id,
    versionId: row.version_id,
    ownerId: row.owner_id,
  }));
}

// ── the purge gate ──────────────────────────────────────────────────────────────────────────

/**
 * The single gate for permanent deletion. A root is HELD when any node in its subtree
 *   - has `legalHold`,
 *   - is `suspected_csam` or `under_review`,
 *   - is named by a DMCA notice that is still open (`received`, `incomplete`, `actioned`,
 *     `counter_received` — the content must survive the counter-notice window),
 * or when the subtree's owner has `user.legalHold`. Throws `LegalHoldError` naming every held
 * root; a root is held or purgeable as a whole. Ids that do not exist are ignored.
 */
export async function assertPurgeable(tx: Executor, rootIds: readonly string[]): Promise<void> {
  const ids = [...new Set(rootIds.filter(isUuid))];
  if (ids.length === 0) return;
  const result = await tx.execute<{
    root_id: string;
    node_hold: boolean;
    owner_hold: boolean;
    under_review: boolean;
    suspected_csam: boolean;
    open_notice: boolean;
  }>(sql`
    WITH RECURSIVE sub(root_id, id) AS (
      SELECT n.id, n.id FROM nodes n WHERE n.id = ANY(${uuidArray(ids)})
      UNION ALL
      SELECT sub.root_id, c.id FROM nodes c JOIN sub ON c.parent_id = sub.id
    ) CYCLE root_id, id SET is_cycle USING path
    SELECT sub.root_id,
           bool_or(n.legal_hold) AS node_hold,
           bool_or(u.legal_hold) AS owner_hold,
           bool_or(n.scan_status = 'under_review') AS under_review,
           bool_or(n.scan_status = 'suspected_csam') AS suspected_csam,
           bool_or(EXISTS (
             SELECT 1 FROM dmca_notice_nodes dn JOIN dmca_notices d ON d.id = dn.notice_id
             WHERE dn.node_id = n.id AND d.status IN ('received', 'incomplete', 'actioned', 'counter_received')
           )) AS open_notice
    FROM sub
    JOIN nodes n ON n.id = sub.id
    JOIN "user" u ON u.id = n.owner_id
    WHERE NOT sub.is_cycle
    GROUP BY sub.root_id`);
  const causes: Record<string, HoldCause[]> = {};
  for (const row of result.rows) {
    const found: HoldCause[] = [];
    if (row.node_hold) found.push("node_legal_hold");
    if (row.owner_hold) found.push("owner_legal_hold");
    if (row.under_review) found.push("under_review");
    if (row.suspected_csam) found.push("suspected_csam");
    if (row.open_notice) found.push("open_notice");
    if (found.length > 0) causes[row.root_id] = found;
  }
  if (Object.keys(causes).length > 0) throw new LegalHoldError(causes);
}

export type DeletedRows = {
  /** Whose `used_bytes` the `freedBytes` belong to. Null when the root did not exist. */
  ownerId: string | null;
  /** Objects to delete after commit: current versions and kept old versions. */
  r2Keys: string[];
  /** `t/<nodeId>/<versionId>/` for every deleted version. */
  thumbPrefixes: string[];
  /** Unfinished upload sessions that were removed; the storage layer aborts them by key. */
  uploadsToAbort: { r2Key: string; r2UploadId: string | null }[];
  /**
   * Everything `used_bytes` must drop by: file sizes, old-version sizes and the reservations of
   * the removed unfinished sessions. The caller passes it to `quota.release` in this transaction.
   */
  freedBytes: number;
};

const emptyDeleted = (ownerId: string | null): DeletedRows => ({
  ownerId,
  r2Keys: [],
  thumbPrefixes: [],
  uploadsToAbort: [],
  freedBytes: 0,
});

/**
 * Deletes a whole subtree's rows — any root, trashed or not — after `assertPurgeable`. One
 * transaction (a savepoint inside the caller's): it locks the owner's `user` row, then every node
 * of the subtree, so a hold set concurrently either is seen or waits for this delete.
 * Upload sessions that point into the subtree are deleted too, finished ones included (their
 * `parent_id` reference would block the delete); shares, links, old versions and scan jobs go
 * with their node. Throws `LegalHoldError` and deletes nothing when the root is held.
 */
export async function deleteSubtreeRows(tx: Executor, rootId: string): Promise<DeletedRows> {
  if (!isUuid(rootId)) return emptyDeleted(null);
  return tx.transaction(async (sp) => {
    const [root] = await sp.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, rootId));
    if (!root) return emptyDeleted(null);
    await sp.select({ id: user.id }).from(user).where(eq(user.id, root.ownerId)).for("update");

    const locked = await sp.execute<{
      id: string;
      kind: "file" | "folder";
      system: string | null;
      size: string;
      r2_key: string | null;
      version_id: string | null;
    }>(sql`
      WITH RECURSIVE sub(id) AS (
        SELECT n.id FROM nodes n WHERE n.id = ${rootId}
        UNION ALL
        SELECT c.id FROM nodes c JOIN sub ON c.parent_id = sub.id
      ) CYCLE id SET is_cycle USING path
      SELECT n.id, n.kind, n.system, n.size, n.r2_key, n.version_id
      FROM nodes n WHERE n.id IN (SELECT id FROM sub) ORDER BY n.id FOR UPDATE OF n`);
    const rows = locked.rows;
    if (rows.length === 0) return emptyDeleted(root.ownerId);
    const ids = rows.map((r) => r.id);

    await assertPurgeable(sp, [rootId]);

    const out = emptyDeleted(root.ownerId);
    const counted = new Set<string>();
    for (const row of rows) {
      if (row.system === null) counted.add(row.id);
      if (row.kind === "file" && row.system === null) out.freedBytes += Number(row.size);
      if (row.r2_key !== null) out.r2Keys.push(row.r2_key);
      if (row.version_id !== null) out.thumbPrefixes.push(`t/${row.id}/${row.version_id}/`);
    }

    const versions = await sp
      .select({
        nodeId: nodeVersions.nodeId,
        versionId: nodeVersions.versionId,
        r2Key: nodeVersions.r2Key,
        size: nodeVersions.size,
      })
      .from(nodeVersions)
      .where(inArray(nodeVersions.nodeId, ids));
    for (const version of versions) {
      out.r2Keys.push(version.r2Key);
      out.thumbPrefixes.push(`t/${version.nodeId}/${version.versionId}/`);
      if (counted.has(version.nodeId)) out.freedBytes += version.size;
    }

    const sessions = await sp
      .delete(uploads)
      .where(or(inArray(uploads.parentId, ids), inArray(uploads.replaceNodeId, ids)))
      .returning({
        status: uploads.status,
        purpose: uploads.purpose,
        size: uploads.size,
        r2Key: uploads.r2Key,
        r2UploadId: uploads.r2UploadId,
      });
    for (const session of sessions) {
      if (session.status !== "open" && session.status !== "completing") continue;
      out.uploadsToAbort.push({ r2Key: session.r2Key, r2UploadId: session.r2UploadId });
      if (session.purpose === "file") out.freedBytes += session.size;
    }

    // One statement for the whole subtree: the self-reference is checked at its end.
    await sp.delete(nodes).where(inArray(nodes.id, ids));
    return out;
  });
}

/**
 * Deletes kept old versions of one node, after the same gate (a held node keeps its history).
 * `uploadsToAbort` is always empty here.
 */
export async function deleteVersionRows(
  tx: Executor,
  nodeId: string,
  versionIds: readonly string[],
): Promise<DeletedRows> {
  if (!isUuid(nodeId) || versionIds.length === 0) return emptyDeleted(null);
  return tx.transaction(async (sp) => {
    const [node] = await sp
      .select({ ownerId: nodes.ownerId, system: nodes.system })
      .from(nodes)
      .where(eq(nodes.id, nodeId));
    if (!node) return emptyDeleted(null);
    await sp.select({ id: user.id }).from(user).where(eq(user.id, node.ownerId)).for("update");
    await sp.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).for("update");
    await assertPurgeable(sp, [nodeId]);

    const deleted = await sp
      .delete(nodeVersions)
      .where(and(eq(nodeVersions.nodeId, nodeId), inArray(nodeVersions.versionId, [...versionIds])))
      .returning({ versionId: nodeVersions.versionId, r2Key: nodeVersions.r2Key, size: nodeVersions.size });
    const out = emptyDeleted(node.ownerId);
    for (const version of deleted) {
      out.r2Keys.push(version.r2Key);
      out.thumbPrefixes.push(`t/${nodeId}/${version.versionId}/`);
      if (node.system === null) out.freedBytes += version.size;
    }
    return out;
  });
}
