// Playwright globalSetup:
//
// 1. Recreate this checkout's local database (HOLDFAST_DB) and apply the migrations. A fresh
//    checkout has no schema, and a missing schema surfaces as a 500 that looks like a missing env
//    var. Runs after Playwright has started its dev server, which is fine: the Worker opens its
//    database connection per request.
//
// 2. WARM THE DEV SERVER — the cause of the "two tests time out together" flake. Playwright
//    considers the server ready when `/__meta` answers: the Worker is up, and NOTHING of the
//    client has been built yet. `vite dev` transforms modules on demand, on one thread: the
//    first page load compiles the whole client module graph (React, MUI, the router, every
//    screen it imports) and the first /api/auth request loads Better Auth into the Worker. On an
//    idle machine that is a few seconds; on a loaded one (CI, or anything else using the CPUs)
//    it is 20–30 s — and it was billed to whichever tests happened to run first, inside their
//    30 s budget: the first test of each project, started at the same moment, both failing with
//    "page.goto: Test timeout of 30000ms exceeded". (Measured: 12 of 12 runs of the longest test
//    failed that way under load with a cold server; a single one took 21 s instead of 4.)
//    So the one-off cost is paid HERE, once, with a budget of its own, before any test's clock
//    starts. No test timeout is raised: a test that is slow once the server is warm still fails.
//
// 3. FORGET THE ROLLBACK DETECTOR'S OBJECT. The bucket in `.wrangler/state` outlives the database
//    reset of step 1, and the hourly slot an earlier run fired (harness.spec.ts) left the detector's
//    generation object in it (src/worker/jobs/reconcile.ts, GENERATION_KEY). A fresh database (0)
//    behind a left-over object (n > 0) is exactly what a restore looks like: every destroy of the
//    run — "delete forever", a purge — would take the held path. Deleted with the reset, the two
//    agree again ("first run ever"). Through wrangler's local mode on the dev server's own state
//    directory: it works while the dev server is up, and it never reaches Cloudflare (`--local`).
import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type FullConfig } from "@playwright/test";
import { localDbName } from "./local-env";

/** The local bucket (wrangler.jsonc, top-level `r2_buckets`) and the detector's key in it. */
export const LOCAL_BUCKET = "holdfast-files-dev";
export const GENERATION_OBJECT = "sys/reconcile-generation";

/** Every screen a test opens first, and the API modules behind them. */
const WARM_PAGES = ["/login", "/signup", "/forgot-password", "/verify-email", "/reset-password", "/"];
const WARM_API = ["/api/public/config", "/api/auth/get-session", "/api/health"];
/** The whole warm-up, however slow the machine: it happens once. */
export const WARM_UP_BUDGET_MS = 240_000;

async function warm(baseURL: string): Promise<void> {
  const started = Date.now();
  const deadline = started + WARM_UP_BUDGET_MS;
  const left = () => Math.max(1_000, deadline - Date.now());
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ baseURL });
    for (const path of WARM_API) {
      await context.request.get(path, { timeout: left(), failOnStatusCode: false });
    }
    const page = await context.newPage();
    for (const path of WARM_PAGES) {
      // `load` and then the app's own root: the shell has rendered, so its modules are built.
      await page.goto(path, { timeout: left(), waitUntil: "load" });
      await page.locator("#root > *").first().waitFor({ state: "attached", timeout: left() });
    }
    // Once more: the second load is the one a test will see (and Vite may have re-optimised and
    // reloaded during the first).
    const again = Date.now();
    await page.goto(WARM_PAGES[0]!, { timeout: left(), waitUntil: "load" });
    await page.locator("#root > *").first().waitFor({ state: "attached", timeout: left() });
    console.log(
      `e2e warm-up: ${((again - started) / 1000).toFixed(1)} s to build the client and load the Worker's auth modules; ` +
        `a page load is now ${((Date.now() - again) / 1000).toFixed(1)} s`,
    );
  } finally {
    await browser.close();
  }
}

/**
 * Step 3. A missing object is no error; a failing wrangler fails the run. And it is READ BACK: an
 * object still there after the delete (the CLI and the dev server no longer sharing one state
 * directory, a key spelled differently) fails the run loudly — otherwise every destroy of the run
 * would take the held path while the setup said nothing.
 */
function forgetGenerationObject(root: string): void {
  const wrangler = resolve(root, "node_modules/.bin/wrangler");
  const env = { ...process.env, CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false" };
  const target = `${LOCAL_BUCKET}/${GENERATION_OBJECT}`;
  execFileSync(wrangler, ["r2", "object", "delete", target, "--local"], { cwd: root, stdio: "inherit", env });
  const read = spawnSync(wrangler, ["r2", "object", "get", target, "--local", "--pipe"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  if (read.status === 0) {
    throw new Error(
      `e2e setup: ${target} is still in the local bucket after its delete — the rollback detector would hold every destroy of this run`,
    );
  }
  if (!/The specified key does not exist/.test(`${read.stderr}${read.stdout}`)) {
    throw new Error(
      `e2e setup: could not read ${target} back from the local bucket (wrangler exit ${read.status})`,
    );
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  execFileSync(resolve(root, "scripts/db-reset.sh"), {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, HOLDFAST_DB: localDbName() },
  });
  forgetGenerationObject(root);
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error("e2e warm-up: no baseURL");
  await warm(baseURL);
}
