// Migration 0003 on a scratch database of its own (the local server only):
//   - it adds `session.second_factor_at` and the UNIQUE index on `account (provider_id, account_id)`;
//   - on a database that already holds one provider identity linked twice it FAILS LOUDLY and
//     changes NOTHING — no row is dropped and the column is not left behind half-applied.
// The statements are run exactly as drizzle's migrator runs them: split on its breakpoint
// marker, inside one transaction per migration file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDbUrl } from "../../../setup/local-env";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = `holdfast_m0003_${randomBytes(4).toString("hex")}`;

type Journal = { entries: Array<{ tag: string }> };
const journal = JSON.parse(readFileSync(`${root}drizzle/meta/_journal.json`, "utf8")) as Journal;
const statementsOf = (tag: string) =>
  readFileSync(`${root}drizzle/${tag}.sql`, "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);

let client: Client;

/** One migration file, in one transaction — as the migrator applies it. */
async function apply(tag: string): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of statementsOf(tag)) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const TAG = "0003_session_second_factor_account_unique";
const hasColumn = async () =>
  (
    await client.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = 'session' AND column_name = 'second_factor_at'",
    )
  ).rowCount === 1;
const hasIndex = async () =>
  (await client.query("SELECT 1 FROM pg_indexes WHERE indexname = 'account_provider_account_uidx'"))
    .rowCount === 1;

async function insertAccount(id: string, providerId: string, accountId: string): Promise<void> {
  await client.query(
    "INSERT INTO account (id, account_id, provider_id, user_id, updated_at) VALUES ($1, $2, $3, $4, now())",
    [id, accountId, providerId, "u-0003"],
  );
}

beforeAll(async () => {
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratch}"`);
  await admin.end();
  client = new Client({ connectionString: localDbUrl(scratch) });
  await client.connect();
  const before = journal.entries.map((entry) => entry.tag).filter((tag) => tag < TAG);
  expect(before).toEqual(["0000_extensions", "0001_schema", "0002_purge_attempted_at"]);
  for (const tag of before) await apply(tag);
  await client.query(
    "INSERT INTO \"user\" (id, name, email, email_verified, updated_at) VALUES ('u-0003', 'M', 'm0003@example.test', true, now())",
  );
}, 60_000);

afterAll(async () => {
  await client?.end();
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.end();
});

describe("migration 0003", () => {
  it("is in the journal, and is the newest migration", () => {
    expect(journal.entries.at(-1)!.tag).toBe(TAG);
  });

  it("refuses — loudly, changing nothing — a database where one provider identity is linked twice", async () => {
    await insertAccount("a-1", "google", "google-subject-1");
    await insertAccount("a-2", "google", "google-subject-1");
    await insertAccount("a-3", "credential", "u-0003");
    await expect(apply(TAG)).rejects.toThrow(
      /migration 0003 refused: 1 provider identit\(ies\) are linked more than once.*Nothing was changed/,
    );
    // Nothing dropped, nothing half-applied.
    expect((await client.query("SELECT id FROM account ORDER BY id")).rows.map((row) => row.id)).toEqual([
      "a-1",
      "a-2",
      "a-3",
    ]);
    expect(await hasColumn()).toBe(false);
    expect(await hasIndex()).toBe(false);
  });

  it("applies once the duplicate is resolved: the column (no default, nullable) and the unique index", async () => {
    await client.query("DELETE FROM account WHERE id = 'a-2'");
    await apply(TAG);
    expect(await hasIndex()).toBe(true);
    const column = await client.query(
      "SELECT data_type, column_default, is_nullable FROM information_schema.columns WHERE table_name = 'session' AND column_name = 'second_factor_at'",
    );
    expect(column.rows).toEqual([
      { data_type: "timestamp without time zone", column_default: null, is_nullable: "YES" },
    ]);
    // From here a second link of the same identity is a unique violation, whoever inserts it.
    await expect(insertAccount("a-4", "google", "google-subject-1")).rejects.toMatchObject({ code: "23505" });
    // The same subject at another provider, and another subject at the same provider, are fine.
    await insertAccount("a-5", "github", "google-subject-1");
    await insertAccount("a-6", "google", "google-subject-2");
  });

  it("expands only: no statement that could break the Worker version before it", () => {
    const sql = readFileSync(`${root}drizzle/${TAG}.sql`, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|SET\s+NOT\s+NULL)\b/i);
    expect(sql).toMatch(/ADD COLUMN "second_factor_at" timestamp;/);
    expect(sql).toMatch(/CREATE UNIQUE INDEX "account_provider_account_uidx"/);
  });
});
