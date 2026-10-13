// Name search over what a user may see: their own tree (`mine`), what is shared with them
// through activated shares (`shared`), or both (`all`).
//
// Matching: `name ILIKE '%q%'`, or trigram similarity of the whole name (`name % q`, pg_trgm's
// default threshold 0.3) — the STRICT matches, one statement per side, served by the GIN trigram
// index on `nodes.name`. Ranking: a name that starts with the query, then a word that starts
// with it, then a name that contains it, then the similar names; within each by similarity.
//
// THE WORD MATCH IS A FALLBACK. Only when the strict matches do not fill the window that was
// asked for, and the query has `WORD_MATCH_MIN_CHARS` or more, the names that match by WORD
// similarity (`q <% name`: the query against the best-matching stretch of the name, so a typo in
// one word of a long name, or a name with an extension, is still found — "reprot" finds
// report.pdf) are read as well, strict matches excluded, and placed AFTER every strict match.
// A query the strict matches answer costs and returns what it did without the fallback; the
// order "strict, then by word" is the same on every page, so paging neither repeats nor skips.
//
// THE WORD THRESHOLD IS A SETTING, NOT AN ARGUMENT. `<%` compares with the server setting
// `pg_trgm.word_similarity_threshold` (default 0.6), and the index is asked with that same
// setting, so the fallback sets it — `set_config(…, is_local => true)`, i.e. SET LOCAL — in a
// transaction of its own around its reads. It ends with that transaction: the connection goes
// back to the pool with the server's default. (Called inside a caller's transaction, it lasts
// until THAT transaction ends; nothing else in this code base uses `<%`.)
// Exclusions are the listings' own: system nodes, and anything in the trash or taken down —
// directly or by ancestry (a file inside a taken-down folder is not found) — for the owner as well.

import { inArray, sql, type SQL } from "drizzle-orm";
import { MIME_CATEGORIES } from "../../../shared/constants";
import type { Executor } from "../client";
import { decodeCursor, encodeCursor } from "../cursor";
import { QueryError } from "../errors";
import { isUuid } from "../ids";
import { type Node, nodes, type ScanStatus } from "../schema";
import { notEffectivelyTrashedOrHidden, type Role } from "./tree";
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
  /**
   * The types and the extensions of one category (`MIME_CATEGORIES`), already resolved: the
   * files `categoryOf` (services/mime.ts) puts in it — every file is in exactly one.
   * `not: true` asks for the complement — the files in NONE of these types and extensions: pass
   * every category's types and extensions and the result is exactly the files it calls `other`.
   */
  category?: { mimes: readonly string[]; exts: readonly string[]; not?: true };
  /** Restrict to the content of this folder (any depth). */
  inFolder?: string;
  cursor?: string | null;
  /** 1–50. */
  limit: number;
  /**
   * Raises the WHOLE-NAME similarity a fuzzy (non-substring) match needs. Default 0.3, the
   * index's own. Given, every fuzzy match must reach it and there is no fallback to word
   * matching; leave it unset for the default search.
   */
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

/**
 * What `pg_trgm.word_similarity_threshold` is set to for a search (the server's default is 0.6).
 * 0.4 is what a swapped pair of letters in a six-letter word still reaches (3 of 7 trigrams).
 */
export const WORD_SIMILARITY_THRESHOLD = 0.4;
/**
 * Queries shorter than this never fall back to the word match: at four letters and fewer the
 * threshold is reached by any word that merely begins with the same two letters.
 */
export const WORD_MATCH_MIN_CHARS = 5;

