// Route coverage: the pieces the dump, the hit collectors and the diff share. Pure functions only
// (the unit tests in tests/unit/e2e-harness/route-coverage.test.ts run them on made-up sets).
//
//   coverage/routes.json             every route of both Hono apps (dump-routes.ts)
//   coverage/routes-hit.<source>.jsonl   one line per request a test made that the Worker answered
//                                    (e2e: tests/e2e/fixtures/route-hits.ts; Vitest: the reporter)
//   diff.ts                          fails on any route that no hit matches, the allowlist apart
//
// A hit holds the CONCRETE method and path of a request; the diff matches it to a route pattern
// itself. A collector then needs no route table, and one source per file means a run replaces its
// own hits and never counts a stale file of another run's as its own.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export type Host = "app" | "files";

/** One route: `path` is Hono's own spelling, `:id{regex}` parameters and a trailing `/*` included. */
export interface Route {
  host: Host;
  method: string;
  path: string;
}

/**
 * One request a test made. `host` is null when the collector cannot tell. Only a hit whose ROUTE
 * HANDLER ran counts (`handler: true`; review M2): a middleware's refusal covers nothing.
 */
export interface Hit {
  source: string;
  host: Host | null;
  method: string;
  path: string;
  status: number;
  /** The route's own handler ran (the Vitest hook; the e2e collector once the Worker stamps it). */
  handler?: boolean;
  /** The test file that made it (Vitest). */
  file?: string;
}

/**
 * Routes no test needs to reach, each with its reason. Explicit: a route is never left out by a
 * pattern.
 */
export const ALLOWLIST: ReadonlyArray<{ host: Host; method: string; path: string; reason: string }> = [
  {
    host: "app",
    method: "GET",
    path: "/api/_test/outbox",
    reason: "the memory outbox of the test harness (mounted only under EMAIL_TRANSPORT=memory)",
  },
];

export const ROUTES_FILE = "coverage/routes.json";
export const HITS_PREFIX = "routes-hit.";
export const COVERAGE_DIR = "coverage";

/** Splits a Hono path on "/" outside `{…}` (a parameter's pattern may hold braces). */
function segments(path: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of path) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (char === "/" && depth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  parts.push(current);
  return parts.filter((part) => part !== "");
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A Hono path as an anchored RegExp: `:name{re}` → `(?:re)`, `:name` → one segment, a last `*` → the rest. */
export function matcher(path: string): RegExp {
  const parts = segments(path);
  let source = "";
  parts.forEach((part, index) => {
    if (part === "*") {
      source += index === parts.length - 1 ? "(?:/.*)?" : "/[^/]+";
      return;
    }
    if (part.startsWith(":")) {
      const brace = part.indexOf("{");
      const pattern = brace === -1 ? "[^/]+" : part.slice(brace + 1, part.lastIndexOf("}"));
      source += `/(?:${pattern})`;
      return;
    }
    source += `/${escape(part)}`;
  });
  return new RegExp(`^${source === "" ? "/" : source}$`);
}

/** Hono answers HEAD from a GET route. */
function methodMatches(route: string, request: string): boolean {
  return route === request || route === "ALL" || (route === "GET" && request === "HEAD");
}

/** One entry of a Hono app's `routes` (a route with a validator in front is two entries). */
export interface HonoEntry {
  method: string;
  path: string;
}

/** Better Auth's endpoints, as src/worker/auth/endpoint-policy.ts lists them. */
export interface AuthTable {
  /** `/api/auth`. */
  prefix: string;
  /** `[methods ("GET,POST"), path relative to the prefix, …]`. */
  endpoints: ReadonlyArray<readonly [string, string, ...string[]]>;
}

/**
 * The routes among a mounted app's entries (dump-routes.ts says what is left out and why): an
 * `ALL …/*` entry is a middleware or a fallback, Better Auth's `ALL <prefix>/*` stands for the
 * endpoints of `auth`, and a HEAD entry beside a GET one for the same path is that GET route.
 */
export function routesOf(host: Host, entries: readonly HonoEntry[], auth: AuthTable): Route[] {
  const seen = new Set<string>();
  const routes: Route[] = [];
  const add = (method: string, path: string) => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    routes.push({ host, method, path });
  };
  // Hono answers a HEAD request with the GET route (hono-base.js dispatches HEAD as GET), so a
  // HEAD entry declared next to a GET one for the same path is never reached on its own.
  const gets = new Set(entries.filter((entry) => entry.method === "GET").map((entry) => entry.path));
  for (const { method, path } of entries) {
    if (method === "HEAD" && gets.has(path)) continue;
    if (method === "ALL" && path === `${auth.prefix}/*`) {
      for (const [methods, relative] of auth.endpoints) {
        for (const one of methods.split(",")) add(one, `${auth.prefix}${relative}`);
      }
      continue;
    }
    if (method === "ALL" && path.endsWith("/*")) continue;
    add(method, path);
  }
  return routes;
}

export const routeKey = (route: Route) => `${route.host} ${route.method} ${route.path}`;

