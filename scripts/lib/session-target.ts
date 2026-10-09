// The decisions of scripts/create-session.ts that need no database and no Worker code: which
// database it may touch, where it may write the cookie, and which addresses it may make users
// for. In a module of their own so that a test can import them
// (tests/unit/harness/node/create-session.test.ts).

import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export type Target = "local" | "non-prod" | "prod";

const SEED_ADDRESS =
  /^remote-spec[a-z0-9+._-]*@(?:holdfast\.ponderance\.dev|(?:[a-z0-9-]+\.)+(?:example|test))$/;
/** Is this an address the script may make a user for? (Lower case; see the header.) */
export function isSeedAddress(email: string): boolean {
  return email.length <= 254 && SEED_ADDRESS.test(email);
}
/**
 * Where a database URL points, and whether this run may touch it. Throws when it may not.
 * Decided from the URL and the flags alone — no connection is made.
 */
export function classifyTarget(
  rawUrl: string | undefined,
  flags: { nonProdHost?: string; iKnowThisIsProd?: boolean },
): { url: string; host: string; target: Target } {
  if (!rawUrl) throw new Error("DATABASE_URL_DIRECT is not set in this shell");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("DATABASE_URL_DIRECT is not a URL");
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error("DATABASE_URL_DIRECT is not a postgres URL");
  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return { url: url.toString(), host, target: "local" };
  // A hosted database is asked for full certificate verification.
  url.searchParams.set("sslmode", "verify-full");
  if (flags.iKnowThisIsProd) return { url: url.toString(), host, target: "prod" };
  if (flags.nonProdHost !== undefined && flags.nonProdHost.trim().toLowerCase() === host) {
    return { url: url.toString(), host, target: "non-prod" };
  }
  throw new Error(
    `refusing to touch the database at ${host}: a database that is not on this machine is presumed to be ` +
      "PRODUCTION. Pass --non-prod-host <that host> if it is the non-production database, or " +
      "--i-know-this-is-prod if production is really meant.",
  );
}

/** Is `path` the directory `root` or something under it? */
function isUnder(root: string, path: string): boolean {
  const inside = relative(root, path);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** The main checkout too, when this file lives in a git worktree of it. */
function repositoryRoots(): string[] {
  const roots = [REPO_ROOT];
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (common) roots.push(dirname(common));
  } catch {
    // Not a git checkout: the script's own tree is all there is to protect.
  }
  return roots;
}

/** `--out` resolved, and refused when it lies inside the repository (a secret must not land there). */
export function outsideRepo(out: string, roots: string[] = repositoryRoots()): string {
  const path = resolve(out);
  if (roots.some((root) => isUnder(root, path))) {
    throw new Error("--out must be a path OUTSIDE the repository (use a `mktemp -d` directory)");
  }
  return path;
}
