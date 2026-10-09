// Creates invite codes directly in the database — for bootstrapping an environment before the
// admin console exists.
//
//   npm run invite -- --uses 1 --note "first admin"
//   npm run invite -- --count 3 --uses 5 --expires-days 14
//
// The database is the one `DATABASE_URL_DIRECT` names, read from the process environment only
// (never from .dev.vars or .env). The URL is never printed; the host is.

import { randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { withDb } from "../src/worker/db/client";
import { invites } from "../src/worker/db/schema";
import { redactText } from "../src/shared/sentry-redact";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** The direct URL; a hosted database is asked for full certificate verification. */
function directUrl(): { url: string; host: string } {
  const raw = process.env.DATABASE_URL_DIRECT;
  if (!raw) throw new Error("DATABASE_URL_DIRECT is not set in this shell");
  const url = new URL(raw);
  if (!LOCAL_HOSTS.has(url.hostname)) url.searchParams.set("sslmode", "verify-full");
  return { url: url.toString(), host: url.hostname };
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
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      uses: { type: "string" },
      count: { type: "string" },
      note: { type: "string" },
      "expires-days": { type: "string" },
    },
    strict: true,
  });
  const uses = positiveInt("uses", values.uses, 1);
  const count = positiveInt("count", values.count, 1);
  const expiresDays =
    values["expires-days"] === undefined ? null : positiveInt("expires-days", values["expires-days"], 1);
  const expiresAt = expiresDays === null ? null : new Date(Date.now() + expiresDays * 86_400_000);

  const { url, host } = directUrl();
  const env = { HYPERDRIVE: { connectionString: url } } as Env;
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
    `created ${codes.length} invite code(s) on ${host}: ${uses} use(s) each, ` +
      (expiresAt ? `expiring ${expiresAt.toISOString()}` : "no expiry"),
  );
  for (const code of codes) console.log(code);
}

main().catch((error: unknown) => {
  // The message only: a driver error can carry the connection string.
  console.error(`create-invite: ${error instanceof Error ? redactText(error.message) : "failed"}`);
  process.exitCode = 1;
});
