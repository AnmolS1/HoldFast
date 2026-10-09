// TanStack Query setup and the shell's own queries: the session, the public config and the
// deletion status. Loaders use `queryClient.fetchQuery`, components the hooks — one cache.
import { QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api, ApiError, configureApi } from "./api";
import { DeletionStatusShape, PublicConfig, SessionShape } from "./contracts";
import { t } from "./i18n";

export const STALE_MS = 15_000;

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        refetchOnWindowFocus: true,
        // A 4xx is an answer, not a blip: only network errors and 5xx get one more try.
        retry: (failures, error) =>
          failures < 1 && !(error instanceof ApiError && error.status >= 400 && error.status < 500),
      },
      mutations: { retry: false },
    },
  });
}

export const queryClient = createQueryClient();

/**
 * The session comes from Better Auth's own endpoint, read directly: the answer is `null` when
 * signed out. The path is under `/api/auth/`, so it can never raise the re-auth modal.
 */
async function fetchSession(): Promise<SessionShape> {
  let response: Response;
  try {
    response = await fetch("/api/auth/get-session", {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
  } catch {
    throw new ApiError({ status: 0, code: "network", message: t("empty.unavailable.body") });
  }
  if (!response.ok) {
    throw new ApiError({ status: response.status, code: "http_error", message: t("toast.generic") });
  }
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError({ status: response.status, code: "invalid_response", message: t("toast.generic") });
  }
  const parsed = SessionShape.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({ status: response.status, code: "invalid_response", message: t("toast.generic") });
  }
  return parsed.data;
}

export const sessionQuery = queryOptions({ queryKey: ["session"] as const, queryFn: fetchSession });

export const publicConfigQuery = queryOptions({
  queryKey: ["public-config"] as const,
  queryFn: () => api("/api/public/config", { schema: PublicConfig }),
  staleTime: 60_000,
});

export const deletionStatusQuery = queryOptions({
  queryKey: ["deletion-status"] as const,
  queryFn: () => api("/api/account/deletion-status", { schema: DeletionStatusShape }),
});

export function useSession() {
  return useQuery(sessionQuery);
}

export function usePublicConfig() {
  return useQuery(publicConfigQuery);
}

/** The cached session, without fetching. */
export function getCachedSession(): SessionShape | undefined {
  return queryClient.getQueryData(sessionQuery.queryKey);
}

/** Re-read the session now (after sign-in, accept-terms, cancel-deletion, …). */
export async function refreshSession(): Promise<SessionShape> {
  await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey, refetchType: "none" });
  return queryClient.fetchQuery({ ...sessionQuery, staleTime: 0 });
}

export function clearSession(): void {
  queryClient.setQueryData(sessionQuery.queryKey, null);
}

configureApi({
  hadSession: () => Boolean(getCachedSession()),
  clearSession,
  patchConfig: (patch) => {
    queryClient.setQueryData(publicConfigQuery.queryKey, (current) => (current ? { ...current, ...patch } : current));
  },
});
