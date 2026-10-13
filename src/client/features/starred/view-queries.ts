// What the five view features (trash, recent, starred, search, usage — one owner) share about
// their queries: every key starts with VIEWS_KEY, so one invalidation refreshes all of them, and
// one listener does exactly that whenever any feature says the tree changed.
//
// The data is TanStack Query's: `purgeUserState()` drops these queries with the rest of the cache.
import type { QueryKey } from "@tanstack/react-query";
import { onNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { queryClient } from "../../lib/query";
import { isHeld } from "./view-state";

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

/**
 * Read these queries again (the mounted ones at once, the others when next shown) — except any
 * that is inside a wait the API named (`isHeld`), and without cutting off a read in flight: a
 * round that is under way finishes, so a stream of refreshes can never starve the view.
 */
export function refreshQueries(queryKey: QueryKey): Promise<void> {
  return queryClient.invalidateQueries(
    { queryKey, predicate: (query) => !isHeld(query) },
    { cancelRefetch: false },
  );
}

/** Refresh every view query. */
export function invalidateViews(): Promise<void> {
  return refreshQueries(viewKeys.all);
}

/**
 * Tree-changed events are gathered. A round of reads starts `INVALIDATE_WAIT_MS` after the first
 * event; events that arrive while a round is waiting or being read are answered by ONE further
 * round, started `INVALIDATE_WAIT_MS` after the one in flight has finished. So while events keep
 * coming the views are refreshed at least every `INVALIDATE_WAIT_MS` + the time the API takes,
 * and once more after the last event — never one round per event, never a round cut short.
 */
export const INVALIDATE_WAIT_MS = 250;

let waiting: ReturnType<typeof setTimeout> | null = null;

function round(): void {
  // A round is still being read: let it finish (cutting it off is what starves a slow API),
  // then read once more for whatever arrived meanwhile.
  if (queryClient.isFetching({ queryKey: viewKeys.all }) > 0) {
    waiting = setTimeout(round, INVALIDATE_WAIT_MS);
    return;
  }
  waiting = null;
  void invalidateViews();
}

export function scheduleInvalidateViews(): void {
  if (waiting !== null) return;
  waiting = setTimeout(round, INVALIDATE_WAIT_MS);
}

// A star toggle, an upload, a move, a restore: whatever changed, these lists and the storage
// numbers may show it. The listener lives for the lifetime of the page, mounted view or not.
onNodesChanged(scheduleInvalidateViews);

// A round still waiting was asked for by the account that is leaving.
registerUserStatePurger(() => {
  if (waiting !== null) clearTimeout(waiting);
  waiting = null;
});
