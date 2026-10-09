import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, parseTimestampAsUtc, withDb } from "../../../src/worker/db/client";
import { rejection, testEnv } from "./_helpers";

const ROOT = join(import.meta.dirname, "../../..");

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "spikes" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) out.push(path);
  }
  return out;
}

describe("createDb", () => {
  it("runs a query, and parallel queries share one pool", async () => {
    const { db, close } = createDb(testEnv());
    try {
      const results = await Promise.all(
        [1, 2, 3, 4, 5, 6, 7].map((n) => db.execute<{ n: number }>(sql`SELECT ${n}::int AS n`)),
      );
      expect(results.map((r) => r.rows[0]!.n)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    } finally {
      await close();
    }
  });

  it("close() twice resolves", async () => {
    const { db, close } = createDb(testEnv());
    await db.execute(sql`SELECT 1`);
    await expect(close()).resolves.toBeUndefined();
    await expect(close()).resolves.toBeUndefined();
  });

  it("close() with no query ever run resolves", async () => {
    const { close } = createDb(testEnv());
    await expect(close()).resolves.toBeUndefined();
    await expect(close()).resolves.toBeUndefined();
  });

  it("a query after close() rejects at once instead of hanging", async () => {
    const { db, close } = createDb(testEnv());
    await close();
    const started = Date.now();
    const error = await rejection(db.execute(sql`SELECT 1`));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(String((error as Error).cause ?? error)).toContain(
      "Cannot use a pool after calling end on the pool",
    );
  });

  it("a transaction has its own connection: the outer handle does not see uncommitted rows", async () => {
    class Undo extends Error {}
    const { db, close } = createDb(testEnv());
    const key = `client-test-${Date.now()}-${Math.random()}`;
    let inside = -1;
    let outside = -1;
    try {
      const attempt = db.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO settings (key, value) VALUES (${key}, '1'::jsonb)`);
        inside = (await tx.execute(sql`SELECT 1 FROM settings WHERE key = ${key}`)).rows.length;
        outside = (await db.execute(sql`SELECT 1 FROM settings WHERE key = ${key}`)).rows.length;
        throw new Undo();
      });
      await expect(attempt).rejects.toBeInstanceOf(Undo);
      expect(inside).toBe(1);
      expect(outside).toBe(0);
      expect((await db.execute(sql`SELECT 1 FROM settings WHERE key = ${key}`)).rows).toHaveLength(0);
    } finally {
      await close();
    }
  });
});

describe("withDb", () => {
  it("returns the callback's value and closes the pool", async () => {
    let captured: ReturnType<typeof createDb>["db"] | undefined;
    const value = await withDb(testEnv(), async (db) => {
      captured = db;
      const result = await db.execute<{ n: number }>(sql`SELECT 41 + 1 AS n`);
      return result.rows[0]!.n;
    });
    expect(value).toBe(42);
    await expect(captured!.execute(sql`SELECT 1`)).rejects.toThrow();
  });

  it("closes the pool when the callback throws", async () => {
    let captured: ReturnType<typeof createDb>["db"] | undefined;
    await expect(
      withDb(testEnv(), async (db) => {
        captured = db;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await expect(captured!.execute(sql`SELECT 1`)).rejects.toThrow();
  });
});

describe("parseTimestampAsUtc", () => {
  it("reads a zone-less value as UTC", () => {
    expect((parseTimestampAsUtc("2026-01-15 18:30:45.123") as Date).toISOString()).toBe(
      "2026-01-15T18:30:45.123Z",
    );
    expect((parseTimestampAsUtc("2026-07-04 03:00:00") as Date).toISOString()).toBe(
      "2026-07-04T03:00:00.000Z",
    );
    expect(parseTimestampAsUtc("infinity")).toBe(Infinity);
    expect(parseTimestampAsUtc("-infinity")).toBe(-Infinity);
  });
});

describe("source rules for the database layer", () => {
  it("nothing in src/worker/db references waitUntil", () => {
    const hits = filesUnder(join(ROOT, "src/worker/db")).filter((file) =>
      readFileSync(file, "utf8").includes("waitUntil"),
    );
    expect(hits).toEqual([]);
  });

  it("nothing imports postgres.js", () => {
    const pattern = /from\s+["'](postgres|drizzle-orm\/postgres-js)["']/;
    const files = [
      ...filesUnder(join(ROOT, "src")),
      ...filesUnder(join(ROOT, "scripts")),
      ...filesUnder(join(ROOT, "tests")),
    ];
    expect(files.length).toBeGreaterThan(20);
    expect(files.filter((file) => pattern.test(readFileSync(file, "utf8")))).toEqual([]);
  });

  it("the pool is created inside createDb, never at module scope", () => {
    const source = readFileSync(join(ROOT, "src/worker/db/client.ts"), "utf8");
    expect(source.match(/new Pool\(/g)).toHaveLength(1);
    expect(source).toMatch(
      /export function createDb\(env: Env\)[^]*?new Pool\(\{ connectionString: env\.HYPERDRIVE\.connectionString, max: 5 \}\)/,
    );
  });
});
