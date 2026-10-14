// What the explorer does to nodes. Rename, star and trash are optimistic: the list changes at
// once, and when the request fails that ONE change is undone (never an old copy of the list put
// back) and the parent is read again. After every saved change the tree-changed event is sent
// with the parents whose listing changed, so the other views refresh theirs.
//
// Two rules hold for everything here:
//  - Work that outlives its request belongs to the account that started it. Each action reads
//    `accountEpoch()` when it starts; after a sign-out or an account switch it writes nothing,
//    says nothing and sends nothing (a rollback after sign-out would otherwise put the previous
//    account's rows into the next account's cache).
//  - Many items never means many requests at once: at most MAX_IN_FLIGHT, and a `429` stops the
//    rest instead of having each refused in turn. (Batch routes are a backlog item.)
import type { NodeDto } from "../../../shared/schemas/node";
import { toast } from "../../components/Toaster";
import { publish } from "../../components/TransferRibbon";
import { undoToast } from "../../components/UndoToast";
import { ApiError, toastApiError } from "../../lib/api";
import { emitNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, queryClient, sameAccount } from "../../lib/query";
import { createFolder, downloadUrl, moveNode, patchNode, rescanNode, restoreNode, trashNode } from "./api";
import { saveUrl } from "./download";
import { beginEdit, cancelListings, invalidateParents, patchInListings, removeFromListings } from "./queries";
import { messages, t } from "./strings";

// ---------------------------------------------------------------------------------------------
// Results of actions, said once for assistive technology (the page renders the live region).

let announcement = "";
const announceListeners = new Set<() => void>();

export function announce(text: string): void {
  // The same sentence twice in a row would change nothing in the live region and stay unsaid:
  // a trailing no-break space makes the second one a change.
  announcement = text !== "" && text === announcement ? `${text}\u00A0` : text;
  for (const listener of announceListeners) listener();
}

export const getAnnouncement = () => announcement;
export const subscribeAnnouncement = (listener: () => void) => {
  announceListeners.add(listener);
  return () => announceListeners.delete(listener);
};

// An announcement names a file of the account that was signed in.
registerUserStatePurger(() => announce(""));

// ---------------------------------------------------------------------------------------------

const unique = (ids: Array<string | null>) => Array.from(new Set(ids));
const isConflict = (cause: unknown) => cause instanceof ApiError && cause.code === "conflict";
const requestIdOf = (cause: unknown) => (cause instanceof ApiError ? cause.requestId : undefined);

/** Whether the account that started the work is still the one signed in. */
function stillMine(): () => boolean {
  const then = accountEpoch();
  return () => sameAccount(then);
}

/** A failure in the explorer's own words where it knows the cause, the standard toast otherwise. */
function toastFailure(cause: unknown, conflictMessage: string): void {
  if (isConflict(cause)) toast({ message: conflictMessage, requestId: requestIdOf(cause) });
  else toastApiError(cause);
}

/** `"report.pdf"` for one item, "3 items" for several. */
export function describe(nodes: readonly Pick<NodeDto, "name">[]): string {
  return nodes.length === 1
    ? t("explorer.item.quoted", { name: nodes[0]!.name })
    : t("explorer.item.count", { count: nodes.length });
}

// ---------------------------------------------------------------------------------------------
// The pool: at most MAX_IN_FLIGHT requests at a time.

export const MAX_IN_FLIGHT = 4;
/** From this many items on, the transfer ribbon shows how far the action is. */
export const PROGRESS_FROM = 12;

export interface PoolResult<T> {
  done: T[];
  failed: Array<{ item: T; cause: unknown }>;
  /** Not attempted: the server said "too many requests" (or the account changed) before their turn. */
  skipped: T[];
}

let nextBatch = 1;

async function pool<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  progress: keyof typeof messages,
  mine: () => boolean,
): Promise<PoolResult<T>> {
  const result: PoolResult<T> = { done: [], failed: [], skipped: [] };
  const sourceId = items.length >= PROGRESS_FROM ? `explorer:${nextBatch++}` : null;
  let next = 0;
  let stopped = false;
  const report = () => {
    if (!sourceId || !mine()) return;
    const settled = result.done.length + result.failed.length;
    publish(sourceId, {
      progress: settled / items.length,
      sentence: t(progress, { done: settled, total: items.length }),
      status: "active",
    });
  };
  report();
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      if (stopped || !mine()) {
        result.skipped.push(item);
        continue;
      }
      try {
        await work(item);
        result.done.push(item);
      } catch (cause) {
        result.failed.push({ item, cause });
        // Refused for rate: the ones still waiting would only be refused too.
        if (cause instanceof ApiError && cause.status === 429) stopped = true;
      }
      report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, items.length) }, worker));
  if (sourceId && mine()) publish(sourceId, null);
  return result;
}

