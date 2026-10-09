// ONE READING OF THE REQUEST LINE, for every layer of both hosts.
//
// A request passes through layers that each decide something by its path and method: the CSRF
// check, the cookie guard, the session gate and its endpoint allow-list, the read-only gates, the
// rate limits, Hono's router, and — for /api/auth/* — Better Auth's own router. Each parses for
// itself: Hono matches on a percent-DECODED path, `new URL()` keeps escapes but folds dot
// segments and backslashes, Better Auth's router takes `new URL(request.url).pathname` and has
// its own rule for slashes (better-call/dist/router.mjs:29–46). A path that two of them read
// differently is counted by one and served by another.
//
// So the path is read ONCE, here, in the first middleware of both hosts, and a request whose path
// is not already in canonical form is answered `404 not_found` — before any limiter, any cookie,
// the database, the router and Better Auth. In canonical form there is nothing left to read
// differently: the raw path, the decoded path and what Better Auth routes on are the same bytes.
//
// THE CANONICAL FORM of a path (the query string is not part of it):
//   - it starts with `/`, and is at most MAX_PATH_CHARS long;
//   - every character is an ASCII letter or digit or one of  - . _ ~ ! $ & ' ( ) * + , ; = : @
//     — so NO percent-encoding at all (no `%2F`, `%5C`, `%2E`, no encoded letter, no encoded
//     UTF-8), no backslash, no control character, no space, nothing outside ASCII. No route of
//     this Worker has a segment that needs an escape: ids, codes and tokens are URL-safe by
//     construction, and file names never travel in a path;
//   - no empty segment (`//`), no dot segment (`.` or `..`);
//   - no trailing slash, except the root `/` itself — uniformly, on both hosts;
//   - `new URL()` of the request's URL has exactly this pathname (it changed nothing).
//   Letter case is NOT folded: `/API/…` is a different path, which no route has.
//
// THE METHOD. GET, HEAD, POST, PUT, PATCH, DELETE and OPTIONS exist; anything else is a 404. A
// HEAD is a GET for every gate (`requestMethod`). Under /api/auth/* only the exact (method, path)
// pairs of the installed handler exist (auth/endpoint-policy.ts) — plus the admin plugin's
// paths, which routes/auth.ts refuses with an audit row. No layer honours a method override:
// `X-HTTP-Method-Override`, `X-Method-Override` and a `_method` parameter are data like any other
// (neither Hono's core nor better-call reads them, and Hono's opt-in `methodOverride` middleware
// is not mounted — tests/unit/worker-core/canonical.test.ts holds all of that).
//
// EVERY LATER LAYER reads the path and the method through `requestPath(c)` and
// `requestMethod(c)`. Nothing under middleware/, auth/, routes/ or files-host.ts may read
// `c.req.path`, `c.req.url`, `c.req.method` or `request.url` to DECIDE anything — a source scan
// (canonical.test.ts) fails on a new one.

import type { Context, MiddlewareHandler } from "hono";
import { isAdminPluginPath } from "../auth/admin-gate";
import { AUTH_PREFIX, isAuthEndpoint, isAuthPath } from "../auth/endpoint-policy";
import { AppError } from "../services/errors";
import { writeMetric } from "../services/metrics";
import type { AppEnv } from "../services/request-context";
import { apiHeaders, filesHeaders } from "./security-headers";

export const MAX_PATH_CHARS = 2048;
export const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);

const SEGMENT = /^[A-Za-z0-9._~!$&'()*+,;=:@-]+$/;
// scheme://authority, then the path up to the query or the fragment — as TEXT, before any parser.
const RAW_PATH = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#\\]*([^?#]*)/;

/** The path of `url` when it is in canonical form (see the header), else null. */
export function canonicalPath(url: string): string | null {
  const raw = RAW_PATH.exec(url)?.[1];
  if (raw === undefined || raw.length === 0 || raw.length > MAX_PATH_CHARS || raw[0] !== "/") return null;
  if (raw !== "/") {
    for (const segment of raw.slice(1).split("/")) {
      // An empty segment is `//` or a trailing slash.
      if (segment === "." || segment === ".." || !SEGMENT.test(segment)) return null;
    }
  }
  let parsed: string;
  try {
    parsed = new URL(url).pathname;
  } catch {
    return null;
  }
  return parsed === raw ? raw : null;
}

/** GET for a HEAD; otherwise the method, upper-cased; null for one that does not exist here. */
export function canonicalMethod(method: string): string | null {
  const upper = method.toUpperCase();
  if (!METHODS.has(upper)) return null;
  return upper === "HEAD" ? "GET" : upper;
}

/** Is this (canonical) request something the app host can have a handler for at all? */
export function existsOnAppHost(method: string, path: string): boolean {
  if (!path.startsWith(`${AUTH_PREFIX}/`)) return true;
  const relative = path.slice(AUTH_PREFIX.length);
  if (isAuthEndpoint(method, relative)) return true;
  // A path under /admin/ that is no endpoint at all is refused — and audited — by routes/auth.ts.
  return isAdminPluginPath(relative) && !isAuthPath(relative);
}

type Canonical = { path: string; method: string };
const read = new WeakMap<Request, Canonical | null>();

function canonicalOf(c: Context<AppEnv>): Canonical | null {
  const request = c.req.raw;
  let found = read.get(request);
  if (found === undefined) {
    const path = canonicalPath(request.url);
    const method = canonicalMethod(request.method);
    found = path !== null && method !== null ? { path, method } : null;
    read.set(request, found);
  }
  return found;
}

/** THE path of the request: canonical, byte-identical for every layer. Throws 404 if it has none. */
export function requestPath(c: Context<AppEnv>): string {
  const found = canonicalOf(c);
  if (!found) throw new AppError("not_found");
  return found.path;
}

/** THE method of the request for a decision: upper-case, and `GET` for a HEAD. */
export function requestMethod(c: Context<AppEnv>): string {
  const found = canonicalOf(c);
  if (!found) throw new AppError("not_found");
  return found.method;
}

async function drain(request: Request): Promise<void> {
  const declared = request.headers.get("content-length");
  if (request.body === null || declared === null || !/^\d+$/.test(declared) || Number(declared) > 65536) {
    return;
  }
  try {
    await request.arrayBuffer();
  } catch {
    // Nothing left to read.
  }
}

/**
 * The first middleware of a host. A request that is not canonical — or, on the app host, that
 * names no (method, path) the auth handler has — is answered 404 here: nothing after this runs.
 */
export function canonicalRequest(host: "app" | "files"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const found = canonicalOf(c);
    if (found && (host === "files" || existsOnAppHost(found.method, found.path))) return next();
    writeMetric(c.env, "request", { outcome: "4xx", route: "", ms: 0 });
    // A small unread body is read to its end (middleware/request-context.ts explains why).
    await drain(c.req.raw);
    // The host's own header set (nothing after this runs, the header middleware included).
    if (host === "files") {
      return new Response("Not found\n", {
        status: 404,
        headers: { ...filesHeaders(c.env), "content-type": "text/plain; charset=utf-8" },
      });
    }
    return Response.json(
      { error: "not_found", message: "Not found.", requestId: crypto.randomUUID() },
      { status: 404, headers: apiHeaders(c.env) },
    );
  };
}