/**
 * The routes in `routes` (in mount order) that no hit reaches. A hit counts for the FIRST route
 * that matches it, as Hono dispatches it; a hit with no host is tried against both hosts.
 */
export function uncovered(routes: readonly Route[], hits: readonly Hit[], allowlist = ALLOWLIST): Route[] {
  const compiled = routes.map((route) => ({ route, test: matcher(route.path) }));
  const reached = new Set<string>();
  for (const hit of hits) {
    if (hit.handler !== true) continue;
    for (const host of hit.host === null ? (["app", "files"] as const) : [hit.host]) {
      const first = compiled.find(
        ({ route, test }) =>
          route.host === host && methodMatches(route.method, hit.method) && test.test(hit.path),
      );
      if (first) reached.add(routeKey(first.route));
    }
  }
  const allowed = new Set(allowlist.map((entry) => routeKey(entry)));
  return routes.filter((route) => !reached.has(routeKey(route)) && !allowed.has(routeKey(route)));
}

/** Allowlist entries that name no route any more: a stale entry fails the diff too. */
export function staleAllowlist(routes: readonly Route[], allowlist = ALLOWLIST): string[] {
  const known = new Set(routes.map(routeKey));
  return allowlist.map((entry) => routeKey(entry)).filter((key) => !known.has(key));
}

/**
 * Was this response written by the Worker (not by a test's `route.fulfill` mock)? Both hosts set a
 * Content-Security-Policy on every answer (src/worker/middleware/security-headers.ts); a mock sets none.
 * The HTML document is not an API answer and does not count.
 */
export function answeredByWorker(headers: Record<string, string>): boolean {
  const csp = headers["content-security-policy"] ?? "";
  return csp.startsWith("default-src 'none'") || csp.startsWith("sandbox;");
}

/** Parses hit lines; a line that is not a hit is an error (a collector bug must not pass quietly). */
export function parseHits(text: string, file: string): Hit[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      const hit = JSON.parse(line) as Partial<Hit>;
      if (
        typeof hit.source !== "string" ||
        typeof hit.method !== "string" ||
        typeof hit.path !== "string" ||
        typeof hit.status !== "number" ||
        !(hit.handler === undefined || typeof hit.handler === "boolean") ||
        !(hit.host === null || hit.host === "app" || hit.host === "files")
      ) {
        throw new Error(`${file}:${index + 1}: not a hit: ${line}`);
      }
      return hit as Hit;
    });
}

/** Every `coverage/routes-hit.*.jsonl`, with its line count and age, for the diff to print. */
export function readHitFiles(dir = COVERAGE_DIR): HitFile[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(HITS_PREFIX) && name.endsWith(".jsonl"))
    .sort()
    .map((name) => {
      const file = join(dir, name);
      return { file, hits: parseHits(readFileSync(file, "utf8"), file), modified: statSync(file).mtime };
    });
}

/** One hit as a line of a hit file. */
export const hitLine = (hit: Hit) => `${JSON.stringify(hit)}\n`;

export interface HitFile {
  file: string;
  hits: Hit[];
  modified: Date;
}

/** What diff.ts prints and fails on: `problems` empty means every route was reached. */
export function diffReport(
  routes: readonly Route[],
  files: readonly HitFile[],
  required: readonly string[] = [],
  allowlist = ALLOWLIST,
  /** When routes.json was written (the start of this coverage run); an older hit file is stale. */
  runStarted: Date | null = null,
): { lines: string[]; problems: string[] } {
  const lines: string[] = [];
  const problems: string[] = [];
  const stale = runStarted === null ? [] : files.filter(({ modified }) => modified < runStarted);
  for (const { file } of stale) problems.push(`${file} is older than ${ROUTES_FILE}: not from this run`);
  files = files.filter((file) => !stale.includes(file));
  if (files.length === 0)
    problems.push(`no hit file (${COVERAGE_DIR}/${HITS_PREFIX}*.jsonl): nothing was collected`);
  for (const { file, hits, modified } of files) {
    lines.push(`${file}: ${hits.length} hits, written ${modified.toISOString()}`);
  }
  for (const source of required) {
    const found = files.find(({ file }) => file.endsWith(`${HITS_PREFIX}${source}.jsonl`));
    if (!found)
      problems.push(`no hits from "${source}" (${COVERAGE_DIR}/${HITS_PREFIX}${source}.jsonl is missing)`);
    else if (found.hits.length === 0) problems.push(`no hits from "${source}" (${found.file} is empty)`);
  }
  const missing = uncovered(
    routes,
    files.flatMap(({ hits }) => hits),
    allowlist,
  );
  for (const route of missing) problems.push(`uncovered: ${route.host} ${route.method} ${route.path}`);
  for (const key of staleAllowlist(routes, allowlist)) problems.push(`allowlist names no route: ${key}`);
  lines.push(
    `${routes.length} routes, ${missing.length} uncovered ` +
      `(allowlisted: ${allowlist.map((entry) => `${entry.method} ${entry.path}`).join(", ") || "none"})`,
  );
  return { lines, problems };
}
