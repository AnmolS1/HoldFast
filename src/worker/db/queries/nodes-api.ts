// Reads only the nodes routes make (routes/nodes.ts): who holds a name in a folder, and the
// files of a zip manifest.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { ZipManifest } from "../../../shared/schemas/node";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { nodes, type ScanStatus } from "../schema";
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

/**
 * The files under `roots` (a root that is a file is itself one), depth first, each folder's
 * content by name, the roots in the order given. `clean` files are `entries`; the others are
 * `skipped` with the reason their download would be refused for.
 *
 * LEFT OUT ENTIRELY — from `entries` and from `skipped`, because naming them would disclose
 * them: a root that is hidden or in the trash (itself or by an ancestor), every taken-down or
 * trashed node below a root with everything under it, system nodes, `suspected_csam` files, and
 * a file without a current version (no download URL would be minted for it either).
 * The roots get the inherited test (`notEffectivelyTrashedOrHidden`); below a root that passed
 * it the walk stops at the first trashed or taken-down row, which is the same test, inherited by
 * the walk itself.
 *
 * At most `maxFiles` files are read (entries and skipped together); `truncated` says there were
 * more. A file reached through two roots (a folder and something inside it) is listed once,
 * under the outer one.
 */
export async function zipManifest(db: Executor, roots: ZipRoot[], maxFiles: number): Promise<ZipManifest> {
  const given = roots.filter((root) => isUuid(root.id));
  if (given.length === 0) return { entries: [], totalBytes: 0, skipped: [], truncated: false };
  // One parameter, whatever the number of roots.
  const list = JSON.stringify(given.map(({ id, label, owner }) => ({ id, label, owner })));
  const result = await db.execute<{
    id: string;
    path: string;
    size: string;
    version_id: string | null;
    modified_at: string;
    scan_status: ScanStatus;
    owner: boolean;
  }>(sql`
    WITH RECURSIVE roots(id, label, owner, ord) AS (
      SELECT (e.value->>'id')::uuid, e.value->>'label', (e.value->>'owner')::boolean, e.ordinality
      FROM jsonb_array_elements(${list}::jsonb) WITH ORDINALITY AS e(value, ordinality)
    ),
    down(id, kind, path, name_key, depth, owner, ord) AS (
      SELECT n.id, n.kind, r.label, n.name_key, 0, r.owner, r.ord
      FROM roots r JOIN nodes n ON n.id = r.id
      WHERE n.system IS NULL AND ${notEffectivelyTrashedOrHidden("n")}
      UNION ALL
      SELECT c.id, c.kind, down.path || '/' || c.name, c.name_key, down.depth + 1, down.owner, down.ord
      FROM nodes c JOIN down ON c.parent_id = down.id
      WHERE c.deleted_at IS NULL AND c.takedown_at IS NULL AND c.system IS NULL
    ) SEARCH DEPTH FIRST BY name_key, id SET ordercol
      CYCLE id SET is_cycle USING walked,
    files AS (
      SELECT DISTINCT ON (down.id) down.id, down.path, down.owner, down.ord, down.ordercol
      FROM down
      WHERE NOT down.is_cycle AND down.kind = 'file'
      ORDER BY down.id, down.depth DESC
    )
    SELECT f.id, f.path, f.owner, n.size, n.version_id, n.scan_status,
           to_char(n.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS modified_at
    FROM files f JOIN nodes n ON n.id = f.id
    WHERE n.scan_status <> 'suspected_csam' AND n.version_id IS NOT NULL
    ORDER BY f.ord, f.ordercol
    LIMIT ${maxFiles + 1}`);

  const rows = result.rows.slice(0, maxFiles);
  const manifest: ZipManifest = {
    entries: [],
    totalBytes: 0,
    skipped: [],
    truncated: result.rows.length > maxFiles,
  };
  for (const row of rows) {
    if (row.scan_status !== "clean") {
      manifest.skipped.push({
        nodeId: row.id,
        path: row.path,
        reason: skipReason(row.scan_status, row.owner),
      });
      continue;
    }
    const size = Number(row.size);
    manifest.entries.push({
      nodeId: row.id,
      path: row.path,
      size,
      etag: row.version_id ?? "",
      modifiedAt: row.modified_at,
    });
    manifest.totalBytes += size;
  }
  return manifest;
}
