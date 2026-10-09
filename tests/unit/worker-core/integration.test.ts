// The worker core against the REAL database layer: the same `CoreDeps` the Worker entry builds
// (createDb over a pg Pool, getSettings, termsVersionOf, insertAudit), this checkout's local
// Postgres through the Hyperdrive binding, and Miniflare's R2. Everything else under
// tests/unit/worker-core drives a fake `CoreDeps`; this file is where the two halves meet.
//
// Postgres is shared with every other test (no isolation): rows are found by a random marker,
// and the `settings` rows this file touches are put back afterwards.
import { env as workerEnv, exports } from "cloudflare:workers";
import { eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { ERROR_STATUS, type ErrorCode } from "../../../src/shared/errors";
import { PublicConfig } from "../../../src/shared/public-config";
import { createApp } from "../../../src/worker/app";
import { createAuth } from "../../../src/worker/auth/create-auth";
import type { SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import { createDb, withDb, type Db } from "../../../src/worker/db/client";
import { LegalHoldError, QueryError } from "../../../src/worker/db/errors";
import { insertAudit } from "../../../src/worker/db/queries/audit";
import { rename } from "../../../src/worker/db/queries/nodes";
import { clearSettingsCache, getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { termsVersionOf } from "../../../src/worker/db/queries/users";
import { auditLog, session, settings as settingsTable, user } from "../../../src/worker/db/schema";
import { createFilesHost } from "../../../src/worker/files-host";
import { audit } from "../../../src/worker/services/audit";
import {
  db,
  defer,
  runBackground,
  type AppEnv,
  type CoreDeps,
} from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN, TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { call, fakeCtx, POOL_ENDED, sameOrigin, sleep, testEnv } from "./helpers";

/** Exactly what src/worker/index.ts injects. */
const realCore: CoreDeps = { createDb, createAuth, getSettings, termsVersionOf, insertAudit };

type Envelope = { error: string; message: string; requestId: string; details?: Record<string, unknown> };

/** Every message on an error's `cause` chain (Drizzle wraps the driver's error). */
function messagesOf(error: unknown): string[] {
  const out: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth++) {
    out.push(current.message);
    current = current.cause;
  }
  return out;
}

/** The pool behind `handle` has been ended: a query is refused with pg's own message. */
async function expectPoolEnded(handle: Db | undefined): Promise<void> {
  expect(handle).toBeDefined();
  const failure: unknown = await handle!.execute(sql`select 1`).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure, "a query after close must be refused").not.toBeNull();
  expect(messagesOf(failure)).toContain(POOL_ENDED);
}

/** A connection string for a database that does not exist on this checkout's server. */
function deadDatabaseUrl(): string {
  const url = new URL(workerEnv.HYPERDRIVE.connectionString);
  url.pathname = "/holdfast_no_such_database";
  return url.toString();
}

describe("GET /api/health against real Postgres and R2", () => {
  it("is 200 { ok, db, r2 } through the app, and the pool is closed afterwards", async () => {
    const seen: { db?: Db } = {};
    const probe = new Hono<AppEnv>();
    probe.get("/_it/which-db", async (c) => {
      seen.db = db(c);
      const result = await db(c).execute(sql`select current_database() as name`);
      return c.json(result.rows[0]);
    });
    const app = createApp(realCore, { extraRouters: [probe] });

    const health = await call(app, "/api/health");
    expect(health.response.status).toBe(200);
    expect(await health.response.json()).toEqual({ ok: true, db: true, r2: true });
    await health.ctx.settle();

    // The database it reached is this checkout's own.
    const which = await call(app, "/api/_it/which-db");
    expect(await which.response.json()).toEqual({ name: inject("holdfastDb") });
    await which.ctx.settle();
    await expectPoolEnded(seen.db);
  });

  it("is 200 through the Worker's own entry (real modules, real bindings)", async () => {
    const response = await exports.default.fetch(`${TEST_APP_ORIGIN}/api/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ ok: true, db: true, r2: true });
  });

  it("is 503 { ok: false, db: false, r2: true } when the database URL is dead, with no error text", async () => {
    const app = createApp(realCore);
    const { response, ctx } = await call(app, "/api/health", {
      env: { HYPERDRIVE: { connectionString: deadDatabaseUrl() } },
    });
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({ ok: false, db: false, r2: true });
    expect(text).not.toMatch(/holdfast_no_such_database|does not exist|postgres/i);
    // The failed pool is still closed, and closing it does not throw.
    await ctx.settle();
  });
});

describe("the placeholder auth router", () => {
  it("answers the session read as signed out (JSON null), and nothing else under /api/auth", async () => {
    const app = createApp(realCore);
    const session = await call(app, "/api/auth/get-session");
    expect(session.response.status).toBe(200);
    expect(session.response.headers.get("content-type")).toMatch(/^application\/json/);
    expect(session.response.headers.get("cache-control")).toBe("no-store");
    expect(await session.response.text()).toBe("null");
    await session.ctx.settle();

    const signIn = await call(app, "/api/auth/sign-in/email", {
      method: "POST",
      headers: sameOrigin,
      body: "{}",
    });
    expect(signIn.response.status).toBe(404);
    expect(((await signIn.response.json()) as Envelope).error).toBe("not_found");
    await signIn.ctx.settle();
  });
});

describe("GET /api/public/config against the real settings table", () => {
  const KEYS = ["signupMode", "termsVersion", "uploadsEnabled", "linksEnabled", "readOnly"];
  let saved: Array<typeof settingsTable.$inferSelect> = [];

  const clearRows = (handle: Db) => handle.delete(settingsTable).where(inArray(settingsTable.key, KEYS));

  beforeAll(async () => {
    await withDb(workerEnv, async (handle) => {
      saved = await handle.select().from(settingsTable).where(inArray(settingsTable.key, KEYS));
      await clearRows(handle);
    });
    clearSettingsCache();
  });

  afterAll(async () => {
    await withDb(workerEnv, async (handle) => {
      await clearRows(handle);
      for (const row of saved) {
        await handle.insert(settingsTable).values({
          key: row.key,
          value: sql`${JSON.stringify(row.value)}::jsonb`,
          updatedBy: row.updatedBy,
          updatedAt: row.updatedAt,
        });
      }
    });
    clearSettingsCache();
  });

  async function readConfig(): Promise<PublicConfig> {
    const { response, ctx } = await call(createApp(realCore), "/api/public/config");
    expect(response.status).toBe(200);
    const body = PublicConfig.parse(await response.json());
    await ctx.settle();
    return body;
  }

  it("comes from the env when the table has no row", async () => {
    const config = await readConfig();
    expect(config).toMatchObject({
      signupMode: workerEnv.SIGNUP_MODE === "open" ? "open" : "invite",
      termsVersion: workerEnv.TERMS_VERSION,
      uploadsEnabled: true,
      linksEnabled: true,
      readOnly: false,
      turnstileSiteKey: workerEnv.TURNSTILE_SITEKEY,
      appOrigin: TEST_APP_ORIGIN,
      filesOrigin: TEST_FILES_ORIGIN,
      maxFileBytes: 2_000_000_000,
    });
  });

  it("reflects a settings row written through setSetting, and a POST then meets the real kill switch", async () => {
    const before = await readConfig();
    const flipped = before.signupMode === "open" ? "invite" : "open";
    const termsVersion = `w1b-${crypto.randomUUID()}`;
    await withDb(workerEnv, async (handle) => {
      await setSetting(handle, "signupMode", flipped, null);
      await setSetting(handle, "termsVersion", termsVersion, null);
      await setSetting(handle, "uploadsEnabled", false, null);
    });

    const after = await readConfig();
    expect(after).toMatchObject({
      signupMode: flipped,
      termsVersion,
      uploadsEnabled: false,
      linksEnabled: true,
      readOnly: false,
    });

    // Not read-only: a same-origin POST passes the whole pipeline and reaches the registry's 404.
    const app = createApp(realCore);
    const open = await call(app, "/api/nodes/folder", { method: "POST", headers: sameOrigin, body: "{}" });
    expect(open.response.status).toBe(404);
    expect(((await open.response.json()) as Envelope).error).toBe("not_found");
    await open.ctx.settle();

    await withDb(workerEnv, (handle) => setSetting(handle, "readOnly", true, null));
    expect((await readConfig()).readOnly).toBe(true);
    const refused = await call(app, "/api/nodes/folder", { method: "POST", headers: sameOrigin, body: "{}" });
    expect(refused.response.status).toBe(503);
    expect(((await refused.response.json()) as Envelope).error).toBe("read_only");
    await refused.ctx.settle();
  });
});

describe("deferred work on a real pool", () => {
  it("fetch: a deferred task that defers a task which queries succeeds, and the pool is closed afterwards", async () => {
    const seen: { db?: Db } = {};
    const order: string[] = [];
    const rows: unknown[] = [];
    const router = new Hono<AppEnv>();
    router.get("/_it/nested", (c) => {
      seen.db = db(c);
      defer(
        c,
        (async () => {
          await sleep(5);
          order.push("A");
          defer(
            c,
            (async () => {
              // Long after the response and after the first drain pass would have ended.
              await sleep(20);
              const result = await db(c).execute(sql`select 41 + 1 as answer`);
              rows.push(...result.rows);
              order.push("B");
            })(),
          );
        })(),
      );
      order.push("handler:end");
      return c.json({ ok: true });
    });

    const { response, ctx } = await call(createApp(realCore, { extraRouters: [router] }), "/api/_it/nested");
    expect(response.status).toBe(200);
    await response.text();
    await ctx.settle();

    // The assertion is on the row: allSettled swallows a rejection, so "no error" proves nothing.
    expect(rows).toEqual([{ answer: 42 }]);
    expect(order).toEqual(["handler:end", "A", "B"]);
    await expectPoolEnded(seen.db);
  });

  it("runBackground: the same for queue and cron code, one pool for the run, closed at the end", async () => {
    const seen: { db?: Db } = {};
    const rows: unknown[] = [];
    await runBackground(
      testEnv(),
      fakeCtx(),
      async (bg) => {
        seen.db = bg.db;
        await bg.db.execute(sql`select 1`);
        bg.defer(
          (async () => {
            await sleep(5);
            bg.defer(
              (async () => {
                await sleep(20);
                expect(bg.db).toBe(seen.db);
                const result = await bg.db.execute(sql`select 41 + 1 as answer`);
                rows.push(...result.rows);
              })(),
            );
          })(),
        );
      },
      realCore,
    );
    expect(rows).toEqual([{ answer: 42 }]);
    await expectPoolEnded(seen.db);
  });

  it("audit(c, …) writes a real audit_log row after the response", async () => {
    const marker = crypto.randomUUID();
    const router = new Hono<AppEnv>();
    router.get("/_it/audit", (c) => {
      audit(c, "w1b.integration", { type: "test", id: marker }, { n: 1 });
      return c.json({ requestId: c.get("requestId") });
    });
    const { response, ctx } = await call(createApp(realCore, { extraRouters: [router] }), "/api/_it/audit", {
      headers: { "user-agent": "w1b-integration" },
    });
    const { requestId } = (await response.json()) as { requestId: string };
    await ctx.settle();

    await withDb(workerEnv, async (handle) => {
      const found = await handle.select().from(auditLog).where(eq(auditLog.targetId, marker));
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        action: "w1b.integration",
        actorType: "system",
        actorUserId: null,
        targetType: "test",
        requestId,
        ua: "w1b-integration",
        meta: { n: 1 },
      });
      expect(found[0]!.ipHashDaily).toMatch(/^[0-9a-f]{64}$/);
      await handle.delete(auditLog).where(eq(auditLog.targetId, marker));
    });
  });
});

describe("a query helper's QueryError is answered like an AppError", () => {
  function thrower() {
    const router = new Hono<AppEnv>();
    router.get("/_qe/code/:code", (c) => {
      throw new QueryError(c.req.param("code") as ErrorCode);
    });
    router.get("/_qe/detailed", () => {
      throw new QueryError("conflict", "a file or folder with that name already exists here", {
        field: "name",
      });
    });
    router.get("/_qe/unknown-code", () => {
      throw Object.assign(new QueryError("conflict"), { code: "teapot" });
    });
    router.get("/_qe/hold", () => {
      throw new LegalHoldError({ "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e": ["suspected_csam", "open_notice"] });
    });
    // The real helpers, on the request's real client.
    router.get("/_qe/rename/:id", async (c) =>
      c.json(await rename(db(c), c.req.param("id"), c.req.query("name") ?? "ok.txt")),
    );
    return router;
  }

  async function get(path: string) {
    const { response, ctx } = await call(createApp(realCore, { extraRouters: [thrower()] }), path);
    const text = await response.text();
    await ctx.settle();
    return { status: response.status, text, body: JSON.parse(text) as Envelope };
  }

  it("uses the shared status table for every code, with the default message", async () => {
    const codes = Object.keys(ERROR_STATUS) as ErrorCode[];
    expect(codes).toHaveLength(19);
    for (const code of codes) {
      const answer = await get(`/api/_qe/code/${code}`);
      expect(answer.status, code).toBe(ERROR_STATUS[code]);
      expect(answer.body.error, code).toBe(code);
      // A helper that gave no message has its code as the message; the caller gets real text.
      expect(answer.body.message, code).not.toBe(code);
      expect(answer.body.message.length, code).toBeGreaterThan(5);
      expect(answer.body.requestId, code).toMatch(/^[0-9a-f-]{36}$/);
    }
  });

  it("keeps the helper's own message and details", async () => {
    const answer = await get("/api/_qe/detailed");
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({
      error: "conflict",
      message: "a file or folder with that name already exists here",
      details: { field: "name" },
    });
  });

  it("maps what the real helpers throw: an unknown node is 404, a bad name is 400", async () => {
    const unknown = await get("/api/_qe/rename/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("not_found");
    const malformed = await get("/api/_qe/rename/not-a-uuid");
    expect(malformed.status).toBe(404);
    const badName = await get(
      `/api/_qe/rename/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e?name=${encodeURIComponent("a/b")}`,
    );
    expect(badName.status).toBe(400);
    expect(badName.body).toMatchObject({ error: "validation", message: "invalid name" });
  });

  it("never invents a status for a code outside the table", async () => {
    const answer = await get("/api/_qe/unknown-code");
    expect(answer.status).toBe(500);
    expect(answer.body.error).toBe("internal");
  });

  it("never discloses a legal hold: LegalHoldError is a 500 with no cause in the body", async () => {
    const answer = await get("/api/_qe/hold");
    expect(answer.status).toBe(500);
    expect(Object.keys(answer.body).sort()).toEqual(["error", "message", "requestId"]);
    expect(answer.body.error).toBe("internal");
    expect(answer.text).not.toMatch(/held|hold|csam|notice|0199c6f0/i);
  });

  it("is plain text on the files host", async () => {
    const files = createFilesHost(realCore);
    files.get("/_qe/missing", () => {
      throw new QueryError("not_found");
    });
    files.get("/_qe/hold", () => {
      throw new LegalHoldError({ "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e": ["under_review"] });
    });
    const missing = await call(files, "/_qe/missing", { origin: TEST_FILES_ORIGIN });
    expect(missing.response.status).toBe(404);
    expect(missing.response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await missing.response.text()).toBe("Not found.\n");
    await missing.ctx.settle();
    const hold = await call(files, "/_qe/hold", { origin: TEST_FILES_ORIGIN });
    expect(hold.response.status).toBe(500);
    expect(await hold.response.text()).toBe("Something went wrong.\n");
    await hold.ctx.settle();
  });
});

describe("the session types and the generated auth schema", () => {
  it("type level: a row of `user` is a SessionUser and a row of `session` is a SessionInfo", () => {
    // Checked by `npm run typecheck`: a regenerated auth schema that renames or retypes a field
    // the worker core reads stops compiling here.
    const asUser = (row: typeof user.$inferSelect): SessionUser => row;
    const asSession = (row: typeof session.$inferSelect): SessionInfo => row;
    expect(typeof asUser).toBe("function");
    expect(typeof asSession).toBe("function");
  });
});
