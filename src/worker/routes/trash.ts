// Trash, restore and permanent delete. Paths are relative to /api; every route needs a verified,
// signed-in user.
//
//   POST   /nodes/:id/trash     an editor or the owner — never the caller's own share root
//   POST   /nodes/:id/restore   the owner, or the editor who trashed it
//   GET    /trash               the caller's own trashed roots, a page at a time
//   DELETE /nodes/:id           the owner; a trashed root only — deleted for good
//   DELETE /trash               the owner; every trashed root, until done or the deadline
//
// TRASH IS REVERSIBLE AND DESTROYS NOTHING, so it consults no hold. Only the trashed root is
// marked; what is under it is in the trash by ancestry. Shares and links stay and stop resolving.
//
// A PERMANENT DELETE NEVER TELLS A HOLD APART. Both DELETE routes answer exactly as they would
// had everything been purged; a root the gate refused keeps every row and object, gets the
// purge-request marker and from then on is gone as far as its owner can tell — out of the
// listing, and `not_found` by id here, for itself and for everything under it, as a purged id
// is: the same answer for the same number of statements (`requireKnown`). The purge job
// finishes the delete by itself once the hold is released. The request leaves the same audit
// row either way (`node.purge_requested`), written in the transaction that acts on it.
//
// A RESTORE THAT CANNOT HAPPEN NOW has one answer, `409 conflict` with no detail — whether the
// folder it was in is in the trash and the caller is not the owner, or the node would leave a
// folder that protects it. What the user can do is the same in both: restore the folder first.
//
// A hidden node (taken down — itself or by a folder above — or locked) does not exist here:
// `requireRole` answers `not_found` for it, for the owner too.

