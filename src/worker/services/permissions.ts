// Who may do what with a node. Every node route asks here; nothing else decides access.
//
//   const access = await requireRole(c, nodeId, "viewer");     404 when there is no access at all
//   await requireUpload(c, parentId);                          403 unless an editor who may upload
//   await assertNotTrashed(c, nodeId);                         404 for a node in the trash
//   assertContentAccess(c);                                    403 for an impersonated session
//
// NO EXISTENCE ORACLE. An id that does not exist and an id the caller has no access to are the
// same `404 not_found`. `403 forbidden` is only ever answered to a caller who can already see the
// node and asks for more than their role allows.
//
// Built on the tree query `effectiveAccess`: ownership, or an ACTIVATED share on the node or an
// ancestor (the highest role wins) — which already answers "no access" for anyone but the owner
// when the owner is banned, suspended or scheduled for deletion.
//
// A HIDDEN NODE DOES NOT EXIST HERE. A node that is taken down — ITSELF OR BY AN ANCESTOR, like
// trash — or is itself locked as `suspected_csam`, is `not_found` for everyone — its owner
// included — exactly as an id that was never issued: the same error, thrown the same way, no
// detail, no audit row, no metric, AND THE SAME WORK: the access query and the hidden query are
// both sent for every question, whatever the first one answered, so that "this id is locked"
// and "this id was never issued" cannot be told apart by the number of statements either. That
// an account holder cannot observe either state is a property of this file, not of each route.
// (One difference in work is not this file's: for a GRANTEE the access query reads the owner's
// state in a second statement — for a node shared with them, hidden or not.)
// The one way to see such a node is the explicit option `{ includeHidden: true }`, which ONLY
// ADMIN ROUTES pass (grep for `includeHidden`) and which is honoured ONLY for an admin's own
// request with no link scope — passed by anyone else it does nothing. The exports that take it:
// `getAccess` and `requireRole`. `requireUpload` never does (nobody uploads into a hidden folder), nor does the
// link scope's answer change with it being absent: a hidden node is hidden behind a link too.
//
// Trash and the other scan states are NOT part of a role: callers check those separately
// (`assertNotTrashed`, the scan gates). A trashed node still exists for its owner (it can be
// restored); a hidden one does not.
//
// REQUEST-ONLY. These functions take the Hono context: they are called from request handlers
// only (no job or queue consumer decides access), and the answers are cached for the request.
//
// LINK SCOPE. A public-link request has no session that counts: after `withLinkScope` every
// answer comes from the link alone — viewer for the link's root and everything under it, nothing
// for any other node, whoever is signed in.
//
// Nothing here reads and then writes: each function is one decision from one read, and the
// writes that depend on it re-check under their own lock (the tree queries, the upload claim).

import type { Context } from "hono";
import { effectiveAccess, effectiveHidden, effectiveTrashed, isDescendantOrSelf } from "../db/queries/tree";
import { requireAdmin } from "../middleware/guards";
import { forbidImpersonation } from "../middleware/impersonation";
import { AppError } from "./errors";
import { db, type AppEnv } from "./request-context";

export type Role = "viewer" | "editor" | "owner";

export interface Access {
  role: Role;
  /** The nearest node with a share to the user (or the link's root); null for the owner. */
  shareRootId: string | null;
  /** Whether files may be added here: always for the owner, the share's toggle for an editor. */
  canUpload: boolean;
  via: "owner" | "share" | "link";
}

export type LinkScope = { linkId: string; rootNodeId: string };

/**
 * `includeHidden: true` — FOR ADMIN ROUTES ONLY — also answers for a node that is taken down
 * (itself or by an ancestor) or locked as `suspected_csam`. Without it such a node is
 * `not_found`, like an unknown id.
 *
 * THE OPTION IS NOT TRUSTED: it takes effect only when the request is an ADMIN's — exactly what
 * `requireAdmin` (middleware/guards.ts) accepts: the role, two-factor, a session that passed it,
 * not impersonating — AND no link scope is set. Passed by anyone else, or behind a link, it is
 * ignored: the node stays `not_found` and the same work is done as without it.
 */
export type AccessOptions = { includeHidden?: true };

const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };

type State = { cache: Map<string, Access | null>; link: LinkScope | null };

// Per request, keyed on the context object (`c.var` cannot hold it: its shape is fixed).
const states = new WeakMap<object, State>();

function stateOf(c: Context<AppEnv>): State {
  let state = states.get(c);
  if (!state) {
    state = { cache: new Map(), link: null };
    states.set(c, state);
  }
  return state;
}

/**
 * From here on, this request's access comes from a public link: viewer for `rootNodeId` and its
 * descendants, nothing else. The caller has already resolved the link (state, password).
 */
