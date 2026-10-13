// Migration 0007 on a scratch database of its own (the local server only): JIT compilation is
// off for every NEW session of the database the migration ran in — and of no other.
//   - the setting is stored on the database (`pg_db_role_setting`), under whatever name it has;
//   - the session that ran the migration keeps its value; a session opened afterwards has `off`;
//   - applying it again changes nothing; a role that does not own the database is REFUSED (the
//     migration fails, it does not pass without having stored anything) — until the owner has
//     stored the setting by hand, after which the same role gets past it.
// The statements are run exactly as drizzle's migrator runs them: split on its breakpoint
// marker, inside one transaction per migration file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDbName, localDbUrl } from "../../../setup/local-env";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const suffix = randomBytes(4).toString("hex");
// A name that needs quoting would not pass `localDbUrl`'s callers elsewhere; this one is plain.
const scratch = `holdfast_m0007_${suffix}`;
const stranger = `holdfast_m0007_role_${suffix}`;
// Made up for this test; the role exists only on the local server, for the length of this file.
const STRANGER_PASSWORD = "made-up-for-this-test";

type Journal = { entries: Array<{ tag: string }> };
const journal = JSON.parse(readFileSync(`${root}drizzle/meta/_journal.json`, "utf8")) as Journal;
const statementsOf = (tag: string) =>
  readFileSync(`${root}drizzle/${tag}.sql`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

let client: Client;

/** One migration file, in one transaction — as the migrator applies it. */
async function apply(tag: string, on: Client = client): Promise<void> {
  await on.query("BEGIN");
  try {
    for (const statement of statementsOf(tag)) await on.query(statement);
    await on.query("COMMIT");
  } catch (error) {
    await on.query("ROLLBACK");
    throw error;
  }
}

const TAG = "0007_jit_off";

/** One statement on a connection of its own: what a session that starts NOW gets. */
async function inNewSession<T>(url: string, text: string): Promise<T> {
  const fresh = new Client({ connectionString: url });
  await fresh.connect();
  try {
    return (await fresh.query(text)).rows[0] as T;
  } finally {
    await fresh.end();
  }
}

const jitOf = async (db: string) =>
  (await inNewSession<{ jit: string }>(localDbUrl(db), "SELECT current_setting('jit') AS jit")).jit;

/** Every setting stored on the scratch database, with the role it is tied to (0 = every role). */
const stored = async () =>
  (
    await client.query(
      `SELECT s.setrole::int AS role, s.setconfig AS config FROM pg_db_role_setting s
       JOIN pg_database d ON d.oid = s.setdatabase WHERE d.datname = current_database()`,
    )
  ).rows as { role: number; config: string[] }[];

beforeAll(async () => {
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratch}"`);
  await admin.query(`CREATE ROLE "${stranger}" LOGIN PASSWORD '${STRANGER_PASSWORD}'`);
  await admin.end();
  client = new Client({ connectionString: localDbUrl(scratch) });
  await client.connect();
  const before = journal.entries.map((entry) => entry.tag).filter((tag) => tag < TAG);
  expect(before).toHaveLength(7);
  for (const tag of before) await apply(tag);
}, 60_000);

afterAll(async () => {
  await client?.end();
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.query(`DROP ROLE IF EXISTS "${stranger}"`);
  await admin.end();
});

describe("migration 0007", () => {
  it("is in the journal, right after 0006", () => {
    expect(journal.entries[7]!.tag).toBe(TAG);
    expect(journal.entries).toHaveLength(8);
  });

  it("before it, a new session compiles: the server has JIT and nothing is stored on the database", async () => {
    // Otherwise "off" below would prove nothing: a server built without LLVM never compiles.
    const server = await inNewSession<{ available: boolean; source: string }>(
      localDbUrl(scratch),
      "SELECT pg_jit_available() AS available, (SELECT source FROM pg_settings WHERE name = 'jit') AS source",
    );
    expect(server).toEqual({ available: true, source: "default" });
    expect(await jitOf(scratch)).toBe("on");
    expect(await stored()).toEqual([]);
  });

  it("a role that does not own the database is refused, and nothing is stored", async () => {
    const other = new Client({
      connectionString: `postgres://${stranger}:${STRANGER_PASSWORD}@localhost:5432/${scratch}`,
    });
    await other.connect();
    try {
      await expect(apply(TAG, other)).rejects.toThrow(`must be owner of database ${scratch}`);
    } finally {
      await other.end();
    }
    expect(await stored()).toEqual([]);
    expect(await jitOf(scratch)).toBe("on");
  });

  it("stores jit = off on this database, for every role: a NEW session has it, the one that migrated does not yet", async () => {
    await apply(TAG);
    expect(await stored()).toEqual([{ role: 0, config: ["jit=off"] }]);
    expect(await jitOf(scratch)).toBe("off");
    expect(
      await inNewSession(localDbUrl(scratch), "SELECT source FROM pg_settings WHERE name = 'jit'"),
    ).toEqual({ source: "database" });
    // A role other than the one that migrated (the Worker's need not be the migrating one).
    expect(
      await inNewSession(
        `postgres://${stranger}:${STRANGER_PASSWORD}@localhost:5432/${scratch}`,
        "SELECT current_setting('jit') AS jit",
      ),
    ).toEqual({ jit: "off" });
    // Stored settings are read when a backend starts: an open (pooled) session keeps its value.
    expect((await client.query("SELECT current_setting('jit') AS jit")).rows[0]).toEqual({ jit: "on" });
  });

  it("applied again, stores the same single setting", async () => {
    await apply(TAG);
    expect(await stored()).toEqual([{ role: 0, config: ["jit=off"] }]);
  });

  it("once the owner has stored it by hand, a role that does not own the database gets past the migration", async () => {
    // The recovery path of a refused deploy: the owner runs the statement, the deploy runs again.
    const other = new Client({
      connectionString: `postgres://${stranger}:${STRANGER_PASSWORD}@localhost:5432/${scratch}`,
    });
    await other.connect();
    try {
      await apply(TAG, other);
      // Any other stored value is not "already done": the statement runs, and is refused.
      await client.query(`ALTER DATABASE "${scratch}" SET jit = on`);
      await expect(apply(TAG, other)).rejects.toThrow(`must be owner of database ${scratch}`);
    } finally {
      await other.end();
    }
    expect(await stored()).toEqual([{ role: 0, config: ["jit=on"] }]);
    await apply(TAG);
    expect(await stored()).toEqual([{ role: 0, config: ["jit=off"] }]);
  });

  it("touches only the database it ran in", async () => {
    expect(
      await inNewSession(
        localDbUrl("postgres"),
        `SELECT count(*)::int AS n FROM pg_db_role_setting s JOIN pg_database d ON d.oid = s.setdatabase
         WHERE d.datname = 'postgres' AND s.setconfig::text LIKE '%jit=%'`,
      ),
    ).toEqual({ n: 0 });
  });

  it("this checkout's own database was migrated with it: a new connection reports jit off", async () => {
    expect(await jitOf(localDbName())).toBe("off");
  });

  it("names no database and swallows no error", () => {
    const sql = readFileSync(`${root}drizzle/${TAG}.sql`, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).toMatch(/format\('ALTER DATABASE %I SET jit = off', current_database\(\)\)/);
    expect(sql).not.toMatch(/\bEXCEPTION\b/i);
    expect(sql).not.toMatch(/holdfast|neondb/i);
  });
});
