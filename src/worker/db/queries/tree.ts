// The folder tree: an adjacency list (`nodes.parent_id`) walked with recursive CTEs.
//
// Trash marks only the trashed root (`deleted_at`, `trashed_root`); its descendants are trashed
// by ancestry. "Effectively trashed" therefore always means "this node or one of its ancestors
// has `deleted_at`".

import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type Node, nodes } from "../schema";
import { isActive, userState } from "./users";

export type TreeRow = {
  id: string;
  parentId: string | null;
  ownerId: string;
  kind: "file" | "folder";
  name: string;
  /** 0 for the starting node; grows away from it. */
  depth: number;
};

type RawTreeRow = {
  id: string;
  parent_id: string | null;
  owner_id: string;
  kind: "file" | "folder";
  name: string;
  depth: number;
};

const toTreeRow = (r: RawTreeRow): TreeRow => ({
  id: r.id,
  parentId: r.parent_id,
  ownerId: r.owner_id,
  kind: r.kind,
  name: r.name,
  depth: Number(r.depth),
});

/**
 * The node's ancestors, root first, the node itself excluded (the breadcrumb order).
 * Empty for a root-level node and for an id that does not exist.
 */
export async function ancestors(db: Executor, nodeId: string): Promise<TreeRow[]> {
  if (!isUuid(nodeId)) return [];
  const result = await db.execute<RawTreeRow>(sql`
    WITH RECURSIVE up(id, parent_id, owner_id, kind, name, depth) AS (
      SELECT n.id, n.parent_id, n.owner_id, n.kind, n.name, 0 FROM nodes n WHERE n.id = ${nodeId}
      UNION ALL
      SELECT p.id, p.parent_id, p.owner_id, p.kind, p.name, up.depth + 1
      FROM nodes p JOIN up ON p.id = up.parent_id
    ) CYCLE id SET is_cycle USING path
    SELECT id, parent_id, owner_id, kind, name, depth FROM up
    WHERE depth > 0 AND NOT is_cycle
    ORDER BY depth DESC`);
  return result.rows.map(toTreeRow);
}

export type SubtreeRow = TreeRow & {
  size: number;
  r2Key: string | null;
  versionId: string | null;
  system: string | null;
  deletedAt: Date | null;
};

/**
 * The node and everything under it, depth first (a folder, then its content ordered by name).
 * Trashed rows are included: this is what purge, export and zip manifests walk.
 */
export async function subtree(db: Executor, nodeId: string): Promise<SubtreeRow[]> {
  if (!isUuid(nodeId)) return [];
  const result = await db.execute<
    RawTreeRow & {
      size: string;
      r2_key: string | null;
      version_id: string | null;
      system: string | null;
      deleted_at: string | null;
    }
  >(sql`
    WITH RECURSIVE down(id, parent_id, owner_id, kind, name, name_key, depth) AS (
      SELECT n.id, n.parent_id, n.owner_id, n.kind, n.name, n.name_key, 0 FROM nodes n WHERE n.id = ${nodeId}
      UNION ALL
      SELECT c.id, c.parent_id, c.owner_id, c.kind, c.name, c.name_key, down.depth + 1
      FROM nodes c JOIN down ON c.parent_id = down.id
    ) SEARCH DEPTH FIRST BY name_key, id SET ordercol
      CYCLE id SET is_cycle USING path
    SELECT down.id, down.parent_id, down.owner_id, down.kind, down.name, down.depth,
           n.size, n.r2_key, n.version_id, n.system,
           to_char(n.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS deleted_at
    FROM down JOIN nodes n ON n.id = down.id
    WHERE NOT down.is_cycle
    ORDER BY down.ordercol`);
  return result.rows.map((r) => ({
    ...toTreeRow(r),
    size: Number(r.size),
    r2Key: r.r2_key,
    versionId: r.version_id,
    system: r.system,
    deletedAt: r.deleted_at === null ? null : new Date(r.deleted_at),
  }));
}

/** True when `candidate` is `of` itself or lies anywhere under it. Trash state is not considered. */
export async function isDescendantOrSelf(db: Executor, candidate: string, of: string): Promise<boolean> {
  if (!isUuid(candidate) || !isUuid(of)) return false;
  const result = await db.execute<{ found: boolean }>(sql`
    WITH RECURSIVE up(id, parent_id) AS (
      SELECT n.id, n.parent_id FROM nodes n WHERE n.id = ${candidate}
      UNION ALL
      SELECT p.id, p.parent_id FROM nodes p JOIN up ON p.id = up.parent_id
    ) CYCLE id SET is_cycle USING path
    SELECT EXISTS (SELECT 1 FROM up WHERE id = ${of}) AS found`);
  return result.rows[0]?.found === true;
}

/**
 * True when the node or one of its ancestors is in the trash — and for an id that does not
 * exist, so a caller that only asks "may this be shown?" fails closed.
 */
