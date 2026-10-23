// The error vocabulary shared by the Worker and the SPA. The code → status table is the single
// source; PLAN §10 mirrors it. Compiled for both the browser and the Worker: no runtime-specific
// imports here.

export type ErrorCode =
  | "validation"
  | "unauthorized"
  | "forbidden"
  | "terms_required"
  | "admin_requires_2fa"
  | "second_factor_required"
  | "second_factor_throttled"
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
  | "feature_disabled"
  | "scanner_starting"
  | "body_too_large"
  | "deletion_admin_scheduled"
  | "self_action"
  | "last_admin"
  | "not_quarantined"
  | "replace_in_progress"
  | "already_taken_down"
  | "not_taken_down"
  | "dmca_restore_only";

/** HTTP status of every error code. 401 has one meaning only: the session is missing or expired. */
export const ERROR_STATUS = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  terms_required: 403,
  admin_requires_2fa: 403,
  // auth/second-factor.ts: the session has not passed the account's second factor (managing the
  // factor), and too many wrong codes in the window (with `Retry-After`).
  second_factor_required: 403,
  second_factor_throttled: 429,
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
  // routes/uploads.ts: an avatar's synchronous scan waited out its budget for a scanner that is
  // starting (or busy) — retryable, with `Retry-After`; nothing was kept.
  scanner_starting: 503,
  // services/body.ts: a JSON request body over its byte cap — refused before it is parsed.
  body_too_large: 413,
  // An account deletion an admin scheduled, which the account itself cannot cancel.
  deletion_admin_scheduled: 409,
  // An admin action aimed at the admin's own account.
  self_action: 400,
  // An action that would leave no admin.
  last_admin: 409,
  // A quarantine action on an item that is not (or no longer) in quarantine.
  not_quarantined: 409,
  // A file whose replacement upload is still in progress.
  replace_in_progress: 409,
  // An admin takedown of an item that is already taken down.
  already_taken_down: 409,
  // An admin restore of an item that is not taken down.
  not_taken_down: 409,
  // An admin restore of a takedown a copyright notice holds: only that notice's own restore lifts it.
  dmca_restore_only: 409,
} as const satisfies Record<ErrorCode, number>;

/**
 * Why a guarded job's on-demand pass (`POST /api/admin/jobs/:name/run`) STOPPED rather than "not
 * done yet": the `details.reason` of its `409 conflict`. Not error codes of their own.
 */
export type JobStopReason = "destroy_paused" | "rolled_back" | "orphans_disabled" | "orphan_threshold";

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
