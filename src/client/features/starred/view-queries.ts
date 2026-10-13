// What the five view features (trash, recent, starred, search, usage — one owner) share about
// their queries: every key starts with VIEWS_KEY, so one invalidation refreshes all of them, and
// one listener does exactly that whenever any feature says the tree changed.
//
// Nothing here is account state outside TanStack Query: `purgeUserState()` drops these queries
// with the rest of the cache, so no purger is registered for them.
import { onNodesChanged } from "../../lib/contracts";
import { queryClient } from "../../lib/query";

export const VIEWS_KEY = "views";

export interface SearchKeyParams {
  q: string;
  category: string | null;
  scope: string;
}

export const viewKeys = {
  all: [VIEWS_KEY] as const,
  trash: [VIEWS_KEY, "trash"] as const,
  recent: [VIEWS_KEY, "recent"] as const,
  starred: [VIEWS_KEY, "starred"] as const,
  usage: [VIEWS_KEY, "usage"] as const,
  search: (params: SearchKeyParams) => [VIEWS_KEY, "search", params] as const,
  suggestions: (q: string) => [VIEWS_KEY, "suggestions", q] as const,
};

/** Mark every view query stale; the mounted ones are fetched again. */
export function invalidateViews(): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: viewKeys.all });
}

// A star toggle, an upload, a move, a restore: whatever changed, these lists and the storage
// numbers may show it. The listener lives for the lifetime of the page, mounted view or not.
onNodesChanged(() => {
  void invalidateViews();
});
