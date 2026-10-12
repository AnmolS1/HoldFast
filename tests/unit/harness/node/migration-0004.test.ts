// Migration 0004 on a scratch database of its own (the local server only): the quota is decimal.
//   - the default of `user.quota_bytes` becomes 5,000,000,000 (it was 5 GiB = 5,368,709,120);
//   - a row that still holds exactly the old default takes the new one; any other value is kept.
// The statements are run exactly as drizzle's migrator runs them: split on its breakpoint
// marker, inside one transaction per migration file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDbUrl } from "../../../setup/local-env";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = `holdfast_m0004_${randomBytes(4).toString("hex")}`;

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

const TAG = "0004_quota_default_decimal";
const OLD_DEFAULT = 5_368_709_120;
const NEW_DEFAULT = 5_000_000_000;

/** A user row; without `quota` the column takes the database default of the moment. */
async function insertUser(id: string, quota?: number, used = 0): Promise<void> {
  const base = [id, `${id}@example.test`, used];
  if (quota === undefined)
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, updated_at, used_bytes) VALUES ($1, 'M', $2, true, now(), $3)`,
      base,
    );
  else
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, updated_at, used_bytes, quota_bytes) VALUES ($1, 'M', $2, true, now(), $3, $4)`,
      [...base, quota],
    );
}

async function quotas(): Promise<Record<string, [quota: number, used: number]>> {
  const result = await client.query('SELECT id, quota_bytes, used_bytes FROM "user" ORDER BY id');
  return Object.fromEntries(
    result.rows.map((row) => [row.id, [Number(row.quota_bytes), Number(row.used_bytes)]]),
  );
}

const columnDefault = async () =>
  (
    await client.query(
      "SELECT column_default FROM information_schema.columns WHERE table_name = 'user' AND column_name = 'quota_bytes'",
    )
  ).rows[0].column_default as string;

beforeAll(async () => {
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${scratch}"`);
  await admin.end();
  client = new Client({ connectionString: localDbUrl(scratch) });
  await client.connect();
  const before = journal.entries.map((entry) => entry.tag).filter((tag) => tag < TAG);
  expect(before).toEqual([
    "0000_extensions",
    "0001_schema",
    "0002_purge_attempted_at",
    "0003_session_second_factor_account_unique",
  ]);
  for (const tag of before) await apply(tag);
}, 60_000);

afterAll(async () => {
  await client?.end();
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.end();
});

describe("migration 0004", () => {
  it("is in the journal, and is the newest migration", () => {
    expect(journal.entries.at(-1)!.tag).toBe(TAG);
  });

  it("before it, a new row is given 5 GiB", async () => {
    expect(await columnDefault()).toBe(`'${OLD_DEFAULT}'::bigint`);
    await insertUser("u-old-default");
    await insertUser("u-old-default-used", undefined, 1_234);
    await insertUser("u-granted-more", 10_000_000_000);
    await insertUser("u-granted-less", 1_000);
    // One byte off the old default is somebody's decision, not the default.
    await insertUser("u-near", OLD_DEFAULT - 1);
    expect((await quotas())["u-old-default"]).toEqual([OLD_DEFAULT, 0]);
  });

  it("moves the default to 5,000,000,000 and, with it, exactly the rows that held the old default", async () => {
    await apply(TAG);
    expect(await columnDefault()).toBe(`'${NEW_DEFAULT}'::bigint`);
    expect(await quotas()).toEqual({
      "u-granted-less": [1_000, 0],
      "u-granted-more": [10_000_000_000, 0],
      "u-near": [OLD_DEFAULT - 1, 0],
      "u-old-default": [NEW_DEFAULT, 0],
      "u-old-default-used": [NEW_DEFAULT, 1_234],
    });
    await insertUser("u-new");
    expect((await quotas())["u-new"]).toEqual([NEW_DEFAULT, 0]);
  });

  it("expands only: no statement that could break the Worker version before it", () => {
    const sql = readFileSync(`${root}drizzle/${TAG}.sql`, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|SET\s+NOT\s+NULL)\b/i);
    expect(sql).toMatch(/ALTER COLUMN "quota_bytes" SET DEFAULT 5000000000;/);
    expect(sql).toMatch(/UPDATE "user" SET "quota_bytes" = 5000000000 WHERE "quota_bytes" = 5368709120;/);
  });
});
