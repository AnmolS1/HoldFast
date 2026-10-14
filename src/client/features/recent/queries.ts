import { useQuery } from "@tanstack/react-query";
import { RecentResponse } from "../../../shared/schemas/search";
import { api } from "../../lib/api";
import { viewKeys } from "../starred/view-queries";
import { AUTO_REFETCH } from "../starred/view-state";

/** The most the API gives: Recent is one list, not paged. */
export const RECENT_LIMIT = 50;

/** `GET /api/recent`. `fetchedAt` is the "now" the answer is grouped against. */
export function useRecent() {
  return useQuery({
    queryKey: viewKeys.recent,
    queryFn: async ({ signal }) => {
      const answer = await api(`/api/recent?limit=${RECENT_LIMIT}`, { schema: RecentResponse, signal });
      return { items: answer.items, fetchedAt: Date.now() };
    },
    ...AUTO_REFETCH,
  });
}
