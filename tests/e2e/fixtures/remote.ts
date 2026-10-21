// The two REMOTE modes of the suite, read from the environment by playwright.config.ts and the
// `origins` fixture. Unset (every local run), nothing here changes anything.
//
//   HOLDFAST_E2E_BASE_URL=https://…                     read-only: no dev server, no globalSetup
//                                                       (it resets a database), baseURL is that URL,
//                                                       and only `@prod-safe` tests run — they create
//                                                       nothing and sign in nowhere.
//   … + HOLDFAST_E2E_SESSION_FILE=<path>               seeded session (the dev deploy only): the
//                                                       `@remote-session` tests also run, in projects
//                                                       of their own whose contexts start from that
//                                                       storage state (T06's scripts/create-session.ts
//                                                       writes it). `@prod-safe` tests never get it.
//   HOLDFAST_E2E_FILES_URL=https://…                    optional: the files origin; otherwise it is
//                                                       read from the deploy's GET /api/public/config.
//   HOLDFAST_E2E_FAIL_ON_SKIP=1                         the gate scripts: any skipped test fails the
//                                                       run (./skip-reporter.ts prints every skip and
//                                                       its reason in remote mode either way).
import { existsSync } from "node:fs";

export const PROD_SAFE = "@prod-safe";
export const REMOTE_SESSION = "@remote-session";

export interface RemoteMode {
  /** The deploy's app origin, e.g. https://holdfast-dev.ponderance.dev */
  baseURL: string;
  /** Playwright storage state for `@remote-session` tests; null = read-only mode only. */
  sessionFile: string | null;
  /** The deploy's files origin, when given; null = ask the deploy's public config. */
  filesURL: string | null;
}

type Env = Record<string, string | undefined>;

function origin(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute http(s) URL, not "${raw}"`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${name} must be an http(s) URL, not "${raw}"`);
  }
  return url.origin;
}

/** The remote mode the environment asks for, or null for a local run. A half-set mode is an error. */
export function remoteMode(env: Env = process.env): RemoteMode | null {
  const base = env.HOLDFAST_E2E_BASE_URL?.trim() ?? "";
  const session = env.HOLDFAST_E2E_SESSION_FILE?.trim() ?? "";
  const files = env.HOLDFAST_E2E_FILES_URL?.trim() ?? "";
  if (base === "") {
    if (session !== "" || files !== "") {
      throw new Error(
        "HOLDFAST_E2E_SESSION_FILE / HOLDFAST_E2E_FILES_URL are remote-mode settings: set HOLDFAST_E2E_BASE_URL too",
      );
    }
    return null;
  }
  if (session !== "" && !existsSync(session)) {
    throw new Error(`HOLDFAST_E2E_SESSION_FILE names no file: ${session}`);
  }
  return {
    baseURL: origin("HOLDFAST_E2E_BASE_URL", base),
    sessionFile: session === "" ? null : session,
    filesURL: files === "" ? null : origin("HOLDFAST_E2E_FILES_URL", files),
  };
}

/** A tag as a whole word in a title (`@prod-safe` must not match `@prod-safe-ish`). */
export function tagPattern(tag: string): RegExp {
  return new RegExp(`${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`);
}

/**
 * The projects of a remote run: each device once for `@prod-safe` (no session), and — with a
 * session file — once more for `@remote-session` with that storage state.
 */
export function remoteProjects<D extends { name: string; use: Record<string, unknown> }>(
  mode: RemoteMode,
  devices: readonly D[],
): Array<{ name: string; grep: RegExp; use: Record<string, unknown> }> {
  const safe = devices.map((device) => ({
    name: `${device.name}-prod-safe`,
    grep: tagPattern(PROD_SAFE),
    use: { ...device.use },
  }));
  if (mode.sessionFile === null) return safe;
  const session = devices.map((device) => ({
    name: `${device.name}-remote-session`,
    grep: tagPattern(REMOTE_SESSION),
    use: { ...device.use, storageState: mode.sessionFile },
  }));
  return [...safe, ...session];
}

/**
 * The deploy's two origins for the `origins` fixture. The files origin is HOLDFAST_E2E_FILES_URL,
 * or what the deploy's public config says (an anonymous GET — nothing is written).
 */
export async function remoteOrigins(mode: RemoteMode): Promise<{ app: string; files: string; port: number }> {
  const app = new URL(mode.baseURL);
  let files = mode.filesURL;
  if (files === null) {
    const response = await fetch(new URL("/api/public/config", app));
    const config = (await response.json()) as { filesOrigin?: unknown };
    if (!response.ok || typeof config.filesOrigin !== "string") {
      throw new Error(`${app.origin}/api/public/config gave no filesOrigin (HTTP ${response.status})`);
    }
    files = origin("filesOrigin of the public config", config.filesOrigin);
  }
  const port = Number(app.port) || (app.protocol === "https:" ? 443 : 80);
  return { app: app.origin, files, port };
}
