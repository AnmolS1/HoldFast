// The search requests. `q` goes to the API through the API client and nowhere else: it is never
// written to the console or to an error report.
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { SearchResponse } from "../../../shared/schemas/search";
import { api } from "../../lib/api";
import { viewKeys } from "../starred/view-queries";
import { AUTO_REFETCH } from "../starred/view-state";
import { isSearchable, Q_MIN, type SearchState } from "./url-state";

export const DEBOUNCE_MS = 250;
export const SUGGESTION_LIMIT = 5;

/** `value`, once it has stopped changing for `ms`. */
export function useDebounced<T>(value: T, ms: number = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** `GET /api/search`, a page at a time. Asks nothing while `q` is shorter than the contract allows. */
export function useSearch(state: SearchState) {
  return useInfiniteQuery({
    queryKey: viewKeys.search({ q: state.q, category: state.category, scope: state.scope }),
    queryFn: ({ pageParam, signal }) => {
      const params = new URLSearchParams({ q: state.q, scope: state.scope });
      if (state.category) params.set("category", state.category);
      if (pageParam) params.set("cursor", pageParam);
      return api(`/api/search?${params.toString()}`, { schema: SearchResponse, signal });
    },
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    enabled: isSearchable(state),
    placeholderData: keepPreviousData,
    ...AUTO_REFETCH,
  });
}

/** The top file matches for the header's box. */
export function useSuggestions(q: string) {
  return useQuery({
    queryKey: viewKeys.suggestions(q),
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q, kind: "file", limit: String(SUGGESTION_LIMIT) });
      return api(`/api/search?${params.toString()}`, { schema: SearchResponse, signal });
    },
    enabled: q.length >= Q_MIN,
    ...AUTO_REFETCH,
  });
}
