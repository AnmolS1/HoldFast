// Writes coverage/routes.json: method + path of every route of both Hono apps, read from the apps
// as they are mounted (never a hand list), so a new route is in the table without an edit here.
//
//   npx tsx scripts/route-coverage/dump-routes.ts
//
// What is NOT a route here, by rule:
//   - the app host's middleware pipeline: the first `buildPipeline(core).length` entries of the
//     app's route list are exactly that pipeline (`createApp` mounts it first, nothing else);
//   - an `ALL …/*` entry: a middleware (`use("*")`) or a fallback — the JSON 404 for /api/*, the
//     SPA, the files host's middleware. A request that reaches only a fallback reached no route;
//   - `ALL /api/auth/*`, Better Auth's one wildcard, is replaced by Better Auth's own endpoints:
//     the allow-list table src/worker/auth/endpoint-policy.ts `AUTH_ENDPOINTS` (one row per
//     endpoint of the installed version; tests/unit/worker-core/auth-endpoints.test.ts holds it to
//     the installed packages).
// The Worker's modules import `cloudflare:workers`, which plain Node cannot load: a resolve hook
// hands them an empty stand-in. Nothing here runs a request.
import { mkdirSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { COVERAGE_DIR, ROUTES_FILE, routesOf, type Host, type HonoEntry } from "./routes";

const hooks = `export async function resolve(specifier, context, next) {
  if (specifier.startsWith("cloudflare:")) {
    return { url: "data:text/javascript,export const env = {};", shortCircuit: true };
  }
  return next(specifier, context);
}`;
register(`data:text/javascript,${encodeURIComponent(hooks)}`);

interface HonoLike {
  routes: HonoEntry[];
}

// Non-literal specifiers: the Worker's sources are type-checked by their own tsconfig, not this one.
const load = (path: string) => import(new URL(path, import.meta.url).href);
const [{ createApp, buildPipeline }, { createFilesHost }, { AUTH_ENDPOINTS, AUTH_PREFIX }] =
  (await Promise.all([
    load("../../src/worker/app.ts"),
    load("../../src/worker/files-host.ts"),
    load("../../src/worker/auth/endpoint-policy.ts"),
  ])) as [
    { createApp(core: unknown): HonoLike; buildPipeline(core: unknown): unknown[] },
    { createFilesHost(core: unknown): HonoLike },
    { AUTH_ENDPOINTS: ReadonlyArray<readonly [string, string, ...string[]]>; AUTH_PREFIX: string },
  ];

// The apps are only built, never asked anything: the core's dependencies are read per request.
const core = {};
const auth = { prefix: AUTH_PREFIX, endpoints: AUTH_ENDPOINTS };

const app = createApp(core);
const routes = [
  ...routesOf("app", app.routes.slice(buildPipeline(core).length), auth),
  ...routesOf("files", createFilesHost(core).routes, auth),
];

mkdirSync(COVERAGE_DIR, { recursive: true });
writeFileSync(ROUTES_FILE, `${JSON.stringify(routes, null, 2)}\n`);
const count = (host: Host) => routes.filter((route) => route.host === host).length;
console.log(
  `dump-routes: ${routes.length} routes (app ${count("app")}, files ${count("files")}) → ${ROUTES_FILE}`,
);
