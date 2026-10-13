// What the five view features (trash, recent, starred, search, usage — one owner) share about
// their queries: every key starts with VIEWS_KEY, so one invalidation refreshes all of them, and
// one listener does exactly that whenever any feature says the tree changed.
//
// The data is TanStack Query's: `purgeUserState()` drops these queries with the rest of the cache.
import { onNodesChanged, registerUserStatePurger } from "../../lib/contracts";
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

/** How long tree-changed events are gathered before the views are read again, once. */
export const INVALIDATE_WAIT_MS = 250;

let waiting: ReturnType<typeof setTimeout> | null = null;

/**
 * Read the views again soon — ONCE, however many events arrive meanwhile. The wait starts at the
 * first event and is not pushed back by later ones, so a steady stream (an upload of 500 files
 * emits 500 times) costs one round of reads per wait, not one per event and not none.
 */
export function scheduleInvalidateViews(): void {
  if (waiting !== null) return;
  waiting = setTimeout(() => {
    waiting = null;
    void invalidateViews();
  }, INVALIDATE_WAIT_MS);
}

// A star toggle, an upload, a move, a restore: whatever changed, these lists and the storage
// numbers may show it. The listener lives for the lifetime of the page, mounted view or not.
onNodesChanged(scheduleInvalidateViews);

// A round still waiting was asked for by the account that is leaving.
registerUserStatePurger(() => {
  if (waiting !== null) clearTimeout(waiting);
  waiting = null;
});
