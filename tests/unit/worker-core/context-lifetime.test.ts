// When the database pool is opened and — the part that matters — when it is closed.
// The fake pool behaves like pg's: `close()` twice throws, and a query after `close()` rejects
// with "Cannot use a pool after calling end on the pool".
import {
  createExecutionContext,
  createMessageBatch,
  createScheduledController,
  getQueueResult,
} from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import worker from "../../../src/worker/index";
import {
  CONTEXT_CLOSED,
  db,
  defer,
  deps,
  runBackground,
  type AppEnv,
  type BackgroundContext,
  type ServiceDeps,
} from "../../../src/worker/services/request-context";
import { appWith, call, fakeCore, fakeCtx, POOL_ENDED, sleep, testEnv, type FakeCore } from "./helpers";

type Queryable = { execute(): Promise<{ rows: unknown[] }> };
const query = (client: unknown) => (client as Queryable).execute();

function probeApp(fake: FakeCore, handlers: (router: Hono<AppEnv>) => void) {
  const router = new Hono<AppEnv>();
  handlers(router);
  return appWith(fake, { extraRouters: [router] });
}

describe("request context: fetch", () => {
  it("opens nothing for an asset, /__meta, or a route that never asks", async () => {
    const fake = fakeCore();
    const app = probeApp(fake, (r) => r.get("/_probe/idle", (c) => c.json({ ok: true })));
    for (const path of ["/", "/some/deep/link", "/__meta", "/api/public/csp-report", "/api/_probe/idle"]) {
      const { response, ctx } = await call(app, path, {
        method: path.endsWith("csp-report") ? "POST" : "GET",
      });
      await response.text();
      await ctx.settle();
    }
    // /api/_probe/idle is the one path here that reads a session; that creates the (lazy) pool
    // object for the auth instance, runs no query on it, and closes it again.
    expect(fake.calls).toEqual(["createDb", "createAuth", "getSession", "close"]);
  });

  it("does not create a pool at all when db(c) was never asked for", async () => {
    const fake = fakeCore();
    const { response, ctx } = await call(appWith(fake), "/__meta");
    await response.text();
    await ctx.settle();
    expect(fake.calls).toEqual([]);
  });

  it("closes exactly once, and only after the handler has returned", async () => {
    const fake = fakeCore();
    const app = probeApp(fake, (r) =>
      r.get("/_probe/query", async (c) => {
        await query(db(c));
        await sleep(5);
        await query(db(c));
        fake.calls.push("handler:end");
        return c.json({ ok: true });
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/query");
    expect(response.status).toBe(200);
    await response.text();
    await ctx.settle();
    const tail = fake.calls.slice(fake.calls.indexOf("handler:end"));
    expect(tail).toEqual(["handler:end", "close"]);
    expect(fake.calls.filter((entry) => entry === "close")).toHaveLength(1);
    expect(fake.calls.filter((entry) => entry === "createDb")).toHaveLength(1);
  });

  it("does not close before a deferred promise settles", async () => {
    const fake = fakeCore();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const app = probeApp(fake, (r) =>
      r.get("/_probe/defer", async (c) => {
        await query(db(c));
        defer(
          c,
          gate.then(async () => {
            await query(db(c));
            fake.calls.push("deferred:done");
          }),
        );
        return c.json({ ok: true });
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/defer");
    await response.text();
    await sleep(20);
    // The response is out, the deferred work is still waiting: the pool must still be open.
    expect(fake.calls).not.toContain("close");
    release();
    await ctx.settle();
    expect(fake.calls.slice(-2)).toEqual(["deferred:done", "close"]);
    expect(fake.calls.filter((entry) => entry === "close")).toHaveLength(1);
  });

  it("closes after a handler that throws", async () => {
    const fake = fakeCore();
    const app = probeApp(fake, (r) =>
      r.get("/_probe/throw", async (c) => {
        await query(db(c));
        throw new Error("boom");
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/throw");
    expect(response.status).toBe(500);
    await response.text();
    await ctx.settle();
    expect(fake.calls.filter((entry) => entry === "close")).toHaveLength(1);
  });

  it("drains work deferred by deferred work before closing", async () => {
    const fake = fakeCore();
    const results: unknown[] = [];
    const app = probeApp(fake, (r) =>
      r.get("/_probe/nested", (c) => {
        defer(
          c,
          (async () => {
            await sleep(5);
            fake.calls.push("A");
            defer(
              c,
              (async () => {
                // Awaits first: by now a single allSettled over [A] would already have closed the pool.
                await sleep(10);
                results.push(await query(db(c)));
                fake.calls.push("B");
              })(),
            );
          })(),
        );
        return c.json({ ok: true });
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/nested");
    await response.text();
    await ctx.settle();
    // B's query returned a row — asserted on the result, because allSettled swallows a rejection.
    expect(results).toEqual([{ rows: [{ "?column?": 1 }] }]);
    expect(fake.calls.slice(-3)).toEqual(["query", "B", "close"]);
    expect(fake.calls.indexOf("A")).toBeLessThan(fake.calls.indexOf("B"));
  });

  it("drains three levels deep", async () => {
    const fake = fakeCore();
    const results: unknown[] = [];
    const app = probeApp(fake, (r) =>
      r.get("/_probe/deep", (c) => {
        const level = (n: number): Promise<void> =>
          (async () => {
            await sleep(5);
            if (n < 3) defer(c, level(n + 1));
            else results.push(await query(db(c)));
            fake.calls.push(`level:${n}`);
          })();
        defer(c, level(1));
        return c.json({ ok: true });
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/deep");
    await response.text();
    await ctx.settle();
    expect(results).toHaveLength(1);
    expect(fake.calls.slice(-2)).toEqual(["level:3", "close"]);
  });

  it("refuses defer() and db() once the context has closed", async () => {
    const fake = fakeCore();
    let late: (() => void) | undefined;
    let lateDb: (() => unknown) | undefined;
    const app = probeApp(fake, (r) =>
      r.get("/_probe/late", async (c) => {
        await query(db(c));
        late = () => defer(c, Promise.resolve());
        lateDb = () => db(c);
        return c.json({ ok: true });
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/late");
    await response.text();
    await ctx.settle();
    expect(fake.calls).toContain("close");
    expect(() => late?.()).toThrowError(new Error(CONTEXT_CLOSED));
    expect(() => lateDb?.()).toThrowError(new Error(CONTEXT_CLOSED));
    expect(CONTEXT_CLOSED).toBe("request context closed");
    // Nothing reopened a pool behind the closed one.
    expect(fake.calls.filter((entry) => entry === "createDb")).toHaveLength(1);
  });

  it("deps(c) shares the request's one client and its defer", async () => {
    const fake = fakeCore();
    let same = false;
    const app = probeApp(fake, (r) =>
      r.get("/_probe/deps", async (c) => {
        const service: ServiceDeps = deps(c);
        // Building it opened nothing.
        fake.calls.push(`after-deps:${fake.calls.filter((entry) => entry === "createDb").length}`);
        same = service.db === db(c) && deps(c).db === service.db && service.env === c.env;
        service.defer(
          (async () => {
            await sleep(5);
            await query(service.db);
            fake.calls.push("service:deferred");
          })(),
        );
        return c.json({ ok: true });
      }),
    );
    const { response, ctx } = await call(app, "/api/_probe/deps");
    await response.text();
    await ctx.settle();
    expect(same).toBe(true);
    // The session lookup had already opened the pool; deps() did not open a second one.
    expect(fake.calls.filter((entry) => entry === "createDb")).toHaveLength(1);
    expect(fake.calls.slice(-2)).toEqual(["service:deferred", "close"]);
  });
});

describe("runBackground: queue and scheduled", () => {
  // The same shapes index.ts calls: consumer.queue(batch, env, ctx, bg) and scheduled(event, env, ctx, bg).
  const nested = (fake: FakeCore, results: unknown[]) => async (bg: BackgroundContext) => {
    await query(bg.db);
    bg.defer(
      (async () => {
        await sleep(5);
        fake.calls.push("A");
        bg.defer(
          (async () => {
            await sleep(10);
            results.push(await query(bg.db));
            fake.calls.push("B");
          })(),
        );
      })(),
    );
    fake.calls.push("fn:end");
  };

  it("as queue(): a deferred task that defers a task which queries succeeds; close is last", async () => {
    const fake = fakeCore();
    const results: unknown[] = [];
    const batch = createMessageBatch("holdfast-scan-dev", [
      { id: "m1", timestamp: new Date(), body: { n: 1 }, attempts: 1 },
    ]);
    const ctx = fakeCtx();
    const env = testEnv();
    const consumer = async (
      b: MessageBatch<unknown>,
      _env: Env,
      _ctx: ExecutionContext,
      bg: BackgroundContext,
    ) => {
      await nested(fake, results)(bg);
      b.ackAll();
    };
    await runBackground(env, ctx, (bg) => consumer(batch, env, ctx, bg), fake.core);
    expect(results).toEqual([{ rows: [{ "?column?": 1 }] }]);
    expect(fake.calls).toEqual(["createDb", "query", "fn:end", "A", "query", "B", "close"]);
  });

  it("as scheduled(): the same, and the pool is one for the whole run", async () => {
    const fake = fakeCore();
    const results: unknown[] = [];
    const event = createScheduledController({ cron: "3 * * * *", scheduledTime: new Date() });
    const ctx = fakeCtx();
    const env = testEnv();
    const job = async (
      _event: ScheduledController,
      _env: Env,
      _ctx: ExecutionContext,
      bg: BackgroundContext,
    ) => nested(fake, results)(bg);
    await runBackground(env, ctx, (bg) => job(event, env, ctx, bg), fake.core);
    expect(results).toHaveLength(1);
    expect(fake.calls).toEqual(["createDb", "query", "fn:end", "A", "query", "B", "close"]);
  });

  it("drains three levels deep", async () => {
    const fake = fakeCore();
    const results: unknown[] = [];
    await runBackground(
      testEnv(),
      fakeCtx(),
      async (bg) => {
        const level = (n: number): Promise<void> =>
          (async () => {
            await sleep(5);
            if (n < 3) bg.defer(level(n + 1));
            else results.push(await query(bg.db));
          })();
        bg.defer(level(1));
      },
      fake.core,
    );
    expect(results).toHaveLength(1);
    expect(fake.calls.at(-1)).toBe("close");
  });

  it("closes after fn throws, and rethrows", async () => {
    const fake = fakeCore();
    await expect(
      runBackground(
        testEnv(),
        fakeCtx(),
        async (bg) => {
          await query(bg.db);
          throw new Error("job failed");
        },
        fake.core,
      ),
    ).rejects.toThrow("job failed");
    expect(fake.calls).toEqual(["createDb", "query", "close"]);
  });

  it("opens no pool when the job never asks for one, and refuses defer() after it has closed", async () => {
    const fake = fakeCore();
    let kept: BackgroundContext | undefined;
    await runBackground(
      testEnv(),
      fakeCtx(),
      async (bg) => {
        kept = bg;
      },
      fake.core,
    );
    expect(fake.calls).toEqual([]);
    expect(() => kept?.defer(Promise.resolve())).toThrowError(new Error(CONTEXT_CLOSED));
    expect(() => kept?.db).toThrowError(new Error(CONTEXT_CLOSED));
  });

  it("the fake pool really rejects a query after close (the failure the drain loop prevents)", async () => {
    const fake = fakeCore();
    const handle = fake.core.createDb(testEnv());
    await handle.close();
    await expect(query(handle.db)).rejects.toThrow(POOL_ENDED);
    await expect(handle.close()).rejects.toThrow("Called end on pool more than once");
  });

  it("type level: deps(c) and a BackgroundContext are both a ServiceDeps", () => {
    const takesService = (service: ServiceDeps) => service;
    const fromBackground = (bg: BackgroundContext) => takesService(bg);
    const fromRequest = (c: Parameters<typeof deps>[0]) => takesService(deps(c));
    expect(typeof fromBackground).toBe("function");
    expect(typeof fromRequest).toBe("function");
  });
});

describe("the Worker's own queue and scheduled exports", () => {
  // The real entry with the real modules. Neither placeholder asks for the database, so no pool
  // is opened; the real-pool lifetime of runBackground is proven in integration.test.ts.
  it("scheduled() runs the stub through runBackground without error", async () => {
    const controller = createScheduledController({ cron: "3 * * * *", scheduledTime: new Date() });
    const ctx = createExecutionContext();
    await expect(worker.scheduled?.(controller, testEnv(), ctx)).resolves.toBeUndefined();
  });

  it("queue() acknowledges the batch through the placeholder consumer", async () => {
    const batch = createMessageBatch("holdfast-scan-dev", [
      { id: "m1", timestamp: new Date(), body: { n: 1 }, attempts: 1 },
    ]);
    const ctx = createExecutionContext();
    await worker.queue?.(batch, testEnv(), ctx);
    const result = await getQueueResult(batch, ctx);
    expect(result.ackAll).toBe(true);
  });
});