/** One toast for what did not go through: the cause for a single item, a count for several. */
function reportShortfall<T>(result: PoolResult<T>, total: number, conflictMessage?: string): void {
  const missing = result.failed.length + result.skipped.length;
  if (missing === 0) return;
  const first = result.failed[0]?.cause;
  if (total === 1) {
    if (conflictMessage) toastFailure(first, conflictMessage);
    else toastApiError(first);
    return;
  }
  // A `429` was already said by the shared client; the count is what it does not say.
  toast({
    message: t("explorer.error.partial", { done: result.done.length, total }),
    requestId: requestIdOf(first),
    key: "partial",
  });
}

// ---------------------------------------------------------------------------------------------

export type CreateResult = { ok: true; node: NodeDto } | { ok: false; conflict: boolean };

/** Not optimistic: where the folder sorts is the server's answer. The dialog shows a name clash. */
export async function createFolderIn(parentId: string | null, name: string): Promise<CreateResult> {
  const mine = stillMine();
  try {
    const node = await createFolder({ parentId, name });
    if (!mine()) return { ok: false, conflict: false };
    emitNodesChanged([parentId]);
    announce(t("explorer.done.created", { name: node.name }));
    return { ok: true, node };
  } catch (cause) {
    if (!mine()) return { ok: false, conflict: false };
    if (isConflict(cause)) return { ok: false, conflict: true };
    toastApiError(cause);
    return { ok: false, conflict: false };
  }
}

export async function renameNode(node: NodeDto, name: string): Promise<boolean> {
  const mine = stillMine();
  const end = beginEdit(queryClient, [node.parentId]);
  try {
    return await renameHeld(node, name, mine);
  } finally {
    end();
  }
}

async function renameHeld(node: NodeDto, name: string, mine: () => boolean): Promise<boolean> {
  await cancelListings(queryClient, node.parentId);
  if (!mine()) return false;
  patchInListings(queryClient, node.parentId, node.id, (current) => ({ ...current, name }));
  try {
    const saved = await patchNode(node.id, { name });
    if (!mine()) return false;
    // Only the name: whatever else changed on this row meanwhile (a star) is not this answer's.
    patchInListings(queryClient, node.parentId, node.id, (current) => ({
      ...current,
      name: saved.name,
      ext: saved.ext,
      updatedAt: saved.updatedAt,
    }));
    emitNodesChanged([node.parentId]);
    announce(t("explorer.done.renamed", { name: saved.name }));
    return true;
  } catch (cause) {
    if (!mine()) return false;
    // Undo this change on this row — if the row still shows it — and read the truth again.
    patchInListings(queryClient, node.parentId, node.id, (current) =>
      current.name === name ? { ...current, name: node.name } : current,
    );
    invalidateParents(queryClient, [node.parentId]);
    toastFailure(cause, t("explorer.error.renameConflict", { name }));
    return false;
  }
}

export async function setStarred(nodes: readonly NodeDto[], starred: boolean): Promise<void> {
  if (nodes.length === 0) return;
  const mine = stillMine();
  const parents = unique(nodes.map((node) => node.parentId));
  const end = beginEdit(queryClient, parents);
  try {
    await starHeld(nodes, starred, parents, mine);
  } finally {
    end();
  }
}

async function starHeld(
  nodes: readonly NodeDto[],
  starred: boolean,
  parents: Array<string | null>,
  mine: () => boolean,
): Promise<void> {
  await Promise.all(parents.map((parentId) => cancelListings(queryClient, parentId)));
  if (!mine()) return;
  for (const node of nodes) {
    patchInListings(queryClient, node.parentId, node.id, (current) => ({ ...current, starred }));
  }
  const result = await pool(
    nodes,
    async (node) => {
      await patchNode(node.id, { starred });
    },
    starred ? "explorer.progress.star" : "explorer.progress.unstar",
    mine,
  );
  if (!mine()) return;
  const undone = [...result.failed.map((entry) => entry.item), ...result.skipped];
  for (const node of undone) {
    patchInListings(queryClient, node.parentId, node.id, (current) => ({
      ...current,
      starred: node.starred,
    }));
  }
  if (undone.length > 0) invalidateParents(queryClient, unique(undone.map((node) => node.parentId)));
  reportShortfall(result, nodes.length);
  if (result.done.length === 0) return;
  emitNodesChanged(unique(result.done.map((node) => node.parentId)));
  announce(t(starred ? "explorer.done.starred" : "explorer.done.unstarred", { what: describe(result.done) }));
}

async function undoTrash(trashed: readonly NodeDto[], mine: () => boolean): Promise<void> {
  if (!mine()) return;
  const parents: Array<string | null> = [];
  const result = await pool(
    trashed,
    async (node) => {
      const restored = await restoreNode(node.id);
      // It may have come back somewhere else: at the top level when its folder is gone.
      parents.push(node.parentId, restored.parentId);
    },
    "explorer.progress.restore",
    mine,
  );
  if (!mine()) return;
  if (parents.length > 0) {
    emitNodesChanged(unique(parents));
    announce(t("explorer.done.restored", { what: describe(result.done) }));
  }
  reportShortfall(result, trashed.length, t("explorer.error.restoreConflict"));
}

