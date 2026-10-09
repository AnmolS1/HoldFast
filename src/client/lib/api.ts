// The one fetch wrapper for `/api/*`: same-origin credentials, zod parsing, the error envelope as
// a typed ApiError, and the cross-cutting status handling (re-auth, terms gate, suspension,
// impersonation, rate limits, kill switches).
//
// This module imports neither the router nor the query client: both register what the client
// needs through `configureApi`, which keeps the import graph acyclic.
import type { ZodType } from "zod";
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
}

const defaultEnvironment: ApiEnvironment = {
  hadSession: () => false,
  routeInfo: () => ({ public: false, auth: false }),
  navigate: () => {},
  currentPath: () =>
    typeof location === "undefined" ? "/" : location.pathname + location.search + location.hash,
  clearSession: () => {},
  patchConfig: () => {},
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

export interface ApiOptions<T> {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** A plain object is sent as JSON; a BodyInit (Blob, FormData, stream) is sent as it is. */
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Parses and types the response. Without it the parsed JSON is returned unchecked. */
  schema?: ZodType<T>;
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

async function toApiError(response: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = undefined;
  }
  if (!isEnvelope(body)) {
    return new ApiError({
      status: response.status,
      code: "http_error",
      message: t("toast.generic"),
      retryAfter,
    });
  }
  // The request id is kept in every case: it is what support uses to find the call.
  const requestId = typeof body.requestId === "string" ? body.requestId : undefined;
  if (isErrorCode(body.error)) {
    return new ApiError({
      status: response.status,
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
    status: response.status,
    code: body.error === INTERNAL_ERROR ? INTERNAL_ERROR : "http_error",
    message: t("toast.generic"),
    requestId,
    retryAfter,
  });
}

async function send(path: string, options: ApiOptions<unknown>): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json", ...options.headers };
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

/** Side effects of a failure that is not replayed. */
function react(error: ApiError): void {
  const reason = typeof error.details?.reason === "string" ? error.details.reason : undefined;
  if (error.status === 403 && reason === "account_suspended") {
    environment.clearSession();
    environment.navigate("/login?reason=suspended", { replace: true });
    return;
  }
  if (error.status === 403 && reason === "impersonation_read_only") {
    toast({ message: t("toast.impersonationReadOnly"), key: "impersonation" });
    return;
  }
  if (error.status === 429) {
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
    toast({ message: t("toast.readOnly"), key: "read-only" });
    return;
  }
  if (error.status === 503 && error.code === "feature_disabled") {
    if (reason === "uploads_disabled") {
      environment.patchConfig({ uploadsEnabled: false });
      toast({ message: t("toast.uploadsPaused"), key: "feature" });
    } else if (reason === "links_disabled") {
      environment.patchConfig({ linksEnabled: false });
      toast({ message: t("toast.linksPaused"), key: "feature" });
    } else {
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
  let replayed = false;
  for (;;) {
    const response = await send(path, options);
    if (response.ok) return readBody(response, options.schema);
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
    react(error);
    throw error;
  }
}

/** The standard error toast: the message, and the request id so support can find the call. */
export function toastApiError(error: unknown): void {
  if (error instanceof ApiError) {
    // These were already announced by `react`.
    if (error.status === 429 || error.status === 503) return;
    toast({ message: error.message, requestId: error.requestId });
    return;
  }
  toast({ message: t("toast.generic") });
}
