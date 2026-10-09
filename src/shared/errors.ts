// The error vocabulary shared by the Worker and the SPA. The code → status table is the single
// source; PLAN §10 mirrors it. Compiled for both the browser and the Worker: no runtime-specific
// imports here.

export type ErrorCode =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "terms_required"
  | "admin_requires_2fa"
  | "scan_blocked"
  | "not_found"
  | "conflict"
  | "scan_pending"
  | "quota_exceeded"
  | "file_too_large"
  | "ceiling_exceeded"
  | "rate_limited"
  | "invalid_token"
  | "password_required"
  | "link_expired"
  | "link_paused"
  | "read_only"
  | "feature_disabled";

/** HTTP status of every error code. 401 has one meaning only: the session is missing or expired. */
export const ERROR_STATUS = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  terms_required: 403,
  admin_requires_2fa: 403,
  scan_blocked: 403,
  not_found: 404,
  conflict: 409,
  scan_pending: 409,
  quota_exceeded: 413,
  file_too_large: 413,
  ceiling_exceeded: 429,
  rate_limited: 429,
  invalid_token: 403,
  password_required: 403,
  link_expired: 410,
  link_paused: 423,
  read_only: 503,
  feature_disabled: 503,
} as const satisfies Record<ErrorCode, number>;

export type ErrorEnvelope = {
  error: ErrorCode;
  message: string;
  requestId: string;
  details?: Record<string, unknown>;
};

/**
 * What an unexpected failure answers with (status 500). It is deliberately outside `ErrorCode`:
 * no route ever chooses it, and the table above stays the list of codes a caller can act on.
 */
export const INTERNAL_ERROR = "internal";

export type InternalErrorEnvelope = {
  error: typeof INTERNAL_ERROR;
  message: string;
  requestId: string;
};

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(ERROR_STATUS, value);
}
