// Redaction applied to everything sent to Sentry, by the Worker and by the browser SDK.
// Pure functions with no SDK import, so both bundles share one copy.
//
// Why: bearer-ish tokens live in URL paths (/d/:id/:token, /s/:token, /invite/:code), and request
// data carries cookies and addresses. None of that may leave the process.

const REDACTED = "[redacted]";

// Everything after one of these path segments is a token or an id that leads to one.
// `reset-password/<token>` is Better Auth's reset link (GET /api/auth/reset-password/:token).
const PATH_MARKERS = /(\/(?:d|i|t|s|links|invites|invite|reset-password)\/)[^?#\s"'<>]+/g;
// `token`, `code` and `password` query values, with or without a leading `?` (Sentry stores the
// query string on its own, without one).
const QUERY_VALUES = /((?:^|[?&])(?:token|code|password)=)[^&#\s"'<>]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

const DROPPED_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-captcha-response"]);
// Keys whose value is dropped wherever they appear (request bodies, extra data).
const SECRET_KEY = /pass(?:word|code)|secret|token|^cookies$/i;
// One-time codes, by their exact key and only inside captured REQUEST data: elsewhere `code` is
// an error's own code (a SQLSTATE, a status), which is what makes an event readable.
const REQUEST_SECRET_KEY = /^(?:code|otp|totp|backupCodes?)$/i;

/** A URL (absolute or relative) with token-bearing path segments and query values replaced. */
export function redactUrl(url: string): string {
  return url.replace(PATH_MARKERS, `$1${REDACTED}`).replace(QUERY_VALUES, `$1${REDACTED}`);
}

/** Any text: the URL rules, plus email addresses replaced with `[email]`. */
export function redactText(text: string): string {
  return redactUrl(text).replace(EMAIL, "[email]");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function walk(value: unknown, seen: WeakSet<object>, inRequest: boolean): unknown {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    return value.map((item) => walk(item, seen, inRequest));
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return undefined;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (DROPPED_HEADERS.has(key.toLowerCase())) continue;
    const secret = SECRET_KEY.test(key) || (inRequest && REQUEST_SECRET_KEY.test(key));
    if (secret && item !== undefined && item !== null) {
      out[key] = REDACTED;
      continue;
    }
    out[key] = walk(item, seen, inRequest || key === "request");
  }
  return out;
}

/**
 * A redacted copy of a Sentry event or breadcrumb. Every string in it goes through `redactText`;
 * `cookie`, `authorization` and `x-captcha-response` headers are dropped; values under a key that
 * names a secret are replaced, and inside `request` so are one-time codes (`code`, `otp`, `totp`,
 * `backupCodes`). The input is not modified.
 */
export function redactEvent<T>(event: T): T {
  return walk(event, new WeakSet(), false) as T;
}
