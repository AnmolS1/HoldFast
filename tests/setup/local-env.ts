// The per-checkout inputs of the test harness, derived in one place.
//
//   HOLDFAST_PORT  the checkout's single port (main tree 5173, worktrees 5180–5199)
//   HOLDFAST_DB    the checkout's own local database (main tree "holdfast", worktrees "holdfast_<task>")
//
// Everything else — origins, the local connection string, the Hyperdrive override — is computed
// from those two. Node-side only (configs and setup files); Worker tests read `env` instead.

const DB_NAME = /^holdfast(_[a-z0-9_]+)?$/;

function intFromEnv(names: string[], fallback: number): number {
  for (const name of names) {
    const raw = process.env[name];
    if (raw === undefined || raw === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1024 || value > 65535) {
      throw new Error(`${name} must be a port between 1024 and 65535, got "${raw}"`);
    }
    return value;
  }
  return fallback;
}

/** The local database name. Throws on anything that is not `holdfast` or `holdfast_<name>`. */
export function localDbName(): string {
  const name = process.env.HOLDFAST_DB || "holdfast";
  if (!DB_NAME.test(name)) {
    throw new Error(`HOLDFAST_DB must be "holdfast" or "holdfast_<name>" (a-z, 0-9, _), got "${name}"`);
  }
  return name;
}

/** The local connection string. Always localhost: tests never reach a hosted database. */
export function localDbUrl(db: string = localDbName()): string {
  return `postgres://postgres:postgres@localhost:5432/${db}`;
}

/** The port Playwright's own server runs on. One port per checkout; the two aliases default to it. */
export function e2ePort(): number {
  return intFromEnv(["HOLDFAST_E2E_PORT", "HOLDFAST_PORT"], 5173);
}

export function appOrigin(port: number): string {
  return `http://localhost:${port}`;
}

export function filesOrigin(port: number): string {
  return `http://files.localhost:${port}`;
}

/** Name of the process env var that overrides the HYPERDRIVE binding's local connection string. */
export const HYPERDRIVE_OVERRIDE = "CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE";

/**
 * Stops wrangler, the Vite plugin and the Vitest plugin from loading the repo-root `.env` into the
 * Worker's local `env` when a checkout has no `.dev.vars`. Call it first in every entry point.
 */
export function forbidDotEnvFallback(): void {
  process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
}
