// Reads only the nodes routes make (routes/nodes.ts): who holds a name in a folder, the caller's
// own shares on the rows of a listing, the files of a zip manifest — and one write: giving the
// rescan hour back.

import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { ZipManifest } from "../../../shared/schemas/node";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { nodes, type ScanStatus, shares } from "../schema";
import { notEffectivelyTrashedOrHidden } from "./tree";

/**
 * The live node that holds `nameKey` in a folder of `ownerId` (`parentId` null = the top level),
 * or null. One probe of the index that makes the name unique — so it finds a file as well as a
 * folder, and a taken-down node, which still holds its name. Whether the caller may see what it
 * found is the caller's question.
 */
export async function liveNameHolder(
  db: Executor,
  args: { ownerId: string; parentId: string | null; nameKey: string },
): Promise<{ id: string; kind: "file" | "folder" } | null> {
  if (args.parentId !== null && !isUuid(args.parentId)) return null;
  const [row] = await db
    .select({ id: nodes.id, kind: nodes.kind })
    .from(nodes)
    .where(
      and(
        eq(nodes.ownerId, args.ownerId),
        args.parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, args.parentId),
        eq(nodes.nameKey, args.nameKey),
        isNull(nodes.deletedAt),
        isNull(nodes.system),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * The nodes among `nodeIds` that `userId` has an ACTIVATED editor share on — a share row on the
 * node itself. For a listing's `role` field only: a child with a share of its own can have a
 * higher role than the folder it is listed in. What the caller may DO is never decided from
 * this; every action asks the permission service.
 */
export async function ownEditorShares(db: Executor, userId: string, nodeIds: string[]): Promise<Set<string>> {
  const ids = nodeIds.filter(isUuid);
  if (ids.length === 0) return new Set();
  const rows = await db
    .select({ nodeId: shares.nodeId })
    .from(shares)
    .where(
      and(
        inArray(shares.nodeId, ids),
        eq(shares.granteeUserId, userId),
        isNotNull(shares.activatedAt),
        eq(shares.role, "editor"),
      ),
    );
  return new Set(rows.map((row) => row.nodeId));
}

/**
 * Gives the owner-rescan hour back: `rescan_requested_at` is set to what it was before the
 * request took it. For a rescan that was granted and then could not be queued.
 */
export async function releaseRescan(db: Executor, nodeId: string, previous: Date | null): Promise<void> {
  if (!isUuid(nodeId)) return;
  await db.update(nodes).set({ rescanRequestedAt: previous }).where(eq(nodes.id, nodeId));
}

/**
 * Did THIS transaction re-parent the node? Asked right after T05 `nodes.move(tx, …)`, in the
 * same transaction — so still under the owner's tree lock that `move` took, where no other move
 * of the tree can come between. `move` stamps `updated_at` with the transaction's clock when, and
 * only when, it re-parents (a move to where the node already is returns the row untouched), and
 * `now()` is that same clock for the whole transaction.
 */
export async function movedInThisTransaction(tx: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const result = await tx.execute<{ moved: boolean }>(
    sql`SELECT n.updated_at = now() AS moved FROM nodes n WHERE n.id = ${nodeId}`,
  );
  return result.rows[0]?.moved === true;
}

export type ZipRoot = {
  id: string;
  /** The first path segment of everything under this root: its name, made unique by the caller. */
  label: string;
  /** Whether the caller owns it: an owner's unscanned file is `unscanned`, anyone else's is blocked. */
  owner: boolean;
};

type ZipSkipReason = ZipManifest["skipped"][number]["reason"];

/** What `download-url` would answer for a file that is not `clean` — as the reason it is left out. */
function skipReason(status: ScanStatus, owner: boolean): ZipSkipReason {
  if (status === "pending") return "scan_pending";
  if (status === "skipped" || status === "error") return owner ? "unscanned" : "scan_blocked";
  return "scan_blocked";
}

/** How many rows of the tree a manifest may walk for each file it may list. */
const WALK_FACTOR = 3;

export type ZipLimits = {
  /** At most this many entries are answered. */
  maxFiles: number;
  /** At most this many rows of the tree (folders and files) are read. Default: 3 × `maxFiles`. */
  maxWalked?: number;
  /**
   * Under a root the caller does NOT own, a file that is not `clean` exists for them only when
   * they uploaded it (`created_by`) and it is in one of these states; every other such file is
   * in neither list. The rule is the route's (`partnerSees`); it hands its two terms in here.
   * Absent: nothing but `clean` under such a root.
   */
  partner?: { viewerId: string; uploaderSees: readonly ScanStatus[] };
};

/**
 * The files under `roots` (a root that is a file is itself one), by path, the roots in the order
 * given. `clean` files are `entries`; the others are `skipped` with the reason their download
 * would be refused for.
 *
 * LEFT OUT ENTIRELY — from `entries` and from `skipped`, because naming them would disclose
 * them: a root that is hidden or in the trash (itself or by an ancestor), every taken-down or
 * trashed node below a root with everything under it, system nodes, `suspected_csam` files, and
 * a file without a current version (no download URL would be minted for it either) — and, under
 * a root the caller does not own, every file that is not `clean`, except the caller's own upload
 * in a state `limits.partner` names (which is `skipped`, as for the owner).
 * The roots get the inherited test (`notEffectivelyTrashedOrHidden`); below a root that passed
 * it the walk stops at the first trashed or taken-down row, which is the same test, inherited by
 * the walk itself.
 *
 * BOUNDED BEFORE IT WALKS. The tree is read level by level, the roots first, and the reading
 * STOPS after `maxWalked` rows: the recursion is cut by a LIMIT directly above it, with nothing
 * between that needs the whole set, so a tree of a million files costs what one of `maxWalked`
 * costs. Everything that does need a whole set — one row per file, the order — works on those
 * rows only. A tree that is larger is answered from its upper levels, with `truncated`.
 *
 * ONE LOOKUP PER ROOT AND PER FOLDER, whatever the planner believes about the table: each step
 * is a LATERAL subquery (kept as one by `OFFSET 0`) that is run for its outer row — a root by
 * its id, a folder's children by `parent_id` — and only a FOLDER is asked for children. Written
 * as plain joins the same walk was left to the planner, which on a table without statistics (a
 * fresh database) compared every row of the tree with every other: 10,000 files took over five
 * seconds.
 *
 * At most `maxFiles` ENTRIES are answered; `truncated` says there were more clean files, or that
 * the walk was cut. Skipped files do not count against the cap (their number is bounded by the
 * walk). A file reached through two roots (a folder and something
 * inside it) is listed once, under the outer one.
 */
export async function zipManifest(db: Executor, roots: ZipRoot[], limits: ZipLimits): Promise<ZipManifest> {
  const { maxFiles } = limits;
  const maxWalked = limits.maxWalked ?? maxFiles * WALK_FACTOR;
  // An id no account has, and no status: nothing matches the uploader's exception.
  const viewerId = limits.partner?.viewerId ?? "";
  const uploaderSees = (limits.partner?.uploaderSees ?? []).join(",");
  const given = roots.filter((root) => isUuid(root.id));
  if (given.length === 0) return { entries: [], totalBytes: 0, skipped: [], truncated: false };
  // One parameter, whatever the number of roots.
  const list = JSON.stringify(given.map(({ id, label, owner }) => ({ id, label, owner })));
  const result = await db.execute<{
    walked: number;
    id: string | null;
    path: string;
    size: string;
    version_id: string;
    modified_at: string;
    scan_status: ScanStatus;
    owner: boolean;
  }>(sql`
    WITH RECURSIVE roots(id, label, owner, ord) AS (
      SELECT (e.value->>'id')::uuid, e.value->>'label', (e.value->>'owner')::boolean, e.ordinality
      FROM jsonb_array_elements(${list}::jsonb) WITH ORDINALITY AS e(value, ordinality)
    ),
    down(id, kind, path, depth, owner, ord) AS (
      SELECT n.id, n.kind, r.label, 0, r.owner, r.ord
      FROM roots r
      CROSS JOIN LATERAL (
        SELECT n.id, n.kind FROM nodes n
        WHERE n.id = r.id AND n.system IS NULL AND ${notEffectivelyTrashedOrHidden("n")}
        OFFSET 0
      ) n
      UNION ALL
      SELECT c.id, c.kind, down.path || '/' || c.name, down.depth + 1, down.owner, down.ord
      FROM down
      CROSS JOIN LATERAL (
        SELECT c.id, c.kind, c.name FROM nodes c
        WHERE c.parent_id = down.id
          AND c.deleted_at IS NULL AND c.takedown_at IS NULL AND c.system IS NULL
        OFFSET 0
      ) c
      WHERE down.kind = 'folder'
    ) CYCLE id SET is_cycle USING seen,
    -- The cut. Nothing may come between this LIMIT and the recursion.
    walked AS MATERIALIZED (
      SELECT down.id, down.kind, down.path, down.depth, down.owner, down.ord
      FROM down WHERE NOT down.is_cycle
      LIMIT ${maxWalked + 1}
    ),
    files AS (
      SELECT DISTINCT ON (w.id) w.id, w.path, w.owner, w.ord
      FROM walked w
      WHERE w.kind = 'file'
      ORDER BY w.id, w.depth DESC
    ),
    listed AS (
      SELECT f.id, f.path, f.owner, f.ord, n.size, n.version_id, n.scan_status,
             to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS modified_at
      FROM files f JOIN nodes n ON n.id = f.id
      WHERE n.scan_status <> 'suspected_csam' AND n.version_id IS NOT NULL
        AND (f.owner OR n.scan_status = 'clean'
             OR (n.created_by = ${viewerId} AND n.scan_status::text = ANY (string_to_array(${uploaderSees}, ','))))
    )
    SELECT t.walked, l.id, l.path, l.owner, l.size, l.version_id, l.scan_status, l.modified_at
    FROM (SELECT count(*)::int AS walked FROM walked) t
    LEFT JOIN listed l ON true
    ORDER BY l.ord, l.path, l.id`);

  const manifest: ZipManifest = {
    entries: [],
    totalBytes: 0,
    skipped: [],
    truncated: Number(result.rows[0]?.walked ?? 0) > maxWalked,
  };
  for (const row of result.rows) {
    if (row.id === null) continue;
    if (row.scan_status !== "clean") {
      manifest.skipped.push({
        nodeId: row.id,
        path: row.path,
        reason: skipReason(row.scan_status, row.owner),
      });
      continue;
    }
    // The cap is on ENTRIES: a file that is skipped anyway does not take a clean file's place.
    if (manifest.entries.length >= maxFiles) {
      manifest.truncated = true;
      continue;
    }
    const size = Number(row.size);
    manifest.entries.push({
      nodeId: row.id,
      path: row.path,
      size,
      etag: row.version_id,
      modifiedAt: row.modified_at,
    });
    manifest.totalBytes += size;
  }
  return manifest;
}
