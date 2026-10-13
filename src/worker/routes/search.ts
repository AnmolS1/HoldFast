// GET /api/search → SearchResponse: files and folders by name, typo-tolerant, over what the caller
// may see — their own tree (`mine`), what is shared with them (`shared`), or both (`all`).
//
// Every query is T05's `searchNames` and every row leaves through the shared mapper
// (services/node-dto.ts); this file writes no SQL and filters nothing afterwards. What it
// decides: which scan statuses each side may see, what a category means in types and
// extensions, and that `inFolder` is a folder the caller has a role on (`requireRole` — a hidden
// folder is the same 404 as an unknown id).
//
// How close a name must be to count as a typo of the query is T05's (`searchNames` without a
// `threshold`: its default matching, by whole name and by word). A threshold passed from here
// could only raise the bar, and would switch the word matching off.
//
// The query text is the caller's own words: it goes to the database and nowhere else. The audit
// row carries its length and the scope.
//
// Paths are relative to /api. The pipeline applies RL_API.

import { Hono } from "hono";
import { MIME_CATEGORIES, type MimeCategoryName } from "../../shared/constants";
import { SearchQuery, type SearchResponse } from "../../shared/schemas/search";
import { OWNER_VISIBLE_STATUSES } from "../db/queries/nodes";
import { searchNames, type SearchOptions } from "../db/queries/search";
import type { ScanStatus } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { audit } from "../services/audit";
import { toSearchResultDtos } from "../services/node-dto";
import { requireRole } from "../services/permissions";
import { db, type AppEnv } from "../services/request-context";

/** What a grantee sees of a shared tree: scanned and clean, nothing else. */
const SHARED_VISIBLE_STATUSES: readonly ScanStatus[] = ["clean"];

/** One list per side — the owner sees more of their own tree than a grantee sees of another's. */
function visibleStatuses(scope: SearchQuery["scope"]): SearchOptions["visibleStatuses"] {
  if (scope === "mine") return OWNER_VISIBLE_STATUSES;
  if (scope === "shared") return SHARED_VISIBLE_STATUSES;
  return { mine: OWNER_VISIBLE_STATUSES, shared: SHARED_VISIBLE_STATUSES };
}

/**
 * A category as the types a scan detects and the extensions that stand in before one has run.
 * `other` has no list of its own: it is whatever is in none of the others.
 */
function categoryFilter(name: MimeCategoryName): NonNullable<SearchOptions["category"]> {
  if (name !== "other") return { mimes: MIME_CATEGORIES[name].types, exts: MIME_CATEGORIES[name].exts };
  const listed: Array<{ types: readonly string[]; exts: readonly string[] }> = Object.values(MIME_CATEGORIES);
  return {
    mimes: listed.flatMap((category) => category.types),
    exts: listed.flatMap((category) => category.exts),
    not: true,
  };
}

export const router = new Hono<AppEnv>();

router.get("/search", async (c) => {
  const user = requireVerified(c);
  const query = SearchQuery.parse(c.req.query());
  if (query.inFolder !== undefined) await requireRole(c, query.inFolder, "viewer");

  const found = await searchNames(db(c), user.id, query.q, {
    scope: query.scope,
    visibleStatuses: visibleStatuses(query.scope),
    kind: query.kind,
    category: query.category && categoryFilter(query.category),
    inFolder: query.inFolder,
    cursor: query.cursor,
    limit: query.limit,
  });

  const body: SearchResponse = {
    items: await toSearchResultDtos(db(c), found.items, { viewerId: user.id }),
    nextCursor: found.nextCursor,
  };

  audit(c, "search.query", null, { length: query.q.length, scope: query.scope });
  return c.json(body);
});
