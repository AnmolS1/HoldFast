// Migration 0006 on a scratch database of its own (the local server only): a blocklist entry
// that a suspected-CSAM lock RAISED to `csam` remembers what it was, so that clearing a false
// positive can put it back.
//   - `hash_blocklist.raised_from` (the blocklist reason type, nullable);
//   - `hash_blocklist.raised_by_node_id` (uuid, nullable, no foreign key — like `source_node_id`).
// The statements are run exactly as drizzle's migrator runs them: split on its breakpoint
// marker, inside one transaction per migration file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDbUrl } from "../../../setup/local-env";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = `holdfast_m0006_${randomBytes(4).toString("hex")}`;

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

const TAG = "0006_blocklist_raised_from";
// Made-up digests: 64 hex characters that belong to no real content.
const LISTED_BEFORE = "ab".repeat(32);
const RAISED = "cd".repeat(32);
const NODE = "0199d3c2-7a10-7000-8000-0000000000a1";

const columns = async () =>
  (
    await client.query(
      `SELECT column_name, udt_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_name = 'hash_blocklist' ORDER BY ordinal_position`,
    )
  ).rows as { column_name: string; udt_name: string; is_nullable: string; column_default: string | null }[];

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
    "0004_quota_default_decimal",
    "0005_strikes_dedupe_ledger_subjects",
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

describe("migration 0006", () => {
  it("is in the journal, right after 0005", () => {
    expect(journal.entries[6]!.tag).toBe(TAG);
  });

  it("before it, an entry cannot say what it was raised from (the control)", async () => {
    expect((await columns()).map((c) => c.column_name)).toEqual([
      "sha256",
      "reason",
      "source_node_id",
      "added_by",
      "added_at",
      "note",
    ]);
    await client.query("INSERT INTO hash_blocklist (sha256, reason, note) VALUES ($1, 'malware', 'before')", [
      LISTED_BEFORE,
    ]);
    await expect(
      client.query("UPDATE hash_blocklist SET raised_from = reason WHERE sha256 = $1", [LISTED_BEFORE]),
    ).rejects.toThrow(/raised_from/);
  });

  it("adds the two columns, nullable and without a default, and leaves existing entries as they were", async () => {
    await apply(TAG);
    const added = (await columns()).filter((c) => c.column_name.startsWith("raised_"));
    expect(added).toEqual([
      { column_name: "raised_from", udt_name: "blocklist_reason", is_nullable: "YES", column_default: null },
      { column_name: "raised_by_node_id", udt_name: "uuid", is_nullable: "YES", column_default: null },
    ]);
    const existing = await client.query("SELECT * FROM hash_blocklist WHERE sha256 = $1", [LISTED_BEFORE]);
    expect(existing.rows[0]).toMatchObject({
      reason: "malware",
      note: "before",
      raised_from: null,
      raised_by_node_id: null,
    });
    // No foreign key on the new node column: an entry outlives the node, like `source_node_id`.
    const fks = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid = 'hash_blocklist'::regclass AND contype = 'f'`,
    );
    expect(fks.rows.map((r) => r.conname as string).filter((name) => name.includes("raised"))).toEqual([]);
  });

  it("the previous Worker version's writes still work: an insert that names neither column", async () => {
    await client.query("INSERT INTO hash_blocklist (sha256, reason) VALUES ($1, 'dmca')", [RAISED]);
    const row = await client.query(
      "SELECT raised_from, raised_by_node_id FROM hash_blocklist WHERE sha256 = $1",
      [RAISED],
    );
    expect(row.rows[0]).toEqual({ raised_from: null, raised_by_node_id: null });
  });

  it("a raise and its undo, as the lock and the clear write them", async () => {
    // The lock's one statement: raise an entry that is not `csam`, remembering what it was.
    const raise = `INSERT INTO hash_blocklist (sha256, reason, source_node_id) VALUES ($1, 'csam', $2)
      ON CONFLICT (sha256) DO UPDATE
      SET reason = 'csam', raised_from = hash_blocklist.reason, raised_by_node_id = $2
      WHERE hash_blocklist.reason <> 'csam'`;
    await client.query(raise, [RAISED, NODE]);
    const read = async () =>
      (
        await client.query(
          "SELECT reason, source_node_id, raised_from, raised_by_node_id FROM hash_blocklist WHERE sha256 = $1",
          [RAISED],
        )
      ).rows[0];
    expect(await read()).toEqual({
      reason: "csam",
      source_node_id: null,
      raised_from: "dmca",
      raised_by_node_id: NODE,
    });
    // Run again by another node: a `csam` entry is not raised, and nothing is recorded over.
    await client.query(raise, [RAISED, "0199d3c2-7a10-7000-8000-0000000000b2"]);
    expect(await read()).toMatchObject({ raised_from: "dmca", raised_by_node_id: NODE });
    // Only a reason of the type fits.
    await expect(
      client.query("UPDATE hash_blocklist SET raised_from = 'nonsense' WHERE sha256 = $1", [RAISED]),
    ).rejects.toThrow(/invalid input value for enum blocklist_reason/);
    await client.query(
      "UPDATE hash_blocklist SET reason = raised_from, raised_from = NULL, raised_by_node_id = NULL WHERE sha256 = $1",
      [RAISED],
    );
    expect(await read()).toEqual({
      reason: "dmca",
      source_node_id: null,
      raised_from: null,
      raised_by_node_id: null,
    });
  });

  it("expands only: no statement that could break the Worker version before it", () => {
    const sql = readFileSync(`${root}drizzle/${TAG}.sql`, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|NOT\s+NULL|DEFAULT)\b/i);
    expect(statementsOf(TAG)).toEqual([
      'ALTER TABLE "hash_blocklist" ADD COLUMN "raised_from" "blocklist_reason";',
      'ALTER TABLE "hash_blocklist" ADD COLUMN "raised_by_node_id" uuid;',
    ]);
  });
});