export function withLinkScope(c: Context<AppEnv>, scope: LinkScope): void {
  const state = stateOf(c);
  state.link = { linkId: scope.linkId, rootNodeId: scope.rootNodeId };
  // Answers given before the scope was set were about the session.
  state.cache.clear();
}

/** Is this request what the admin routes' guard accepts? The guard itself decides, not a copy. */
function isAdminRequest(c: Context<AppEnv>): boolean {
  try {
    requireAdmin(c);
    return true;
  } catch {
    return false;
  }
}

/** What the session or the link alone says, hidden or not. One access query (none: signed out). */
async function reach(c: Context<AppEnv>, link: LinkScope | null, nodeId: string): Promise<Access | null> {
  if (link) {
    // The link decides alone: a signed-in visitor gets no more through it than a stranger.
    return (await isDescendantOrSelf(db(c), nodeId, link.rootNodeId))
      ? { role: "viewer", shareRootId: link.rootNodeId, canUpload: false, via: "link" }
      : null;
  }
  const user = c.get("user");
  const found = user ? await effectiveAccess(db(c), user.id, nodeId) : null;
  return found ? { ...found, via: found.role === "owner" ? "owner" : "share" } : null;
}

/**
 * The caller's access to a node, or null: no access, no such node, or a node that is hidden
 * (taken down itself or by an ancestor, suspected CSAM) — never told apart, by the answer or by
 * the work. Behind a link the same holds for the target: a hidden node anywhere on its chain —
 * the link's root included — hides it. `{ includeHidden: true }` is for admin routes.
 */
export async function getAccess(
  c: Context<AppEnv>,
  nodeId: string,
  opts: AccessOptions = {},
): Promise<Access | null> {
  const state = stateOf(c);
  const includeHidden = opts.includeHidden === true && state.link === null && isAdminRequest(c);
  const cacheKey = `${includeHidden ? "all" : "visible"}:${nodeId}`;
  if (state.cache.has(cacheKey)) return state.cache.get(cacheKey) ?? null;

  // A caller with neither a session nor a link reaches nothing, and nothing is asked.
  const anyone = state.link !== null || Boolean(c.get("user"));
  // ALWAYS BOTH, never "hidden only when reachable": the work must not depend on the answer.
  const [reached, hidden] = await Promise.all([
    reach(c, state.link, nodeId),
    anyone && !includeHidden ? effectiveHidden(db(c), nodeId) : false,
  ]);
  const access = hidden ? null : reached;
  state.cache.set(cacheKey, access);
  return access;
}

/**
 * The access, when it is at least `min`. None — also a hidden node — → `404 not_found`; too low
 * → `403 forbidden`. `{ includeHidden: true }` is for admin routes.
 */
export async function requireRole(
  c: Context<AppEnv>,
  nodeId: string,
  min: Role,
  opts: AccessOptions = {},
): Promise<Access> {
  const access = await getAccess(c, nodeId, opts);
  if (!access) throw new AppError("not_found");
  if (RANK[access.role] < RANK[min]) throw new AppError("forbidden", undefined, { reason: "role" });
  return access;
}

/**
 * May the caller add a file under `parentId`? An editor or the owner, AND (the owner, or an
 * editor whose share allows uploads). `parentId` null is the caller's own root: any signed-in
 * user's, and nobody's through a link.
 */
export async function requireUpload(c: Context<AppEnv>, parentId: string | null): Promise<Access> {
  if (parentId === null) {
    if (stateOf(c).link || !c.get("user")) throw new AppError("not_found");
    return { role: "owner", shareRootId: null, canUpload: true, via: "owner" };
  }
  const access = await requireRole(c, parentId, "editor");
  if (access.role !== "owner" && !access.canUpload) {
    throw new AppError("forbidden", undefined, { reason: "upload_not_allowed" });
  }
  return access;
}

/**
 * `404 not_found` for a node that is in the trash, itself or by an ancestor — or does not exist.
 * A separate question from visibility: it says nothing about takedown or scan state.
 */
export async function assertNotTrashed(c: Context<AppEnv>, nodeId: string): Promise<void> {
  if (await effectiveTrashed(db(c), nodeId)) throw new AppError("not_found");
}

/**
 * The content half of the impersonation rule. The middleware already makes an impersonated
 * session read-only for every state change; but content also leaves through reads. Every
 * endpoint that mints a files-host URL (download, thumbnail, batch, zip manifest) or returns a
 * link's URL calls this: `403 forbidden` for an impersonated session.
 */
export function assertContentAccess(c: Context<AppEnv>): void {
  forbidImpersonation(c);
}
