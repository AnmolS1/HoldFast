// What the views read off a query to decide what to show and whether to ask for more.
import { useCallback } from "react";

/** The parts of a query's state these helpers read (a plain or an infinite query has them). */
export interface QueryLike {
  data: unknown;
  error: unknown;
  isError: boolean;
  fetchStatus: "fetching" | "paused" | "idle";
  refetch(): unknown;
}

export interface PagedQueryLike extends QueryLike {
  hasNextPage: boolean;
  isFetchNextPageError: boolean;
  fetchNextPage(): unknown;
}

/** Nothing to show and no request under way: the browser is offline and the query is waiting. */
export function isWaitingOffline(query: QueryLike): boolean {
  return query.fetchStatus === "paused" && query.data === undefined;
}

/** Nothing to show because the first request failed. */
export function hasFailed(query: QueryLike): boolean {
  return query.isError && query.data === undefined;
}

/**
 * May the list ask for its next page by itself? Not after ANY failure (a `429`, a `5xx`, no
 * answer, a refused cursor — the user asks again with "Try again"), and not while offline. The
 * list re-arms its scroll trigger on every render, so a `true` here after a failed page would
 * ask again at once, without end.
 */
export function canLoadMore(query: PagedQueryLike): boolean {
  return query.hasNextPage && !query.isError && query.fetchStatus !== "paused";
}

/** A stable "load the next page" for a list's scroll trigger. */
export function useLoadMore(fetchNextPage: () => unknown): () => void {
  return useCallback(() => void fetchNextPage(), [fetchNextPage]);
}