/** Every extension some category lists: a generic type with one of these is labelled by it. */
const CATEGORY_EXTS: readonly string[] = Object.values(MIME_CATEGORIES).flatMap((category) => [
  ...category.exts,
]);

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
  byWord: boolean,
): { where: SQL; rank: SQL; sim: SQL } {
  const escaped = escapeLike(q);
  const threshold = opts.threshold ?? 0.3;
  const strict = sql`(n.name ILIKE ${"%" + escaped + "%"} OR (n.name % ${q} AND similarity(n.name, ${q}) >= ${threshold}::real))`;
  const conditions: SQL[] = [
    // By word: what the strict read did not already find.
    byWord ? sql`${q} <% n.name AND NOT ${strict}` : strict,
    sql`n.system IS NULL`,
    notEffectivelyTrashedOrHidden("n"),
    sql`n.scan_status IN (${statusList(statuses)})`,
  ];
  if (opts.kind) conditions.push(sql`n.kind = ${opts.kind}::node_kind`);
  if (opts.category) {
    // `categoryOf` (services/mime.ts) in SQL, so that a file is found under the category its
    // answer shows and under no other. A file not yet sniffed, or sniffed as nothing in
    // particular, is labelled by its extension first, and by its type only when no category
    // lists the extension; a specific detected type is never overruled by the name.
    const type = sql`coalesce(lower(n.mime_sniffed), '')`;
    const generic = sql`${type} IN ('', 'text/plain', 'application/octet-stream')`;
    const byType = sql`${type} = ANY(${textArray(opts.category.mimes)})`;
    const byExt = sql`n.ext = ANY(${textArray(opts.category.exts)})`;
    conditions.push(
      opts.category.not
        ? // In none of them: neither its type is listed nor — for a generic type — its extension.
          sql`n.kind = 'file' AND NOT (${byType} OR (${generic} AND ${byExt}))`
        : sql`n.kind = 'file' AND CASE WHEN ${generic}
            THEN ${byExt} OR (${byType} AND NOT n.ext = ANY(${textArray(CATEGORY_EXTS)}))
            ELSE ${byType} END`,
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
  const where = sql.join(conditions, sql` AND `);
  // Below every strict match, the closest stretch first.
  if (byWord) return { where, rank: sql`-1`, sim: sql`word_similarity(${q}, n.name)` };
  const rank = sql`CASE
    WHEN n.name ILIKE ${escaped + "%"} THEN 3
    WHEN n.name ILIKE ${"% " + escaped + "%"} OR n.name ILIKE ${"%\\_" + escaped + "%"}
      OR n.name ILIKE ${"%-" + escaped + "%"} OR n.name ILIKE ${"%." + escaped + "%"} THEN 2
    WHEN n.name ILIKE ${"%" + escaped + "%"} THEN 1
    ELSE 0 END`;
  return { where, rank, sim: sql`similarity(n.name, ${q})` };
}

const ORDER = sql`rank DESC, sim DESC, name_key ASC, id ASC`;

async function searchMine(
  db: Executor,
  userId: string,
  q: string,
  opts: SearchOptions,
  statuses: readonly ScanStatus[],
  take: number,
  byWord: boolean,
) {
  if (statuses.length === 0) return [];
  const m = matchAndRank(q, opts, statuses, byWord);
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
  byWord: boolean,
) {
  if (statuses.length === 0) return [];
  const m = matchAndRank(q, opts, statuses, byWord);
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
  const rankedReads = async (ex: Executor, byWord: boolean, rows: number) => {
    if (opts.scope !== "shared")
      ranked.push(...(await searchMine(ex, userId, query, opts, mineStatuses, rows, byWord)));
    if (opts.scope !== "mine")
      ranked.push(...(await searchShared(ex, userId, query, opts, sharedStatuses, rows, byWord)));
  };
  await rankedReads(db, false, take);
  // Fewer strict matches than the window needs: every one of them is in hand (each side was
  // asked for the whole window), and the rest of the window is filled by word.
  const missing = take - ranked.length;
  if (missing > 0 && opts.threshold === undefined && [...query].length >= WORD_MATCH_MIN_CHARS) {
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT set_config('pg_trgm.word_similarity_threshold', ${String(WORD_SIMILARITY_THRESHOLD)}, true)`,
      );
      await rankedReads(tx, true, missing);
    });
  }
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
