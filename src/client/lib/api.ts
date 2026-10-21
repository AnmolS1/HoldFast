// The one fetch wrapper for `/api/*`: same-origin credentials, zod parsing, the error envelope as
// a typed ApiError, and the cross-cutting status handling (re-auth, terms gate, suspension,
// impersonation, rate limits, kill switches).
//
// This module imports neither the router nor the query client: both register what the client
// needs through `configureApi`, which keeps the import graph acyclic.
import type { ZodType } from "zod";
import { HEADER_USER } from "../../shared/constants";
import { toast } from "../components/Toaster/store";
import { INTERNAL_ERROR, isErrorCode, type ErrorCode } from "./contracts";
import { t } from "./i18n";

/**
 * `ErrorCode` is what the server's table can answer. The rest are the client's own:
 *  - `internal`          the server's 500 envelope (`{ error: "internal" }`) — deliberately outside the table
 *  - `network`           the request never got an answer
 *  - `invalid_response`  a 2xx whose body is not what the schema says
 *  - `http_error`        a failure with no envelope, or with a code this build does not know
 */
export type ApiErrorCode = ErrorCode | typeof INTERNAL_ERROR | "network" | "invalid_response" | "http_error";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string | undefined;
  readonly details: Record<string, unknown> | undefined;
  /** Seconds, from `Retry-After`. */
  readonly retryAfter: number | undefined;

  constructor(init: {
    status: number;
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    details?: Record<string, unknown>;
    retryAfter?: number;
  }) {
    super(init.message);
    this.name = "ApiError";
    this.status = init.status;
    this.code = init.code;
    this.requestId = init.requestId;
    this.details = init.details;
    this.retryAfter = init.retryAfter;
  }
}

export interface RouteInfo {
  /** The current route is marked `handle.public` (public link page, /dmca, …). */
  public: boolean;
  /** The current route is an auth screen (`handle.auth`). */
  auth: boolean;
}

export interface ApiEnvironment {
  /** Was a signed-in session known when the request STARTED? */
  hadSession(): boolean;
  routeInfo(): RouteInfo;
  navigate(to: string, options?: { replace?: boolean }): void;
  /** Path + search + hash of the current location. */
  currentPath(): string;
  /** Forget the session locally (suspension). */
  clearSession(): void;
  /** Reflect a kill switch learned from a 503 into the cached public config. */
  patchConfig(patch: { readOnly?: boolean; uploadsEnabled?: boolean; linksEnabled?: boolean }): void;
  /** The account the client's state belongs to (sent as `X-Holdfast-User`), or null. */
  userId(): string | null;
  /**
   * The browser is signed in to another account than the one this client's state belongs to
   * (the API refused a request with `identity_mismatch`): purge, and adopt the account the
   * session now names. The API client then starts again at `/`.
   */
  identityChanged(): Promise<void>;
  /** Load the app again from `to` (a full page load): what is left when the session cannot be read. */
  reload(to: string): void;
}

const defaultEnvironment: ApiEnvironment = {
  hadSession: () => false,
  routeInfo: () => ({ public: false, auth: false }),
  navigate: () => {},
  currentPath: () =>
    typeof location === "undefined" ? "/" : location.pathname + location.search + location.hash,
  clearSession: () => {},
  patchConfig: () => {},
  userId: () => null,
  identityChanged: async () => {},
  reload: (to) => {
    if (typeof window !== "undefined") window.location.assign(to);
  },
};

let environment: ApiEnvironment = { ...defaultEnvironment };

export function configureApi(patch: Partial<ApiEnvironment>): void {
  environment = { ...environment, ...patch };
}

/** Tests only: back to the inert defaults and no pending gates. */
export function resetApiForTests(): void {
  environment = { ...defaultEnvironment };
  reauth = null;
  terms = null;
  adopting = null;
  emitGates();
}

// ---------------------------------------------------------------------------------------------
// The 401 rule (plan §10: "401 means no session, and nothing else").

export interface ReauthInput {
  status: number;
  code: string | undefined;
  /** Request URL or path. */
  path: string;
  hadSession: boolean;
  route: RouteInfo;
}

function pathnameOf(path: string): string {
  try {
    return new URL(path, "http://app.invalid").pathname;
  } catch {
    return path;
  }
}

/**
 * Re-authentication opens only when ALL four hold: a 401 `unauthorized`; a path under `/api/`
 * that is neither `/api/public/*` nor `/api/auth/*`; a session existed when the request was
 * made; and the current route is neither public nor an auth screen. So a wrong password, any
 * Better Auth answer, and anything on a public link page can never open the modal.
 */
