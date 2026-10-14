// A NUL in a bind value is refused by the statement wrapper (db/client.ts) before anything is
// sent, as `QueryError("validation")`; a NUL Postgres sees anyway (JSON text) is mapped to the
// same by `asQueryError` (db/errors.ts).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod";
import * as account from "../../../src/shared/schemas/account";
import * as admin from "../../../src/shared/schemas/admin";
import * as common from "../../../src/shared/schemas/common";
import * as link from "../../../src/shared/schemas/link";
import * as node from "../../../src/shared/schemas/node";
import * as report from "../../../src/shared/schemas/report";
import * as search from "../../../src/shared/schemas/search";
import * as share from "../../../src/shared/schemas/share";
import * as upload from "../../../src/shared/schemas/upload";
import { statementsSent } from "../../../src/worker/db/client";
import { asQueryError, QueryError } from "../../../src/worker/db/errors";
import { openDb, rejection } from "./_helpers";

const { db, close } = openDb();
afterAll(() => close());

/** The error a statement failed with, as the error handlers will classify it. */
async function classified(statement: Promise<unknown>) {
  const error = await rejection(statement);
  const query = asQueryError(error);
  return { error, query: query ? { name: query.name, code: query.code } : undefined };
}
const VALIDATION = { name: "QueryError", code: "validation" };
const schemaModules: Record<string, Record<string, unknown>> = {
  account,
  admin,
  common,
  link,
  node,
  report,
  search,
  share,
  upload,
};

