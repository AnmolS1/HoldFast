// Error hygiene (T26 item 11): a 5xx body is `{ error, message, requestId }` and nothing else — no
// stack, no SQL, no table or column, no connection detail — whatever the database threw. Forced
// with REAL Postgres errors through the real pipeline and the real error handlers: a statement
// against a table that does not exist, a constraint violation, and a database that cannot be
// reached (a made-up password in its connection string). The files host answers plain text.
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { INTERNAL_ERROR } from "../../../src/shared/errors";
import { createApp } from "../../../src/worker/app";
import { createFilesHost } from "../../../src/worker/files-host";
import { db, type AppEnv } from "../../../src/worker/services/request-context";
import { TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { realCore } from "../auth/helpers";
import { urlFor } from "../files-host/harness";
import { call } from "../worker-core/helpers";

// Obviously made up: what must never appear in an answer.
const SECRET = "made-up-db-password-T26";
const UNREACHABLE = { connectionString: `postgres://holdfast:${SECRET}@127.0.0.1:1/no_such_db_t26` };

const LEAKS = [
  /no_such_table_t26/,
  /no_such_db_t26/,
  /select|insert|update|delete from/i,
  /relation|constraint|violates|syntax|column/i,
  /postgres|pg_|hyperdrive|ECONNREFUSED|127\.0\.0\.1|:1\b/i,
  new RegExp(SECRET),
  /\bat \S+ \(|\.ts:\d+|\.js:\d+|stack/i,
];

function probeRouter() {
  const router = new Hono<AppEnv>();
  // Under /api/public/: no session is read, so the only database work is the probe's own.
  router.get("/public/t26-missing-table", async (c) => {
    await db(c).execute(sql`SELECT secret_column FROM no_such_table_t26 WHERE id = ${"x"}`);
    return c.json({ reached: true });
  });
  router.get("/public/t26-check-violation", async (c) => {
    await db(c).execute(sql`SELECT (1 / 0)::int AS crash, 'no_such_table_t26' AS hint`);
    return c.json({ reached: true });
  });
  router.get("/public/t26-any-query", async (c) => {
    await db(c).execute(sql`SELECT 1`);
    return c.json({ reached: true });
  });
  return router;
}

function expectClean(status: number, text: string, label: string) {
  expect(status, label).toBe(500);
  for (const leak of LEAKS) expect(text, `${label} ${leak}`).not.toMatch(leak);
}

describe("5xx bodies on the app host", () => {
  // The real core: the probe routes use the request's own client of the real database.
  const real = createApp(realCore, { extraRouters: [probeRouter()] });

  it.each([
    ["a statement against a missing table", "/api/public/t26-missing-table", {}],
    ["a statement that fails at run time", "/api/public/t26-check-violation", {}],
    ["a database that cannot be reached", "/api/public/t26-any-query", { HYPERDRIVE: UNREACHABLE }],
  ])("%s → exactly { error, message, requestId }", async (label, path, env) => {
    const { response, ctx } = await call(real, path, { env });
    const text = await response.text();
    await ctx.settle();
    expectClean(response.status, text, label);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort(), label).toEqual(["error", "message", "requestId"]);
    expect(body.error).toBe(INTERNAL_ERROR);
    expect(body.message).toBe("Something went wrong.");
    expect(body.requestId).toMatch(/^[A-Za-z0-9-]{8,}$/);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
  });
});

describe("5xx bodies on the files host", () => {
  it("a database that cannot be reached → plain text, no detail", async () => {
    // A token that verifies, so the request gets as far as the database.
    const node = {
      id: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e",
      versionId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9f",
    };
    const path = await urlFor("download", node, { user: "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL" });
    const { response, ctx } = await call(createFilesHost(realCore), path, {
      origin: TEST_FILES_ORIGIN,
      env: { HYPERDRIVE: UNREACHABLE },
    });
    const text = await response.text();
    await ctx.settle();
    for (const leak of LEAKS) expect(text, String(leak)).not.toMatch(leak);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(text).not.toMatch(/[{}]/);
  });
});
