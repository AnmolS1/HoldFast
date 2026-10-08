// End-to-end tests against `vite dev`.
//
//   npm run e2e                                  everything under tests/e2e
//   npm run e2e -- tests/e2e/harness.spec.ts
//
// ONE PORT PER CHECKOUT. HOLDFAST_PORT is the single source (main tree 5173, worktrees 5180–5199);
// HOLDFAST_E2E_PORT is only an alias. Playwright always starts its OWN fresh server on that port
// and never reuses one: a reused server may be another checkout's. So a dev server and an e2e run
// cannot be up at the same time in one checkout — stop `npm run dev` first.
//
// HOLDFAST_E2E_REAL is not read here: it reaches the specs through the environment untouched.
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, devices } from "@playwright/test";
import { preflight } from "./tests/setup/e2e-preflight";
import {
  appOrigin,
  e2ePort,
  forbidDotEnvFallback,
  HYPERDRIVE_OVERRIDE,
  localDbName,
  localDbUrl,
} from "./tests/setup/local-env";

forbidDotEnvFallback();

const root = dirname(fileURLToPath(import.meta.url));
const port = e2ePort();
const db = localDbName();
const baseURL = appOrigin(port);

// Once, in the process that will start the server. Playwright loads this file again in its
// worker processes, by which time the port is (rightly) held by its own server.
if (process.env.HOLDFAST_E2E_PREFLIGHT !== String(port)) {
  preflight(root, port);
  process.env.HOLDFAST_E2E_PREFLIGHT = String(port);
}

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  globalSetup: "./tests/setup/e2e-global-setup.ts",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    // Below the 1024 px mobile breakpoint.
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run dev -- --port ${port} --strictPort`,
    // `localhost`, not 127.0.0.1: the Worker answers any other host with 421. /api/health is
    // answered by the Worker itself, so "ready" means the Worker is up, not just Vite.
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
    env: {
      HOLDFAST_PORT: String(port),
      HOLDFAST_DEV_PORT: String(port),
      HOLDFAST_DB: db,
      // Read from the process environment, never from .dev.vars.
      [HYPERDRIVE_OVERRIDE]: localDbUrl(db),
      CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
    },
  },
});