export function shouldReauth(input: ReauthInput): boolean {
  if (input.status !== 401 || input.code !== "unauthorized") return false;
  const pathname = pathnameOf(input.path);
  if (!pathname.startsWith("/api/")) return false;
  if (pathname.startsWith("/api/public/") || pathname.startsWith("/api/auth/")) return false;
  if (!input.hadSession) return false;
  if (input.route.public || input.route.auth) return false;
  return true;
}

// ---------------------------------------------------------------------------------------------
// Gates: one shared pending promise each, so concurrent failures open one modal and all replay.

interface Gate {
  promise: Promise<void>;
  resolve(): void;
  reject(reason: unknown): void;
}

function createGate(): Gate {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // A gate nobody is waiting on any more must not surface as an unhandled rejection.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

let reauth: Gate | null = null;
let terms: Gate | null = null;
const gateListeners = new Set<() => void>();

function emitGates(): void {
  for (const listener of gateListeners) listener();
}

export function subscribeGates(listener: () => void): () => void {
  gateListeners.add(listener);
  return () => gateListeners.delete(listener);
}

export const AUTH_EXPIRED_EVENT = "auth:expired";
export const AUTH_RESTORED_EVENT = "auth:restored";

function announce(name: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name));
}

export function isReauthPending(): boolean {
  return reauth !== null;
}

function waitForReauth(): Promise<void> {
  if (!reauth) {
    reauth = createGate();
    emitGates();
    announce(AUTH_EXPIRED_EVENT);
  }
  return reauth.promise;
}

/** The re-auth modal calls this after a successful sign-in: every waiting request replays. */
export function completeReauth(): void {
  const gate = reauth;
  if (!gate) return;
  reauth = null;
  emitGates();
  announce(AUTH_RESTORED_EVENT);
  gate.resolve();
}

/** The user gave up (signed out instead): every waiting request fails with its 401. */
export function cancelReauth(): void {
  const gate = reauth;
  if (!gate) return;
  reauth = null;
  emitGates();
  gate.reject(new ApiError({ status: 401, code: "unauthorized", message: t("reauth.title") }));
}

export function isTermsPending(): boolean {
  return terms !== null;
}

function waitForTerms(): Promise<void> {
  if (!terms) {
    terms = createGate();
    emitGates();
    environment.navigate(`/accept-terms?next=${encodeURIComponent(environment.currentPath())}`);
  }
  return terms.promise;
}

/** The terms screen calls this after `accept-terms` succeeded: every waiting request replays. */
export function completeTermsGate(): void {
  const gate = terms;
  if (!gate) return;
  terms = null;
  emitGates();
  gate.resolve();
}

export function cancelTermsGate(): void {
  const gate = terms;
  if (!gate) return;
  terms = null;
  emitGates();
  gate.reject(new ApiError({ status: 403, code: "terms_required", message: t("terms.title") }));
}

// ---------------------------------------------------------------------------------------------
// The identity pin (W2S4). The session cookie is the browser's, shared by every tab: another tab
// signing in as someone else changes who THIS tab's next request runs as. Each request names the
// account this client's state belongs to; the API refuses one whose session is another account
// (403 forbidden, `identity_mismatch`, src/worker/middleware/identity-pin.ts), and the client then
// adopts the account the browser is signed in as — the request is never replayed.

/** The header name (src/shared/constants.ts), as `Headers` spells it. */
export const IDENTITY_HEADER = HEADER_USER.toLowerCase();

/**
 * Where the pin is sent: every `/api/*` path but `/api/public/*` (nothing there acts for an
 * account). Under `/api/auth/*` the Worker itself leaves the identity endpoints unpinned.
 */
function pinned(path: string): boolean {
  const pathname = pathnameOf(path);
  return pathname.startsWith("/api/") && !pathname.startsWith("/api/public/");
}

/** The account this client's state belongs to now (what `api()` captures when a call starts). */
export function currentAccount(): string | null {
  return environment.userId();
}

/** For a request made outside `api()` (the upload bodies): the header for `account`. */
export function identityHeaders(account: string | null = environment.userId()): Record<string, string> {
  return account === null ? {} : { [IDENTITY_HEADER]: account };
}

export function isIdentityMismatch(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403 && error.details?.reason === "identity_mismatch";
}

let adopting: Promise<void> | null = null;

/**
 * Once, however many requests were refused at the same time: purge, adopt, start again at `/`.
 * When the session cannot be read, the app is loaded again from `/` instead: the account it
 * remembers would still be the old one, and every request made for it would be refused again —
 * and adopted again — without end.
 */
function adoptBrowserIdentity(): void {
  if (adopting) return;
  adopting = environment
    .identityChanged()
    .then(
      () => environment.navigate("/", { replace: true }),
      () => environment.reload("/"),
    )
    .finally(() => {
      adopting = null;
    });
}

