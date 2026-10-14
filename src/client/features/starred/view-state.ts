// What the views read off a query to decide what to show and whether to ask for more — and the
// two things a query's own state cannot remember: that a NEXT page failed (a refresh of the
// pages in hand clears the query's error), and until when the API asked not to be called.
import { hashKey, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { ApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, queryClient, sameAccount } from "../../lib/query";

/** The parts of a query's state these helpers read (a plain or an infinite query has them). */
export interface QueryLike {
  data: unknown;
  error: unknown;
  isError: boolean;
  /** When `error` arrived (ms); 0 when there is none. */
  errorUpdatedAt: number;
  fetchStatus: "fetching" | "paused" | "idle";
  refetch(): Promise<{ isSuccess: boolean }>;
}

export interface PagedQueryLike extends QueryLike {
  hasNextPage: boolean;
  fetchNextPage(): Promise<{ isError: boolean; isFetchNextPageError: boolean; error: unknown }>;
}

/** Nothing to show and no request under way: the browser is offline and the query is waiting. */
export function isWaitingOffline(query: QueryLike): boolean {
  return query.fetchStatus === "paused" && query.data === undefined;
}

/** Nothing to show because the first request failed. */
export function hasFailed(query: QueryLike): boolean {
  return query.isError && query.data === undefined;
}

// ---------------------------------------------------------------------------------------------
// Retry-After.

/** `setTimeout` takes 31 bits of milliseconds; a longer wait is taken in steps. */
const LONGEST_TIMER_MS = 2_147_483_647;

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
  const [step, setStep] = useState(0);
  useEffect(() => {
    if (until === 0) return;
    const left = Math.max(0, until - Date.now());
    const timer = setTimeout(
      () => (left > LONGEST_TIMER_MS ? setStep((count) => count + 1) : setPassed(until)),
      Math.min(left, LONGEST_TIMER_MS),
    );
    return () => clearTimeout(timer);
  }, [until, step]);
  return until !== 0 && passed !== until;
}

// ---------------------------------------------------------------------------------------------
// A next page that failed. Kept HERE, per query, not in the query: any successful refresh of the
// pages already shown (a tree-changed event, the tab coming back, a reconnect, a batch of Empty
// trash) clears the query's error, and a list that read only that flag would ask for the failed
// page again — by itself, as often as something refreshes, through a running Retry-After.
// The rule: once a next page has failed, that list asks for no further page until the user
// presses "Try again" or starts the list again from its first page — or the list is known to end
// before that page. It is account state: purged with the rest.

export interface PageFailure {
  error: unknown;
  /** When it failed (ms). */
  at: number;
}

const failures = new Map<string, PageFailure>();
const failureListeners = new Set<() => void>();
// A failure forgotten while the wait it came with still runs leaves that wait behind: no notice,
// but nothing refreshes the list by itself before it is over (`isHeld`). Until when, per query.
const quietHolds = new Map<string, number>();

function setFailure(hash: string, failure: PageFailure | null): void {
  if (failure) failures.set(hash, failure);
  else if (!failures.delete(hash)) return;
  for (const listener of failureListeners) listener();
}

/** The list's failed page is no longer the list's problem; a wait the API named still holds. */
function forgetFailure(hash: string): void {
  const failure = failures.get(hash);
  if (!failure) return;
  const until = retryNotBefore(failure.error, failure.at);
  if (until > Date.now()) quietHolds.set(hash, until);
  setFailure(hash, null);
}

/**
 * The failure of this list, forgotten — unless a wait it came with still runs. True when there
 * was one to forget: the caller then reads the list again from its first page.
 */
export function forgetPageFailure(key: QueryKey): boolean {
  const hash = hashKey(key);
  const failure = failures.get(hash);
  if (!failure || retryNotBefore(failure.error, failure.at) > Date.now()) return false;
  setFailure(hash, null);
  return true;
}

/** Does the query's newest data end the list (its last page has no next cursor)? */
function endsTheList(data: unknown): boolean {
  const pages = (data as { pages?: unknown } | undefined)?.pages;
  if (!Array.isArray(pages)) return false;
  const last = pages.at(-1) as { nextCursor?: unknown } | undefined;
  return last !== undefined && last.nextCursor === null;
}

// A remembered failure lives exactly as long as it can be true: it goes when its query leaves the
// cache (a later visit loads the list afresh), and when the list turns out to end before the page
// that failed — written (an emptied trash) or read again (a list that shrank to one page).
queryClient.getQueryCache().subscribe((event) => {
  if (!failures.has(event.query.queryHash)) return;
  if (event.type === "removed") forgetFailure(event.query.queryHash);
  else if (
    event.type === "updated" &&
    event.action.type === "success" &&
    endsTheList(event.query.state.data)
  ) {
    forgetFailure(event.query.queryHash);
  }
});

const subscribeFailures = (listener: () => void) => {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
};

/** Forget every failed page. Run by `purgeUserState()` and by tests. */
export function clearPageFailures(): void {
  failures.clear();
  quietHolds.clear();
  for (const listener of failureListeners) listener();
}

registerUserStatePurger(clearPageFailures);

/** Tests only. */
export function pageFailureOf(key: QueryKey): PageFailure | null {
  return failures.get(hashKey(key)) ?? null;
}

/** What `refetchOn…` options and an invalidation's predicate are handed: a query of the cache. */
export interface CachedQuery {
  queryHash: string;
  state: { error: unknown; errorUpdatedAt: number };
}

