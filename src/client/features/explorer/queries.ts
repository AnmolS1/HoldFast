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
  });
}

export function useFolderDetail(folderId: string | null) {
  return useQuery({
    queryKey: explorerKeys.node(folderId ?? TOP),
    queryFn: ({ signal }) => getNode(folderId!, signal),
    enabled: folderId !== null,
  });
}

/** Every sub-folder of a parent, all pages (the move picker shows the whole level). */
export async function fetchFolders(folderId: string | null, signal?: AbortSignal): Promise<NodeDto[]> {
  const out: NodeDto[] = [];
  let cursor: string | undefined;
  do {
    const page = await listChildren(folderId, { sort: "name", dir: "asc", kind: "folder", cursor, signal });
    out.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cache edits. Each returns what is needed to put things back when the request fails.

export type ListingSnapshot = Array<[QueryKey, Listing | undefined]>;

export function snapshotListings(client: QueryClient, parentId: string | null): ListingSnapshot {
  return client.getQueriesData<Listing>({ queryKey: explorerKeys.children(parentId) });
}

export function restoreListings(client: QueryClient, snapshot: ListingSnapshot): void {
  for (const [key, data] of snapshot) client.setQueryData(key, data);
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

export function removeFromListings(client: QueryClient, parentId: string | null, ids: readonly string[]) {
  const gone = new Set(ids);
  editListings(client, parentId, (items) => items.filter((item) => !gone.has(item.id)));
}

/** The tree changed under these parents: their listings, picker levels and details are stale. */
export function invalidateParents(client: QueryClient, parentIds: readonly (string | null)[]): void {
  for (const parentId of new Set(parentIds)) {
    void client.invalidateQueries({ queryKey: explorerKeys.children(parentId) });
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