export async function effectiveTrashed(db: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return true;
  const result = await db.execute<{ found: boolean; trashed: boolean }>(sql`
    WITH RECURSIVE up(id, parent_id, deleted_at) AS (
      SELECT n.id, n.parent_id, n.deleted_at FROM nodes n WHERE n.id = ${nodeId}
      UNION ALL
      SELECT p.id, p.parent_id, p.deleted_at FROM nodes p JOIN up ON p.id = up.parent_id
    ) CYCLE id SET is_cycle USING path
    SELECT EXISTS (SELECT 1 FROM up) AS found,
           EXISTS (SELECT 1 FROM up WHERE deleted_at IS NOT NULL) AS trashed`);
  const row = result.rows[0];
  return !row || !row.found || row.trashed;
}

/**
 * A predicate for a query over `nodes`: the row is not in the trash, directly or by ancestry.
 * `alias` is the SQL name the outer query gives the table (default `nodes`).
 */
export function notEffectivelyTrashed(alias: string = "nodes"): SQL {
  const t = sql.identifier(alias);
  return sql`(${t}.deleted_at IS NULL AND NOT EXISTS (
    WITH RECURSIVE up(id, parent_id, deleted_at) AS (
      SELECT a.id, a.parent_id, a.deleted_at FROM nodes a WHERE a.id = ${t}.parent_id
      UNION ALL
      SELECT p.id, p.parent_id, p.deleted_at FROM nodes p JOIN up ON p.id = up.parent_id
    ) CYCLE id SET is_cycle USING path
    SELECT 1 FROM up WHERE deleted_at IS NOT NULL))`;
}

export type Role = "owner" | "editor" | "viewer";

export type Access = {
  role: Role;
  /** The nearest node (this one or an ancestor) with a share to the user; null for the owner. */
  shareRootId: string | null;
  /** Whether the user may add files here: always for the owner, the share's toggle for an editor. */
  canUpload: boolean;
};

/**
 * What `userId` may do with the node, through ownership or through ACTIVATED shares on the node
 * or any ancestor (the highest role wins). Null when there is no access — and, for anyone but
 * the owner, when the node's owner is banned, suspended or scheduled for deletion.
 *
 * Trash, takedown and scan state are NOT considered here: callers check those separately.
 * A pending share (no `granteeUserId`) grants nothing.
 */
export async function effectiveAccess(db: Executor, userId: string, nodeId: string): Promise<Access | null> {
  if (!isUuid(nodeId)) return null;
  const result = await db.execute<{
    id: string;
    depth: number;
    owner_id: string;
    role: "viewer" | "editor" | null;
    can_upload: boolean | null;
  }>(sql`
    WITH RECURSIVE up(id, parent_id, owner_id, depth) AS (
      SELECT n.id, n.parent_id, n.owner_id, 0 FROM nodes n WHERE n.id = ${nodeId}
      UNION ALL
      SELECT p.id, p.parent_id, p.owner_id, up.depth + 1 FROM nodes p JOIN up ON p.id = up.parent_id
    ) CYCLE id SET is_cycle USING path
    SELECT up.id, up.depth, up.owner_id, s.role, s.can_upload
    FROM up
    LEFT JOIN shares s
      ON s.node_id = up.id AND s.grantee_user_id = ${userId} AND s.activated_at IS NOT NULL
    WHERE NOT up.is_cycle
    ORDER BY up.depth`);
  const chain = result.rows;
  const self = chain[0];
  if (!self) return null;
  if (self.owner_id === userId) return { role: "owner", shareRootId: null, canUpload: true };

  const grants = chain.filter((row) => row.role !== null);
  const nearest = grants[0];
  if (!nearest) return null;
  if (!isActive(await userState(db, self.owner_id))) return null;

  const nearestEditor = grants.find((row) => row.role === "editor");
  if (nearestEditor) {
    return { role: "editor", shareRootId: nearest.id, canUpload: nearestEditor.can_upload === true };
  }
  return { role: "viewer", shareRootId: nearest.id, canUpload: false };
}

/** `effectiveAccess(...)?.role ?? null`. */
export async function effectiveRole(db: Executor, userId: string, nodeId: string): Promise<Role | null> {
  return (await effectiveAccess(db, userId, nodeId))?.role ?? null;
}

/**
 * The owner's root-level nodes, trashed or not, including hidden ones (taken down, quarantined):
 * this is the list the account export and the user-purge job walk. `includeSystem` adds the
 * `system = 'avatar'` nodes.
 */
export async function ownedRoots(
  db: Executor,
  ownerId: string,
  opts: { includeSystem?: boolean } = {},
): Promise<Node[]> {
  const conditions = [eq(nodes.ownerId, ownerId), isNull(nodes.parentId)];
  if (!opts.includeSystem) conditions.push(isNull(nodes.system));
  return db
    .select()
    .from(nodes)
    .where(and(...conditions))
    .orderBy(nodes.nameKey, nodes.id);
}
