// Restores one dated nightly export (jobs/backup.ts) into an EMPTY migrated database.
//
//   HOLDFAST_DB=holdfast_restore bash scripts/db-reset.sh             an empty migrated database first
//   npx tsx scripts/restore-from-backup.ts --bucket <bucket> --date YYYY-MM-DD            the LOCAL simulator
//   npx tsx scripts/restore-from-backup.ts --bucket holdfast-files-dev --date … --remote  the deployed bucket
//
// The set is read with `wrangler r2 object get <bucket>/b/db/<date>/<name> --pipe`, which reads the
// LOCAL simulator unless `--remote` is given (the same `.wrangler/state` that `vite dev` writes).
// The database is the one `DATABASE_URL_DIRECT` names, from the process environment only (never
// from .dev.vars or .env); `scripts/dev-worktree.sh` exports it for a worktree's own database.
//
// Everything it checks and refuses, and how it loads (one transaction; dangling rows resolved by
// their foreign key's ON DELETE rule and named; `session` and `verification` emptied) is
// scripts/ops/restore-core.ts.
//
//   --accept-detection   the manifest says the set was written while the rollback detector read
//                        something other than "ok": load it anyway (runbooks/backup-restore.md)
//   --database-is-remote the database is not on this machine (refused otherwise, as create-invite does)
//
// What is printed: counts, table names, the dangling rows' table/constraint/primary key, and the
// database NAME and class. Never a row's content, never the host or the URL. The export holds
// password hashes and TOTP secrets: never restore a PRODUCTION set into the dev database or any
// shared place.

import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import pg from "pg";
import { RestoreRefusal, restoreSet } from "./ops/restore-core";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function target(): { url: string; database: string; remote: boolean } {
  const raw = process.env.DATABASE_URL_DIRECT;
  if (!raw) throw new RestoreRefusal("DATABASE_URL_DIRECT is not set in this shell");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RestoreRefusal("DATABASE_URL_DIRECT is not a URL");
  }
  const remote = !LOCAL_HOSTS.has(url.hostname);
  if (remote) url.searchParams.set("sslmode", "verify-full");
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""))
    .replace(/[^A-Za-z0-9_.-]/g, "?")
    .slice(0, 63);
  return { url: url.toString(), database, remote };
}

/** One object's bytes through wrangler, or null when it does not exist. */
function wranglerGet(bucket: string, key: string, remote: boolean): Promise<Uint8Array | null> {
  return new Promise((resolve, reject) => {
    const args = [
      "wrangler",
      "r2",
      "object",
      "get",
      `${bucket}/${key}`,
      "--pipe",
      ...(remote ? ["--remote"] : ["--local"]),
    ];
    const child = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(new Uint8Array(Buffer.concat(out)));
      // wrangler's own words for a missing key; anything else is a failure, reported by kind only.
      if (/not exist|not found|NoSuchKey/i.test(err)) return resolve(null);
      reject(new RestoreRefusal(`wrangler could not read ${key} (exit ${code})`));
    });
  });
}

function safeMessage(error: unknown): string {
  if (error instanceof RestoreRefusal) return error.message;
  const code = (error as { code?: unknown } | null)?.code;
  return `the restore failed${typeof code === "string" && /^[A-Z0-9_]{2,32}$/.test(code) ? ` (${code})` : ""}; nothing was committed`;
}

async function main(): Promise<void> {
  let values: {
    bucket?: string;
    date?: string;
    remote?: boolean;
    "accept-detection"?: boolean;
    "database-is-remote"?: boolean;
  };
  try {
    ({ values } = parseArgs({
      options: {
        bucket: { type: "string" },
        date: { type: "string" },
        remote: { type: "boolean" },
        "accept-detection": { type: "boolean" },
        "database-is-remote": { type: "boolean" },
      },
      strict: true,
    }));
  } catch {
    throw new RestoreRefusal(
      "unknown or malformed option — see the header of scripts/restore-from-backup.ts",
    );
  }
  if (!values.bucket || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(values.bucket))
    throw new RestoreRefusal("--bucket <name> is required");
  if (!values.date) throw new RestoreRefusal("--date YYYY-MM-DD is required");
  const db = target();
  if (db.remote !== (values["database-is-remote"] === true)) {
    throw new RestoreRefusal(
      db.remote
        ? `refusing: database "${db.database}" is not on this machine — pass --database-is-remote to confirm`
        : `--database-is-remote was given, but database "${db.database}" is local`,
    );
  }
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  try {
    process.stderr.write(
      `restore: set ${values.date} from ${values.bucket} (${values.remote ? "remote" : "local"}) → database "${db.database}" (${db.remote ? "remote" : "local"})\n`,
    );
    const result = await restoreSet({
      date: values.date,
      read: (key) => wranglerGet(values.bucket!, key, values.remote === true),
      sql: { query: async (text, params) => ({ rows: (await client.query(text, params)).rows }) },
      acceptDetection: values["accept-detection"] === true,
      log: (line) => process.stderr.write(`restore: ${line}\n`),
    });
    for (const warning of result.warnings) process.stderr.write(`restore: WARNING ${warning}\n`);
    for (const row of result.dangling) {
      process.stdout.write(`dangling\t${row.table}\t${row.constraint}\t${row.action}\t${row.key}\n`);
    }
    for (const table of result.manifest.tables) {
      process.stdout.write(
        `table\t${table.name}\tmanifest ${table.rows}\tloaded ${result.loaded[table.name]}\n`,
      );
    }
    process.stdout.write(`done\t${result.manifest.tables.length} tables\tcommit ${result.manifest.commit}\n`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`restore: ${safeMessage(error)}\n`);
  process.exitCode = 1;
});
