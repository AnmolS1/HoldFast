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
  CLOSE_DEADLINE_MS,
  DEFER_LIMIT,
  DRAIN_DEADLINE_MS,
  MAX_DEFER_ROUNDS,
  MAX_DEFERRED_TASKS,
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

  // ── the drain is bounded ──────────────────────────────────────────────────────────────────
  // The real pool, real Postgres; only the deadline is shortened (20 s cannot be waited for).
  const quick = (limits: CoreDeps["limits"]): CoreDeps => ({ ...realCore, limits });
  const metricsSink = () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const METRICS = {
      writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => void points.push(point),
    };
    return { points, METRICS };
  };
  /** The drain-then-close promise: the last thing the middleware hands to waitUntil. */
  const drainOf = (ctx: { pending: Promise<unknown>[] }) => ctx.pending.at(-1)!;
  const healthy = async () => {
    const { response, ctx } = await call(createApp(realCore), "/api/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, db: true, r2: true });
    await ctx.settle();
  };

  /** Is that backend still connected to the server? Asked over a separate connection. */
  const backendAlive = (pid: number) =>
    withDb(workerEnv, async (handle) => {
      const found = await handle.execute(sql`select 1 from pg_stat_activity where pid = ${pid}`);
      return found.rows.length > 0;
    });
  /** Waits (bounded) for the server to drop the backend. */
  const backendGone = async (pid: number) => {
    for (let waited = 0; waited < 3_000; waited += 50) {
      if (!(await backendAlive(pid))) return true;
      await sleep(50);
    }
    return false;
  };
  const pidOf = async (handle: { execute: Db["execute"] }) =>
    Number(((await handle.execute(sql`select pg_backend_pid() as pid`)).rows[0] as { pid: number }).pid);

  type Stuck = { pid?: number; release(): void; task(handle: Db): Promise<unknown> };
  /** A task that checks a connection out inside a transaction and never commits. */
  const openTransaction = (): Stuck => {
    let release!: () => void;
    const never = new Promise<void>((resolve) => (release = resolve));
    const stuck: Stuck = {
      release,
      task: (handle) =>
        handle.transaction(async (tx) => {
          stuck.pid = await pidOf(tx);
          await never;
        }),
    };
    return stuck;
  };
  /** A task with a query in flight for a minute. */
  const longQuery = (): Stuck => {
    const stuck: Stuck = {
      release: () => {},
      task: (handle) =>
        handle.transaction(async (tx) => {
          stuck.pid = await pidOf(tx);
          await tx.execute(sql`select pg_sleep(60)`);
        }),
    };
    return stuck;
  };
  /** The same minute-long query through the pool's own `query` (no transaction, no explicit client). */
  const longPoolQuery = (): Stuck => ({
    release: () => {},
    task: (handle) => handle.execute(sql`select pg_sleep(60), 'hf-drain-test' as marker`),
  });
  const poolQueryRunning = () =>
    withDb(workerEnv, async (handle) => {
      const found = await handle.execute(
        sql`select pid from pg_stat_activity where state = 'active' and query like '%pg_sleep(60), ''hf-drain-test''%' and pid <> pg_backend_pid()`,
      );
      return found.rows.map((row) => Number((row as { pid: number }).pid));
    });

  for (const [label, make] of [
    ["holds a connection in a transaction it never commits", openTransaction],
    ["has a minute-long query in flight inside a transaction", longQuery],
  ] as const) {
    it(`fetch: a deferred task that ${label} is abandoned at the deadline; the pool closes and the server-side connection is gone`, async () => {
      const seen: { db?: Db } = {};
      const stuck = make();
      const sink = metricsSink();
      const router = new Hono<AppEnv>();
      router.get("/_it/hung", (c) => {
        seen.db = db(c);
        defer(c, stuck.task(db(c)));
        defer(c, sleep(5));
        return c.json({ ok: true });
      });
      const started = Date.now();
      const { response, ctx } = await call(
        createApp(quick({ drainDeadlineMs: 300, closeDeadlineMs: 1_000 }), { extraRouters: [router] }),
        "/api/_it/hung",
        { env: { METRICS: sink.METRICS } },
      );
      expect(response.status).toBe(200);
      await response.text();
      // Before the deadline the task really is sitting on a live server connection.
      await sleep(100);
      expect(stuck.pid).toEqual(expect.any(Number));
      expect(await backendAlive(stuck.pid!)).toBe(true);

      await drainOf(ctx);
      const took = Date.now() - started;
      expect(took).toBeGreaterThanOrEqual(290);
      // Deadline + one close attempt at most; not the minute the query would take.
      expect(took).toBeLessThan(300 + 1_000 + 1_500);
      await expectPoolEnded(seen.db);
      expect(await backendGone(stuck.pid!), "the server no longer has the connection").toBe(true);
      // Counted and logged: how many, never what. The forced close worked first time.
      const abandoned = sink.points.filter((point) => point.blobs[2] === "deferred_abandoned");
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]!.doubles[0]).toBe(1);
      expect(JSON.stringify(abandoned)).not.toContain("_it/hung");
      expect(sink.points.filter((point) => point.blobs[2] === "pool_close")).toEqual([]);
      // The next invocation has its own pool and is unaffected.
      await healthy();
      stuck.release();
      await sleep(20);
    });
  }

  it("fetch: a minute-long query through pool.query is abandoned too, with no stray error", async () => {
    const seen: { db?: Db } = {};
    const stuck = longPoolQuery();
    const router = new Hono<AppEnv>();
    router.get("/_it/hung-query", (c) => {
      seen.db = db(c);
      defer(c, stuck.task(db(c)));
      return c.json({ ok: true });
    });
    const { response, ctx } = await call(
      createApp(quick({ drainDeadlineMs: 300, closeDeadlineMs: 1_000 }), { extraRouters: [router] }),
      "/api/_it/hung-query",
    );
    await response.text();
    await sleep(100);
    const before = await poolQueryRunning();
    expect(before.length).toBeGreaterThanOrEqual(1);
    await drainOf(ctx);
    await expectPoolEnded(seen.db);
    for (const pid of before) expect(await backendGone(pid)).toBe(true);
    // pg-pool's own query wrapper releases the client again when the query errors: that second
    // release must not throw (it would be an uncaught exception, failing this whole file).
    await sleep(50);
    await healthy();
  });

  it("fetch: deferred work that finishes before the deadline is waited for and the close is a plain one", async () => {
    const seen: { db?: Db } = {};
    const rows: unknown[] = [];
    const sink = metricsSink();
    const router = new Hono<AppEnv>();
    router.get("/_it/slow-but-fine", (c) => {
      seen.db = db(c);
      defer(
        c,
        db(c)
          .execute(sql`select pg_sleep(0.4), 42 as answer`)
          .then((result) => rows.push((result.rows[0] as { answer: number }).answer)),
      );
      return c.json({ ok: true });
    });
    const started = Date.now();
    const { response, ctx } = await call(
      createApp(quick({ drainDeadlineMs: 3_000, closeDeadlineMs: 1_000 }), { extraRouters: [router] }),
      "/api/_it/slow-but-fine",
      { env: { METRICS: sink.METRICS } },
    );
    await response.text();
    await ctx.settle();
    expect(rows).toEqual([42]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(390);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(sink.points.filter((p) => ["deferred_abandoned", "pool_close"].includes(p.blobs[2]!))).toEqual([]);
    await expectPoolEnded(seen.db);
  });

  it("fetch: a connection leaked by the handler itself (nothing deferred) cannot hang the close either", async () => {
    const seen: { db?: Db } = {};
    const stuck = openTransaction();
    const sink = metricsSink();
    const router = new Hono<AppEnv>();
    router.get("/_it/leak", async (c) => {
      seen.db = db(c);
      // Not deferred: the drain knows nothing about it, so the close starts as a plain one.
      void stuck.task(db(c)).catch(() => {});
      await sleep(50);
      return c.json({ ok: true });
    });
    const started = Date.now();
    const { response, ctx } = await call(
      createApp(quick({ closeDeadlineMs: 300 }), { extraRouters: [router] }),
      "/api/_it/leak",
      { env: { METRICS: sink.METRICS } },
    );
    await response.text();
    await drainOf(ctx);
    expect(Date.now() - started).toBeLessThan(300 + 300 + 1_500);
    expect(sink.points.filter((point) => point.blobs[2] === "pool_close").map((p) => p.blobs[3])).toEqual([
      "forced",
    ]);
    await expectPoolEnded(seen.db);
    expect(await backendGone(stuck.pid!)).toBe(true);
    stuck.release();
    await sleep(20);
  });

  it("fetch: a task that re-defers itself forever stops at the round limit, and the pool is closed", async () => {
    const seen: { db?: Db } = {};
    let runs = 0;
    let refusal: unknown;
    const sink = metricsSink();
    const router = new Hono<AppEnv>();
    router.get("/_it/forever", (c) => {
      seen.db = db(c);
      const again = async (): Promise<void> => {
        runs += 1;
        await db(c).execute(sql`select 1`);
        try {
          defer(c, again());
        } catch (error) {
          // The first refusal: the already-started next run is refused again, later, as "closed".
          refusal ??= error;
        }
      };
      // The handler's own defer is not a re-deferral; `again` starts on the first drain pass.
      defer(c, sleep(1).then(again));
      return c.json({ ok: true });
    });
    const { response, ctx } = await call(
      createApp(quick({ maxDeferRounds: 4 }), { extraRouters: [router] }),
      "/api/_it/forever",
      { env: { METRICS: sink.METRICS } },
    );
    await response.text();
    await ctx.settle();
    expect(refusal).toBeInstanceOf(Error);
    expect((refusal as Error).message).toBe(DEFER_LIMIT);
    // Passes 1–4 ran one task each; the fifth run is the one whose defer was refused (it had
    // already started a sixth, which nothing waits for and which finds the pool closed).
    expect(runs).toBeGreaterThanOrEqual(5);
    expect(runs).toBeLessThanOrEqual(6);
    expect(sink.points.filter((point) => point.blobs[2] === "defer_refused").map((p) => p.blobs[3])).toEqual([
      "rounds",
    ]);
    await expectPoolEnded(seen.db);
    await healthy();
  });

  it("fetch: defer() refuses the task past the per-invocation cap; the first ones still run", async () => {
    let ran = 0;
    let refused = 0;
    const router = new Hono<AppEnv>();
    router.get("/_it/many", (c) => {
      for (let n = 0; n < 12; n++) {
        try {
          defer(
            c,
            (async () => {
              await db(c).execute(sql`select 1`);
              ran += 1;
            })(),
          );
        } catch (error) {
          expect((error as Error).message).toBe(DEFER_LIMIT);
          refused += 1;
        }
      }
      return c.json({ ok: true });
    });
    const { response, ctx } = await call(
      createApp(quick({ maxDeferredTasks: 10 }), { extraRouters: [router] }),
      "/api/_it/many",
    );
    await response.text();
    await ctx.settle();
    expect(refused).toBe(2);
    expect(ran).toBe(12); // the two refused tasks had already started; they are just not waited for
  });

  it("the defaults are under the platform's 30 s waitUntil window", () => {
    expect(DRAIN_DEADLINE_MS).toBe(20_000);
    expect(DRAIN_DEADLINE_MS).toBeLessThanOrEqual(30_000 - 10_000);
    expect(CLOSE_DEADLINE_MS).toBe(3_000);
    // The drain, a plain close and a forced close, all inside the platform's window.
    expect(DRAIN_DEADLINE_MS + 2 * CLOSE_DEADLINE_MS).toBeLessThan(30_000);
    expect(MAX_DEFERRED_TASKS).toBe(100);
    expect(MAX_DEFER_ROUNDS).toBe(8);
  });

  // queue() and scheduled() both run through runBackground (src/worker/index.ts).
  for (const [label, make] of [
    ["holds a connection in a transaction it never commits", openTransaction],
    ["has a minute-long query in flight", longQuery],
  ] as const) {
    it(`runBackground (queue and cron): a deferred task that ${label} is abandoned at the deadline; the next run works`, async () => {
      const seen: { db?: Db } = {};
      const stuck = make();
      const sink = metricsSink();
      const started = Date.now();
      await runBackground(
        testEnv({ METRICS: sink.METRICS }),
        fakeCtx(),
        async (bg) => {
          seen.db = bg.db;
          bg.defer(stuck.task(bg.db));
          await sleep(100);
          expect(await backendAlive(stuck.pid!)).toBe(true);
        },
        quick({ drainDeadlineMs: 300, closeDeadlineMs: 1_000 }),
      );
      expect(Date.now() - started).toBeLessThan(100 + 300 + 1_000 + 1_500);
      await expectPoolEnded(seen.db);
      expect(await backendGone(stuck.pid!)).toBe(true);
      expect(sink.points.filter((point) => point.blobs[2] === "deferred_abandoned")).toHaveLength(1);
      const again = await runBackground(
        testEnv(),
        fakeCtx(),
        async (bg) => bg.db.execute(sql`select 7 as n`),
        realCore,
      );
      expect(again.rows).toEqual([{ n: 7 }]);
      stuck.release();
      await sleep(20);
    });
  }

  it("runBackground: a failing job whose pool will not close still rethrows the job's own error", async () => {
    const stuck = openTransaction();
    await expect(
      runBackground(
        testEnv(),
        fakeCtx(),
        async (bg) => {
          void stuck.task(bg.db).catch(() => {});
          await sleep(50);
          throw new Error("job failed");
        },
        quick({ closeDeadlineMs: 300 }),
      ),
    ).rejects.toThrow("job failed");
    expect(await backendGone(stuck.pid!)).toBe(true);
    stuck.release();
    await sleep(20);
  });

  it("runBackground: a task that re-defers forever stops at the round limit", async () => {
    let runs = 0;
    let refusal: unknown;
    await runBackground(
      testEnv(),
      fakeCtx(),
      async (bg) => {
        const again = async (): Promise<void> => {
          runs += 1;
          await bg.db.execute(sql`select 1`);
          try {
            bg.defer(again());
          } catch (error) {
            // The first refusal: the already-started next run is refused again, later, as "closed".
            refusal ??= error;
          }
        };
        bg.defer(sleep(1).then(again));
      },
      quick({ maxDeferRounds: 3 }),
    );
    expect((refusal as Error).message).toBe(DEFER_LIMIT);
    expect(runs).toBeGreaterThanOrEqual(4);
    expect(runs).toBeLessThanOrEqual(5);
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
