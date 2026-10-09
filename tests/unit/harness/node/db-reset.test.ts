// scripts/db-reset.sh is what every local run and Playwright's globalSetup use to get a database:
// it must leave the two extensions AND every migration in the journal applied. Run here against a
// scratch database of its own, on the local server only.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { localDbUrl } from "../../../setup/local-env";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = `holdfast_dbreset_${randomBytes(4).toString("hex")}`;

type Journal = { entries: Array<{ tag: string }> };
const journal = JSON.parse(readFileSync(`${root}drizzle/meta/_journal.json`, "utf8")) as Journal;

async function query<T extends Record<string, unknown>>(db: string, text: string): Promise<T[]> {
  const client = new Client({ connectionString: localDbUrl(db) });
  await client.connect();
  try {
    return (await client.query<T>(text)).rows;
  } finally {
    await client.end();
  }
}

function reset(): string {
  return execFileSync("bash", ["scripts/db-reset.sh"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HOLDFAST_DB: scratch },
  });
}

afterAll(async () => {
  await query("postgres", `DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
});

describe("scripts/db-reset.sh", () => {
  it("creates the database with both extensions and applies every migration in the journal", async () => {
    expect(journal.entries.length).toBeGreaterThanOrEqual(2);
    const output = reset();
    expect(output).toContain(`recreated database ${scratch}`);
    expect(output).toContain(`migrations applied to ${scratch}`);

    const applied = await query<{ n: string }>(
      scratch,
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    expect(Number(applied[0]!.n)).toBe(journal.entries.length);

    const extensions = await query<{ extname: string }>(
      scratch,
      "select extname from pg_extension where extname in ('citext', 'pg_trgm') order by extname",
    );
    expect(extensions.map((row) => row.extname)).toEqual(["citext", "pg_trgm"]);

    // Tables from both halves of the schema: Better Auth's and ours.
    const tables = await query<{ table_name: string }>(
      scratch,
      "select table_name from information_schema.tables where table_schema = 'public'",
    );
    const names = tables.map((row) => row.table_name);
    for (const expected of ["user", "session", "nodes", "settings", "audit_log", "share_links"]) {
      expect(names, expected).toContain(expected);
    }
  }, 60_000);

  it("run again, drops what was there and migrates from empty", async () => {
    await query(scratch, "insert into settings (key, value) values ('dbResetMarker', 'true'::jsonb)");
    reset();
    expect(await query(scratch, "select key from settings")).toEqual([]);
    const applied = await query<{ n: string }>(
      scratch,
      "select count(*) as n from drizzle.__drizzle_migrations",
    );
    expect(Number(applied[0]!.n)).toBe(journal.entries.length);
  }, 60_000);
});
