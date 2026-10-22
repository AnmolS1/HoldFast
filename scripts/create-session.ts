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
// WHICH USER. Only a user THIS SCRIPT made (T20): the address must be a seed address — its local
// part starts with `remote-spec`, at holdfast.ponderance.dev or at a reserved test domain
// (`.example`, `.test`) — and an existing row is reused, changed or deleted only if it carries
// the script's own marker (a `verification` row `create-session:<user id>`, which nothing a user
// can do writes). Anyone can SIGN UP with a seed-shaped address and choose its password; without
// the marker rule this script would then verify that row, lift its suspension and hand out a
// session — or, with `--delete`, remove a real person's account past the deletion rules.
//
// The rows are what Better Auth itself would have written: ids from its own generator (32
// characters of [A-Za-z0-9] — never a UUID), the session token likewise, and the cookie signed
// by the library's own cookie serializer with that environment's secret, under the name the
// Worker uses there (`__Host-hf.session_token` on https, `hf.session_token` on plain http).

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { withDb } from "../src/worker/db/client";
import { redactText } from "../src/shared/sentry-redact";
import { removeSeededUser, seedSession } from "./lib/seed-session";
import { classifyTarget, isSeedAddress, outsideRepo } from "./lib/session-target";

const DEFAULT_EMAIL = "remote-spec@holdfast.ponderance.dev";

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
  if (!isSeedAddress(email)) {
    throw new Error(
      "--email must be a seed address: remote-spec…@holdfast.ponderance.dev, or remote-spec…@ a .example / .test domain",
    );
  }
  if (values.role !== undefined && values.role !== "admin" && values.role !== "user") {
    throw new Error("--role must be admin or user");
  }
  const target = classifyTarget(process.env.DATABASE_URL_DIRECT, {
    nonProdHost: values["non-prod-host"],
    iKnowThisIsProd: values["i-know-this-is-prod"],
  });
  const env = { HYPERDRIVE: { connectionString: target.url } } as Env;

  if (values.delete) {
    const removed = await withDb(env, (db) => removeSeededUser(db, email));
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

  const secure = origin.protocol === "https:";
  const made = await withDb(env, (db) =>
    seedSession(db, {
      email,
      admin: values.role === "admin",
      twoFactor: values["two-factor"] === true,
      ttlHours,
      secret,
      secure,
    }),
  );
  const { name, value, expiresAt } = made.cookie;
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

// Run only as a script. (Its pure decisions live in ./lib/session-target.ts, where a test imports them.)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    // The message only, with any URL removed: a driver error can carry the connection string.
    const message = error instanceof Error ? redactText(error.message) : "failed";
    console.error(`create-session: ${message}`);
    process.exitCode = 1;
  });
}
