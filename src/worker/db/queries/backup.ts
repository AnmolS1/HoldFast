// The nightly export's reads (T27's one query module, PLAN §6 rule V-B2). Nothing here writes.
//
// WHICH TABLES. Every table of T05's Drizzle schema — `schema.ts` and Better Auth's
// `auth-schema.ts` — found by walking the two modules' exports, never a hand list: a migration
// that adds a table adds it here, and the coverage test (tests/unit/observability) compares this
// set with the schema's.
//
// WHAT A ROW IS. `to_jsonb(t)` of the row, one JSON object per line: Postgres serialises every
// type itself (microsecond timestamps, `bytea` as `\x…` hex, arrays, enums, jsonb), and the
// restore reads it back with `jsonb_populate_recordset(NULL::<table>, …)` — the same types both
// ways, with no client-side conversion that could round a timestamp or mangle bytes.
//
// KEYSET. Each table is read in primary-key order, a page at a time: the next page starts after
// the last row's key, compared as a row value against that row's own JSON read back through
// `jsonb_populate_record` — so composite, text, uuid and enum keys need no casts of ours. The
// keys come from the database's own catalogue (`pg_index.indisprimary`), as do the foreign keys
// that decide the order.

import { is, sql } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as authSchema from "../auth-schema";
import type { Executor } from "../client";
import * as appSchema from "../schema";

/** The physical name of every table in the Drizzle schema, sorted. */
export function schemaTableNames(): string[] {
  const names = new Set<string>();
  for (const value of [...Object.values(appSchema), ...Object.values(authSchema)]) {
    if (is(value, PgTable)) names.add(getTableConfig(value).name);
  }
  return [...names].sort();
}

/** One table's key and the foreign keys it holds. */
export type TableShape = {
  name: string;
  /** Primary-key columns, in index order. */
  key: string[];
  /** The tables this one references (its own name included for a self-reference). */
  references: string[];
};

/** A double-quoted identifier. Names come from the schema and the catalogue, never from a caller. */
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/**
 * The key and references of each named table, from the catalogue. A named table with no primary
 * key cannot be paged and throws: every table of the schema has one.
 */
export async function tableShapes(db: Executor, names: string[]): Promise<Map<string, TableShape>> {
  if (names.length === 0) return new Map();
  const list = sql.join(
    names.map((name) => sql`${name}`),
    sql`, `,
  );
  const keys = await db.execute<{ table: string; columns: string[] }>(sql`
    SELECT c.relname AS "table",
           array_agg(a.attname::text ORDER BY k.ord) AS columns
    FROM pg_index i
    JOIN pg_class c ON c.oid = i.indrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE i.indisprimary AND c.relname IN (${list})
    GROUP BY c.relname`);
  const refs = await db.execute<{ table: string; target: string }>(sql`
    SELECT DISTINCT src.relname AS "table", dst.relname AS target
    FROM pg_constraint f
    JOIN pg_class src ON src.oid = f.conrelid
    JOIN pg_class dst ON dst.oid = f.confrelid
    JOIN pg_namespace n ON n.oid = src.relnamespace AND n.nspname = 'public'
    WHERE f.contype = 'f' AND src.relname IN (${list})`);
  const shapes = new Map<string, TableShape>();
  for (const row of keys.rows) shapes.set(row.table, { name: row.table, key: row.columns, references: [] });
  for (const name of names) {
    if (!shapes.has(name)) throw new Error(`backup: table ${name} has no primary key`);
  }
  for (const row of refs.rows) shapes.get(row.table)!.references.push(row.target);
  return shapes;
}

/**
 * Parents before children: every table after each table it references (a self-reference is
 * ignored — `nodes` orders its own rows on restore). Ties by name. Throws on a cycle between
 * tables, which the schema does not have.
 */
export function parentsFirst(shapes: Map<string, TableShape>): string[] {
  const order: string[] = [];
  const placed = new Set<string>();
  const pending = [...shapes.keys()].sort();
  while (pending.length) {
    const next = pending.find((name) =>
      shapes.get(name)!.references.every((ref) => ref === name || placed.has(ref) || !shapes.has(ref)),
    );
    if (!next) throw new Error(`backup: a foreign-key cycle among ${pending.join(", ")}`);
    order.push(next);
    placed.add(next);
    pending.splice(pending.indexOf(next), 1);
  }
  return order;
}

