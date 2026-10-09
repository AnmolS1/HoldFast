// Redaction applied to everything sent to Sentry, by the Worker and by the browser SDK.
// Pure functions with no SDK import, so both bundles share one copy.
//
// Why: bearer-ish tokens live in URL paths (/d/:id/:token, /s/:token, /invite/:code), and request
// data carries cookies and addresses. None of that may leave the process.

const REDACTED = "[redacted]";

// Everything after one of these path segments is a token or an id that leads to one.
// `reset-password/<token>` is Better Auth's reset link (GET /api/auth/reset-password/:token).
const PATH_MARKERS = /(\/(?:d|i|t|s|links|invites|invite|reset-password)\/)[^?#\s"'<>]+/g;
// Credential-bearing query values, with or without a leading `?` (Sentry stores the query string
// on its own, without one): tokens, one-time and OAuth codes, the OAuth `state`, passwords, and
// `error_description` — free text from a provider or a hook on an error redirect.
const QUERY_VALUES =
  /((?:^|[?&])(?:token|code|state|password|error_description|id_token|access_token|refresh_token)=)[^&#\s"'<>]*/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

// Credentials, and the client's raw address (the app keeps only keyed hashes of it).
const DROPPED_HEADERS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "x-captcha-response",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "true-client-ip",
]);
// Keys whose value is dropped wherever they appear (request bodies, extra data).
const SECRET_KEY = /pass(?:word|code)|secret|token|^cookies$/i;
// One-time codes, by their exact key and only inside captured REQUEST data: elsewhere `code` is
// an error's own code (a SQLSTATE, a status), which is what makes an event readable.
const REQUEST_SECRET_KEY = /^(?:code|otp|totp|backupCodes?)$/i;

/**
 * A `User-Agent` reduced to its browser family: enough to say "this breaks in Safari", not enough
 * to help single a person out. The same reduction for Worker and browser events.
 */
export function userAgentFamily(userAgent: string): string {
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/\b(?:OPR|Opera)\//.test(userAgent)) return "Opera";
  if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) return "Firefox";
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(userAgent)) return "Chrome";
  if (/\bSafari\//.test(userAgent)) return "Safari";
  return "other";
}

/** A URL (absolute or relative) with token-bearing path segments and query values replaced. */
export function redactUrl(url: string): string {
  return url.replace(PATH_MARKERS, `$1${REDACTED}`).replace(QUERY_VALUES, `$1${REDACTED}`);
}

/** Any text: the URL rules, plus email addresses replaced with `[email]`. */
export function redactText(text: string): string {
  return redactUrl(text).replace(EMAIL, "[email]");
}

// ── the scan: the ONE function every free-text string passes on its way out ────────────────────
//
// `redactText` above knows a few shapes by name. The scan adds everything shaped like a secret
// or like personal data, whatever field it turned up in: whole URLs, JWTs, long random strings
// (session tokens, ids, OAuth codes), backup codes, one-time codes, IP addresses, the parameter
// list of a failed query, the whole query of a relative URL. It is idempotent: scanning its own
// output changes nothing (every replacement is a short bracketed word no rule matches).

const MAX_TEXT = 500;

// A whole absolute URL: verification, reset and callback links carry their secret anywhere in
// the path or the query, so none of it is kept.
const ABSOLUTE_URL = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>)\]]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
// A run of 20+ token characters. Kept only when it reads as a word or a constant (one case and
// no digit: INVALID_EMAIL_OR_PASSWORD, a long identifier); anything mixed is a random string.
const LONG_RUN = /[A-Za-z0-9_+/=-]{20,}/g;
// Better Auth's backup codes: five characters, a hyphen, five characters — with a digit, which
// is what separates one from two hyphenated words.
const BACKUP_CODE = /\b(?=[A-Za-z0-9-]*\d)[A-Za-z0-9]{5}-[A-Za-z0-9]{5}\b/g;
const ONE_TIME_CODE = /(?<![\w.-])\d{6,8}(?![\w-])/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

