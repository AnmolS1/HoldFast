// Worker tests: they run inside workerd through @cloudflare/vitest-plugin, against the full
// wrangler.jsonc, with local simulations of R2, Queues, Images, rate limits and Hyperdrive (the
// last one pointing at this checkout's own local Postgres database).
//
//   npm test                                                    both configs
//   npx vitest run -c vitest.workers.config.ts tests/unit/<area>
//
// `npx vitest run <path>` WITHOUT `-c vitest.workers.config.ts` uses vitest.config.ts and runs zero
// Worker tests.
//
// Storage isolation is per test FILE: tests in one file share R2, queue and Durable Object state.
// Postgres is not isolated at all — create rows with random ids, never assert on table-wide counts.
// Custom environments are not supported here; jsdom and plain-Node tests live in vitest.config.ts.
import { fileURLToPath } from "node:url";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { forbidDotEnvFallback, localDbName, localDbUrl } from "./tests/setup/local-env.ts";
import { testVars } from "./tests/setup/test-vars.ts";

forbidDotEnvFallback();

const db = localDbName();
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
    name: "workers",
    include: ["tests/unit/**/*.test.{ts,tsx}"],
    exclude: [
      "tests/unit/client/**",
      "tests/unit/db/**",
      "tests/unit/e2e-harness/**",
      "tests/unit/harness/client/**",
      "tests/unit/harness/node/**",
    ],
    // The name of this checkout's database, for tests that assert which one they are talking to.
    provide: { holdfastDb: db },
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