/** Trash, no confirmation: the toast's Undo restores. */
export async function trashNodes(nodes: readonly NodeDto[]): Promise<void> {
  if (nodes.length === 0) return;
  const mine = stillMine();
  const parents = unique(nodes.map((node) => node.parentId));
  const end = beginEdit(queryClient, parents);
  try {
    await trashHeld(nodes, parents, mine);
  } finally {
    end();
  }
}

async function trashHeld(nodes: readonly NodeDto[], parents: Array<string | null>, mine: () => boolean) {
  await Promise.all(parents.map((parentId) => cancelListings(queryClient, parentId)));
  if (!mine()) return;
  const putBack = parents.map((parentId) =>
    removeFromListings(
      queryClient,
      parentId,
      nodes.filter((node) => node.parentId === parentId).map((node) => node.id),
    ),
  );
  const result = await pool(
    nodes,
    async (node) => {
      await trashNode(node.id);
    },
    "explorer.progress.trash",
    mine,
  );
  if (!mine()) return;
  const kept = [...result.failed.map((entry) => entry.item), ...result.skipped];
  if (kept.length > 0) {
    // Back come exactly the rows that were not trashed, then the server's own list.
    for (const back of putBack) back(kept.map((node) => node.id));
    invalidateParents(queryClient, unique(kept.map((node) => node.parentId)));
    reportShortfall(result, nodes.length);
  }
  const done = result.done;
  if (done.length === 0) return;
  emitNodesChanged(unique(done.map((node) => node.parentId)));
  undoToast({
    message: t("explorer.done.trashed", { what: describe(done) }),
    onUndo: () => void undoTrash(done, mine),
  });
}

export interface MoveTarget {
  /** `null` is the top level. */
  id: string | null;
  name: string;
}

function moveAll(nodes: readonly NodeDto[], parentId: string | null, mine: () => boolean) {
  return pool(
    nodes,
    async (node) => {
      await moveNode(node.id, { parentId });
    },
    "explorer.progress.move",
    mine,
  );
}

export async function moveNodes(nodes: readonly NodeDto[], target: MoveTarget): Promise<void> {
  const movable = nodes.filter((node) => node.parentId !== target.id && node.id !== target.id);
  if (movable.length === 0) return;
  const mine = stillMine();
  const result = await moveAll(movable, target.id, mine);
  if (!mine()) return;
  reportShortfall(result, movable.length, t("explorer.error.moveConflict", { name: target.name }));
  const moved = result.done;
  if (moved.length === 0) return;
  for (const node of moved) removeFromListings(queryClient, node.parentId, [node.id]);
  // Both sides changed: where it was and where it is now.
  emitNodesChanged(unique([...moved.map((node) => node.parentId), target.id]));
  undoToast({
    message: t("explorer.done.moved", { what: describe(moved), name: target.name }),
    onUndo: () => {
      if (!mine()) return;
      for (const origin of unique(moved.map((node) => node.parentId))) {
        const from = moved.filter((node) => node.parentId === origin);
        void moveAll(from, origin, mine).then((back) => {
          if (!mine()) return;
          reportShortfall(back, from.length);
          if (back.done.length > 0) emitNodesChanged(unique([origin, target.id]));
        });
      }
    },
  });
}

/** One file, through a short-lived files-host URL. */
export async function downloadNode(node: NodeDto): Promise<void> {
  const mine = stillMine();
  try {
    const answer = await downloadUrl(node.id, "download");
    if (!mine()) return;
    if (!saveUrl(answer.url)) {
      toast({ message: t("explorer.download.refused"), key: "download" });
      return;
    }
    if (answer.warning === "unscanned")
      toast({ message: t("explorer.download.unscanned"), key: "unscanned" });
  } catch (cause) {
    if (!mine()) return;
    if (cause instanceof ApiError && cause.code === "scan_pending")
      toast({ message: t("explorer.download.pending"), requestId: cause.requestId });
    else if (cause instanceof ApiError && cause.code === "scan_blocked")
      toast({ message: t("explorer.download.blocked"), requestId: cause.requestId });
    else toastApiError(cause);
  }
}

/** Ask for another scan of a file that could not be scanned. The row goes back to "scanning". */
export async function recheckNode(node: NodeDto): Promise<void> {
  const mine = stillMine();
  try {
    await rescanNode(node.id);
    if (!mine()) return;
    patchInListings(queryClient, node.parentId, node.id, (current) => ({
      ...current,
      scanStatus: "pending",
      scanReason: null,
    }));
    announce(t("explorer.done.recheck", { name: node.name }));
  } catch (cause) {
    if (mine()) toastApiError(cause);
  }
}