/**
 * A refusal as another account's, for the account the request was SENT for. Adopted only when this
 * tab still holds that account: a request made for the previous account whose refusal arrives
 * after the tab has already moved on (a session re-read adopted the new one) is dropped quietly —
 * adopting again would purge the account the tab holds now. Returns whether it adopted.
 */
export function noteIdentityMismatch(error: unknown, sentFor: string | null): boolean {
  if (!isIdentityMismatch(error)) return false;
  if (sentFor === null || sentFor !== environment.userId()) return false;
  adoptBrowserIdentity();
  return true;
}

// ---------------------------------------------------------------------------------------------

export interface ApiOptions<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A plain object is sent as JSON; a BodyInit (Blob, FormData, stream) is sent as it is. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Parses and types the response. Without it the parsed JSON is returned unchecked. */
  schema?: ZodType<T>;
  /**
   * The caller wants no body: any 2xx resolves to `undefined` without reading it (a `202` that
   * may or may not carry one). A failure is read and thrown as usual.
   */
  empty?: boolean;
  /**
   * Codes this caller announces itself: no toast is shown for them (their other side effects
   * still happen, and the error is thrown as usual). E.g. the uploader says "Daily upload limit
   * reached" in its ribbon, so its init passes `["ceiling_exceeded"]`.
   */
  silent?: readonly ApiErrorCode[];
}

function isBodyInit(body: unknown): body is BodyInit {
  return (
    typeof body === "string" ||
    body instanceof Blob ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    (typeof FormData !== "undefined" && body instanceof FormData) ||
    (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) ||
    (typeof ReadableStream !== "undefined" && body instanceof ReadableStream)
  );
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.ceil(seconds));
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Anything shaped like the server's envelope; `error` is not yet known to be a code we know. */
type RawEnvelope = { error: string; message: string; requestId?: unknown; details?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnvelope(value: unknown): value is RawEnvelope {
  return isRecord(value) && typeof value.error === "string" && typeof value.message === "string";
}

/** A failed answer as its parts: what `apiErrorOf` reads (an XMLHttpRequest has no `Response`). */
export interface FailedAnswer {
  status: number;
  /** The body as text; `undefined`/`null` when there was none. */
  body?: string | null;
  /** The raw `Retry-After` header, when there was one. */
  retryAfter?: string | null;
}

function parseJsonText(text: string | null | undefined): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The error envelope (or its absence) as a typed ApiError; `fallback` is the client's own words. */
function errorFrom(
  status: number,
  body: unknown,
  retryAfter: number | undefined,
  fallback: string,
): ApiError {
  if (!isEnvelope(body)) {
    return new ApiError({ status, code: "http_error", message: fallback, retryAfter });
  }
  // The request id is kept in every case: it is what support uses to find the call.
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  if (isErrorCode(body.error)) {
    return new ApiError({
      status,
      code: body.error,
      message: body.message,
      requestId,
      details: isRecord(body.details) ? body.details : undefined,
      retryAfter,
    });
  }
  // An unexpected failure (`500 internal`), or a code newer than this build: a generic failure
  // in the client's own words — the server's text for these says nothing a user can act on.
  return new ApiError({
    status,
    code: body.error === INTERNAL_ERROR ? INTERNAL_ERROR : "http_error",
    message: fallback,
    requestId,
    retryAfter,
  });
}

/**
 * A failed answer read some other way than `fetch` (the upload bodies go through
 * XMLHttpRequest): the same ApiError `api()` would have thrown. `fallback` is the message when
 * the server's own text is not shown (no envelope, `internal`, a code this build does not know).
 */
export function apiErrorOf(answer: FailedAnswer, fallback: string = t("toast.generic")): ApiError {
  return errorFrom(
    answer.status,
    parseJsonText(answer.body),
    parseRetryAfter(answer.retryAfter ?? null),
    fallback,
  );
}

/** A failed `Response` as the ApiError `api()` throws for it. The response's body is not consumed. */
export async function toApiError(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  return errorFrom(
    response.status,
    body,
    parseRetryAfter(response.headers.get("retry-after")),
    t("toast.generic"),
  );
}

async function send(path: string, options: ApiOptions<unknown>, userId: string | null): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
  if (userId !== null && pinned(path)) headers[IDENTITY_HEADER] = userId;
  let body: BodyInit | undefined;
  if (options.body !== undefined && options.body !== null) {
    if (isBodyInit(options.body)) {
      body = options.body;
    } else {
      body = JSON.stringify(options.body);
      headers["content-type"] ??= "application/json";
    }
  }
  try {
    return await fetch(path, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      headers,
      body,
      signal: options.signal,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
    throw new ApiError({ status: 0, code: "network", message: t("empty.unavailable.body") });
  }
}

async function readBody<T>(response: Response, schema: ZodType<T> | undefined): Promise<T> {
  if (response.status === 204 || response.headers.get("content-length") === "0") return undefined as T;
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new ApiError({ status: response.status, code: "invalid_response", message: t("toast.generic") });
  }
  if (!schema) return json as T;
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    throw new ApiError({ status: response.status, code: "invalid_response", message: t("toast.generic") });
  }
  return parsed.data;
}

