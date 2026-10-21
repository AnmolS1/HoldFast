// TanStack Query setup and the shell's own queries: the session, the public config and the
// deletion status. Loaders use `queryClient.fetchQuery`, components the hooks — one cache.
import {
  hashKey,
  QueryClient,
  queryOptions,
  useQuery,
  type DefaultOptions,
  type QueryKey,
} from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { api, ApiError, cancelReauth, cancelTermsGate, configureApi } from "./api";
import { DeletionStatusShape, PublicConfig, runUserStatePurgers, SessionShape } from "./contracts";
import { t } from "./i18n";

export const STALE_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// Retry-After. Every wait the API named, in ONE place, per query hash (or a key of a caller's
// own, e.g. a batch): until when that query must not be asked again. Not in the query cache: any
// write to the cache (an emptied trash, a row taken out after a restore) clears a query's error,
// and a wait read from the error would go with it. A wait goes only when its time has passed, or
// with the account (`purgeUserState`).

const waits = new Map<string, number>();
const waitListeners = new Set<() => void>();

const subscribeWaits = (listener: () => void) => {
  waitListeners.add(listener);
  return () => waitListeners.delete(listener);
};

function emitWaits(): void {
  for (const listener of waitListeners) listener();
}

/**
 * Until when the API asked not to be called again: a failure that came with `Retry-After` (a
 * `429`, a `503`) names a number of seconds. 0 = no wait.
 */
export function retryNotBefore(error: unknown, since: number): number {
  return error instanceof ApiError && error.retryAfter !== undefined ? since + error.retryAfter * 1000 : 0;
}

/** Record a wait for this hash (a query's `queryHash`) ending at `until` (ms). A longer one stays. */
export function holdUntil(hash: string, until: number): void {
  if (until <= Date.now() || (waits.get(hash) ?? 0) >= until) return;
  waits.set(hash, until);
  emitWaits();
}

/** Until when (ms) this hash must wait; 0 when it need not (a wait that has passed is dropped). */
export function waitUntil(hash: string): number {
  const until = waits.get(hash) ?? 0;
  if (until === 0) return 0;
  if (until > Date.now()) return until;
  waits.delete(hash);
  return 0;
}

/** The hash a query key is held under: the same as the query's `queryHash`. */
export const waitKey = (key: QueryKey): string => hashKey(key);

/** The end of this hash's wait, re-read when a wait is recorded (pair with a timer of its own). */
export function useWaitUntil(hash: string): number {
  return useSyncExternalStore(
    subscribeWaits,
    () => waitUntil(hash),
    () => 0,
  );
}

/** Forget every wait. Run by `purgeUserState()` and by tests. */
export function clearWaits(): void {
  waits.clear();
  emitWaits();
}

/** What `refetchOn…` options and an invalidation's predicate are handed: a query of the cache. */
export interface CachedQuery {
  queryHash: string;
}

/**
 * Is this query inside a wait the API named? While it is, NOTHING refreshes it by itself: not the
 * tab coming back, not a reconnect, not a remount, not the load an errored query without data gets
 * on mount. (After the wait, the next such trigger does.)
 */
export function isHeld(query: CachedQuery): boolean {
  return waitUntil(query.queryHash) > 0;
}

export const unlessHeld = (query: CachedQuery): boolean => !isHeld(query);

/**
 * The client's defaults. Every automatic refetch asks `isHeld` first — `retryOnMount` too: a
 * query in the error state with NO data is loaded on mount without asking `refetchOnMount`
 * (query-core `shouldLoadOnMount`), so a list whose FIRST read drew a `429` would otherwise be read
 * again on every visit inside the wait.
 */
export const QUERY_DEFAULTS = {
  queries: {
    staleTime: STALE_MS,
    refetchOnWindowFocus: unlessHeld,
    refetchOnReconnect: unlessHeld,
    refetchOnMount: unlessHeld,
    retryOnMount: unlessHeld,
    // A 4xx is an answer, not a blip: only network errors and 5xx get one more try — and not one
    // that named a wait (a `503` with `Retry-After`): that wait is honoured, not retried through.
    retry: (failures: number, error: unknown) =>
      failures < 1 &&
      !(error instanceof ApiError && error.status >= 400 && error.status < 500) &&
      retryNotBefore(error, 0) === 0,
  },
  mutations: { retry: false },
} satisfies DefaultOptions;

export function createQueryClient(): QueryClient {
  const client = new QueryClient({ defaultOptions: QUERY_DEFAULTS });
  // Every failure of a query — a first read, a refresh, a next page — that names a wait goes into
  // the registry, where no later write to the cache can lift it.
  client.getQueryCache().subscribe((event) => {
    if (event.type === "updated" && event.action.type === "error") {
      holdUntil(event.query.queryHash, retryNotBefore(event.action.error, Date.now()));
    }
  });
  return client;
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
let epoch = 0;

/**
 * A number that changes every time the account's state is purged (sign-out, a different
 * identity). Work that outlives its request — a rollback after a failed save, an Undo, a toast, a
 * poll — reads it when it STARTS and checks `sameAccount(then)` before it writes to the query
 * cache or shows anything: a request that fails after the purge must not put the previous
 * account's rows back into a cache the next account reads.
 */
export function accountEpoch(): number {
  return epoch;
}

/** Whether no purge has happened since `then` (a value of `accountEpoch()`). */
export function sameAccount(then: number): boolean {
  return then === epoch;
}

export async function purgeUserState(options: { keepSession?: boolean } = {}): Promise<void> {
  // First: from here on nothing started earlier may write.
  epoch += 1;
  cancelReauth();
  cancelTermsGate();
  const userScoped = (key: readonly unknown[]) => key[0] !== CONFIG_KEY && key[0] !== SESSION_KEY;
  await queryClient.cancelQueries({ predicate: (query) => userScoped(query.queryKey) });
  queryClient.removeQueries({ predicate: (query) => userScoped(query.queryKey) });
  queryClient.getMutationCache().clear();
  clearWaits();
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
    userId: getKnownUserId,
    // The API refused a request: the browser's session is another account now (another tab).
    identityChanged: async () => {
      await purgeUserState({ keepSession: true });
      await refreshSession();
    },
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
