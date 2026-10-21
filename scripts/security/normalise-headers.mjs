// The normal form of a response's headers, for the header snapshot (T26 item 12,
// tests/unit/security/__snapshots__/headers.json) and for comparing a deploy against it (T30).
//
// A literal snapshot taken locally can never equal production's: the CSP nonce changes on every
// response, and the origins come from the environment. So, in every value:
//   'nonce-…'         → 'nonce-<NONCE>', only for a WELL-FORMED nonce (16 bytes of base64: 22
//                       characters and "=="; not a constant such as sixteen zero bytes), and only
//                       when every nonce of that value is the same one. Anything else stays
//                       literal, so a broken nonce in production fails the comparison (T30).
//   the files origin  → <FILES_ORIGIN>
//   the Sentry origin → <SENTRY_ORIGIN>
//   the app origin    → <APP_ORIGIN>   (the files host's Access-Control-Allow-Origin)
// Validators (ETag, Last-Modified) become <validator>; the headers a platform adds per response
// (Date, CF-Ray, CF-Cache-Status, the local simulator's log header) are left out. Names are
// lower-cased and sorted. Pure ECMAScript: it runs in Node, in workerd and in a browser.

const PER_RESPONSE = new Set(["date", "cf-ray", "cf-cache-status", "x-mf-additional-response-log"]);
const VALIDATORS = new Set(["etag", "last-modified"]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const WELL_FORMED = /^[A-Za-z0-9+/]{22}==$/;
/** Fewer different characters than this in 22 is not a random value (sixteen equal bytes, …). */
const MIN_DISTINCT = 8;

/** The value with its nonce as the token — or as it is, when the nonce is not a sound one. */
function normaliseNonces(value) {
  const nonces = [...value.matchAll(/'nonce-([^']*)'/g)].map((match) => match[1]);
  if (nonces.length === 0) return value;
  const [first] = nonces;
  const sound =
    nonces.every((nonce) => nonce === first) &&
    WELL_FORMED.test(first) &&
    new Set(first.slice(0, 22)).size >= MIN_DISTINCT;
  return sound ? value.replaceAll(`'nonce-${first}'`, "'nonce-<NONCE>'") : value;
}

/**
 * @param {Headers | Record<string, string> | Iterable<[string, string]>} headers
 * @param {{ appOrigin?: string | null, filesOrigin?: string | null, sentryOrigin?: string | null }} origins
 * @returns {Record<string, string>}
 */
export function normaliseHeaders(headers, origins = {}) {
  const entries =
    typeof headers.entries === "function" && !Array.isArray(headers)
      ? [...headers.entries()]
      : Symbol.iterator in Object(headers)
        ? [...headers]
        : Object.entries(headers);
  // Longest first, and only a whole origin: never a prefix of a longer host or port.
  const tokens = [
    [origins.sentryOrigin, "<SENTRY_ORIGIN>"],
    [origins.filesOrigin, "<FILES_ORIGIN>"],
    [origins.appOrigin, "<APP_ORIGIN>"],
  ]
    .filter(([origin]) => typeof origin === "string" && origin !== "")
    .sort(([a], [b]) => b.length - a.length)
    .map(([origin, token]) => [new RegExp(`${escape(origin)}(?![\\w.:-])`, "g"), token]);

  const out = {};
  for (const [rawName, rawValue] of entries) {
    const name = rawName.toLowerCase();
    if (PER_RESPONSE.has(name)) continue;
    if (VALIDATORS.has(name)) {
      out[name] = "<validator>";
      continue;
    }
    let value = normaliseNonces(String(rawValue));
    for (const [pattern, token] of tokens) value = value.replace(pattern, token);
    out[name] = value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
