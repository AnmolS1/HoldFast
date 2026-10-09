// The one redaction function of the auth layer: everything it writes to a log, and every error
// it hands to Sentry, passes through here first.
//
// Two rules, because two kinds of value arrive:
//
//  - STRUCTURED values (an object beside a log message, the fields of an error) are reduced to an
//    allow-list: `event`, `userId`, `requestId`, `code` — and each only when its value has the
//    shape that field has (an identifier; for `code`, an error code). Every other field is
//    dropped, whatever it is called: a user row, a request body, a session, a credential, a
//    header bag never get as far as being looked at.
//  - FREE TEXT (a message, an error's message) is scanned (`scanText`, src/shared/sentry-redact.ts —
//    one implementation for this layer and for the final Sentry walk), and everything shaped like a
//    secret or like personal data is replaced: the named rules first (
//    email addresses, token-bearing path segments, `token=` / `code=` / `password=` values),
//    then whole URLs, JWTs, long random strings (session tokens, ids, OAuth codes), backup codes,
//    one-time codes and IP addresses.
//
// A scan cannot recognise a person's NAME or any other free-form value inside a sentence. Nothing
// here relies on it to: such values arrive inside objects, which the first rule drops — and in
// the one place a library puts a row into a sentence (the parameter list of a failed query, in
// the error's message), the whole list is cut off.

import { scanText } from "../../shared/sentry-redact";

/**
 * Free text, safe to keep: scanned, and capped in length. The rules themselves are the shared
 * scan (src/shared/sentry-redact.ts `scanText`) — the same function the final Sentry walk uses,
 * so a string redacted here and again on its way out reads the same.
 */
export function scrubText(text: string): string {
  return scanText(text);
}

/** An event name, a user id, a request id: one short token of identifier characters. */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
// An error code: a constant (`USER_NOT_FOUND`), a SQLSTATE (`23505`), or an HTTP status.
// Deliberately NOT "any string": `code` is also what an OAuth code and a one-time code are called.
const ERROR_CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|[0-9A-Z]{5})$/;

export type SafeFields = { event?: string; userId?: string; requestId?: string; code?: string };

function errorCode(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
    return String(value);
  }
  return typeof value === "string" && ERROR_CODE.test(value) ? value : undefined;
}

/** The allow-listed fields of a structured value; everything else is dropped unread. */
export function safeFields(value: unknown): SafeFields {
  const out: SafeFields = {};
  if (value === null || typeof value !== "object") return out;
  const source = value as Record<string, unknown>;
  for (const key of ["event", "userId", "requestId"] as const) {
    let field: unknown;
    try {
      field = source[key];
    } catch {
      field = undefined;
    }
    if (typeof field === "string" && IDENTIFIER.test(field)) out[key] = field;
  }
  let code: unknown;
  try {
    // Better Auth's APIError carries its code on `body`.
    code = source.code ?? (source.body as { code?: unknown } | null | undefined)?.code;
  } catch {
    code = undefined;
  }
  const safeCode = errorCode(code);
  if (safeCode) out.code = safeCode;
  return out;
}

const fieldsText = (fields: SafeFields) =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

/** An error as text: its class, its code, its scanned message — never its other fields. */
export function describeError(error: Error, depth = 0): string {
  const name = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error";
  const fields = fieldsText(safeFields(error));
  let cause = "";
  try {
    if (error.cause instanceof Error && depth < 2)
      cause = ` (cause: ${describeError(error.cause, depth + 1)})`;
  } catch {
    cause = "";
  }
  return `${name}${fields ? ` [${fields}]` : ""}: ${scrubText(String(error.message))}${cause}`;
}

/** Any one value as loggable text. */
export function describeValue(value: unknown): string {
  if (typeof value === "string") return scrubText(value);
  if (typeof value === "number" || typeof value === "boolean" || value === null || value === undefined) {
    return scrubText(String(value));
  }
  if (value instanceof Error) return describeError(value);
  if (typeof value === "object") {
    const fields = fieldsText(safeFields(value));
    return fields ? `{${fields}}` : "{…}";
  }
  return "";
}

/**
 * An error that is safe to hand to Sentry: the class, the code and the scanned message of the
 * original, and its stack frames (file and line — the message line of the stack is rewritten).
 * The original's own fields (a database error's `detail`, `parameters`, `where`…) are left behind.
 */
export function safeError(error: unknown): Error {
  if (!(error instanceof Error)) return new Error(describeValue(error));
  const safe = new Error(scrubText(String(error.message)));
  Object.defineProperty(safe, "name", {
    value: /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name) ? error.name : "Error",
    enumerable: false,
    configurable: true,
    writable: true,
  });
  const code = safeFields(error).code;
  if (code) (safe as Error & { code?: string }).code = code;
  const frames = (error.stack ?? "").split("\n").filter((line) => /^\s+at\s/.test(line));
  // Frames are function names and bundle positions — code, not data — and are kept as they are.
  safe.stack = [`${safe.name}: ${safe.message}`, ...frames.slice(0, 30)].join("\n");
  return safe;
}

/**
 * An error code read out of a response (a JSON body's `code`, a redirect's `error` parameter),
 * for an audit row or a metric: kept when it reads as a code in either spelling Better Auth uses
 * (`INVALID_TOKEN`, `unable_to_create_user`), otherwise "other" — a response can echo what the
 * caller sent.
 */
export function responseCode(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) && scrubText(value) === value ? value : "other";
}
