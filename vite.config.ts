import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { extname, join } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

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

// pdf.js's data files: the binary Adobe CMaps (CJK text), the standard fonts (a document that does
// not embed Helvetica, Times…), the image decoders as WebAssembly (JPEG 2000, JBIG2, colour
// profiles) and the one ICC profile. pdf.js asks for them by URL; they are this app's own static
// files under /pdfjs/ — served from node_modules in dev, emitted into the client build. What is
// NOT served: pdf.js's scripting engine (wasm/quickjs-*), which nothing here may run.
const PDFJS_URL_BASE = "/pdfjs/";
const PDFJS_DATA: Record<string, (name: string) => boolean> = {
  cmaps: (name) => name.endsWith(".bcmap") || name === "LICENSE",
  standard_fonts: (name) => /\.(pfb|ttf)$/.test(name) || name.startsWith("LICENSE"),
  wasm: (name) => !name.startsWith("quickjs") && (/\.(wasm|js)$/.test(name) || name.startsWith("LICENSE")),
  iccs: (name) => name.endsWith(".icc") || name === "LICENSE",
};
const PDFJS_TYPES: Record<string, string> = {
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".icc": "application/vnd.iccprofile",
};

function pdfjsData(): Plugin {
  const root = join(realpathSync("node_modules"), "pdfjs-dist");
  /** The file a `/pdfjs/<dir>/<name>` path names, or null: listed directories and names only. */
  const fileOf = (urlPath: string): string | null => {
    const match = /^\/pdfjs\/([a-z_]+)\/([A-Za-z0-9._-]+)$/.exec(urlPath);
    if (!match) return null;
    const [, dir, name] = match as unknown as [string, string, string];
    const allowed = PDFJS_DATA[dir];
    if (!allowed || !allowed(name)) return null;
    const file = join(root, dir, name);
    return existsSync(file) ? file : null;
  };
  return {
    name: "holdfast:pdfjs-data",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = (request.url ?? "").split("?")[0] ?? "";
        if (!path.startsWith(PDFJS_URL_BASE)) return next();
        const file = fileOf(path);
        if (!file) {
          response.statusCode = 404;
          response.setHeader("content-type", "text/plain");
          response.end("Not found.");
          return;
        }
        response.setHeader("content-type", PDFJS_TYPES[extname(file)] ?? "application/octet-stream");
        response.end(readFileSync(file));
      });
    },
    generateBundle() {
      // The client build only; the Worker's bundle has no use for them.
      if (this.environment.name !== "client") return;
      for (const [dir, allowed] of Object.entries(PDFJS_DATA)) {
        for (const name of readdirSync(join(root, dir)).sort()) {
          if (!allowed(name)) continue;
          this.emitFile({
            type: "asset",
            fileName: `pdfjs/${dir}/${name}`,
            source: readFileSync(join(root, dir, name)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  // Vite's dependency cache defaults to node_modules/.vite, and worktrees share one node_modules
  // through a symlink: two checkouts with different imports would rewrite each other's cache and
  // break each other's running dev server. Keep it inside the checkout (.wrangler/ is ignored).
  cacheDir: ".wrangler/vite",
  plugins: [
    pdfjsData(),
    react(),
    cloudflare({
      inspectorPort,
      // E2E only (playwright.config.ts sets the variable for the server it starts): the admin
      // addresses of the run, as a var of its own. The plugin can set a var per process only
      // when `.dev.vars` does not define it, which is why this is not ADMIN_EMAILS — and the
      // Worker honours it in test mode only (src/worker/services/signup-policy.ts).
      config: (config) => {
        const admins = process.env.HOLDFAST_E2E_ADMIN_EMAILS;
        if (admins) config.vars = { ...config.vars, E2E_ADMIN_EMAILS: admins };
      },
    }),
  ],
  server: {
    host,
    port,
    strictPort: true,
    // In a worktree node_modules is a symlink to the main checkout's, which is outside this
    // checkout: without its real path here Vite refuses (403) every file served from it by
    // path — the font files. In the main checkout the two entries are the same tree.
    fs: { allow: [".", realpathSync("node_modules")] },
  },
  // Vite's start-up scan crawls the HTML entry, not `new Worker(new URL(...))`: a package only a Web
  // Worker imports (hash-wasm, in the upload's hasher) was found the first time a test hashed a
  // file — "dependency optimized … reloading", the page reloaded in the middle of that test. With
  // the dev server started `--force` (playwright.config.ts) that happened on every run. The workers
  // are scanned as entries too, so their packages are known before the first page loads.
  optimizeDeps: { entries: ["index.html", "src/client/workers/*.worker.ts"] },
  preview: { host, port, strictPort: true },
  define: {
    __GIT_SHA__: JSON.stringify(commit),
    __GIT_BRANCH__: JSON.stringify(branch),
    __BUILT_AT__: JSON.stringify(builtAt),
    __APP_VERSION__: JSON.stringify(version),
  },
});
