// The READ-ONLY orphan listing of restore-runbook step 5 (brief R-11): what reconcile's orphan
// sweep WOULD delete, listed for a person to review — it deletes nothing, writes nothing, and has
// no mode that does. (The sweep itself has no list-only mode: with `orphanDeleteEnabled` off it
// returns before listing, and its own "list first" pass is inside a deleting run.)
//
// The rules are the sweep's (jobs/reconcile.ts `unreferenced`, T14), over the same three areas —
// `ORPHAN_AREAS` = `u/`, `t/`, `a/`; `b/` is never listed:
//   u/, a/   unreferenced when no `nodes.r2_key`, no `node_versions.r2_key` and no unfinished
//            (`open` / `completing`) `uploads.r2_key` names it (trash-jobs.ts `referencedKeys`);
//   t/       a thumbnail `t/<node>/<version>/<size>` is unreferenced when that (node, version) is
//            neither a node's current version nor a kept one (`knownVersions`); a key of any
//            other shape is left alone.
// The sweep deletes only what is older than 48 h (`ORPHAN_MIN_AGE_MS`); the listing shows every
// unreferenced object with its age and says which of them the sweep would take.
//
// The reference rules arrive as an interface: the Workers test hands it T14's own functions, the
// CLI (list-orphans.ts) hands it `sqlReferences` — the same three statements in plain SQL over a
// `pg` connection, held equal to T14's by that test.

export const ORPHAN_LIST_AREAS = ["u/", "t/", "a/"] as const;
/** The sweep's floor (jobs/reconcile.ts `ORPHAN_MIN_AGE_MS`). */
export const SWEEP_MIN_AGE_MS = 48 * 3_600_000;

export type Listed = { key: string; uploaded: Date };
export type Lister = (
  prefix: string,
  cursor: string | null,
) => Promise<{ objects: Listed[]; cursor: string | null }>;
export type References = {
  referencedKeys(keys: readonly string[]): Promise<Set<string>>;
  knownVersions(nodeIds: readonly string[]): Promise<Set<string>>;
};

export type Orphan = { key: string; area: string; ageHours: number; sweepWouldDelete: boolean };

/** `t/<node>/<version>/<size>` → its (node, version); anything else → null (left alone). */
export function thumbOwnerOf(key: string): { nodeId: string; versionId: string } | null {
  if (!key.startsWith("t/")) return null;
  const parts = key.slice(2).split("/");
  if (parts.length !== 3) return null;
  const [nodeId, versionId] = parts as [string, string, string];
  return nodeId && versionId ? { nodeId, versionId } : null;
}

async function unreferencedOf(area: string, objects: Listed[], refs: References): Promise<Listed[]> {
  if (objects.length === 0) return [];
  if (area !== "t/") {
    const referenced = await refs.referencedKeys(objects.map((object) => object.key));
    return objects.filter((object) => !referenced.has(object.key));
  }
  const owned = objects.map((object) => ({ object, owner: thumbOwnerOf(object.key) }));
  const known = await refs.knownVersions(owned.flatMap((entry) => (entry.owner ? [entry.owner.nodeId] : [])));
  return owned
    .filter((entry) => entry.owner && !known.has(`${entry.owner.nodeId}/${entry.owner.versionId}`))
    .map((entry) => entry.object);
}

/** Every unreferenced object in the three areas, oldest first within each area. Reads only. */
export async function listOrphans(
  list: Lister,
  refs: References,
  options: { now?: Date; maxPages?: number } = {},
): Promise<Orphan[]> {
  const now = (options.now ?? new Date()).getTime();
  const out: Orphan[] = [];
  let pages = 0;
  for (const area of ORPHAN_LIST_AREAS) {
    let cursor: string | null = null;
    do {
      if (pages++ >= (options.maxPages ?? 10_000)) throw new Error("orphan listing: page limit reached");
      const page = await list(area, cursor);
      for (const object of await unreferencedOf(area, page.objects, refs)) {
        const age = now - object.uploaded.getTime();
        out.push({
          key: object.key,
          area,
          ageHours: Math.floor(age / 3_600_000),
          sweepWouldDelete: age >= SWEEP_MIN_AGE_MS,
        });
      }
      cursor = page.cursor;
    } while (cursor !== null);
  }
  return out;
}

type Query = {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: Row[] }>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** T14's two reference reads (trash-jobs.ts `referencedKeys`, `knownVersions`) in plain SQL. */
export function sqlReferences(sql: Query): References {
  return {
    async referencedKeys(keys) {
      const found = new Set<string>();
      if (keys.length === 0) return found;
      const { rows } = await sql.query<{ key: string }>(
        `SELECT r2_key AS key FROM nodes WHERE r2_key = ANY($1::text[])
         UNION SELECT r2_key FROM node_versions WHERE r2_key = ANY($1::text[])
         UNION SELECT r2_key FROM uploads WHERE r2_key = ANY($1::text[]) AND status IN ('open', 'completing')`,
        [[...keys]],
      );
      for (const row of rows) if (row.key !== null) found.add(row.key);
      return found;
    },
    async knownVersions(nodeIds) {
      const found = new Set<string>();
      const ids = [...new Set(nodeIds.filter((id) => UUID.test(id)))];
      if (ids.length === 0) return found;
      const { rows } = await sql.query<{ node_id: string; version_id: string | null }>(
        `SELECT id::text AS node_id, version_id::text AS version_id FROM nodes WHERE id = ANY($1::uuid[])
         UNION SELECT node_id::text, version_id::text FROM node_versions WHERE node_id = ANY($1::uuid[])`,
        [ids],
      );
      for (const row of rows) if (row.version_id !== null) found.add(`${row.node_id}/${row.version_id}`);
      return found;
    },
  };
}