describe("a NUL in a bind value", () => {
  it("a string bind: refused before it is sent — validation, not counted as a statement", async () => {
    for (const value of ["\u0000", "a\u0000b", `${"x".repeat(5000)}\u0000`]) {
      const before = statementsSent(db);
      expect((await classified(db.execute(sql`SELECT ${value}::text AS v`))).query).toEqual(VALIDATION);
      expect(statementsSent(db)).toBe(before);
    }
  });

  it("an array bind (= ANY($1)), at any depth — and an array spread into one bind per item", async () => {
    const before = statementsSent(db);
    for (const value of [
      ["ok", "a\u0000"],
      [["ok"], ["\u0000"]],
    ]) {
      const one = sql`SELECT 1 WHERE 'x' = ANY(${sql.param(value)}::text[])`;
      expect((await classified(db.execute(one))).query).toEqual(VALIDATION);
    }
    const spread = sql`SELECT 1 WHERE 'x' IN (${sql.join(
      ["ok", "a\u0000"].map((v) => sql`${v}`),
      sql`, `,
    )})`;
    expect((await classified(db.execute(spread))).query).toEqual(VALIDATION);
    expect(statementsSent(db)).toBe(before);
  });

  it("the handle goes on: the next statement runs; a transaction with such a statement rolls back like any failed one", async () => {
    await rejection(db.execute(sql`SELECT ${"\u0000"}::text`));
    expect((await db.execute<{ v: string }>(sql`SELECT ${"fine"}::text AS v`)).rows).toEqual([{ v: "fine" }]);
    const failed = await rejection(
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT 1`);
        await tx.execute(sql`SELECT ${"\u0000"}::text`);
      }),
    );
    expect(asQueryError(failed)?.code).toBe("validation");
    expect((await db.execute<{ n: number }>(sql`SELECT 2::int AS n`)).rows).toEqual([{ n: 2 }]);
  });

  // Review m3: outside a transaction a statement goes through `pool.query`, which ends the client
  // it lent when the statement fails. A refusal takes no client at all: the connection stays.
  it("a refusal outside a transaction keeps the pooled connection: the next statement runs on the same backend", async () => {
    const pid = async () =>
      (await db.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
    const before = await pid();
    for (let i = 0; i < 3; i++) await rejection(db.execute(sql`SELECT ${"a\u0000"}::text`));
    expect(await pid()).toBe(before);
  });

  it("clean binds are sent and counted exactly as before: one statement each", async () => {
    const before = statementsSent(db);
    const rows = await db.execute<{ a: string; b: string[]; c: string }>(
      sql`SELECT ${"plain \u0001 \t control"}::text AS a, ${sql.param(["x", "y"])}::text[] AS b, ${"\\u0000"}::text AS c`,
    );
    expect(rows.rows).toEqual([{ a: "plain \u0001 \t control", b: ["x", "y"], c: "\\u0000" }]);
    expect(statementsSent(db)).toBe(before + 1);
  });

  it("byte data is never inspected: a bytea bind with zero bytes goes through", async () => {
    const bytes = Buffer.from([0, 1, 0, 2]);
    const rows = await db.execute<{ n: number }>(sql`SELECT length(${bytes}::bytea)::int AS n`);
    expect(rows.rows).toEqual([{ n: 4 }]);
  });

  it("JSON: a real NUL in a value (sent as the escape) is Postgres's 22P05 → validation; an escaped backslash + 'u0000' is stored", async () => {
    const bad = JSON.stringify({ name: "a\u0000b" });
    expect((await classified(db.execute(sql`SELECT ${bad}::jsonb AS j`))).query).toEqual(VALIDATION);
    const harmless = JSON.stringify({ name: "a\\u0000b" });
    const rows = await db.execute<{ j: { name: string } }>(sql`SELECT ${harmless}::jsonb AS j`);
    expect(rows.rows[0]!.j).toEqual({ name: "a\\u0000b" });
  });

  it("the net under the check: a NUL Postgres meets in text (22021) is validation too; other database errors are not", async () => {
    const nul = await classified(db.execute(sql`SELECT convert_from('\\x00'::bytea, 'UTF8')`));
    expect(nul.query).toEqual(VALIDATION);
    const other = await classified(db.execute(sql`SELECT 1/0`));
    expect(other.query).toBeUndefined();
    expect(asQueryError(new Error("plain"))).toBeUndefined();
    const mine = new QueryError("not_found");
    expect(asQueryError(Object.assign(new Error("wrapped"), { cause: mine }))).toBe(mine);
  });
});

// ── every exported request schema, every string field ────────────────────────────────────────
// Each request schema (a `…Body` / `…Query` export of src/shared/schemas) is walked to its string
// leaves. Each leaf is given strings carrying a NUL: one it refuses is the route's 400 (ZodError);
// one it ACCEPTS is what a route would hand to a query — bound here, it must be the wrapper's
// `validation`, never a database error. Routes that exist on `dev` are walked through for real
// in tests/unit/worker-core/nul-routes.test.ts.
type Leaf = { path: string; schema: z.ZodType };
function stringLeaves(schema: z.ZodType, path: string, out: Leaf[], seen = new Set<z.ZodType>()): Leaf[] {
  if (seen.has(schema)) return out;
  seen.add(schema);
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  const inner = (key: string) => def[key] as z.ZodType;
  switch (def.type) {
    case "string":
    case "email":
      out.push({ path, schema });
      break;
    case "object":
      for (const [key, value] of Object.entries(def.shape as Record<string, z.ZodType>)) {
        stringLeaves(value, `${path}.${key}`, out, seen);
      }
      break;
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "catch":
    case "readonly":
    case "nonoptional":
      stringLeaves(inner("innerType"), path, out, seen);
      break;
    case "pipe":
      stringLeaves(inner("in"), path, out, seen);
      break;
    case "array":
      stringLeaves(inner("element"), `${path}[]`, out, seen);
      break;
    case "union":
      for (const option of def.options as z.ZodType[]) stringLeaves(option, path, out, seen);
      break;
    case "record":
      stringLeaves(inner("valueType"), `${path}{}`, out, seen);
      break;
    default:
      break;
  }
  return out;
}

const NUL_CANDIDATES = [
  "\u0000",
  "a\u0000b",
  "report\u0000.pdf",
  "someone\u0000@example.test",
  `${crypto.randomUUID().slice(0, 35)}\u0000`,
  "2026-10-13T00:00:00.000Z\u0000",
];

describe("every exported request schema: a NUL in any string field is a 400, never a 500", () => {
  it("walks every …Body / …Query export; a value the schema accepts is refused when bound", async () => {
    // Every schema file is in the walk: a new one must be added above.
    const files = readdirSync(join(import.meta.dirname, "../../../src/shared/schemas"))
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.slice(0, -3))
      .sort();
    expect(Object.keys(schemaModules).sort()).toEqual(files);
    const leaves: Leaf[] = [];
    for (const [file, mod] of Object.entries(schemaModules)) {
      for (const [name, value] of Object.entries(mod)) {
        if (!/(Body|Query)$/.test(name) || !(value instanceof z.ZodType)) continue;
        stringLeaves(value, `${file}:${name}`, leaves);
      }
    }
    // Not vacuous: the walk reaches the string fields there are (names, cursors, emails, ids, free text).
    expect(leaves.length).toBeGreaterThan(30);
    for (const sample of [
      "node:CreateFolderBody.name",
      "search:SearchQuery.cursor",
      "account:PendingEmailBody.email",
    ]) {
      expect(leaves.map((leaf) => leaf.path)).toContain(sample);
    }
    let accepted = 0;
    for (const leaf of leaves) {
      for (const candidate of NUL_CANDIDATES) {
        const parsed = leaf.schema.safeParse(candidate);
        if (!parsed.success) continue;
        if (typeof parsed.data !== "string" || !parsed.data.includes("\u0000")) continue;
        accepted += 1;
        const before = statementsSent(db);
        const outcome = await classified(db.execute(sql`SELECT ${parsed.data}::text`));
        expect(outcome.query, `${leaf.path} ← ${JSON.stringify(candidate)}`).toEqual(VALIDATION);
        expect(statementsSent(db)).toBe(before);
      }
    }
    // Schemas DO let NULs through (free text, names): that is what the wrapper is for.
    expect(accepted).toBeGreaterThan(10);
  });
});
