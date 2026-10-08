import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// When there is no .dev.vars, the Cloudflare plugin falls back to loading `.env` into the Worker's
// local `env`. `.env` is not a Worker vars file in this repo, so that fallback is switched off:
// local Worker vars come from .dev.vars (written by scripts/dev-env.sh) and nowhere else.
process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV ??= "false";

function git(...args: string[]): string | undefined {
  try {
    const out = execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return out.trim() || undefined;
  } catch {
    return undefined;
  }
}

// Build stamp served at GET /__meta. CI may supply the values; otherwise they come from git.
const commit =
  process.env.HOLDFAST_GIT_SHA ?? process.env.GITHUB_SHA ?? git("rev-parse", "HEAD") ?? "unknown";
const branch =
  process.env.HOLDFAST_GIT_BRANCH ??
  process.env.GITHUB_REF_NAME ??
  git("rev-parse", "--abbrev-ref", "HEAD") ??
  "unknown";
const builtAt = process.env.HOLDFAST_BUILT_AT ?? new Date().toISOString();
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as {
  version: string;
};

// One port per checkout. HOLDFAST_PORT is the single source; HOLDFAST_DEV_PORT is an alias for it.
// The Worker dispatches on the host including its port, so the port must match .dev.vars.
const port = Number(process.env.HOLDFAST_DEV_PORT ?? process.env.HOLDFAST_PORT ?? 5173);
// Bind IPv4 loopback explicitly. Vite's default ("localhost") binds whichever family the OS lists
// first (::1 only on macOS), and then `curl --resolve files.localhost:<port>:127.0.0.1` cannot connect.
// Open the app as http://localhost:<port>: Vite prints the 127.0.0.1 URL, which the Worker answers
// with 421 because its host is not APP_ORIGIN.
const host = "127.0.0.1";
// The Worker debugger gets its own port per checkout. Left to the default, two dev servers that
// start at the same moment (two worktrees running e2e) both find 9229 taken, both pick the same
// next free port, and one of them dies with EADDRINUSE.
const inspectorPort = port + 4000;

export default defineConfig({
  // Vite's dependency cache defaults to node_modules/.vite, and worktrees share one node_modules
  // through a symlink: two checkouts with different imports would rewrite each other's cache and
  // break each other's running dev server. Keep it inside the checkout (.wrangler/ is ignored).
  cacheDir: ".wrangler/vite",
  plugins: [react(), cloudflare({ inspectorPort })],
  server: { host, port, strictPort: true },
  preview: { host, port, strictPort: true },
  define: {
    __GIT_SHA__: JSON.stringify(commit),
    __GIT_BRANCH__: JSON.stringify(branch),
    __BUILT_AT__: JSON.stringify(builtAt),
    __APP_VERSION__: JSON.stringify(version),
  },
});
