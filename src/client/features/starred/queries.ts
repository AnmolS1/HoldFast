import { useInfiniteQuery } from "@tanstack/react-query";
import { StarredResponse } from "../../../shared/schemas/search";
import { api } from "../../lib/api";
import { viewKeys } from "./view-queries";
import { AUTO_REFETCH } from "./view-state";

/** `GET /api/starred`, a page at a time. */
export function useStarred() {
  return useInfiniteQuery({
    queryKey: viewKeys.starred,
    queryFn: ({ pageParam, signal }) =>
      api(`/api/starred${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`, {
        schema: StarredResponse,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    ...AUTO_REFETCH,
  });
}
