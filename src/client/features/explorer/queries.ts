// The explorer's queries and the cache edits its optimistic actions make. Listings are keyed by
// parent, then sort and direction: a change of either is a new query, so a cursor never crosses
// from one order into another.
import {
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { NodeDto, NodePage } from "../../../shared/schemas/node";
import { onNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { queryClient } from "../../lib/query";
import { getNode, listChildren, type SortDir, type SortKey } from "./api";

const TOP = "top";
const scope = (folderId: string | null) => folderId ?? TOP;

export const explorerKeys = {
  all: ["explorer"] as const,
  /** Every listing of one parent, whatever its order. */
  children: (folderId: string | null) => ["explorer", "children", scope(folderId)] as const,
  listing: (folderId: string | null, sort: SortKey, dir: SortDir) =>
    ["explorer", "children", scope(folderId), sort, dir] as const,
  node: (id: string) => ["explorer", "node", id] as const,
  /** The sub-folders of one parent, for the move picker. */
  folders: (folderId: string | null) => ["explorer", "folders", scope(folderId)] as const,
};

export type Listing = InfiniteData<NodePage, string | undefined>;

export function useListing(folderId: string | null, sort: SortKey, dir: SortDir) {
  return useInfiniteQuery({
    queryKey: explorerKeys.listing(folderId, sort, dir),
    queryFn: ({ pageParam, signal }) => listChildren(folderId, { sort, dir, cursor: pageParam, signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // A refetch reads every loaded page again, one request each: only a short list does that by
    // itself. A long one is marked as changed and read again when the user asks (see below).
    // Nor while an optimistic edit of this parent is in flight (see `beginEdit`).
    refetchOnWindowFocus: (query) =>
      (query.state.data?.pages.length ?? 0) <= MAX_REFETCH_PAGES && !editing.has(String(query.queryKey[2])),
  });
}

export function useFolderDetail(folderId: string | null) {
  return useQuery({
    queryKey: explorerKeys.node(folderId ?? TOP),
    queryFn: ({ signal }) => getNode(folderId!, signal),
    enabled: folderId !== null,
  });
}

/** Pages of sub-folders the move picker reads for one level: 5 × 200 = 1,000 folders. */
export const MAX_FOLDER_PAGES = 5;

export interface FolderLevel {
  folders: NodeDto[];
  /** The level holds more folders than were read. */
  more: boolean;
}

/** The sub-folders of a parent for the move picker — a bounded number of pages, never a loop without end. */
export async function fetchFolders(folderId: string | null, signal?: AbortSignal): Promise<FolderLevel> {
  const folders: NodeDto[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < MAX_FOLDER_PAGES; page += 1) {
    const answer = await listChildren(folderId, { sort: "name", dir: "asc", kind: "folder", cursor, signal });
    folders.push(...answer.items);
    cursor = answer.nextCursor ?? undefined;
    // A cursor that comes back a second time would never end.
    if (!cursor || seen.has(cursor)) return { folders, more: false };
    seen.add(cursor);
  }
  return { folders, more: true };
}

// ---------------------------------------------------------------------------------------------
// Cache edits. Each returns what is needed to put things back when the request fails.

/** Stop any read of this parent's listings that is under way: its answer would overwrite an optimistic edit. */
export function cancelListings(client: QueryClient, parentId: string | null): Promise<void> {
  return client.cancelQueries({ queryKey: explorerKeys.children(parentId) });
}

function editListings(
  client: QueryClient,
  parentId: string | null,
  edit: (items: NodeDto[]) => NodeDto[],
): void {
  client.setQueriesData<Listing>({ queryKey: explorerKeys.children(parentId) }, (data) =>
    data ? { ...data, pages: data.pages.map((page) => ({ ...page, items: edit(page.items) })) } : data,
  );
}

export function patchInListings(
  client: QueryClient,
  parentId: string | null,
  id: string,
  patch: (node: NodeDto) => NodeDto,
): void {
  editListings(client, parentId, (items) => items.map((item) => (item.id === id ? patch(item) : item)));
}

/**
 * Take rows out of every listing of a parent. Returns the function that puts some of them back —
 * each where it was, in whatever the cache holds by then: only into a listing that still exists
 * (never re-creating one), and never a row that is there already. A rollback undoes ITS change;
 * it does not restore an old copy of the list.
 */
export function removeFromListings(
  client: QueryClient,
  parentId: string | null,
  ids: readonly string[],
): (putBack: readonly string[]) => void {
  const gone = new Set(ids);
  const places: Array<{ key: QueryKey; page: number; index: number; node: NodeDto }> = [];
  for (const [key, data] of client.getQueriesData<Listing>({ queryKey: explorerKeys.children(parentId) })) {
    data?.pages.forEach((page, pageIndex) =>
      page.items.forEach((node, index) => {
        if (gone.has(node.id)) places.push({ key, page: pageIndex, index, node });
      }),
    );
  }
  editListings(client, parentId, (items) => items.filter((item) => !gone.has(item.id)));
  return (putBack) => {
    const wanted = new Set(putBack);
    for (const place of places) {
      if (!wanted.has(place.node.id)) continue;
      client.setQueriesData<Listing>({ queryKey: place.key, exact: true }, (data) => {
        if (!data || data.pages.some((page) => page.items.some((item) => item.id === place.node.id)))
          return data;
        const at = Math.min(place.page, data.pages.length - 1);
        return {
          ...data,
          pages: data.pages.map((page, pageIndex) => {
            if (pageIndex !== at) return page;
            const items = [...page.items];
            items.splice(Math.min(place.index, items.length), 0, place.node);
            return { ...page, items };
          }),
        };
      });
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Reading again after a change. A refetch of an infinite listing is one request per loaded page;
// in a long folder that is dozens for one star. So: a listing of up to MAX_REFETCH_PAGES pages is
// read again at once; a longer one is marked stale and named in `changedParents`, and the page
// offers to reload it (from its first page).

export const MAX_REFETCH_PAGES = 3;

let changed: ReadonlySet<string> = new Set();
const changedListeners = new Set<() => void>();
const setChanged = (next: ReadonlySet<string>) => {
  changed = next;
  for (const listener of changedListeners) listener();
};
const subscribeChanged = (listener: () => void) => {
  changedListeners.add(listener);
  return () => changedListeners.delete(listener);
};
const getChanged = () => changed;

/** Whether this parent's long listing changed on the server since it was read. */
export function useListingChanged(folderId: string | null): boolean {
  return useSyncExternalStore(subscribeChanged, getChanged, getChanged).has(scope(folderId));
}

/** Read a parent's listings again from their first page (the "Reload" of a long, changed list). */
export function reloadListing(client: QueryClient, folderId: string | null): void {
  if (changed.has(scope(folderId)))
    setChanged(new Set(Array.from(changed).filter((key) => key !== scope(folderId))));
  void client.resetQueries({ queryKey: explorerKeys.children(folderId) });
}

/** Back to nothing: run by `purgeUserState()` and by tests (the keys are folder ids). */
export function resetChangedForTests(): void {
  if (changed.size > 0) setChanged(new Set());
}

registerUserStatePurger(resetChangedForTests);

// ---------------------------------------------------------------------------------------------
// Optimistic edits in flight. A read of a parent that STARTS while an optimistic edit of it is
// pending (another action's tree-changed event, window focus) would answer what the server holds
// before that edit lands — a trashed row drawn back, an old name. So while a parent has an edit in
// flight its listings are only marked stale, and read again once, when the last edit has settled.

/** Edits in flight per parent (by scope key), and the parents whose read was held back meanwhile. */
const editing = new Map<string, number>();
const heldBack = new Set<string>();
let editGeneration = 0;

/**
 * Mark an optimistic edit of these parents as in flight. Returns the function that ends it (call
 * it exactly once, whatever the outcome): a parent with nothing left in flight whose read was held
 * back is read again then.
 */
export function beginEdit(client: QueryClient, parentIds: readonly (string | null)[]): () => void {
  const keys = Array.from(new Set(parentIds), scope);
  const generation = editGeneration;
  for (const key of keys) editing.set(key, (editing.get(key) ?? 0) + 1);
  let ended = false;
  return () => {
    // Ended twice, or the account changed meanwhile (the purger has forgotten every edit).
    if (ended || generation !== editGeneration) return;
    ended = true;
    const due: Array<string | null> = [];
    for (const key of keys) {
      const left = (editing.get(key) ?? 1) - 1;
      if (left > 0) {
        editing.set(key, left);
        continue;
      }
      editing.delete(key);
      if (heldBack.delete(key)) due.push(key === TOP ? null : key);
    }
    if (due.length > 0) invalidateParents(client, due);
  };
}

/** Forget every edit in flight: run by `purgeUserState()` and by tests. */
export function resetEditsForTests(): void {
  editGeneration += 1;
  editing.clear();
  heldBack.clear();
}

registerUserStatePurger(resetEditsForTests);

/** The tree changed under these parents: their listings, picker levels and details are stale. */
export function invalidateParents(client: QueryClient, parentIds: readonly (string | null)[]): void {
  for (const parentId of new Set(parentIds)) {
    if (editing.has(scope(parentId))) {
      // Stale, but not read now: the edit in flight would be drawn over. Read once it settles.
      heldBack.add(scope(parentId));
      void client.invalidateQueries({ queryKey: explorerKeys.children(parentId), refetchType: "none" });
      void client.invalidateQueries({ queryKey: explorerKeys.folders(parentId) });
      if (parentId !== null) void client.invalidateQueries({ queryKey: explorerKeys.node(parentId) });
      continue;
    }
    const long = client
      .getQueriesData<Listing>({ queryKey: explorerKeys.children(parentId), type: "active" })
      .some(([, data]) => (data?.pages.length ?? 0) > MAX_REFETCH_PAGES);
    void client.invalidateQueries({
      queryKey: explorerKeys.children(parentId),
      refetchType: long ? "none" : "active",
    });
    if (long && !changed.has(scope(parentId))) setChanged(new Set(changed).add(scope(parentId)));
    void client.invalidateQueries({ queryKey: explorerKeys.folders(parentId) });
    if (parentId !== null) void client.invalidateQueries({ queryKey: explorerKeys.node(parentId) });
  }
}

// Whoever changed the tree — this feature, the uploader, the trash — says so with the tree-changed
// event; the explorer's part is to drop what it holds for those parents. Listening for the life of
// the page, not of a component: an Undo may land after the explorer was left.
onNodesChanged(({ parentIds }) => invalidateParents(queryClient, parentIds));

// ---------------------------------------------------------------------------------------------
// The chosen order. It outlives a route (entering a folder keeps it), so it is state of the
// signed-in account's session and is reset with it.

export interface SortState {
  sort: SortKey;
  dir: SortDir;
}

const DEFAULT_SORT: SortState = { sort: "name", dir: "asc" };
let sortState: SortState = DEFAULT_SORT;
const sortListeners = new Set<() => void>();

export function getSort(): SortState {
  return sortState;
}

export function setSort(next: SortState): void {
  if (next.sort === sortState.sort && next.dir === sortState.dir) return;
  sortState = next;
  for (const listener of sortListeners) listener();
}

const subscribeSort = (listener: () => void) => {
  sortListeners.add(listener);
  return () => sortListeners.delete(listener);
};

export function useSort(): SortState {
  return useSyncExternalStore(subscribeSort, getSort, getSort);
}

/** Back to the default order: run by `purgeUserState()` and by tests. */
export function resetSortForTests(): void {
  setSort(DEFAULT_SORT);
}

registerUserStatePurger(resetSortForTests);
