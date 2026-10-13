// Migration 0005 on a scratch database of its own (the local server only): one unlifted strike
// per violation, and the ledger subject of the owner-wide link ceiling.
//   - `ledger_subject` gains the value `link_owner`;
//   - `strikes.content_sha256` (nullable);
//   - a unique partial index on (user_id, kind, node_id) and one on (user_id, kind, content_sha256),
//     each over unlifted rows that have the key.
// The statements are run exactly as drizzle's migrator runs them: split on its breakpoint
// marker, inside one transaction per migration file.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localDbUrl } from "../../../setup/local-env";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const scratch = `holdfast_m0005_${randomBytes(4).toString("hex")}`;

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

const TAG = "0005_strikes_dedupe_link_owner";
const USER = "u-0005";
const OTHER = "u-0005-other";
const NODE = "0199d3c2-7a10-7000-8000-0000000000a1";
const NODE_2 = "0199d3c2-7a10-7000-8000-0000000000b2";
// A made-up digest: 64 hex characters that belong to no real content.
const SHA = "ab".repeat(32);

let n = 0;
const strikeId = () => `0199d3c2-7a10-7000-8000-${String(++n).padStart(12, "0")}`;

async function strike(row: { user?: string; kind?: string; node?: string; sha?: string; lifted?: boolean }) {
  const columns = ["id", "user_id", "kind", "node_id", "lifted_at"];
  const values: unknown[] = [
    strikeId(),
    row.user ?? USER,
    row.kind ?? "malware",
    row.node ?? null,
    row.lifted ? new Date() : null,
  ];
  if (row.sha !== undefined) {
    columns.push("content_sha256");
    values.push(row.sha);
  }
  await client.query(
    `INSERT INTO strikes (${columns.join(", ")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(", ")})`,
    values,
  );
}

const refused = async (row: Parameters<typeof strike>[0]) => {
  const error = await strike(row).then(
    () => null,
    (thrown: { code?: string; constraint?: string }) => thrown,
  );
  expect(error?.code).toBe("23505");
  return error?.constraint;
};

const count = async () => Number((await client.query("SELECT count(*) AS n FROM strikes")).rows[0].n);

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
  ]);
  for (const tag of before) await apply(tag);
  for (const id of [USER, OTHER]) {
    await client.query(
      `INSERT INTO "user" (id, name, email, email_verified, updated_at) VALUES ($1, 'M', $2, true, now())`,
      [id, `${id}@example.test`],
    );
  }
}, 60_000);

afterAll(async () => {
  await client?.end();
  const admin = new Client({ connectionString: localDbUrl("postgres") });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.end();
});