import { Hono, type Context } from "hono";
import { UUID_PARAM } from "../../shared/ids";
import { type EmptyTrashResponse, TrashQuery, type TrashResponse } from "../../shared/schemas/node";
import type { Tx } from "../db/client";
import { LegalHoldError, QueryError } from "../db/errors";
import { getNode } from "../db/queries/nodes";
import { listTrash, restore, trash } from "../db/queries/trash";
import { countTrash, purgeWasRequested, requestPurge } from "../db/queries/trash-jobs";
import { effectiveAccess, effectiveTrashed, lockOwnerTree } from "../db/queries/tree";
import { retryOnDeadlock } from "../db/retry";
import type { Node } from "../db/schema";
import { purgeRoot, recordPurgeRequest } from "../jobs/purge";
import { requireVerified } from "../middleware/guards";
import { audit } from "../services/audit";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { toNodeDto, toTrashItemDto, toTrashItemDtos } from "../services/node-dto";
import { getAccess, requireRole, type Access, type AccessOptions, type Role } from "../services/permissions";
import { db, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

const ID = `:id{${UUID_PARAM}}`;

/** Roots `DELETE /trash` takes from the listing at once. */
export const EMPTY_TRASH_BATCH = 100;
/** `DELETE /trash` stops starting purges after this long and answers `202` with what is left. */
export const EMPTY_TRASH_DEADLINE_MS = 20_000;

/** The one "cannot do that now" of this file: no message of its own, no detail, no cause. */
const refused = () => new AppError("conflict");

/**
 * The caller's access to the node, when it is at least `min` — for every by-id route here.
 *
 * `not_found` for an id that was never issued, for a hidden node, AND for a root whose purge was
 * requested (or anything under one): to its owner that root is deleted, and it must answer as a
 * purged id does — by the answer and BY THE WORK. Both questions are therefore always asked,
 * whatever the first one answered: "you deleted this and it is still here" cannot be told from
 * "this id does not exist" by counting statements either. `{ notTrashed: true }` adds "in the
 * trash, itself or by a folder above" to what does not exist — from the same statements.
 */
async function requireKnown(
  c: Context<AppEnv>,
  id: string,
  min: Role,
  opts: AccessOptions = {},
): Promise<Access> {
  const access = await getAccess(c, id, opts);
  const gone = await purgeWasRequested(db(c), id);
  if (!access || gone) throw new AppError("not_found");
  // Answered from the request's cache: the role check only.
  return requireRole(c, id, min, opts);
}

/** The row behind a by-id route that acts on something IN the trash. Never a system node. */
async function knownNode(c: Context<AppEnv>, id: string): Promise<Node> {
  const node = await getNode(db(c), id);
  if (!node || node.system !== null) throw new AppError("not_found");
  return node;
}

/**
 * An editor's right to restore, decided again where the restore happens: under the owner's tree
 * lock (the first lock `restore` takes too), from the row and the share as they are then. What
 * the route read before its transaction may be stale — the file restored and trashed again by
 * someone else, the editor's share lowered — and a restore must not ride on it.
 * (Share rows are not locked by anything: a change in the same instant is seen or not.)
 */
async function assertStillTheirs(tx: Tx, node: Node, userId: string): Promise<void> {
  await lockOwnerTree(tx, node.ownerId);
  const current = await getNode(tx, node.id);
  const parent =
    current && current.parentId !== null ? await effectiveAccess(tx, userId, current.parentId) : null;
  if (!current || current.trashedBy !== userId || !parent || parent.role === "viewer") {
    throw new AppError("forbidden", undefined, { reason: "role" });
  }
}

const isTrashedRoot = (node: Node) => node.trashedRoot && node.deletedAt !== null;

/**
 * Deletes one trashed root for good — or, when it is held, records that its owner asked: the
 * marker on the root and the `node.purge_requested` row, in ONE transaction (the same row an
 * un-held delete writes beside its deletes — `purgeRoot`). So no request is acted on without its
 * record, and a held root's request leaves the trace an un-held one does.
 * False when it was no trashed root any more by the time a transaction held it (restored in this
 * instant): nothing was deleted, nothing recorded.
 */
async function purgeOne(c: Context<AppEnv>, rootId: string): Promise<boolean> {
  const result = await purgeRoot(c, rootId, "user");
  if (result.outcome === "skipped") return false;
  if (result.outcome !== "held") return true;
  return retryOnDeadlock(db(c), async (tx) => {
    if ((await requestPurge(tx, [rootId])) === 0) return false;
    await recordPurgeRequest(tx, c, rootId);
    return true;
  });
}

router.get("/trash", async (c) => {
  const user = requireVerified(c);
  const query = TrashQuery.parse(c.req.query());
  const page = await listTrash(db(c), user.id, query);
  const body: TrashResponse = {
    items: await toTrashItemDtos(db(c), page.items, { viewerId: user.id, role: "owner" }),
    nextCursor: page.nextCursor,
  };
  return c.json(body);
});

router.delete("/trash", async (c) => {
  const user = requireVerified(c);
  // When the request began, by the one server clock (services/clock.ts) — which a test may set
  // for its own request, and nothing else can: there is no other way to move this deadline.
  const stopAt = now(c).getTime() + EMPTY_TRASH_DEADLINE_MS;
  for (;;) {
    // Always the first page: a root that was purged, or marked as requested, has left the listing.
    const page = await listTrash(db(c), user.id, { limit: EMPTY_TRASH_BATCH });
    if (page.items.length === 0) return c.body(null, 204);
    for (const root of page.items) {
      await purgeOne(c, root.id);
      if (Date.now() < stopAt) continue;
      const remaining = await countTrash(db(c), user.id);
      if (remaining === 0) return c.body(null, 204);
      const body: EmptyTrashResponse = { remaining };
      return c.json(body, 202);
    }
  }
});

router.post(`/nodes/${ID}/trash`, async (c) => {
  const user = requireVerified(c);
  const id = c.req.param("id");
  // Already in the trash — itself, or with a folder above it — is not there to be trashed: an
  // unknown id, at an unknown id's cost.
  const access = await requireKnown(c, id, "editor", { notTrashed: true });
  // An editor may trash what is inside a shared folder, never the shared folder itself.
  if (access.role !== "owner" && access.shareRootId === id) {
    throw new AppError("forbidden", undefined, { reason: "share_root" });
  }
  const row = await retryOnDeadlock(db(c), (tx) => trash(tx, id, user.id));
  // A system node, or one that went to the trash in this instant.
  if (!row) throw new AppError("not_found");
  // After the transaction, once: an attempt Postgres threw away leaves no row.
  audit(c, "node.trash", { type: "node", id });
  const view = { viewerId: user.id, role: access.role, shareRootId: access.shareRootId };
  return c.json(await toTrashItemDto(db(c), row, view));
});

router.post(`/nodes/${ID}/restore`, async (c) => {
  const user = requireVerified(c);
  const id = c.req.param("id");
  const access = await requireKnown(c, id, "viewer");
  const node = await knownNode(c, id);
  if (access.role !== "owner") {
    // The editor who trashed it, for as long as they are an editor of the folder it was in.
    const parent = node.parentId === null ? null : await getAccess(c, node.parentId);
    if (node.trashedBy !== user.id || !parent || parent.role === "viewer") {
      throw new AppError("forbidden", undefined, { reason: "role" });
    }
  }
  if (!isTrashedRoot(node)) throw refused();
  // The folder it was in is in the trash too: it comes back at the owner's top level.
  const toRoot = node.parentId !== null && (await effectiveTrashed(db(c), node.parentId));
  if (toRoot && access.role !== "owner") throw refused();

  let row: Node | null;
  try {
    row = await retryOnDeadlock(db(c), async (tx) => {
      if (access.role !== "owner") await assertStillTheirs(tx, node, user.id);
      return restore(tx, id, { toRoot });
    });
  } catch (error) {
    // Out from under a folder that protects it, or its folder was trashed in this instant: the
    // same answer as above, and nothing that says which.
    if (error instanceof LegalHoldError) throw refused();
    if (error instanceof QueryError && error.code === "conflict") throw refused();
    throw error;
  }
  if (!row) throw refused();
  audit(c, "node.restore", { type: "node", id }, { toRoot });
  const view = { viewerId: user.id, role: access.role, shareRootId: access.shareRootId };
  return c.json(await toNodeDto(db(c), row, view));
});

router.delete(`/nodes/${ID}`, async (c) => {
  requireVerified(c);
  const id = c.req.param("id");
  await requireKnown(c, id, "owner");
  const node = await knownNode(c, id);
  if (!isTrashedRoot(node)) throw refused();
  if (!(await purgeOne(c, id))) throw refused();
  return c.body(null, 204);
});