/**
 * One page of a table: up to `limit` rows after `after` (the previous page's LAST line, or null
 * for the first page), each as its `to_jsonb` text, in key order.
 */
export async function readPage(
  db: Executor,
  shape: TableShape,
  after: string | null,
  limit: number,
  /** Columns left out of every line (the restore then loads them as NULL). Never a key column. */
  omit: readonly string[] = [],
): Promise<string[]> {
  if (omit.some((column) => shape.key.includes(column)))
    throw new Error("backup: a key column cannot be omitted");
  const table = sql.raw(ident(shape.name));
  const keyOf = (alias: string) => sql.raw(shape.key.map((column) => `${alias}.${ident(column)}`).join(", "));
  const where =
    after === null
      ? sql``
      : sql`WHERE (${keyOf("t")}) > (SELECT ${keyOf("c")} FROM jsonb_populate_record(NULL::${table}, ${after}::jsonb) c)`;
  const result = await db.execute<{ line: string }>(sql`
    SELECT (to_jsonb(t)${sql.raw(omit.map((column) => ` - '${column.replace(/'/g, "''")}'`).join(""))})::text AS line FROM ${table} t
    ${where}
    ORDER BY ${keyOf("t")}
    LIMIT ${limit}`);
  return result.rows.map((row) => row.line);
}

/**
 * The image transformations performed in one calendar month: the sum of the `transform_user`
 * units (T13 records one per transform actually made) on days in [`from`, `to`). Days as
 * `YYYY-MM-DD`. One statement over the month's ledger rows.
 */
export async function transformUnits(db: Executor, from: string, to: string): Promise<number> {
  const result = await db.execute<{ units: string | number | null }>(sql`
    SELECT COALESCE(SUM(count), 0)::bigint AS units FROM download_ledger
    WHERE subject_type = 'transform_user' AND day >= ${from}::date AND day < ${to}::date`);
  return Number(result.rows[0]?.units ?? 0);
}

/**
 * Each table's columns, in their order, as `name:type` (`udt_name`: enums by their own name) —
 * what the restore compares with its target, so that a renamed, dropped or added column refuses
 * the set instead of loading it silently wrong.
 */
export async function tableColumns(db: Executor, names: string[]): Promise<Map<string, string[]>> {
  const result = await db.execute<{ table: string; columns: string[] }>(sql`
    SELECT table_name::text AS "table",
           array_agg(column_name::text || ':' || udt_name::text ORDER BY ordinal_position) AS columns
    FROM information_schema.columns
    WHERE table_schema = current_schema()
    GROUP BY table_name`);
  const wanted = new Set(names);
  return new Map(result.rows.filter((row) => wanted.has(row.table)).map((row) => [row.table, row.columns]));
}

/**
 * The database's migration level: the `created_at` of the last migration drizzle applied, which
 * drizzle sets to that migration's journal `when` (drizzle/meta/_journal.json). Null when none.
 */
export async function migrationLevel(db: Executor): Promise<number | null> {
  const result = await db.execute<{ when: string | number | null }>(
    sql`SELECT max(created_at)::bigint AS "when" FROM drizzle.__drizzle_migrations`,
  );
  const raw = result.rows[0]?.when;
  return raw === null || raw === undefined ? null : Number(raw);
}

/** For each account, the last UTC day the kept-bytes alarm named it (its `notice` marker), if ever. */
export async function lastKeptAlerts(
  db: Executor,
  ownerIds: readonly string[],
): Promise<Map<string, string>> {
  if (ownerIds.length === 0) return new Map();
  const keys = sql.join(
    ownerIds.map((id) => sql`${`kept_backstop:${id}`}`),
    sql`, `,
  );
  const result = await db.execute<{ key: string; day: string }>(sql`
    SELECT subject_id AS key, max(day)::text AS day FROM download_ledger
    WHERE subject_type = 'notice' AND subject_id IN (${keys})
    GROUP BY subject_id`);
  return new Map(result.rows.map((row) => [row.key.slice("kept_backstop:".length), row.day]));
}