/** "45 min", "1 h 30 min", "30 s": how long until a limit resets. */
function waitWords(seconds: number): string {
  if (seconds < 60) return t("time.seconds", { count: Math.max(1, seconds) });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("time.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? t("time.hours", { count: hours }) : t("time.hoursMinutes", { hours, minutes: rest });
}

/** Side effects of a failure that is not replayed. `silent`: codes whose toast the caller shows. */
function react(error: ApiError, silent: readonly ApiErrorCode[], sentFor: string | null): void {
  const quiet = silent.includes(error.code);
  if (isIdentityMismatch(error)) {
    noteIdentityMismatch(error, sentFor);
    return;
  }
  const reason = typeof error.details?.reason === "string" ? error.details.reason : undefined;
  if (error.status === 403 && reason === "account_suspended") {
    environment.clearSession();
    environment.navigate("/login?reason=suspended", { replace: true });
    return;
  }
  if (error.status === 403 && reason === "impersonation_read_only") {
    if (!quiet) toast({ message: t("toast.impersonationReadOnly"), key: "impersonation" });
    return;
  }
  // A daily limit, not "too many requests": it resets at 00:00 UTC (the Retry-After says when).
  if (error.status === 429 && error.code === "ceiling_exceeded") {
    if (quiet) return;
    toast({
      message:
        error.retryAfter === undefined
          ? t("toast.ceilingReached")
          : t("toast.ceilingReachedIn", { wait: waitWords(error.retryAfter) }),
      requestId: error.requestId,
      key: "rate",
    });
    return;
  }
  if (error.status === 429) {
    if (quiet) return;
    toast({
      message:
        error.retryAfter === undefined
          ? t("toast.rateLimitedSoon")
          : t("toast.rateLimited", { seconds: error.retryAfter }),
      requestId: error.requestId,
      key: "rate",
    });
    return;
  }
  if (error.status === 503 && error.code === "read_only") {
    environment.patchConfig({ readOnly: true });
    if (!quiet) toast({ message: t("toast.readOnly"), key: "read-only" });
    return;
  }
  if (error.status === 503 && error.code === "feature_disabled") {
    if (reason === "uploads_disabled") {
      environment.patchConfig({ uploadsEnabled: false });
      if (!quiet) toast({ message: t("toast.uploadsPaused"), key: "feature" });
    } else if (reason === "links_disabled") {
      environment.patchConfig({ linksEnabled: false });
      if (!quiet) toast({ message: t("toast.linksPaused"), key: "feature" });
    } else if (!quiet) {
      toast({ message: t("toast.featurePaused"), key: "feature" });
    }
  }
}

/**
 * Call the API. Rejects with ApiError (or the caller's AbortError). A 401 or `terms_required`
 * that qualifies waits for the user and then replays the request once.
 */
export async function api<T = unknown>(path: string, options: ApiOptions<T> = {}): Promise<T> {
  // Captured before the request leaves: a session that ends while it is in flight still counts.
  const hadSession = environment.hadSession();
  // The account this request is made for — the same on a replay after re-auth.
  const userId = environment.userId();
  let replayed = false;
  for (;;) {
    const response = await send(path, options, userId);
    if (response.ok) {
      if (options.empty) {
        // Not read: release the connection's body without parsing it.
        void response.body?.cancel().catch(() => {});
        return undefined as T;
      }
      return readBody(response, options.schema);
    }
    const error = await toApiError(response);
    if (!replayed) {
      if (
        shouldReauth({
          status: error.status,
          code: error.code,
          path,
          hadSession,
          route: environment.routeInfo(),
        })
      ) {
        await waitForReauth();
        replayed = true;
        continue;
      }
      if (error.status === 403 && error.code === "terms_required" && !environment.routeInfo().public) {
        await waitForTerms();
        replayed = true;
        continue;
      }
    }
    react(error, options.silent ?? [], userId);
    throw error;
  }
}

/** The standard error toast: the message, and the request id so support can find the call. */
export function toastApiError(error: unknown): void {
  if (error instanceof ApiError) {
    // These were already announced by `react`; an identity change says nothing (the page starts
    // again as the account the browser is signed in as).
    if (error.status === 429 || error.status === 503 || isIdentityMismatch(error)) return;
    toast({ message: error.message, requestId: error.requestId });
    return;
  }
  toast({ message: t("toast.generic") });
}
