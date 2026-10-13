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
// when the owner is banned, suspended or scheduled for deletion. Trash, takedown and scan state
// are NOT part of a role: callers check those separately (`assertNotTrashed`, the scan gates).
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
import { effectiveAccess, effectiveTrashed, isDescendantOrSelf } from "../db/queries/tree";
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

/** The caller's access to a node, or null: no access, or no such node — never told apart. */
export async function getAccess(c: Context<AppEnv>, nodeId: string): Promise<Access | null> {
  const state = stateOf(c);
  if (state.cache.has(nodeId)) return state.cache.get(nodeId) ?? null;

  let access: Access | null = null;
  if (state.link) {
    // The link decides alone: a signed-in visitor gets no more through it than a stranger.
    if (await isDescendantOrSelf(db(c), nodeId, state.link.rootNodeId)) {
      access = { role: "viewer", shareRootId: state.link.rootNodeId, canUpload: false, via: "link" };
    }
  } else {
    const user = c.get("user");
    const found = user ? await effectiveAccess(db(c), user.id, nodeId) : null;
    if (found) access = { ...found, via: found.role === "owner" ? "owner" : "share" };
  }
  state.cache.set(nodeId, access);
  return access;
}

/** The access, when it is at least `min`. None → `404 not_found`; too low → `403 forbidden`. */
export async function requireRole(c: Context<AppEnv>, nodeId: string, min: Role): Promise<Access> {
  const access = await getAccess(c, nodeId);
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

/** `404 not_found` for a node that is in the trash, itself or by an ancestor — or does not exist. */
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