describe("migration 0005", () => {
  it("is in the journal, right after 0004", () => {
    expect(journal.entries[5]!.tag).toBe(TAG);
  });

  it("before it, the same node can be struck twice and there is no content column (the control)", async () => {
    await strike({ user: OTHER, node: NODE });
    await strike({ user: OTHER, node: NODE });
    expect(await count()).toBe(2);
    await expect(strike({ user: OTHER, sha: SHA })).rejects.toThrow(/content_sha256/);
    await expect(
      client.query(
        "INSERT INTO download_ledger (day, subject_type, subject_id, bytes, count) VALUES (current_date, 'link_owner', 'x', 1, 0)",
      ),
    ).rejects.toThrow(/invalid input value for enum ledger_subject/);
    // A table holding such duplicates could not take the unique index: start from none.
    await client.query("DELETE FROM strikes");
  });

  it("adds the column and the two unique partial indexes", async () => {
    await apply(TAG);
    const column = await client.query(
      "SELECT data_type, is_nullable FROM information_schema.columns WHERE table_name = 'strikes' AND column_name = 'content_sha256'",
    );
    expect(column.rows).toEqual([{ data_type: "text", is_nullable: "YES" }]);
    const indexes = await client.query(
      "SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'strikes' AND indexname LIKE 'strikes_user_kind_%' ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "strikes_user_kind_content_uq",
      "strikes_user_kind_node_uq",
    ]);
    for (const row of indexes.rows) expect(row.indexdef).toMatch(/^CREATE UNIQUE INDEX /);
    expect(indexes.rows[0].indexdef).toMatch(
      /\(user_id, kind, content_sha256\) WHERE \(\(content_sha256 IS NOT NULL\) AND \(lifted_at IS NULL\)\)/,
    );
    expect(indexes.rows[1].indexdef).toMatch(
      /\(user_id, kind, node_id\) WHERE \(\(node_id IS NOT NULL\) AND \(lifted_at IS NULL\)\)/,
    );
  });

  it("one unlifted strike per user, kind and node", async () => {
    await strike({ node: NODE });
    expect(await refused({ node: NODE })).toBe("strikes_user_kind_node_uq");
    // Another kind, another node, another user: allowed.
    await strike({ node: NODE, kind: "dmca" });
    await strike({ node: NODE_2 });
    await strike({ node: NODE, user: OTHER });
  });

  it("one unlifted strike per user, kind and content, whatever the node", async () => {
    await strike({ sha: SHA });
    expect(await refused({ sha: SHA })).toBe("strikes_user_kind_content_uq");
    expect(await refused({ sha: SHA, node: "0199d3c2-7a10-7000-8000-0000000000c3" })).toBe(
      "strikes_user_kind_content_uq",
    );
    await strike({ sha: SHA, kind: "dmca" });
    await strike({ sha: "cd".repeat(32) });
    await strike({ sha: SHA, user: OTHER });
  });

  it("a lifted strike blocks nothing, and a strike with neither key is never unique", async () => {
    await client.query("UPDATE strikes SET lifted_at = now() WHERE user_id = $1 AND kind = 'malware'", [
      USER,
    ]);
    await strike({ node: NODE });
    await strike({ sha: SHA });
    // Lifted rows may repeat as well.
    await strike({ node: NODE, lifted: true });
    await strike({ sha: SHA, lifted: true });
    const before = await count();
    await strike({});
    await strike({});
    await strike({});
    expect(await count()).toBe(before + 3);
  });

  it("adds the ledger subject link_owner, usable once the migration has committed", async () => {
    const values = await client.query(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'ledger_subject' ORDER BY e.enumsortorder",
    );
    const labels = values.rows.map((row) => row.enumlabel as string);
    expect(labels).toContain("link_owner");
    // Every value that existed before is still there, in its place.
    expect(labels.filter((label) => label !== "link_owner")).toEqual([
      "user",
      "link",
      "ip",
      "upload_user",
      "upload_editor",
      "transform_user",
      "share_user",
      "link_user",
      "signup_ip",
      "signup_ip24",
      "signup_asn",
      "signup_domain",
      "ip24",
      "asn",
      "email",
    ]);
    await client.query(
      "INSERT INTO download_ledger (day, subject_type, subject_id, bytes, count) VALUES (current_date, 'link_owner', $1, 5, 0)",
      [USER],
    );
    const row = await client.query(
      "SELECT bytes FROM download_ledger WHERE subject_type = 'link_owner' AND subject_id = $1",
      [USER],
    );
    expect(Number(row.rows[0].bytes)).toBe(5);
  });

  it("the migration never uses the new value itself (it could not, in the same transaction)", () => {
    const statements = statementsOf(TAG);
    expect(statements[0]).toMatch(/^ALTER TYPE "public"\."ledger_subject" ADD VALUE 'link_owner'/);
    for (const statement of statements.slice(1)) expect(statement).not.toContain("link_owner");
  });

  it("expands only: no statement that could break the Worker version before it", () => {
    const sql = readFileSync(`${root}drizzle/${TAG}.sql`, "utf8").replace(/--[^\n]*/g, "");
    expect(sql).not.toMatch(/\b(DROP|RENAME|TRUNCATE|DELETE|UPDATE|SET\s+NOT\s+NULL)\b/i);
    expect(sql).toMatch(/ADD COLUMN "content_sha256" text;/);
    expect(statementsOf(TAG)).toHaveLength(4);
  });
});
