// Seeds a signed-in session straight into a database — for automated specs against a DEPLOY,
// which must never solve a captcha (the deploys keep the real Turnstile widget).
//
//   DATABASE_URL_DIRECT=… BETTER_AUTH_SECRET=… npx tsx scripts/create-session.ts \
//       --origin https://holdfast-dev.ponderance.dev --out "$(mktemp -d)/session.json" \
//       [--email remote-spec@holdfast.ponderance.dev] [--role admin --two-factor] [--ttl-hours 2]
//   … --delete --email remote-spec@holdfast.ponderance.dev          removes that user and its sessions
//
// It creates (or reuses) a VERIFIED user with the current terms accepted, and a session row, and
// writes the session cookie to `--out` — a JSON file, mode 600, which must lie OUTSIDE the
// repository. Nothing secret is printed: not the cookie, not the URL, not the secret.
//
// WHICH DATABASE. `DATABASE_URL_DIRECT` and `BETTER_AUTH_SECRET` come from the process
// environment only. Every database that is not on this machine is PRESUMED TO BE PRODUCTION, and
// the script refuses it unless one of two things is said out loud:
//   --non-prod-host <hostname>   "this URL's host is our non-production database" — and the host
//                                of the URL must be exactly that. Take the name from somewhere
//                                other than the URL itself, or the check checks nothing.
//   --i-know-this-is-prod        for the production go-live checks, and nothing else.
//
// The rows are what Better Auth itself would have written: ids from its own generator (32
// characters of [A-Za-z0-9] — never a UUID), the session token likewise, and the cookie signed
// by the library's own cookie serializer with that environment's secret, under the name the
// Worker uses there (`__Secure-hf.session_token` on https, `hf.session_token` on plain http).

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateId } from "@better-auth/core/utils/id";
import { hashPassword } from "better-auth/crypto";
import { serializeSignedCookie } from "better-call";
import { eq } from "drizzle-orm";
import { withDb, type Db } from "../src/worker/db/client";
import { account, session, settings, user, userPrefs } from "../src/worker/db/schema";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EMAIL = "remote-spec@holdfast.ponderance.dev";
/** The default of the `TERMS_VERSION` var; the `settings` row, when there is one, wins. */
const DEFAULT_TERMS_VERSION = "2026-10";

export type Target = "local" | "non-prod" | "prod";

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

async function currentTermsVersion(db: Db): Promise<string> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, "termsVersion"));
  return typeof row?.value === "string" && row.value !== "" ? row.value : DEFAULT_TERMS_VERSION;
}

async function removeUser(db: Db, email: string): Promise<boolean> {
  const [row] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (!row) return false;
  // Sessions, accounts and preferences go with the user (ON DELETE CASCADE); a user that owns
  // files is not a seeded test user and is left alone by the foreign keys.
  await db.delete(session).where(eq(session.userId, row.id));
  await db.delete(account).where(eq(account.userId, row.id));
  await db.delete(user).where(eq(user.id, row.id));
  return true;
}

async function ensureUser(
  db: Db,
  email: string,
  options: { admin: boolean; twoFactor: boolean },
): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const termsVersion = await currentTermsVersion(db);
  const wanted = {
    emailVerified: true,
    role: options.admin ? "admin" : "user",
    twoFactorEnabled: options.twoFactor,
    termsVersion,
    termsAcceptedAt: now,
    ageVerifiedAt: now,
    banned: false,
    suspendedAt: null,
    deleteScheduledAt: null,
  };
  const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (existing) {
    await db.update(user).set(wanted).where(eq(user.id, existing.id));
    return { id: existing.id, created: false };
  }
  const id = generateId();
  await db.insert(user).values({ id, name: "Remote Spec", email, ...wanted });
  // A credential account, as a signed-up user has — with a password nobody knows.
  await db.insert(account).values({
    id: generateId(),
    accountId: id,
    providerId: "credential",
    userId: id,
    password: await hashPassword(generateId(48)),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(userPrefs).values({ userId: id }).onConflictDoNothing();
  return { id, created: true };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      origin: { type: "string" },
      email: { type: "string" },
      role: { type: "string" },
      "two-factor": { type: "boolean" },
      "ttl-hours": { type: "string" },
      delete: { type: "boolean" },
      "non-prod-host": { type: "string" },
      "i-know-this-is-prod": { type: "boolean" },
    },
    strict: true,
  });
  const email = (values.email ?? DEFAULT_EMAIL).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("--email is not an address");
  if (values.role !== undefined && values.role !== "admin" && values.role !== "user") {
    throw new Error("--role must be admin or user");
  }
  const target = classifyTarget(process.env.DATABASE_URL_DIRECT, {
    nonProdHost: values["non-prod-host"],
    iKnowThisIsProd: values["i-know-this-is-prod"],
  });
  const env = { HYPERDRIVE: { connectionString: target.url } } as Env;

  if (values.delete) {
    const removed = await withDb(env, (db) => removeUser(db, email));
    console.error(
      `create-session: ${removed ? "removed" : "no such user"} on ${target.host} (${target.target})`,
    );
    return;
  }

  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret)
    throw new Error(
      "BETTER_AUTH_SECRET is not set in this shell (that environment's value is needed to sign the cookie)",
    );
  if (!values.out) throw new Error("--out <file> is required");
  if (!values.origin) throw new Error("--origin <the app origin the cookie is for> is required");
  const origin = new URL(values.origin);
  const out = outsideRepo(values.out);
  const ttlHours = values["ttl-hours"] === undefined ? 2 : Number(values["ttl-hours"]);
  if (!Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 24 * 14)
    throw new Error("--ttl-hours must be between 0 and 336");

  const token = generateId(32);
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  const made = await withDb(env, async (db) => {
    const owner = await ensureUser(db, email, {
      admin: values.role === "admin",
      twoFactor: values["two-factor"] === true,
    });
    const now = new Date();
    await db.insert(session).values({
      id: generateId(),
      token,
      userId: owner.id,
      expiresAt,
      createdAt: now,
      updatedAt: now,
      userAgent: "scripts/create-session.ts",
    });
    return owner;
  });

  const secure = origin.protocol === "https:";
  const name = `${secure ? "__Secure-" : ""}hf.session_token`;
  // The library's own signer: `<token>.<signature>`, exactly as its Set-Cookie carries it.
  const serialized = await serializeSignedCookie(name, token, secret, {});
  const value = serialized.slice(name.length + 1);
  const file = {
    header: `${name}=${value}`,
    cookie: {
      name,
      value,
      domain: origin.hostname,
      path: "/",
      httpOnly: true,
      secure,
      sameSite: "Lax" as const,
      expires: Math.floor(expiresAt.getTime() / 1000),
    },
    user: { id: made.id, email },
    expiresAt: expiresAt.toISOString(),
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
  chmodSync(out, 0o600);
  console.error(
    `create-session: ${made.created ? "created" : "reused"} a ${values.role === "admin" ? "admin" : "user"} on ` +
      `${target.host} (${target.target}) and wrote its session cookie to the --out file (mode 600, expires ${file.expiresAt})`,
  );
}

// Run only as a script (the two pure functions above are imported by a test).
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // The message only, with any URL removed: a driver error can carry the connection string.
    const message =
      error instanceof Error ? error.message.replace(/postgres(ql)?:\/\/\S+/g, "<url>") : "failed";
    console.error(`create-session: ${message}`);
    process.exitCode = 1;
  });
}
