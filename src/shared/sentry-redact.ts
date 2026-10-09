// Redaction for everything that leaves the process as telemetry: Sentry events and breadcrumbs
// (Worker and browser SDK), log lines, audit metadata. Pure functions, no SDK import, and no
// Workers, DOM or Node API — the Worker and the browser bundle share this one copy.
//
// FOUR RULES. Each is here because breaking it was a real defect.
//
//  1. ONE PIPELINE, ONE PARSER. Exactly one function redacts a string: `redactText`. It has one
//     grammar for a URL token — absolute, protocol-relative, a bare host with a path, a path
//     starting with `/` — and one treatment of it, the URL reducer (`reduceUrl`): scheme, host
//     and path are kept; userinfo, query and fragment are dropped whole. The string is decoded
//     to a fixed point (percent-encoding, HTML entities, backslash escapes) ONE KIND OF ENCODING
//     AT A TIME, and after every step the URLs that have become visible are reduced — so a
//     link's query is cut while it is still one unbroken span, before a later step could turn
//     its `%20` into a space and let the rest of the query drift out of the link. What is left
//     between the URL tokens goes through the one secret-shape scanner. There is no second way
//     to treat a URL, so the same link cannot be redacted in one field and survive in another.
//  2. STRUCTURAL DEFAULT-DENY. `redactEvent` walks a value by its OWN properties only, reads
//     them through property descriptors (a getter is never run), and keeps every lookup table in
//     a `Map` or a `Set` — a key named `__proto__` or `constructor` is a key like any other.
//     A value under a sensitive name is replaced without being read; anything that is not a plain
//     object or an array is replaced by a fixed description (`[Error]`, `[Headers]`) — never
//     opened, never stringified, its `toJSON` never called.
//  3. FAIL CLOSED, VISIBLY. If redaction throws or an input is past the bounds, the event is
//     neither sent as it is nor dropped in silence: it is replaced by a fixed marker event
//     (`redaction_failed`) built from nothing of the payload, and the caller's `onFailure` is
//     called (a metric). A breadcrumb is dropped, and counted the same way.
//  4. IDEMPOTENT AND TOTAL. `redactText(redactText(x)) === redactText(x)` by construction (the
//     scan is repeated until its output is stable, and a string that will not settle becomes
//     `[unscannable]`); `redactEvent` never throws.
//
// What a scan cannot do: recognise a secret that has no shape and no name — a first name in a
// sentence, a five-letter word under an arbitrary key. Such values reach an event inside a URL's
// query (dropped whole), under a named key (replaced whole), or in a failed query's parameter
// list (cut off whole).

// ── what the SDKs may collect ──────────────────────────────────────────────────────────────────
//
// Both SDKs (Worker and browser) are given this as their `dataCollection` option: every category
// of request- and user-derived data OFF, by the option names of the installed @sentry/core 11.5
// (build/types/types/datacollection.d.ts). The defaults are all ON — up to 10 KB of every
// non-GET request body, every cookie and header, the query string, the client address (and, in
// the browser, a request to Sentry to infer the address from the connection, which no
// `beforeSend` can undo). Redaction is for what is left, not for what should never be read.
// (Plain data: this module imports no SDK. Each caller checks it against its SDK's type.)
export const SENTRY_DATA_COLLECTION = {
  userInfo: false,
  cookies: false,
  httpHeaders: false,
  httpBodies: [] as never[],
  urlQueryParams: false,
  databaseQueryData: false,
  stackFrameVariables: false,
};

// ── placeholders ───────────────────────────────────────────────────────────────────────────────

const REDACTED = "[redacted]";
/** A string that could not be brought to a stable, decoded form within the bounds. */
export const UNSCANNABLE = "[unscannable]";
/** The `message` of the event that replaces one that could not be redacted. */
export const REDACTION_FAILED = "redaction_failed";

// ── bounds ─────────────────────────────────────────────────────────────────────────────────────

const MAX_INPUT = 4096; // characters of one string that are looked at
const MAX_OUTPUT = 1000; // characters of one string that are kept
const MAX_KEY = 128; // characters of one object key that are kept
const MAX_DECODE_ROUNDS = 6; // layers of encoding that are followed
const MAX_SETTLE_ROUNDS = 4;
const MAX_DEPTH = 16;
const MAX_KEYS = 500; // own keys of one object
const MAX_ITEMS = 500; // items of one array
const MAX_NODES = 20_000; // values in one event
const MAX_CHARS = 262_144; // characters of strings and keys that are scanned in one event

// ── decoding to a fixed point ──────────────────────────────────────────────────────────────────
//
// A link is the same link written `https%3A%2F%2F…`, `https:&#x2F;&#x2F;…` or `https:\/\/…`,
// and whoever reads the event later may decode it. So the scan works on the DECODED text, and
// what it returns is built from that — the encoded original is never copied to the output.

const ENTITY_NAMES = new Map<string, string>([
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["sol", "/"],
  ["bsol", "\\"],
  ["colon", ":"],
  ["semi", ";"],
  ["quest", "?"],
  ["equals", "="],
  ["num", "#"],
  ["commat", "@"],
  ["period", "."],
  ["percnt", "%"],
  ["nbsp", " "],
]);

