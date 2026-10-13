// What the explorer does to nodes. Rename, star and trash are optimistic: the list changes at
// once and is put back when the request fails. After every saved change the tree-changed event is
// sent with the parents whose listing changed, so the other views refresh theirs.
import type { NodeDto } from "../../../shared/schemas/node";
import { toast } from "../../components/Toaster";
import { undoToast } from "../../components/UndoToast";
import { ApiError, toastApiError } from "../../lib/api";
import { emitNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { queryClient } from "../../lib/query";
import { createFolder, downloadUrl, moveNode, patchNode, rescanNode, restoreNode, trashNode } from "./api";
import { saveUrl } from "./download";
import { patchInListings, removeFromListings, restoreListings, snapshotListings } from "./queries";
import { t } from "./strings";

// ---------------------------------------------------------------------------------------------
// Results of actions, said once for assistive technology (the page renders the live region).

let announcement = "";
const announceListeners = new Set<() => void>();

export function announce(text: string): void {
  announcement = text;
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

/** A failure in the explorer's own words where it knows the cause, the standard toast otherwise. */
function toastFailure(cause: unknown, conflictMessage: string): void {
  if (isConflict(cause)) toast({ message: conflictMessage, requestId: requestIdOf(cause) });
  else toastApiError(cause);
}

export type CreateResult = { ok: true; node: NodeDto } | { ok: false; conflict: boolean };

/** Not optimistic: where the folder sorts is the server's answer. The dialog shows a name clash. */
export async function createFolderIn(parentId: string | null, name: string): Promise<CreateResult> {
  try {
    const node = await createFolder({ parentId, name });
    emitNodesChanged([parentId]);
    announce(t("explorer.done.created", { name: node.name }));
    return { ok: true, node };
  } catch (cause) {
    if (isConflict(cause)) return { ok: false, conflict: true };
    toastApiError(cause);
    return { ok: false, conflict: false };
  }
}

export async function renameNode(node: NodeDto, name: string): Promise<boolean> {
  const snapshot = snapshotListings(queryClient, node.parentId);
  patchInListings(queryClient, node.parentId, node.id, (current) => ({ ...current, name }));
  try {
    const saved = await patchNode(node.id, { name });
    patchInListings(queryClient, node.parentId, node.id, () => saved);
    emitNodesChanged([node.parentId]);
    announce(t("explorer.done.renamed", { name: saved.name }));
    return true;
  } catch (cause) {
    restoreListings(queryClient, snapshot);
    toastFailure(cause, t("explorer.error.renameConflict", { name }));
    return false;
  }
}

export async function setStarred(nodes: readonly NodeDto[], starred: boolean): Promise<void> {
  const saved: NodeDto[] = [];
  await Promise.all(
    nodes.map(async (node) => {
      patchInListings(queryClient, node.parentId, node.id, (current) => ({ ...current, starred }));
      try {
        const answer = await patchNode(node.id, { starred });
        patchInListings(queryClient, node.parentId, node.id, () => answer);
        saved.push(answer);
      } catch (cause) {
        // Back to what it was — this node only, so the others' answers stay.
        patchInListings(queryClient, node.parentId, node.id, (current) => ({
          ...current,
          starred: node.starred,
        }));
        toastApiError(cause);
      }
    }),
  );
  if (saved.length === 0) return;
  emitNodesChanged(
    unique(nodes.filter((node) => saved.some((s) => s.id === node.id)).map((n) => n.parentId)),
  );
  announce(
    t(starred ? "explorer.done.starred" : "explorer.done.unstarred", {
      what: describe(saved),
    }),
  );
}

/** `"report.pdf"` for one item, "3 items" for several. */
export function describe(nodes: readonly Pick<NodeDto, "name">[]): string {
  return nodes.length === 1
    ? t("explorer.item.quoted", { name: nodes[0]!.name })
    : t("explorer.item.count", { count: nodes.length });
}

async function undoTrash(trashed: readonly NodeDto[]): Promise<void> {
  const parents: Array<string | null> = [];
  let failed: unknown;
  await Promise.all(
    trashed.map(async (node) => {
      try {
        const restored = await restoreNode(node.id);
        // It may have come back somewhere else: at the top level when its folder is gone.
        parents.push(node.parentId, restored.parentId);
      } catch (cause) {
        failed = cause;
      }
    }),
  );
  if (parents.length > 0) {
    emitNodesChanged(unique(parents));
    announce(t("explorer.done.restored", { what: describe(trashed) }));
  }
  if (failed !== undefined) toastFailure(failed, t("explorer.error.restoreConflict"));
}

/** Trash, no confirmation: the toast's Undo restores. */
export async function trashNodes(nodes: readonly NodeDto[]): Promise<void> {
  if (nodes.length === 0) return;
  const parents = unique(nodes.map((node) => node.parentId));
  const snapshots = parents.map((parentId) => snapshotListings(queryClient, parentId));
  for (const parentId of parents) {
    removeFromListings(
      queryClient,
      parentId,
      nodes.filter((node) => node.parentId === parentId).map((node) => node.id),
    );
  }
  const done: NodeDto[] = [];
  let failed: unknown;
  await Promise.all(
    nodes.map(async (node) => {
      try {
        await trashNode(node.id);
        done.push(node);
      } catch (cause) {
        failed = cause;
      }
    }),
  );
  if (failed !== undefined) {
    // Put the list back, then take out again what really went.
    for (const snapshot of snapshots) restoreListings(queryClient, snapshot);
    for (const node of done) removeFromListings(queryClient, node.parentId, [node.id]);
    toastApiError(failed);
  }
  if (done.length === 0) return;
  emitNodesChanged(unique(done.map((node) => node.parentId)));
  undoToast({
    message: t("explorer.done.trashed", { what: describe(done) }),
    onUndo: () => void undoTrash(done),
  });
}

export interface MoveTarget {
  /** `null` is the top level. */
  id: string | null;
  name: string;
}

async function moveAll(nodes: readonly NodeDto[], parentId: string | null) {
  const moved: NodeDto[] = [];
  let failed: unknown;
  await Promise.all(
    nodes.map(async (node) => {
      try {
        await moveNode(node.id, { parentId });
        moved.push(node);
      } catch (cause) {
        failed = cause;
      }
    }),
  );
  return { moved, failed };
}

export async function moveNodes(nodes: readonly NodeDto[], target: MoveTarget): Promise<void> {
  const movable = nodes.filter((node) => node.parentId !== target.id && node.id !== target.id);
  if (movable.length === 0) return;
  const { moved, failed } = await moveAll(movable, target.id);
  if (failed !== undefined) toastFailure(failed, t("explorer.error.moveConflict", { name: target.name }));
  if (moved.length === 0) return;
  for (const node of moved) removeFromListings(queryClient, node.parentId, [node.id]);
  // Both sides changed: where it was and where it is now.
  emitNodesChanged(unique([...moved.map((node) => node.parentId), target.id]));
  undoToast({
    message: t("explorer.done.moved", { what: describe(moved), name: target.name }),
    onUndo: () => {
      void Promise.all(
        unique(moved.map((node) => node.parentId)).map(async (origin) => {
          const back = await moveAll(
            moved.filter((node) => node.parentId === origin),
            origin,
          );
          if (back.failed !== undefined) toastApiError(back.failed);
          if (back.moved.length > 0) emitNodesChanged(unique([origin, target.id]));
        }),
      );
    },
  });
}

/** One file, through a short-lived files-host URL and a hidden `<a download>`. */
export async function downloadNode(node: NodeDto): Promise<void> {
  try {
    const answer = await downloadUrl(node.id, "download");
    if (answer.warning === "unscanned")
      toast({ message: t("explorer.download.unscanned"), key: "unscanned" });
    saveUrl(answer.url);
  } catch (cause) {
    if (cause instanceof ApiError && cause.code === "scan_pending")
      toast({ message: t("explorer.download.pending"), requestId: cause.requestId });
    else if (cause instanceof ApiError && cause.code === "scan_blocked")
      toast({ message: t("explorer.download.blocked"), requestId: cause.requestId });
    else toastApiError(cause);
  }
}

/** Ask for another scan of a file that could not be scanned. The row goes back to "scanning". */
export async function recheckNode(node: NodeDto): Promise<void> {
  try {
    await rescanNode(node.id);
    patchInListings(queryClient, node.parentId, node.id, (current) => ({
      ...current,
      scanStatus: "pending",
      scanReason: null,
    }));
    announce(t("explorer.done.recheck", { name: node.name }));
  } catch (cause) {
    toastApiError(cause);
  }
}
