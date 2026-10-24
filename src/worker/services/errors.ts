// The one error type routes throw, and the one envelope clients get.
//
//   throw new AppError("not_found");
//   throw new AppError("forbidden", "This account is suspended.", { reason: "account_suspended" });
//
// The status comes from the table in src/shared/errors.ts — never pass one. `401 unauthorized`
// has a single meaning (no session) and is produced only by `requireUser` — and by the session
// middleware for a write under /api/auth/* from an account whose deletion date has passed (that
// session does not exist either).
// A response never carries a stack trace, SQL text or an upstream error message.
//
// The query helpers (src/worker/db/**) cannot import this file — they also run under plain Node —
// so they throw `QueryError`, which carries the same shared code. The handlers below answer it
// exactly as they answer an `AppError`. `LegalHoldError` is deliberately NOT mapped: a hold must
// never be disclosed, so one that escapes a route is an unexpected failure (500, reported).

import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { ZodError } from "zod";
import {
  ERROR_STATUS,
  INTERNAL_ERROR,
  isErrorCode,
  type ErrorCode,
  type ErrorEnvelope,
  type InternalErrorEnvelope,
} from "../../shared/errors";
import { asQueryError, QueryError } from "../db/errors";
import { captureError } from "../sentry";
import { writeMetric } from "./metrics";
import type { AppEnv } from "./request-context";

const DEFAULT_MESSAGE: Record<ErrorCode, string> = {
  validation: "The request is not valid.",
  unauthorized: "Sign in to continue.",
  forbidden: "You do not have access to this.",
  terms_required: "Accept the current Terms to continue.",
  admin_requires_2fa: "Admin actions need two-factor authentication.",
  second_factor_required: "Confirm your two-factor code to continue.",
  second_factor_throttled: "Too many wrong codes. Wait a while and try again.",
  scan_blocked: "This file is blocked.",
  not_found: "Not found.",
  conflict: "That conflicts with the current state.",
  scan_pending: "This file is still being scanned.",
  quota_exceeded: "Storage quota exceeded.",
  file_too_large: "The file is too large.",
  ceiling_exceeded: "Daily limit reached.",
  rate_limited: "Too many requests. Try again shortly.",
  invalid_token: "The link is not valid.",
  password_required: "A password is required.",
  link_expired: "This link has expired.",
  link_paused: "This link is not available right now.",
  read_only: "Holdfast is read-only right now.",
  feature_disabled: "This feature is switched off right now.",
  scanner_starting: "The virus scanner is starting up. Try again in a minute.",
  body_too_large: "The request is too large.",
  deletion_admin_scheduled: "This deletion was scheduled by an admin and cannot be cancelled here.",
  self_action: "You cannot do this to your own account.",
  last_admin: "This would leave no admin.",
  not_quarantined: "This item is not in quarantine.",
  replace_in_progress: "A new version of this file is still being uploaded.",
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: (typeof ERROR_STATUS)[ErrorCode];
  readonly details?: Record<string, unknown>;
  /** Extra response headers (`Retry-After`). */
  readonly headers?: Record<string, string>;

  constructor(
    code: ErrorCode,
    message?: string,
    details?: Record<string, unknown>,
    headers?: Record<string, string>,
  ) {
    super(message ?? DEFAULT_MESSAGE[code]);
    this.name = "AppError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
    this.headers = headers;
  }
}

/** Validation issues an error answer names; the rest are only counted (R1 secweb-n6). */
export const MAX_ECHOED_ISSUES = 20;

/**
 * The `details` of a `400 validation` for zod's issues: the first `MAX_ECHOED_ISSUES` of them,
 * and how many there were — an answer never grows with the input it refuses.
 */
export function validationDetails(issues: ZodError["issues"]): {
  issues: { path: string; message: string }[];
  issueCount: number;
} {
  return {
    issues: issues
      .slice(0, MAX_ECHOED_ISSUES)
      .map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    issueCount: issues.length,
  };
}

function requestIdOf(c: Context<AppEnv>): string {
  return c.get("requestId") ?? "unknown";
}

/** The JSON envelope for an `AppError`. */
export function errorResponse(c: Context<AppEnv>, error: AppError): Response {
  const body: ErrorEnvelope = { error: error.code, message: error.message, requestId: requestIdOf(c) };
  if (error.details) body.details = error.details;
  return Response.json(body, { status: error.status, headers: error.headers });
}

function fromHttpException(error: HTTPException): AppError | null {
  switch (error.status) {
    case 400:
      return new AppError("validation");
    case 401:
      return new AppError("unauthorized");
    case 403:
      return new AppError("forbidden");
    case 404:
      return new AppError("not_found");
    case 409:
      return new AppError("conflict");
    case 413:
      return new AppError("file_too_large");
    case 429:
      return new AppError("rate_limited");
    default:
      return null;
  }
}

/** A query helper's failure as the route-level error: same code, same details. */
function fromQueryError(error: QueryError): AppError | null {
  // The code is typed, but the class is also built by code this module does not own: a value
  // outside the table is an unexpected failure, not a status picked from thin air.
  if (!isErrorCode(error.code)) return null;
  // A helper that gave no message has its code as the message; the caller gets the default text.
  const message = error.message === error.code ? undefined : error.message;
  return new AppError(error.code, message, error.details);
}

function asAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  // Also the QueryError a statement threw INSIDE Drizzle (wrapped as `cause`), and a NUL Postgres
  // refused (db/errors.ts#asQueryError).
  const query = asQueryError(error);
  if (query) return fromQueryError(query);
  if (error instanceof ZodError) {
    return new AppError("validation", undefined, validationDetails(error.issues));
  }
  if (error instanceof HTTPException) return fromHttpException(error);
  return null;
}

function reportUnexpected(c: Context<AppEnv>, error: unknown): void {
  let route = "";
  try {
    route = routePath(c);
  } catch {
    route = "";
  }
  captureError(error, { requestId: requestIdOf(c), route });
  writeMetric(c.env, "error", { kind: "unhandled", route });
}

/** `app.onError` of the app host: always the JSON envelope. */
export function handleError(error: unknown, c: Context<AppEnv>): Response {
  const known = asAppError(error);
  if (known) {
    // A deliberate 503 (a kill switch) is counted, not reported: it is not a fault.
    if (known.status >= 500) writeMetric(c.env, "error", { kind: "refused", reason: known.code });
    return errorResponse(c, known);
  }
  reportUnexpected(c, error);
  const body: InternalErrorEnvelope = {
    error: INTERNAL_ERROR,
    message: "Something went wrong.",
    requestId: requestIdOf(c),
  };
  return Response.json(body, { status: 500 });
}

/** `app.onError` of the files host: plain text only, never JSON. */
export function handlePlainError(error: unknown, c: Context<AppEnv>): Response {
  const known = asAppError(error);
  const headers = new Headers({ "content-type": "text/plain; charset=utf-8" });
  if (known) {
    for (const [name, value] of Object.entries(known.headers ?? {})) headers.set(name, value);
    return new Response(`${known.message}\n`, { status: known.status, headers });
  }
  reportUnexpected(c, error);
  return new Response("Something went wrong.\n", { status: 500, headers });
}
