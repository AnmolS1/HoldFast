// TanStack Query setup and the shell's own queries: the session, the public config and the
// deletion status. Loaders use `queryClient.fetchQuery`, components the hooks — one cache.
import { QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import { api, ApiError, cancelReauth, cancelTermsGate, configureApi } from "./api";
import { DeletionStatusShape, PublicConfig, runUserStatePurgers, SessionShape } from "./contracts";
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

// ---------------------------------------------------------------------------------------------
// Identity guard. The id of the account the client state in memory belongs to. It survives the
// session ending (so a re-authentication can be compared with it) and is forgotten only by an
// explicit purge.
let knownUserId: string | null = null;
// The address that goes with it: the re-auth dialog signs THAT account in again, and by the time
// it opens the session query may already hold `null` (the server now says "nobody" on the very
// first read after a session ends, not a minute later).
let knownUserEmail: string | null = null;

/** The account the in-memory state belongs to, or null when there is none. */
export function getKnownUserId(): string | null {
  return knownUserId;
}

/** The address of that account, for the re-auth dialog. Null when there is none. */
export function getKnownUserEmail(): string | null {
  return knownUserEmail;
}

const SESSION_KEY = "session";
const CONFIG_KEY = "public-config";

/**
 * Drop everything that belongs to the signed-in account: requests waiting behind the re-auth or
 * terms gate are discarded (never replayed), the whole query and mutation cache goes (the public
 * config stays — it is not user data), and every purger a feature registered runs. Called on
 * sign-out and on any identity change; `keepSession` is for the guard below, which runs while the
 * new session is being adopted.
 */
export async function purgeUserState(options: { keepSession?: boolean } = {}): Promise<void> {
  cancelReauth();
  cancelTermsGate();
  const userScoped = (key: readonly unknown[]) => key[0] !== CONFIG_KEY && key[0] !== SESSION_KEY;
  await queryClient.cancelQueries({ predicate: (query) => userScoped(query.queryKey) });
  queryClient.removeQueries({ predicate: (query) => userScoped(query.queryKey) });
  queryClient.getMutationCache().clear();
  if (!options.keepSession) {
    queryClient.setQueryData([SESSION_KEY], null);
    knownUserId = null;
    knownUserEmail = null;
  }
  await runUserStatePurgers();
}

/**
 * Every session answer passes through here. If it names a different account than the one the
 * client state belongs to, that state is purged BEFORE the new session becomes visible.
 * Returns whether the identity changed.
 */
export async function adoptIdentity(session: SessionShape): Promise<boolean> {
  const next = session?.user.id ?? null;
  if (next === null) return false; // signed out: the remembered id stays for a later comparison
  const changed = knownUserId !== null && knownUserId !== next;
  if (changed) await purgeUserState({ keepSession: true });
  knownUserId = next;
  knownUserEmail = session?.user.email ?? null;
  return changed;
}

/** Tests only. */
export function resetIdentityForTests(): void {
  knownUserId = null;
  knownUserEmail = null;
}

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
  await adoptIdentity(parsed.data);
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

/** Forget the session only (the account's state stays until `purgeUserState`). */
export function clearSession(): void {
  queryClient.setQueryData(sessionQuery.queryKey, null);
}

export type ReauthOutcome = "same" | "changed";

/**
 * After a sign-in inside the re-auth modal: is this the account whose session ended?
 * `expectedUserId` is the id remembered from the expired session. Unknown counts as changed.
 */
export async function confirmReauthIdentity(expectedUserId: string | null): Promise<ReauthOutcome> {
  const session = await refreshSession();
  const actual = session?.user.id ?? null;
  if (expectedUserId !== null && actual !== null && actual === expectedUserId) return "same";
  // A different (or unknown) account: nothing queued for the old one may run, and nothing of it
  // may remain. `adoptIdentity` has purged already when the ids differ; this covers "unknown".
  await purgeUserState({ keepSession: true });
  return "changed";
}

function connectApi(): void {
  configureApi({
    hadSession: () => Boolean(getCachedSession()),
    clearSession,
    patchConfig: (patch) => {
      queryClient.setQueryData(publicConfigQuery.queryKey, (current) =>
        current ? { ...current, ...patch } : current,
      );
    },
  });
}

connectApi();

/** Tests only: `resetApiForTests()` drops the registration above. */
export function reconnectApiForTests(): void {
  connectApi();
}
