// What the views read off a query to decide what to show and whether to ask for more.
import { useCallback, useEffect, useState } from "react";
import { ApiError } from "../../lib/api";

/** The parts of a query's state these helpers read (a plain or an infinite query has them). */
export interface QueryLike {
  data: unknown;
  error: unknown;
  isError: boolean;
  /** When `error` arrived (ms); 0 when there is none. */
  errorUpdatedAt: number;
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

/**
 * Until when the API asked not to be called again: a failure that came with `Retry-After` (a
 * `429`) names a number of seconds. 0 = no wait. "Try again" is the user's own request, and it
 * honours that wait like any other.
 */
export function retryNotBefore(error: unknown, since: number): number {
  return error instanceof ApiError && error.retryAfter !== undefined ? since + error.retryAfter * 1000 : 0;
}

/** True until the clock passes `until` (ms); false at once for 0 or a time already past. */
export function useBlockedUntil(until: number): boolean {
  // The `until` whose wait is over. Compared, not reset: a new failure brings a new `until`.
  const [passed, setPassed] = useState(0);
  useEffect(() => {
    if (until === 0) return;
    const timer = setTimeout(() => setPassed(until), Math.max(0, until - Date.now()));
    return () => clearTimeout(timer);
  }, [until]);
  return until !== 0 && passed !== until;
}
