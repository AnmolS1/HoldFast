// The console's reads: TanStack Query with no automatic refetch at all — a screen is read when it
// is opened and when the admin presses Refresh (standing check (c)).
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { ON_DEMAND } from "./api";

export function useAdminQuery<T>(queryKey: QueryKey, queryFn: (signal: AbortSignal) => Promise<T>) {
  return useQuery({
    queryKey,
    queryFn: ({ signal }) => queryFn(signal),
    ...ON_DEMAND,
    staleTime: 0,
    retry: false,
  });
}
