// Worker tests: they run inside workerd through @cloudflare/vitest-plugin, against the full
// wrangler.jsonc, with local simulations of R2, Queues, Images, rate limits and Hyperdrive (the
// last one pointing at this checkout's own local Postgres database).
//
//   npm test                                                    both configs
//   npx vitest run -c vitest.workers.config.ts tests/unit/<area>
//   HOLDFAST_TEST_WORKERS=3 npm test                            at most 3 test files at once
//
// `npx vitest run <path>` WITHOUT `-c vitest.workers.config.ts` uses vitest.config.ts and runs zero
// Worker tests.
//
// Storage isolation is per test FILE: tests in one file share R2, queue and Durable Object state.
// Postgres is not isolated at all — create rows with random ids, never assert on table-wide counts.
//
// TABLE-WIDE TESTS. A test of code that acts on every row of a table (a purge of everything due,
// a sweep, a reconcile over all users) cannot share the database with files that are writing to
// it. Name such a file `*.tablewide.test.ts`: it is LEFT OUT of the run above and runs in the
// third step of `npm test`, after the other two have finished, one file at a time:
//
//   HOLDFAST_TABLEWIDE=1 npx vitest run -c vitest.workers.config.ts            all of them
//   HOLDFAST_TABLEWIDE=1 npx vitest run -c vitest.workers.config.ts <path>     one
//
// Without the variable a table-wide path is "No test files found" (exit 1), never a pass. The
// rows other files left behind are still there: only nothing else is writing while it runs.
// Custom environments are not supported here; jsdom and plain-Node tests live in vitest.config.ts.
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { forbidDotEnvFallback, localDbName, localDbUrl } from "./tests/setup/local-env.ts";
import { testVars } from "./tests/setup/test-vars.ts";

forbidDotEnvFallback();

const db = localDbName();
const TABLEWIDE = "tests/unit/**/*.tablewide.test.{ts,tsx}";
const tablewide = process.env.HOLDFAST_TABLEWIDE === "1";

/** HOLDFAST_TEST_WORKERS caps how many test files run at once; unset = Vitest's own default. */
function workersCap(): { maxWorkers?: number } {
  const raw = process.env.HOLDFAST_TEST_WORKERS;
  if (raw === undefined || raw === "") return {};
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`HOLDFAST_TEST_WORKERS must be a whole number of at least 1, not "${raw}"`);
  }
  return { maxWorkers: count };
}
const modulePath = (path: string) => fileURLToPath(new URL(`./node_modules/${path}`, import.meta.url));

export default defineConfig({
  // Per checkout, not in the node_modules that worktrees share (see vite.config.ts).
  cacheDir: ".wrangler/vitest-workers",
  resolve: {
    alias: {
      // node-postgres (`pg`) does not load in this plugin without these two. Its CommonJS files
      // `require("pg-protocol")` and `require("pg-cloudflare")`; the plugin resolves the first to
      // the package's ESM wrapper ("Cannot use import statement outside a module") and the second
      // to its empty non-workerd build ("Cannot destructure property 'CloudflareSocket'").
      // Pointing both at their CommonJS builds is what `vite dev` and a deployed Worker load anyway.
      "pg-protocol": modulePath("pg-protocol/dist/index.js"),
      "pg-cloudflare": modulePath("pg-cloudflare/dist/index.js"),
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Layered over wrangler.jsonc `vars` and over whatever the checkout's .dev.vars holds.
        bindings: { ...testVars },
        hyperdrives: { HYPERDRIVE: localDbUrl(db) },
        // wrangler.jsonc names no assets directory (the Vite plugin supplies the built SPA), so
        // without this there is no ASSETS binding at all. A static shell stands in for the SPA;
        // `binding`, SPA fallback and run_worker_first still come from wrangler.jsonc.
        assets: { directory: "./tests/fixtures/assets" },
      },
    }),
  ],
  test: {
    name: tablewide ? "tablewide" : "workers",
    include: [tablewide ? TABLEWIDE : "tests/unit/**/*.test.{ts,tsx}"],
    exclude: [
      "tests/unit/client/**",
      "tests/unit/db/**",
      "tests/unit/e2e-harness/**",
      "tests/unit/harness/client/**",
      "tests/unit/harness/node/**",
      ...(tablewide ? [] : [TABLEWIDE]),
    ],
    // One table-wide file at a time; everything else in parallel, up to HOLDFAST_TEST_WORKERS.
    ...(tablewide ? { fileParallelism: false } : workersCap()),
    // The name of this checkout's database, for tests that assert which one they are talking to.
    // `process.env` of this process does not reach a test inside workerd: what a test needs from
    // it is provided here. `capTests`: the 2,000,000,000-byte tests run only when asked for
    // (HOLDFAST_CAP_TESTS=1) — a file gates itself with `describe.skipIf(!inject("capTests"))`.
    provide: { holdfastDb: db, capTests: process.env.HOLDFAST_CAP_TESTS === "1" },
    // Each file starts with its own bucket's rollback detector in step (see the file).
    setupFiles: ["./tests/setup/workers-generation.ts"],
    // Closing a database client (`client.end()` in pg, `sql.end()` in postgres.js) makes the
    // driver's pending socket read reject with exactly this message, after the test has passed.
    // Vitest would fail the whole run on it. Only this one message is let through.
    onUnhandledError(error) {
      if (error.message === "This socket has been closed.") return false;
    },
    coverage: {
      // V8 coverage does not work inside workerd.
      provider: "istanbul",
      include: ["src/worker/**", "src/shared/**"],
      reportsDirectory: "coverage/workers",
    },
  },
});
