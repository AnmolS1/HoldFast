// Creates invite codes directly in the database — for bootstrapping an environment before the
// admin console exists.
//
//   npm run invite -- --uses 1 --note "first admin"
//   npm run invite -- --count 3 --uses 5 --expires-days 14
//   npm run invite -- --remote --uses 1 --note "first admin"      a database that is NOT on this machine
//
// The database is the one `DATABASE_URL_DIRECT` names, read from the process environment only
// (never from .dev.vars or .env).
//
// `--remote` is an acknowledgement, and it is required exactly when the host is not this
// machine: a shell that still carries a hosted URL would otherwise write invites into that
// database on one Enter. Without it (or with it against a local database) the script refuses
// before it connects.
//
// What is printed: the codes (stdout), and on stderr the database NAME and its class — `local` or
// `remote`. Never the host, never the URL, on success or on failure.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { withDb } from "../src/worker/db/client";
import { invites } from "../src/worker/db/schema";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

type Target = { url: string; host: string; database: string; remote: boolean };

/** The direct URL; a hosted database is asked for full certificate verification. */
function directUrl(): Target {
  const raw = process.env.DATABASE_URL_DIRECT;
  if (!raw) throw new Refusal("DATABASE_URL_DIRECT is not set in this shell");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not the parser's message: it quotes its input.
    throw new Refusal("DATABASE_URL_DIRECT is not a URL");
  }
  const remote = !LOCAL_HOSTS.has(url.hostname);
  if (remote) url.searchParams.set("sslmode", "verify-full");
  const database = decodeURIComponent(url.pathname.replace(/^\//, "")) || "(default)";
  return { url: url.toString(), host: url.hostname, database, remote };
}

/** `database "name" (local|remote)` — everything this script ever says about where it writes. */
const describeTarget = (target: Target) =>
  `database ${JSON.stringify(target.database.replace(/[^A-Za-z0-9_.-]/g, "?").slice(0, 63))} (${target.remote ? "remote" : "local"})`;

/** A refusal of this script's own: its message is ours, word for word, and safe to print. */
class Refusal extends Error {}

/**
 * What is printed for a failure. Only a `Refusal` speaks for itself. Anything else came from the
 * driver or the network, and such a message names the host (in whatever spelling the resolver
 * gave it) and can carry the connection string: it is reduced to its error code.
 */
function safeMessage(error: unknown): string {
  if (error instanceof Refusal) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  const cause = ((error as { cause?: { code?: unknown } } | null)?.cause ?? null)?.code;
  const known = [code, cause].find((value) => typeof value === "string" && /^[A-Z0-9_]{2,32}$/.test(value));
  return `the database could not be written to${known ? ` (${String(known)})` : ""}`;
}

// No 0/O/1/I/L: codes are read aloud and typed by hand.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function newCode(): string {
  let out = "";
  const bytes = randomBytes(64);
  // Rejection sampling keeps the characters uniform.
  for (let i = 0; i < bytes.length && out.length < 20; i++) {
    const value = bytes[i]!;
    if (value < 248) out += ALPHABET[value % ALPHABET.length];
  }
  if (out.length < 20) return newCode();
  return `${out.slice(0, 5)}-${out.slice(5, 10)}-${out.slice(10, 15)}-${out.slice(15, 20)}`;
}

function positiveInt(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Refusal(`--${name} must be a positive whole number`);
  return n;
}

async function main(): Promise<void> {
  let values: {
    uses?: string;
    count?: string;
    note?: string;
    "expires-days"?: string;
    remote?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        uses: { type: "string" },
        count: { type: "string" },
        note: { type: "string" },
        "expires-days": { type: "string" },
        remote: { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    throw new Refusal("unknown or malformed option — see the header of scripts/create-invite.ts");
  }
  const uses = positiveInt("uses", values.uses, 1);
  const count = positiveInt("count", values.count, 1);
  const expiresDays =
    values["expires-days"] === undefined ? null : positiveInt("expires-days", values["expires-days"], 1);
  const expiresAt = expiresDays === null ? null : new Date(Date.now() + expiresDays * 86_400_000);

  const target = directUrl();
  if (target.remote !== (values.remote === true)) {
    throw new Refusal(
      target.remote
        ? `refusing to write to ${describeTarget(target)}: it is not on this machine — pass --remote to confirm`
        : `--remote was given, but the target is ${describeTarget(target)} — drop the flag`,
    );
  }
  const env = { HYPERDRIVE: { connectionString: target.url } } as Env;
  const codes = await withDb(env, async (db) => {
    const rows = await db
      .insert(invites)
      .values(
        Array.from({ length: count }, () => ({
          code: newCode(),
          maxUses: uses,
          expiresAt,
          note: values.note ?? null,
        })),
      )
      .returning({ code: invites.code });
    return rows.map((row) => row.code);
  });

  console.error(
    `created ${codes.length} invite code(s) on ${describeTarget(target)}: ${uses} use(s) each, ` +
      (expiresAt ? `expiring ${expiresAt.toISOString()}` : "no expiry"),
  );
  for (const code of codes) console.log(code);
}

main().catch((error: unknown) => {
  console.error(`create-invite: ${safeMessage(error)}`);
  process.exitCode = 1;
});