const QUERY_PARAMS = /\bparams:[\s\S]*$/i;
// A path, then `?` and at least one `key=`: its query and fragment, up to the next space or quote.
const RELATIVE_QUERY = /((?:^|[\s"'(=])\/[^\s"'<>?#]*)\?[^\s"'<>=]*=[^\s"'<>]*/g;

// A cookie or credential header quoted in a sentence ("Cookie: a=b; c=d"): the rest of the line.
const HEADER_LINE = /\b((?:set-)?cookie|authorization)\s*:\s*[^\r\n]*/gi;
// One of this app's own cookies as `name=value` (hf.session_token, hf_pending, hf_intent, with or
// without a __Secure- / __Host- prefix): a signed value has a short signature part with no shape.
const OWN_COOKIE = /\b(?:__(?:Secure|Host)-)?hf[._][A-Za-z0-9_.-]*=[^;\s"'<>]*/g;

const isWordLike = (run: string) => /^[A-Z_]+$/.test(run) || /^[a-z_-]+$/.test(run);

/** A long run: a word or a constant is kept; a path is judged segment by segment; the rest goes. */
function scrubRun(run: string): string {
  if (isWordLike(run)) return run;
  // `/` is a base64 character and a path separator. A run that starts with one is a path
  // (/api/auth/admin/set-user-password): its segments are words, or they are replaced.
  if (run.startsWith("/")) {
    return run
      .split("/")
      .map((segment) => (segment.length < 20 || isWordLike(segment) ? segment : "[token]"))
      .join("/");
  }
  return "[token]";
}

/** The shape rules shared by free text and by a URL kept as a URL. */
function scanShapes(text: string): string {
  return redactText(text)
    .replace(JWT, "[token]")
    .replace(LONG_RUN, scrubRun)
    .replace(BACKUP_CODE, "[code]")
    .replace(IPV4, "[ip]")
    .replace(IPV6, (run) => (run.replace(/:/g, "").length >= 2 ? "[ip]" : run))
    .replace(ONE_TIME_CODE, "[code]");
}

const capped = (text: string) => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text);

/** Free text, safe to keep: scanned, and capped in length. Idempotent. */
export function scanText(text: string): string {
  // A query's parameters are the row itself — names, hashes, tokens, in no recognisable shape.
  // Drizzle puts them in the MESSAGE of the error it wraps a failed query in ("Failed query: …
  // params: a,b,c"), so everything after that word goes, unread.
  // The query (and fragment) of a relative URL goes whole too: the named rules know a few
  // parameters, and a short `state` or a name in a redirect has no shape to scan for.
  const withoutParams = text
    .slice(0, 4 * MAX_TEXT)
    .replace(QUERY_PARAMS, "params: [dropped]")
    .replace(HEADER_LINE, "$1: [redacted]")
    .replace(OWN_COOKIE, "[cookie]")
    .replace(RELATIVE_QUERY, "$1?[query]");
  // Whole URLs first: the named rules rewrite parts of a URL, and what they leave would no
  // longer read as one.
  return capped(scanShapes(withoutParams.replace(ABSOLUTE_URL, "[url]")));
}

/**
 * A value that IS a URL (a request's `url`, a fetch breadcrumb's, a stack frame's file): the
 * origin and the path are what make an event readable, so they are kept — scanned by the shape
 * rules — and everything from the first `?` or `#` on is dropped whole. Idempotent.
 */
export function scanUrl(url: string): string {
  const cut = url.search(/[?#]/);
  const base = cut === -1 ? url : url.slice(0, cut);
  // Segment by segment: `/` is also a base64 character, and scanned whole, a host and a path
  // of plain words ("example/api/nodes/folder") would read as one long random run.
  const scanned = redactUrl(
    base
      .slice(0, 4 * MAX_TEXT)
      .replace(HEADER_LINE, "$1: [redacted]")
      .replace(OWN_COOKIE, "[cookie]"),
  )
    .split("/")
    .map((segment) => scanShapes(segment))
    .join("/");
  return capped(scanned) + (cut === -1 ? "" : "?[query]");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

// ── the walk: every string of a fully assembled event ──────────────────────────────────────────
//
// This runs LAST, in `beforeSend` / `beforeSendTransaction` / `beforeBreadcrumb`, on the event as
// it will be transmitted. By then the SDK has copied the same value into several places — an
// error's message into `exception.values[].value`, a request's URL into `request.url`, a fetch
// breadcrumb, the transaction name, a tag — and whatever a helper redacted earlier covered one
// copy at most. So nothing here depends on which field a string is in: the walk is generic
// (any key, any depth), and every string gets the same scan. Earlier redaction (`safeError`, the
// auth layer's `observe.ts`) stays as defence in depth; nothing relies on it.
//
// What is NOT scanned as free text, and why — the whole list:
//
//  URL_KEYS      the value is a URL: `scanUrl` (path kept and shape-scanned, query dropped whole)
//                instead of `scanText`, which would replace it with "[url]" and leave a fetch
//                breadcrumb or a stack frame saying nothing.
//  CODE_PATHS    the value is produced by the build or the SDK, never by a request, AND is at the
//                exact place in an event where the SDK puts it: the release (a commit hash), the
//                SDK's own name and version, debug ids, a stack frame's function and module. A
//                commit hash and a debug id are long random runs the scan would replace, and
//                with them the link from an event to its source map. Matched by full path, so
//                the same key name inside request data, extras, tags or a breadcrumb is scanned
//                like any text. These still get the named rules (`redactText`).
//  ID_SHAPES     a key whose value is kept ONLY when it has exactly the shape of that id (the
//                request id is a UUID; event, trace and span ids are hex): the ids support uses
//                to find an event. Any other value under the same key is scanned like any text.
const URL_KEYS = new Set(["url", "abs_path", "filename", "from", "to", "http.url", "url.full"]);
const CODE_PATHS =
  /^(?:release|dist|environment|platform|sdk|debug_meta|modules)$|^(?:exception|threads)\/values\/stacktrace\/frames\/(?:function|module|debug_id|instruction_addr|addr_mode)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_SHAPES: Record<string, RegExp> = {
  requestId: UUID,
  request_id: UUID,
  event_id: /^[0-9a-f]{32}$/i,
  trace_id: /^[0-9a-f]{32}$/i,
  span_id: /^[0-9a-f]{16}$/i,
  parent_span_id: /^[0-9a-f]{16}$/i,
};

// Bounds: an event is small. Past them the rest is dropped rather than sent unread.
const MAX_DEPTH = 12;
const MAX_ENTRIES = 1000;
const TOO_DEEP = "[too deep]";

const PLACEHOLDER = /\[(?:redacted|token|url|email|code|ip|cookie|query|dropped|too deep)\]/g;

type Mode = "text" | "code";

function scanString(value: string, key: string | null, mode: Mode): string {
  if (key !== null && ID_SHAPES[key]?.test(value)) return value;
  if (key !== null && URL_KEYS.has(key)) return scanUrl(value);
  return mode === "code" ? capped(redactText(value)) : scanText(value);
}

function walk(
  value: unknown,
  seen: WeakSet<object>,
  inRequest: boolean,
  key: string | null,
  path: string,
  mode: Mode,
  depth: number,
): unknown {
  if (typeof value === "string") return scanString(value, key, mode);
  if (value === null || typeof value !== "object") {
    // Numbers, booleans, undefined pass; a function or a symbol is not data.
    return typeof value === "function" || typeof value === "symbol" ? undefined : value;
  }
  if (depth >= MAX_DEPTH) return TOO_DEEP;
  if (seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    // An array adds nothing to the path: `frames/function` is every frame's function.
    return value.slice(0, MAX_ENTRIES).map((item) => walk(item, seen, inRequest, key, path, mode, depth + 1));
  }
  // Anything that is not a plain object (an Error, a Request, a Map, a class instance) is not
  // event data: described by its class name, never opened.
  if (!isPlainObject(value)) {
    const name = (value as { constructor?: { name?: unknown } }).constructor?.name;
    return `[${typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "object"}]`;
  }
  const out: Record<string, unknown> = {};
  let entries = 0;
  for (const [rawKey, item] of Object.entries(value)) {
    if (++entries > MAX_ENTRIES) break;
    const lower = rawKey.toLowerCase();
    if (DROPPED_HEADERS.has(lower)) continue;
    // A key is a string too (a tag name, a header name, a body field's name).
    const outKey = scanText(rawKey);
    if (lower === "user-agent") {
      if (typeof item === "string") out[outKey] = userAgentFamily(item);
      continue;
    }
    // The rules about a key's NAME read the name without the scan's own placeholders: a key that
    // was a token is "[token]" after one pass, and must not then read as "a key named token".
    const named = outKey.replace(PLACEHOLDER, "");
    const secret = SECRET_KEY.test(named) || (inRequest && REQUEST_SECRET_KEY.test(named));
    if (secret && item !== undefined && item !== null) {
      out[outKey] = REDACTED;
      continue;
    }
    const childPath = path === "" ? rawKey : `${path}/${rawKey}`;
    const childMode: Mode = mode === "code" || CODE_PATHS.test(childPath) ? "code" : "text";
    out[outKey] = walk(
      item,
      seen,
      inRequest || rawKey === "request",
      rawKey,
      childPath,
      childMode,
      depth + 1,
    );
  }
  return out;
}

/**
 * A redacted copy of a Sentry event or breadcrumb, for the LAST step before it is sent: every
 * string in it, whatever field it is in, goes through the one scan (`scanText`; `scanUrl` for a
 * value that is a URL); credential and client-address headers are dropped and a `User-Agent` is
 * reduced to its browser family; a value under a key that names a secret is replaced, and inside
 * `request` so are one-time codes. Generic, cycle-safe, bounded in depth and size, idempotent
 * (`redactEvent(redactEvent(e))` equals `redactEvent(e)`). The input is not modified.
 */
export function redactEvent<T>(event: T): T {
  return walk(event, new WeakSet(), false, null, "", "text", 0) as T;
}