/**
 * Is this query inside a wait the API named — on its own last error, or on its failed next page?
 * While it is, NOTHING refreshes it by itself: not an event, not the tab coming back, not a
 * reconnect, not a remount. (After the wait, the next such trigger does.)
 */
export function isHeld(query: CachedQuery): boolean {
  const failure = failures.get(query.queryHash);
  const quiet = quietHolds.get(query.queryHash) ?? 0;
  if (quiet !== 0 && quiet <= Date.now()) quietHolds.delete(query.queryHash);
  const until = Math.max(
    retryNotBefore(query.state.error, query.state.errorUpdatedAt),
    failure ? retryNotBefore(failure.error, failure.at) : 0,
    quiet,
  );
  return until > Date.now();
}

const unlessHeld = (query: CachedQuery): boolean => !isHeld(query);

/** Spread into every query of the views: the automatic refetches respect `isHeld`. */
export const AUTO_REFETCH = {
  refetchOnWindowFocus: unlessHeld,
  refetchOnReconnect: unlessHeld,
  refetchOnMount: unlessHeld,
} as const;

// ---------------------------------------------------------------------------------------------
// Focus after a retry: the control that was pressed goes away when the retry succeeds.

/**
 * Returns `focusRow(index)`: put the keyboard focus on that row of the page's list once it is
 * drawn — or, when there is no such row (a page without a list, a windowed list), on the page's
 * main region. Never left to fall to the document.
 */
export function useRowFocus(): (index: number) => void {
  // A new object per request, so asking for the same row twice focuses twice.
  const [target, setTarget] = useState<{ index: number } | null>(null);
  useEffect(() => {
    if (target === null) return;
    const row = document.querySelector<HTMLElement>(`[data-view-page] [data-item-index="${target.index}"]`);
    (row ?? document.querySelector<HTMLElement>("[data-main]"))?.focus();
  }, [target]);
  return useCallback((index: number) => setTarget({ index }), []);
}

/** What a notice under a list says and what its "Try again" does. */
export interface ListProblem {
  /** "more": the next page failed. "refresh": re-reading the pages in hand failed. */
  kind: "more" | "refresh";
  error: unknown;
  since: number;
  /** `hadFocus`: the button had the keyboard focus when it was pressed. */
  retry(hadFocus: boolean): void;
}

/** Read the query again on the user's request; focus follows when it works. */
export function useRefresh(query: QueryLike): (hadFocus: boolean) => void {
  const focusRow = useRowFocus();
  const refetch = query.refetch;
  return useCallback(
    (hadFocus: boolean) => {
      void refetch().then((result) => {
        if (result.isSuccess && hadFocus) focusRow(0);
      });
    },
    [refetch, focusRow],
  );
}

export interface PagedView {
  /** May the list's scroll trigger ask for the next page by itself? */
  hasMore: boolean;
  /** For the scroll trigger. Stable; does nothing while a next page stands failed. */
  loadMore(): void;
  /** The notice to show under the rows, if any. */
  problem: ListProblem | null;
  /** For the page's "nothing to show" error state. */
  refresh(hadFocus: boolean): void;
}

/**
 * Paging of a view's list. `key` is the query's key; `count` the number of rows shown (where
 * the focus goes after a retried next page arrives).
 */
export function usePagedView(query: PagedQueryLike, key: QueryKey, count: number): PagedView {
  const hash = hashKey(key);
  const failure = useSyncExternalStore(
    subscribeFailures,
    () => failures.get(hash) ?? null,
    () => null,
  );
  const focusRow = useRowFocus();
  const refresh = useRefresh(query);
  const fetchNextPage = query.fetchNextPage;

  const request = useCallback(async (): Promise<boolean> => {
    const account = accountEpoch();
    const result = await fetchNextPage();
    // The account changed while it was out: its failure is nobody's to remember.
    if (!sameAccount(account)) return false;
    if (result.isFetchNextPageError) {
      setFailure(hash, { error: result.error, at: Date.now() });
      return false;
    }
    return !result.isError;
  }, [fetchNextPage, hash]);

  const loadMore = useCallback(() => {
    if (failures.has(hash)) return;
    void request();
  }, [hash, request]);

  let problem: ListProblem | null = null;
  if (failure) {
    problem = {
      kind: "more",
      error: failure.error,
      since: failure.at,
      retry: (hadFocus) => {
        setFailure(hash, null);
        void request().then((ok) => {
          if (ok && hadFocus) focusRow(count);
        });
      },
    };
  } else if (query.isError && query.data !== undefined) {
    problem = { kind: "refresh", error: query.error, since: query.errorUpdatedAt, retry: refresh };
  }

  return {
    // Not after ANY failure — of the next page (remembered above) or of a refresh (the query's
    // own error) — and not while offline. The list re-arms its trigger on every render, so a
    // `true` here with a failed page would ask again at once.
    hasMore: query.hasNextPage && failure === null && !query.isError && query.fetchStatus !== "paused",
    loadMore,
    problem,
    refresh,
  };
}

/** The notice of a list that is one page: only a failed refresh can be its problem. */
export function refreshProblem(query: QueryLike, refresh: (hadFocus: boolean) => void): ListProblem | null {
  return query.isError && query.data !== undefined
    ? { kind: "refresh", error: query.error, since: query.errorUpdatedAt, retry: refresh }
    : null;
}
