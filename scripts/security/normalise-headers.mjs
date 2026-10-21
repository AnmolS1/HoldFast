// The normal form of a response's headers, for the header snapshot (T26 item 12,
// tests/unit/security/__snapshots__/headers.json) and for comparing a deploy against it (T30).
//
// A literal snapshot taken locally can never equal production's: the CSP nonce changes on every
// response, and the origins come from the environment. So, in every value:
//   'nonce-…'         → 'nonce-<NONCE>'
//   the files origin  → <FILES_ORIGIN>
//   the Sentry origin → <SENTRY_ORIGIN>
//   the app origin    → <APP_ORIGIN>   (the files host's Access-Control-Allow-Origin)
// Validators (ETag, Last-Modified) become <validator>; the headers a platform adds per response
// (Date, CF-Ray, CF-Cache-Status, the local simulator's log header) are left out. Names are
// lower-cased and sorted. Pure ECMAScript: it runs in Node, in workerd and in a browser.

const PER_RESPONSE = new Set(["date", "cf-ray", "cf-cache-status", "x-mf-additional-response-log"]);
const VALIDATORS = new Set(["etag", "last-modified"]);

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
    let value = String(rawValue).replace(/'nonce-[^']*'/g, "'nonce-<NONCE>'");
    for (const [pattern, token] of tokens) value = value.replace(pattern, token);
    out[name] = value;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