// DECODED DELIMITERS ARE DATA. When a decoding step produces a character that ENDS a value in
// one of the grammars below — white space, `&`, `;`, `,` — that character was part of whatever
// it was written in, not the end of it: `secret=pre%20rest` is the pair secret → "pre rest".
// Whether the name's own `=` becomes visible before or after that space does (they may be
// written in different encodings, peeled in different steps) must not decide how much is taken.
// So a decoded delimiter is written as a STAND-IN from the private-use area, which no pattern
// treats as a delimiter; the scan sees one unbroken value; and the stand-ins are turned into the
// real characters only in what `redactText` returns. (Private-use characters already in the
// input are replaced first, so nothing can pose as a stand-in.)
const STAND_INS = new Map<string, string>([
  [" ", "\uE000"],
  ["\n", "\uE001"],
  ["\r", "\uE002"],
  ["\t", "\uE003"],
  ["\u00a0", "\uE004"],
  ["&", "\uE005"],
  [";", "\uE006"],
  [",", "\uE007"],
]);
const REAL = new Map<string, string>([...STAND_INS].map(([real, standIn]) => [standIn, real]));
const AMP = "[&\uE005]";
const SEMI = "[;\uE006]";

const protect = (decoded: string) =>
  decoded.replace(/[ \n\r\t\u00a0&;,]/g, (char) => STAND_INS.get(char) ?? char);
const reveal = (text: string) => text.replace(/[\uE000-\uE007]/g, (char) => REAL.get(char) ?? char);
const withoutPrivateUse = (text: string) => text.replace(/[\uE000-\uF8FF]/g, "\uFFFD");

function fromCodePoint(code: number, fallback: string): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
    return fallback;
  }
  // A private-use code point written as an escape is not let in either.
  if (code >= 0xe000 && code <= 0xf8ff) return "\uFFFD";
  return protect(String.fromCodePoint(code));
}

function percentDecode(run: string): string {
  try {
    return protect(withoutPrivateUse(decodeURIComponent(run)));
  } catch {
    // Not valid UTF-8 as a whole: decode the ASCII bytes, leave the rest as written.
    return run.replace(/%([0-9a-f]{2})/gi, (whole, hex: string) => {
      const code = parseInt(hex, 16);
      return code < 0x80 ? protect(String.fromCharCode(code)) : whole;
    });
  }
}

