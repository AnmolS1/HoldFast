// Name search over what a user may see: their own tree (`mine`), what is shared with them
// through activated shares (`shared`), or both (`all`).
//
// Matching: `name ILIKE '%q%'` or trigram similarity (`name % q`, pg_trgm's default threshold
// 0.3). Both are served by the GIN trigram index on `nodes.name`. Ranking: a name that starts
// with the query, then a word that starts with it, then the rest by similarity.
// Exclusions are the listings' own: system nodes, taken-down nodes, anything in the trash
// (directly or by ancestry) — for the owner as well.

import { inArray, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import { decodeCursor, encodeCursor } from "../cursor";
import { QueryError } from "../errors";
import { isUuid } from "../ids";
import { type Node, nodes, type ScanStatus } from "../schema";
import { notEffectivelyTrashed, type Role } from "./tree";
import { ownerIsActive } from "./users";

export type SearchScope = "mine" | "shared" | "all";

export type SearchOptions = {
  scope: SearchScope;
  /**
   * Which scan statuses each side may see. `mine` and `shared` take a list; `all` MUST take one
   * list per side — never one list applied to both (the owner sees more than a grantee).
   */
  visibleStatuses: readonly ScanStatus[] | { mine: readonly ScanStatus[]; shared: readonly ScanStatus[] };
  kind?: "file" | "folder";
  /** The sniffed types and the extension fallback of one category, already resolved. */
  category?: { mimes: readonly string[]; exts: readonly string[] };
  /** Restrict to the content of this folder (any depth). */
  inFolder?: string;
  cursor?: string | null;
  /** 1–50. */
  limit: number;
  /** Raises the similarity a fuzzy (non-substring) match needs. Default 0.3, the index's own. */
  threshold?: number;
};

export type SearchHit = {
  node: Node;
  /**
   * The parent folder's name; null at the top level — and, for a hit shared with the user, null
   * when the parent is not itself shared with them (the hit is the root of the share).
   */
  pathHint: string | null;
  role: Role;
};

type Ranked = {
  id: string;
  role: Role;
  path_hint: string | null;
  rank: number;
  sim: number;
  name_key: string;
};

const MAX_LIMIT = 50;
/** How far a search can be paged. Search is ranked, not keyset-ordered. */
const MAX_OFFSET = 1000;

/** Escapes LIKE wildcards; the patterns below use the default escape character, backslash. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => "\\" + ch);
}

const textArray = (values: readonly string[]): SQL =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;

const statusList = (statuses: readonly ScanStatus[]): SQL =>
  sql.join(
    statuses.map((s) => sql`${s}::scan_status`),
    sql`, `,
  );

/** The filters and ranking both sides share, over a `nodes` row aliased `n`. */
function matchAndRank(
  q: string,
  opts: SearchOptions,
  statuses: readonly ScanStatus[],
): { where: SQL; rank: SQL; sim: SQL } {
  const escaped = escapeLike(q);
  const threshold = opts.threshold ?? 0.3;
  const conditions: SQL[] = [
    sql`(n.name ILIKE ${"%" + escaped + "%"} OR (n.name % ${q} AND similarity(n.name, ${q}) >= ${threshold}::real))`,
    sql`n.system IS NULL`,
    sql`n.takedown_at IS NULL`,
    notEffectivelyTrashed("n"),
    sql`n.scan_status IN (${statusList(statuses)})`,
  ];
  if (opts.kind) conditions.push(sql`n.kind = ${opts.kind}::node_kind`);
  if (opts.category) {
    conditions.push(
      sql`n.kind = 'file' AND (n.mime_sniffed = ANY(${textArray(opts.category.mimes)})
        OR (n.mime_sniffed IS NULL AND n.ext = ANY(${textArray(opts.category.exts)})))`,
    );
  }
  if (opts.inFolder !== undefined) {
    conditions.push(sql`n.id IN (
      WITH RECURSIVE inside(id) AS (
        SELECT c.id FROM nodes c WHERE c.parent_id = ${opts.inFolder}
        UNION ALL
        SELECT c.id FROM nodes c JOIN inside ON c.parent_id = inside.id
      ) CYCLE id SET is_cycle USING path
      SELECT id FROM inside)`);
  }
  const rank = sql`CASE
    WHEN n.name ILIKE ${escaped + "%"} THEN 3
    WHEN n.name ILIKE ${"% " + escaped + "%"} OR n.name ILIKE ${"%\\_" + escaped + "%"}
      OR n.name ILIKE ${"%-" + escaped + "%"} OR n.name ILIKE ${"%." + escaped + "%"} THEN 2
    ELSE 1 END`;
  return { where: sql.join(conditions, sql` AND `), rank, sim: sql`similarity(n.name, ${q})` };
}

const ORDER = sql`rank DESC, sim DESC, name_key ASC, id ASC`;

async function searchMine(
  db: Executor,
  userId: string,
  q: string,
  opts: SearchOptions,
  statuses: readonly ScanStatus[],
  take: number,
) {
  if (statuses.length === 0) return [];
  const m = matchAndRank(q, opts, statuses);
  const result = await db.execute<Ranked>(sql`
    SELECT n.id, 'owner' AS role, p.name AS path_hint, ${m.rank} AS rank, ${m.sim} AS sim, n.name_key
    FROM nodes n LEFT JOIN nodes p ON p.id = n.parent_id
    WHERE n.owner_id = ${userId} AND ${m.where}
    ORDER BY ${ORDER} LIMIT ${take}`);
  return result.rows;
}

async function searchShared(
  db: Executor,
  userId: string,
  q: string,
  opts: SearchOptions,
  statuses: readonly ScanStatus[],
  take: number,
) {
  if (statuses.length === 0) return [];
  const m = matchAndRank(q, opts, statuses);
  // Everything under an activated share of a live owner; the highest role over all paths.
  const result = await db.execute<Ranked>(sql`
    WITH RECURSIVE reach(id, role) AS (
      SELECT s.node_id, s.role
      FROM shares s JOIN nodes r ON r.id = s.node_id
      WHERE s.grantee_user_id = ${userId} AND s.activated_at IS NOT NULL
        AND r.owner_id <> ${userId} AND ${ownerIsActive(sql`r.owner_id`)}
      UNION
      SELECT c.id, reach.role FROM nodes c JOIN reach ON c.parent_id = reach.id
    ),
    best AS (SELECT id, max(role) AS role FROM reach GROUP BY id)
    SELECT n.id, best.role::text AS role,
           -- The parent's name only when the parent is itself shared with this user. Above a
           -- share root sits the owner's own, unshared folder: its name is not the grantee's.
           CASE WHEN p.id IN (SELECT id FROM best) THEN p.name END AS path_hint,
           ${m.rank} AS rank, ${m.sim} AS sim, n.name_key
    FROM best JOIN nodes n ON n.id = best.id LEFT JOIN nodes p ON p.id = n.parent_id
    WHERE ${m.where}
    ORDER BY ${ORDER} LIMIT ${take}`);
  return result.rows;
}

const compareRanked = (a: Ranked, b: Ranked): number =>
  Number(b.rank) - Number(a.rank) ||
  Number(b.sim) - Number(a.sim) ||
  (a.name_key < b.name_key ? -1 : a.name_key > b.name_key ? 1 : 0) ||
  (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

type OffsetCursor = { offset: number };
const isOffsetCursor = (v: unknown): v is OffsetCursor =>
  !!v &&
  typeof v === "object" &&
  Number.isInteger((v as OffsetCursor).offset) &&
  (v as OffsetCursor).offset > 0;

/**
 * Searches names. The cursor is opaque and belongs to one (user, query, scope); pages are ranked
 * windows, so a result set that changes between pages can repeat or skip a row.
 * `validation` for a bad cursor, an empty query, or scope `all` without one status list per side.
 */
export async function searchNames(
  db: Executor,
  userId: string,
  q: string,
  opts: SearchOptions,
): Promise<{ items: SearchHit[]; nextCursor: string | null }> {
  const query = q.trim();
  if (query === "") throw new QueryError("validation", "empty query");
  if (!Number.isInteger(opts.limit) || opts.limit < 1) throw new QueryError("validation", "invalid limit");
  if (opts.inFolder !== undefined && !isUuid(opts.inFolder)) return { items: [], nextCursor: null };
  const limit = Math.min(opts.limit, MAX_LIMIT);

  const split = !Array.isArray(opts.visibleStatuses);
  if (opts.scope === "all" && !split) {
    throw new QueryError("validation", "scope 'all' needs one status list per side");
  }
  const lists = opts.visibleStatuses as { mine: readonly ScanStatus[]; shared: readonly ScanStatus[] };
  const mineStatuses = split ? lists.mine : (opts.visibleStatuses as readonly ScanStatus[]);
  const sharedStatuses = split ? lists.shared : (opts.visibleStatuses as readonly ScanStatus[]);

  const tag = `search:${userId}:${opts.scope}:${query.toLowerCase()}`;
  const offset = opts.cursor ? decodeCursor(tag, opts.cursor, isOffsetCursor).offset : 0;
  if (offset > MAX_OFFSET) return { items: [], nextCursor: null };
  const take = offset + limit + 1;

  const ranked: Ranked[] = [];
  if (opts.scope !== "shared")
    ranked.push(...(await searchMine(db, userId, query, opts, mineStatuses, take)));
  if (opts.scope !== "mine")
    ranked.push(...(await searchShared(db, userId, query, opts, sharedStatuses, take)));
  ranked.sort(compareRanked);

  const window = ranked.slice(offset, offset + limit);
  if (window.length === 0) return { items: [], nextCursor: null };
  const rows = await db
    .select()
    .from(nodes)
    .where(
      inArray(
        nodes.id,
        window.map((r) => r.id),
      ),
    );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const items: SearchHit[] = [];
  for (const r of window) {
    const node = byId.get(r.id);
    if (node) items.push({ node, pathHint: r.path_hint, role: r.role });
  }
  return {
    items,
    nextCursor:
      ranked.length > offset + limit
        ? encodeCursor(tag, { offset: offset + limit } satisfies OffsetCursor)
        : null,
  };
}