// One KIND of encoding per step — never two in one go. Between any two steps the URLs that have
// become visible are reduced and the named values taken (see `decodeAndReduce`): a link's query
// and a secret's value must be cut while they are still one unbroken span.
const ENTITY_HEX = new RegExp(`${AMP}#x([0-9a-f]{1,6})${SEMI}?`, "gi");
const ENTITY_DEC = new RegExp(`${AMP}#(\\d{1,7})${SEMI}?`, "g");
const ENTITY_NAME = new RegExp(`${AMP}([a-z]{2,8})(?:${SEMI}|(?![a-z0-9]))`, "gi");
const DECODERS: Array<(text: string) => string> = [
  // HTML entities.
  (text) =>
    text
      .replace(ENTITY_HEX, (whole, hex: string) => fromCodePoint(parseInt(hex, 16), whole))
      .replace(ENTITY_DEC, (whole, dec: string) => fromCodePoint(parseInt(dec, 10), whole))
      .replace(ENTITY_NAME, (whole, name: string) => {
        const real = ENTITY_NAMES.get(name.toLowerCase());
        return real === undefined ? whole : protect(real);
      }),
  // Numeric backslash escapes, as in a JSON or JavaScript string…
  (text) =>
    text
      .replace(/\\u\{([0-9a-f]{1,6})\}/gi, (whole, hex: string) => fromCodePoint(parseInt(hex, 16), whole))
      .replace(/\\u([0-9a-f]{4})/gi, (whole, hex: string) => fromCodePoint(parseInt(hex, 16), whole))
      .replace(/\\x([0-9a-f]{2})/gi, (whole, hex: string) => fromCodePoint(parseInt(hex, 16), whole)),
  // …and, as a step of its own, the one-character ones: `\u005c\u0022` is first `\"` (an
  // escaped quote INSIDE a value, which the pair rule reads as such) and only then `"`.
  (text) => text.replace(/\\([/"'\\])/g, "$1"),
  // Percent-encoding.
  (text) => text.replace(/(?:%[0-9a-f]{2})+/gi, percentDecode),
];

// ── sensitive names ────────────────────────────────────────────────────────────────────────────
//
// One list for an object's keys and for `key=value` pairs in text. A name is compared in lower
// case with its separators removed: `Pass-Word`, `ACCESS_TOKEN`, `x-api-key`, `new.password`.

const SENSITIVE_PARTS = [
  "captcha",
  "nonce",
  "verifier",
  // A date of birth is kept nowhere (the age gate keeps only "old enough").
  "birth",
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "secret",
  "token",
  "cookie",
  "authorization",
  "credential",
  "signature",
  "apikey",
  "privatekey",
  "sessionid",
];
// Sensitive only as the WHOLE name — everywhere: in text, and as an object key at any depth of an
// event (not only inside captured request data: an extra, a tag or a breadcrumb named `otp` holds
// an OTP). Two of them are also what makes an event readable — an error's own `code`, a record's
// own `state` — so under those two a value is kept when it READS as one (`isReadableCode`).
const SENSITIVE_WHOLE = new Set([
  "pass",
  "pw",
  "newpass",
  "oldpass",
  "key",
  "answer",
  "dob",
  "pwd",
  "auth",
  "sig",
  "otp",
  "totp",
  "pin",
  "code",
  "state",
  "backupcode",
  "backupcodes",
  "errordescription",
  "idtoken",
]);

// A query string kept apart from its URL (Sentry's `request.query_string`, a fetch breadcrumb's
// `url.query` / `url.fragment`): replaced whole wherever it is, like the query of a URL.
// Likewise a span's copy of a request body (`http.request.body.data`).
const QUERY_NAMES = new Set(["querystring", "urlquery", "urlfragment", "httprequestbodydata"]);

// What the SDK's request-data integration can attach under an event's `request` (and what its
// processing metadata holds before that): the body, the cookies, the server's environment. A
// body is a password, a name, a birth date — values with no shape — so these are never scanned
// for what might be kept: they are replaced whole. (The Worker's options switch their collection
// off; this is what holds if an option is ever renamed or an integration added.)
const REQUEST_HOLDERS = new Set(["request", "normalizedRequest"]);
const REQUEST_WHOLE = new Set(["data", "cookies", "env"]);

// Letters of other scripts that are drawn like a Latin one: `pаssword` with a Cyrillic а is a
// key named password to whoever reads it. (Full-width and other compatibility forms are folded
// by NFKC.)
// prettier-ignore
const LOOKALIKES = new Map<string, string>(
  Object.entries({
    // Cyrillic
    а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y", і: "i", ј: "j", ѕ: "s", к: "k", м: "m", т: "t",
    ԁ: "d", һ: "h", ӏ: "l", ո: "n", ս: "u", ԛ: "q", ԝ: "w",
    А: "a", В: "b", Е: "e", К: "k", М: "m", Н: "h", О: "o", Р: "p", С: "c", Т: "t", Х: "x", У: "y",
    // Greek (a capital and its small letter do not always resemble the same Latin letter)
    α: "a", ε: "e", ο: "o", ρ: "p", τ: "t", κ: "k", ι: "i", ν: "v", υ: "u", χ: "x", η: "n", β: "b", μ: "m",
    Α: "a", Β: "b", Ε: "e", Ζ: "z", Η: "h", Ι: "i", Κ: "k", Μ: "m", Ν: "n", Ο: "o", Ρ: "p", Τ: "t", Υ: "y", Χ: "x",
  }),
);

function normaliseName(name: string): string {
  let folded = "";
  for (const char of name.normalize("NFKC")) folded += LOOKALIKES.get(char) ?? char.toLowerCase();
  return folded.replace(/[^a-z0-9]/g, "");
}

function isSensitiveName(name: string): boolean {
  const plain = normaliseName(name);
  if (plain === "") return false;
  if (QUERY_NAMES.has(plain)) return true;
  for (const part of SENSITIVE_PARTS) if (plain.includes(part)) return true;
  return SENSITIVE_WHOLE.has(plain);
}

// ── the secret-shape scanner (text that is not a URL) ──────────────────────────────────────────

// Every pattern here starts only at the START of a run (a look-behind for the run's own
// characters) or has bounded repeats: without that, one long run of one character costs a scan
// from each of its positions — quadratic, and an event can hold hundreds of such strings.
//
// Any letters and digits, not ASCII alone: `jané@exämple.com` and `用户@例子.公司` are addresses.
const EMAIL =
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]{1,254}@[\p{L}\p{N}-]{1,63}(?:\.[\p{L}\p{N}-]{1,63})+/gu;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g;
// A run of 20+ token characters is a random string unless it reads as words.
const LONG_RUN = /[A-Za-z0-9_+/=-]{20,}/g;
// Better Auth's backup codes: five characters of [A-Za-z0-9], a hyphen, five more. One in six
// has no digit, so the mark of a code is a digit OR a capital: two lower-case words of five
// letters (`known-issue`) are words; anything else of this shape is taken for a code.
const BACKUP_CODE =
  /(?<![A-Za-z0-9-])(?=[A-Za-z0-9-]{0,10}[\dA-Z])[A-Za-z0-9]{5}-[A-Za-z0-9]{5}(?![A-Za-z0-9-])/g;
// Three or more dot-joined pieces, each too short to be a long run by itself. A token when the
// whole has a digit and both cases (a host name, a file name and a version have not).
const DOTTED = /(?<![A-Za-z0-9_.-])[A-Za-z0-9_-]{6,64}(?:\.[A-Za-z0-9_-]{6,64}){2,8}(?![A-Za-z0-9_.-])/g;
const isMixed = (run: string) => /\d/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run);
// A token-bearing path written without its leading slash (`invite/ABCD1234`,
// `api/public/links/…`): everything after the prefix goes, with its query. Only the prefixes that
// are words — a bare `s/` or `d/` is not a path.
const BARE_TOKEN_PATH =
  /(?<![A-Za-z0-9_.@%/-])((?:[A-Za-z0-9_.-]{1,64}\/){0,8}(?:links|invites|invite|reset-password|range)\/)[^\s"'<>`?#]+(?:[?#][^\s"<>`]*)?/gi;
const ONE_TIME_CODE = /(?<![\w.-])\d{6,8}(?![\w-])/g;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;
const IPV6 = /(?<![\w:])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![\w:])/gi;

// One case, letters only, with `-` / `_` between words: INVALID_EMAIL_OR_PASSWORD,
// set-user-password. Anything with a digit or mixed case in it is not a word.
// And a "word" has a length: a run of 25 letters and more with no separator is a random string.
const isWords = (part: string) =>
  /^(?:[a-z]+(?:[-_]+[a-z]+)*|[A-Z]+(?:[-_]+[A-Z]+)*)$/.test(part) &&
  part.split(/[-_]+/).every((word) => word.length <= 24);

/** A long run is kept only when every `/`-separated part of it reads as words. */
function scrubRun(run: string): string {
  return run.split("/").every((part) => part === "" || isWords(part)) ? run : "[token]";
}

function scanShapes(text: string): string {
  return text
    .replace(BARE_TOKEN_PATH, `$1${REDACTED}`)
    .replace(EMAIL, "[email]")
    .replace(JWT, "[token]")
    .replace(DOTTED, (run) => (isMixed(run) ? "[token]" : run))
    .replace(LONG_RUN, scrubRun)
    .replace(BACKUP_CODE, "[code]")
    .replace(IPV4, "[ip]")
    .replace(IPV6, (run) => (run.replace(/:/g, "").length >= 2 ? "[ip]" : run))
    .replace(ONE_TIME_CODE, "[code]");
}

// ── the URL reducer ────────────────────────────────────────────────────────────────────────────
//
// What is kept of a URL: scheme, host, path. Dropped whole: userinfo, query, fragment. In the
// path, everything after a token-bearing prefix is replaced, and so is any segment (and any host
// label) that has the shape of a secret.

// The path segment after one of these is a bearer token or an id that leads to one:
// /d/:id/:token, /i/…, /t/…, /s/:token, /api/public/links/:token, /api/invites/:code,
// /invite/:code, and Better Auth's GET /api/auth/reset-password/:token.
// And the breach lookup's /range/<first five hex digits of the password's SHA-1>.
const TOKEN_PREFIXES = new Set(["d", "i", "t", "s", "links", "invites", "invite", "reset-password", "range"]);

const CLOSERS = new Map<string, string>([
  [")", "("],
  ["]", "["],
  ["}", "{"],
]);

/**
 * Where the punctuation that merely FOLLOWS a URL in its sentence begins: `.,;:!?'"*`, and a
 * closing bracket that the URL itself did not open (so the `]` of a placeholder stays).
 */
function trailingStart(token: string): number {
  let end = token.length;
  while (end > 0) {
    const last = token[end - 1]!;
    const opener = CLOSERS.get(last);
    if (opener !== undefined ? !token.slice(0, end - 1).includes(opener) : ".,;:!?'\"*".includes(last)) end--;
    else break;
  }
  return end;
}

function reduceHost(authority: string): string {
  // Userinfo — everything up to the last `@` — is dropped.
  const host = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  if (host === "[ip]") return host;
  if (host.startsWith("[")) return "[ip]"; // an IPv6 literal
  const colon = host.lastIndexOf(":");
  const hasPort = colon !== -1 && /^\d{1,5}$/.test(host.slice(colon + 1));
  const name = hasPort ? host.slice(0, colon) : host;
  const port = hasPort ? host.slice(colon) : "";
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/.test(name)) return `[ip]${port}`;
  return (
    name
      .split(".")
      .map((label) => scanShapes(label))
      .join(".") + port
  );
}

function reducePath(path: string): string {
  // A second link inside the path (…/y,https://user:pw@host/…) is a link: reduced as one.
  const inner = path.search(/[a-z][a-z0-9+.-]{0,15}:\/\//i);
  if (inner > 0) return reducePath(path.slice(0, inner)) + reduceUrl(path.slice(inner));
  const out: string[] = [];
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!;
    const scanned = scanShapes(segment);
    // What still has an `@` in it after the scan is userinfo in the wrong place, not a path.
    out.push(scanned.includes("@") ? REDACTED : scanned);
    const rest = segments.slice(index + 1);
    if (TOKEN_PREFIXES.has(segment.toLowerCase()) && rest.some((later) => later !== "")) {
      out.push(REDACTED);
      break;
    }
  }
  return out.join("/");
}

/** One URL token → scheme + host + reduced path. The ONLY treatment of a URL in this module. */
function reduceUrl(token: string): string {
  const stop = trailingStart(token);
  const tail = token.slice(stop);
  let rest = token.slice(0, stop);
  // Query and fragment: gone, whatever is in them.
  const cut = rest.search(/[?#]/);
  if (cut !== -1) rest = rest.slice(0, cut);

  let scheme = "";
  const schemeMatch = /^([a-z][a-z0-9+.-]{0,15}):(?=\/\/)/i.exec(rest);
  if (schemeMatch) {
    scheme = `${schemeMatch[1]!.toLowerCase()}:`;
    rest = rest.slice(schemeMatch[0].length);
  }
  let slashes = "";
  let authority: string | null = null;
  if (rest.startsWith("//")) {
    slashes = "//";
    rest = rest.slice(2);
    const end = rest.indexOf("/");
    authority = end === -1 ? rest : rest.slice(0, end);
    rest = end === -1 ? "" : rest.slice(end);
  } else if (!rest.startsWith("/")) {
    // A bare host with a path (example.com/cb), possibly with userinfo in front.
    const end = rest.indexOf("/");
    authority = end === -1 ? rest : rest.slice(0, end);
    rest = end === -1 ? "" : rest.slice(end);
  }
  const host = authority === null ? "" : reduceHost(authority);
  // The punctuation that followed the URL in its sentence is not part of it and is kept —
  // unless it followed a query, which took it along.
  return scheme + slashes + host + reducePath(rest) + (cut === -1 ? tail : "");
}

// A URL token. Three forms, one treatment:
//   scheme://…  and  //…         absolute and protocol-relative
//   [user@]host.tld[:port]/…     a bare host with a path (also localhost and an IPv4 address)
//   /…                           a path — when the `/` does not continue a word (and/or, 1/2)
// The token ends at whitespace, a double quote, `<`, `>` or a backtick — and, before its query,
// at a single quote (a link quoted in a sentence). Once a `?` or `#` has begun, a single quote
// is part of the query, as it is in a real URL: the query goes on to the next space. A backslash
// never ends a token (a link written with JSON escapes, `https:\/\/…`, is still one span).
const PATH_BODY = "[^\\s\"'<>`?#]";
const QUERY_TAIL = '(?:[?#][^\\s"<>`]*)?';
const URL_TOKEN = new RegExp(
  `(?:[a-z][a-z0-9+.-]{0,15}:)?//${PATH_BODY}+${QUERY_TAIL}` +
    // Starts at the start of a run, and every repeat is bounded (see the note above EMAIL).
    `|(?<![A-Za-z0-9._+-])(?:[^\\s/@"'<>\`?#]{1,128}@)?(?:(?:[a-z0-9-]{1,63}\\.){1,12}[a-z]{2,24}|localhost|(?:\\d{1,3}\\.){3}\\d{1,3})(?::\\d{1,5})?/${PATH_BODY}*${QUERY_TAIL}` +
    `|(?<![A-Za-z0-9_.@%/-])/${PATH_BODY}*${QUERY_TAIL}`,
  "gi",
);

// ── whole-string rules, applied before the split ───────────────────────────────────────────────

// A failed query's parameters are the row itself — names, hashes, tokens, in no recognisable
// shape. Drizzle puts them in the MESSAGE of its error ("Failed query: … params: a,b,c").
const QUERY_PARAMS = /\bparams:[\s\S]*$/i;
// A credential header quoted in a sentence: the rest of its line.
// (Where white space is part of a pattern's own SYNTAX — after `Bearer`, around a `:` or `=` —
// a decoded space counts as one: `Bearer%20…` is a bearer token.)
const HEADER_LINE = /\b((?:set-)?cookie|authorization)[\s-]*:[^\r\n]*/gi;
// To the next space or quote — not "to the next character a token cannot have": an ENCODED
// space inside it (`abc%20…`) is still the token.
const BEARER = /\b(Bearer|Basic)[\s-]+[^\s"'<>,]{4,}/g;
// This app's own cookies as `name=value` (hf.session_token, hf_pending, hf_intent, with or without
// a __Secure- / __Host- prefix): a signed value has a short signature part with no shape.
const OWN_COOKIE = /\b(?:__(?:Secure|Host)-)?hf[._][A-Za-z0-9_.-]*=[^;\s"'<>]*/g;
// `name=value`, `name: value`, `"name":"value"` — the value goes when the name is sensitive.
// The quotes around a name need not match (a pair quoted inside a quoted value: `""name":"v""`),
// and a quoted value need not be closed (a string cut off mid-value): it runs to the end of its line.
// A name is letters of any script (`ｐａｓｓｗｏｒｄ=…`); an unquoted value runs to a delimiter, and a
// character ENTITY inside it (`pre&#x20;rest`) is part of it, not the `&` and `;` that end it.
const KEY_VALUE =
  /(["']?)([\p{L}][\p{L}\p{N}_.[\]-]{0,63})(["']?)([\s-]*[:=][\s-]*)("(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\\\r\n]|\\.)*'?|(?:[&]#[xX]?[0-9a-fA-F]{1,7}[;]?|[&][A-Za-z]{2,8}[;]|[^\s&;,"'<>])+)/gu;
// An error's own code (a constant, a SQLSTATE, an HTTP status) is kept under `code`, and a
// record's own state (`open`, `IN_PROGRESS`) under `state`: a value that reads as a constant or
// as one plain lower-case word. Anything else under those two names is a one-time code or an
// OAuth state.
const ERROR_CODE = /^(?:[A-Z][A-Z0-9_]{1,63}|[0-9A-Z]{5}|\d{3})$/;
const PLAIN_WORD = /^[a-z][a-z_]{1,31}$/;
const READABLE_NAMES = new Set(["code", "state"]);

function isReadableCode(name: string, value: unknown): boolean {
  if (!READABLE_NAMES.has(normaliseName(name))) return false;
  if (typeof value === "number") return Number.isInteger(value) && value >= 100 && value <= 599;
  return typeof value === "string" && (ERROR_CODE.test(value) || PLAIN_WORD.test(value));
}

/**
 * `name=value` pairs: the value of a sensitive name goes. A pair whose name is not sensitive
 * consumes only its NAME: its value is looked at again as the possible start of another pair
 * (`finish: x-api-key: …`, `"detail":"password=…"`).
 */
function redactPairs(text: string): string {
  let out = "";
  let last = 0;
  KEY_VALUE.lastIndex = 0;
  for (let match = KEY_VALUE.exec(text); match !== null; match = KEY_VALUE.exec(text)) {
    const [whole, open = "", name = "", close = "", separator = "", value = ""] = match;
    if (!isSensitiveName(name)) {
      KEY_VALUE.lastIndex = match.index + open.length + name.length;
      continue;
    }
    const bare = value.replace(/^["']|["']$/g, "");
    if (isReadableCode(name, bare)) continue;
    out += `${text.slice(last, match.index)}${open}${name}${close}${separator}${REDACTED}`;
    last = match.index + whole.length;
  }
  return out + text.slice(last);
}

/**
 * THE split. Every URL token of `text` goes to the URL reducer; the text between two tokens goes
 * to `between`. Used twice with the same token grammar and the same reducer: while decoding
 * (`between` leaves the text as it is) and for the final scan (`between` is the shape scanner).
 */
function splitUrls(text: string, between: (plain: string) => string): string {
  let out = "";
  let last = 0;
  URL_TOKEN.lastIndex = 0;
  for (let match = URL_TOKEN.exec(text); match !== null; match = URL_TOKEN.exec(text)) {
    out += between(text.slice(last, match.index)) + reduceUrl(match[0]);
    last = match.index + match[0].length;
    if (match[0] === "") URL_TOKEN.lastIndex++;
  }
  return out + between(text.slice(last));
}

const asItIs = (plain: string) => plain;

/**
 * The text decoded to a fixed point, with every URL reduced at the moment it becomes visible —
 * or null when it is still changing after the bound (encodings nested too deep to follow).
 */
/**
 * The rules that go by a NAME: a failed query's parameters, a credential header's line, a bearer
 * token, this app's cookies, and `name=value` pairs. Applied to the text AS WRITTEN, before each
 * decoding step, and again once it is fully decoded — for the same reason the URLs are reduced
 * at every step: a named value must be taken while it is still one unbroken span. Decoded first,
 * `token=abc%20rest` is `token=abc rest`, the value ends at the new space, and `rest` is left
 * behind as text with no name and no shape.
 */
function redactNamed(text: string): string {
  return redactPairs(
    text
      .replace(QUERY_PARAMS, "params: [dropped]")
      .replace(HEADER_LINE, `$1: ${REDACTED}`)
      .replace(BEARER, `$1 ${REDACTED}`)
      .replace(OWN_COOKIE, "[cookie]"),
  );
}

function decodeAndReduce(text: string): string | null {
  let current = splitUrls(redactNamed(text), asItIs);
  for (let round = 0; round < MAX_DECODE_ROUNDS; round++) {
    let changed = false;
    for (const decode of DECODERS) {
      const decoded = decode(current);
      if (decoded === current) continue;
      changed = true;
      current = splitUrls(redactNamed(decoded), asItIs);
    }
    if (!changed) return current;
  }
  return DECODERS.every((decode) => decode(current) === current) ? current : null;
}

function scanOnce(text: string): string {
  const prepared = redactNamed(text);
  const out = splitUrls(prepared, scanShapes);
  return out.length > MAX_OUTPUT ? `${out.slice(0, MAX_OUTPUT)}…` : out;
}

/**
 * At most `max` characters of `text` — cut at a word boundary, never inside a word: the first
 * half of an address or of a token has no shape left to be recognised by. A text with no space
 * in its first `max` characters is one over-long word, and none of it is kept.
 */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const boundary = head.search(/\s\S*$/);
  return boundary === -1 ? "…" : `${head.slice(0, boundary)} …`;
}

/**
 * THE string redaction. Any string — a message, a URL, a header value, an object key — comes out
 * with its URLs reduced to scheme + host + path and everything shaped or named like a secret
 * replaced. Idempotent, and it never throws.
 */
export function redactText(text: string): string {
  try {
    let current = clip(withoutPrivateUse(text), MAX_INPUT);
    // Repeated until stable: removing a query or a userinfo can bring two kept pieces together,
    // and the result must read the same on a second pass (by whoever redacts it again later).
    for (let round = 0; round <= MAX_SETTLE_ROUNDS; round++) {
      const decoded = decodeAndReduce(current);
      if (decoded === null) return UNSCANNABLE;
      const next = scanOnce(decoded);
      if (round > 0 && next === current) return reveal(current);
      current = next;
    }
    return UNSCANNABLE;
  } catch {
    return UNSCANNABLE;
  }
}

/**
 * A `User-Agent` reduced to its browser family: enough to say "this breaks in Safari", not enough
 * to help single a person out. The same reduction for Worker and browser events.
 */
const FAMILIES = new Set(["Edge", "Opera", "Firefox", "Chrome", "Safari", "other"]);

export function userAgentFamily(userAgent: string): string {
  // Already a family (an event redacted a second time): as it is.
  if (FAMILIES.has(userAgent)) return userAgent;
  if (/\bEdg(?:e|A|iOS)?\//.test(userAgent)) return "Edge";
  if (/\b(?:OPR|Opera)\//.test(userAgent)) return "Opera";
  if (/\b(?:Firefox|FxiOS)\//.test(userAgent)) return "Firefox";
  if (/\b(?:Chrome|CriOS|Chromium)\//.test(userAgent)) return "Chrome";
  if (/\bSafari\//.test(userAgent)) return "Safari";
  return "other";
}

// ── the walk ───────────────────────────────────────────────────────────────────────────────────
//
// This runs LAST — in `beforeSend`, `beforeSendTransaction` and `beforeBreadcrumb` — on the item
// as it will be transmitted. By then the SDK has copied one value into several places (an
// error's message into `exception.values[].value`, the request URL into `request.url`, a
// breadcrumb, the transaction name, a tag), so nothing here depends on which field a string is
// in: every string of every own property gets `redactText`. Earlier redaction (`safeError`, the
// auth layer's `observe.ts`) is defence in depth; nothing relies on it.

// Header names whose value is the client's credentials or raw address: the property is removed.
const DROPPED_KEYS = new Set([
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "x-captcha-response",
  "cf-connecting-ip",
  "x-forwarded-for",
  "x-real-ip",
  "true-client-ip",
  "forwarded",
]);

// The ONLY strings that are not scanned: four ids, each kept solely in exactly its own shape and
// at exactly the place the SDK or this app writes it (the full path from the event's root; arrays
// add nothing to a path). Anything else at these paths is scanned like any string.
//   release              a commit hash — the link from an event to its source map
//   event_id, trace ids  what support quotes to find an event
//   tags/requestId       this app's request id (a UUID), set by the error handlers
// A stack frame's function name is NOT here: an identifier has no shape a secret could not have,
// so a long mixed-case one reads as a random run and is replaced (the file and line stay).
const HEX32 = /^[0-9a-f]{32}$/i;
const HEX16 = /^[0-9a-f]{16}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEPT_IN_SHAPE = new Map<string, RegExp>([
  ["release", /^[0-9a-f]{7,40}$/i],
  ["event_id", HEX32],
  ["contexts/trace/trace_id", HEX32],
  ["contexts/trace/span_id", HEX16],
  ["contexts/trace/parent_span_id", HEX16],
  ["tags/requestId", UUID],
]);

const PLACEHOLDER = /\[(?:redacted|token|email|code|ip|cookie|dropped|unscannable|getter|cycle)\]/g;

/** Past a bound. Caught by `redactEvent` / `redactBreadcrumb`, which fail closed. */
class RedactionBound extends Error {}

type Walk = { seen: WeakSet<object>; nodes: number; chars: number };

/** Counts a string against the event's budget of scanned characters. */
function spend(state: Walk, text: string): void {
  state.chars += Math.min(text.length, MAX_INPUT);
  if (state.chars > MAX_CHARS) throw new RedactionBound("too much text");
}

// The only whole numbers of six to eight digits that are kept: a stack frame's position, where
// the SDK writes it. Any other such number has the shape of a one-time code (a TOTP sent as a
// JSON number) and is replaced like one.
const KEPT_NUMBERS = new Set([
  "exception/values/stacktrace/frames/lineno",
  "exception/values/stacktrace/frames/colno",
  "threads/values/stacktrace/frames/lineno",
  "threads/values/stacktrace/frames/colno",
]);

function walkNumber(value: number, path: string): unknown {
  if (!Number.isFinite(value)) return null;
  if (Number.isInteger(value) && Math.abs(value) >= 100_000 && Math.abs(value) <= 99_999_999) {
    return KEPT_NUMBERS.has(path) ? value : "[code]";
  }
  return value;
}

const headerName = (name: string) => name.toLowerCase().replace(/_/g, "-");

/** An own data property's value. A getter is not run: its property reads as `[getter]`. */
function ownValue(holder: object, key: string | number): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(holder, key);
  if (descriptor === undefined) return undefined;
  return "value" in descriptor ? (descriptor.value as unknown) : "[getter]";
}

// Constructors that exist in every runtime this module runs in, or are looked up by name on the
// global object where they exist. Never `Object.prototype.toString` (it runs `Symbol.toStringTag`)
// and never the value's own `constructor.name`, `toString` or `toJSON`.
const GLOBALS = globalThis as unknown as Record<string, unknown>;
const KNOWN_CLASSES = [
  "Error",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "ArrayBuffer",
  "Headers",
  "Request",
  "Response",
  "URL",
  "URLSearchParams",
  "FormData",
  "Blob",
]
  .map((name) => [name, GLOBALS[name]] as const)
  .filter((entry): entry is readonly [string, new (...args: never[]) => unknown] => {
    return typeof entry[1] === "function";
  });

function describeObject(value: object): string {
  try {
    if (ArrayBuffer.isView(value)) return "[bytes]";
    for (const [name, constructor] of KNOWN_CLASSES) {
      if (value instanceof constructor) return `[${name}]`;
    }
  } catch {
    // A proxy whose traps throw.
  }
  return "[object]";
}

function isPlain(value: object): boolean {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * What the NAME of a value says about it: `drop` (a credential or address header), `agent`
 * (reduced to a browser family), `redact` (replaced without being read), or null (walk it).
 * `names`: the name as written and as it reads once decoded (see the note in `walk`).
 */
function ruleFor(
  names: string[],
  holder: string,
  key: string,
  item: unknown,
): "drop" | "agent" | "redact" | null {
  const headers = names.map(headerName);
  if (headers.some((name) => DROPPED_KEYS.has(name))) return "drop";
  if (headers.includes("user-agent")) return "agent";
  if (REQUEST_HOLDERS.has(holder) && REQUEST_WHOLE.has(key)) return "redact";
  if (names.some((name) => isSensitiveName(name))) {
    return names.every((name) => !isSensitiveName(name) || isReadableCode(name, item)) ? null : "redact";
  }
  return null;
}

function walk(value: unknown, state: Walk, path: string, depth: number): unknown {
  if (++state.nodes > MAX_NODES) throw new RedactionBound("too many values");
  if (typeof value === "string") {
    if (KEPT_IN_SHAPE.get(path)?.test(value)) return value;
    spend(state, value);
    return redactText(value);
  }
  if (typeof value === "number") return walkNumber(value, path);
  if (typeof value === "boolean" || value === null || value === undefined) return value;
  if (typeof value === "bigint") return "[bigint]";
  if (typeof value !== "object") return undefined; // a function, a symbol
  if (depth >= MAX_DEPTH) throw new RedactionBound("too deep");
  if (state.seen.has(value)) return "[cycle]";
  state.seen.add(value);

  if (Array.isArray(value)) {
    if (value.length > MAX_ITEMS) throw new RedactionBound("array too long");
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const item = ownValue(value, index);
      // A [name, value] pair — headers are often carried as a list of them — gets the rules of
      // its name, exactly as a property would.
      if (Array.isArray(item) && item.length === 2 && typeof ownValue(item, 0) === "string") {
        const name = ownValue(item, 0) as string;
        const paired = ownValue(item, 1);
        spend(state, name);
        // The name exactly as the walk below would emit it (a string item, not a key: not cut
        // to a key's length) — so that a second pass over the output reads the same name.
        const outName = redactText(name);
        const names = [name.replace(PLACEHOLDER, ""), outName.replace(PLACEHOLDER, "")];
        const rule = ruleFor(names, "", name, paired);
        if (rule === "drop") continue;
        if (rule === "agent") {
          if (typeof paired === "string") items.push([outName, userAgentFamily(paired)]);
          continue;
        }
        if (rule === "redact") {
          items.push([outName, paired === undefined || paired === null ? paired : REDACTED]);
          continue;
        }
      }
      items.push(walk(item, state, path, depth + 1));
    }
    return items;
  }
  if (!isPlain(value)) return describeObject(value);

  const keys = Object.keys(value);
  if (keys.length > MAX_KEYS) throw new RedactionBound("too many keys");
  const out: Record<string, unknown> = {};
  const put = (key: string, item: unknown) => {
    // defineProperty, not assignment: a key named `__proto__` must become a property.
    Object.defineProperty(out, key, { value: item, enumerable: true, writable: true, configurable: true });
  };
  const holder = path.slice(path.lastIndexOf("/") + 1);
  for (const key of keys) {
    // A key is a string like any other — and bounded like one.
    spend(state, key);
    const outKey = redactText(clip(key, MAX_KEY));
    // The rules about a key's NAME hold for the name as written AND as it reads once decoded
    // (`c%6Fokie`), without the scan's own placeholders (a key that was a token is "[token]"
    // afterwards, which is not "a key named token"). Both, so that a second pass over the
    // output decides as the first did.
    const names = [key.replace(PLACEHOLDER, ""), outKey.replace(PLACEHOLDER, "")];
    const item = ownValue(value, key);
    const rule = ruleFor(names, holder, key, item);
    if (rule === "drop") continue;
    if (rule === "agent") {
      if (typeof item === "string") put(outKey, userAgentFamily(item));
      continue;
    }
    if (rule === "redact") {
      // Replaced without being read. (Null and undefined say nothing and are kept as they are.)
      put(outKey, item === undefined || item === null ? item : REDACTED);
      continue;
    }
    const childPath = path === "" ? key : `${path}/${key}`;
    put(outKey, walk(item, state, childPath, depth + 1));
  }
  return out;
}

/** A redacted deep copy. THROWS past a bound — use `redactEvent` / `redactBreadcrumb`. */
export function redactValue<T>(value: T): T {
  return walk(value, { seen: new WeakSet(), nodes: 0, chars: 0 }, "", 0) as T;
}

export type RedactionFailure = (kind: "event" | "breadcrumb") => void;

function report(onFailure: RedactionFailure | undefined, kind: "event" | "breadcrumb"): void {
  try {
    onFailure?.(kind);
  } catch {
    // Counting a failure must not become one.
  }
}

/** A plain object's own data property, when it is a string of the given shape. */
function safeField(holder: unknown, key: string, shape: RegExp): string | undefined {
  try {
    if (holder === null || typeof holder !== "object" || Array.isArray(holder)) return undefined;
    const value = ownValue(holder, key);
    return typeof value === "string" && shape.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What is sent in place of an event that could not be redacted: a fixed message, and only the
 * fields whose value is one of ours and has exactly its own shape (the release, the environment,
 * this app's request id). Nothing else of the failing payload.
 */
function markerEvent(event: unknown): Record<string, unknown> {
  const marker: Record<string, unknown> = { message: REDACTION_FAILED, level: "error" };
  const release = safeField(event, "release", /^[0-9a-f]{7,40}$/i);
  if (release) marker.release = release;
  const environment = safeField(event, "environment", /^[a-z][a-z0-9_-]{0,31}$/i);
  if (environment) marker.environment = environment;
  let tags: unknown;
  try {
    tags = event !== null && typeof event === "object" ? ownValue(event, "tags") : undefined;
  } catch {
    tags = undefined;
  }
  const requestId = safeField(tags, "requestId", UUID);
  if (requestId) marker.tags = { requestId };
  return marker;
}

/**
 * A redacted copy of a Sentry event, for the LAST step before it is sent. Never throws and never
 * returns its input: when redaction fails or the event is past the bounds, the result is the
 * `redaction_failed` marker event and `onFailure("event")` is called.
 */
export function redactEvent<T>(event: T, onFailure?: RedactionFailure): T {
  try {
    return redactValue(event);
  } catch {
    report(onFailure, "event");
    return markerEvent(event) as T;
  }
}

/** A redacted copy of a breadcrumb — or null (the breadcrumb is dropped) and `onFailure("breadcrumb")`. */
export function redactBreadcrumb<T>(breadcrumb: T, onFailure?: RedactionFailure): T | null {
  try {
    return redactValue(breadcrumb);
  } catch {
    report(onFailure, "breadcrumb");
    return null;
  }
}
