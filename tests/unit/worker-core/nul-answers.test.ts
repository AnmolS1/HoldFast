// A NUL that reaches a statement is the caller's mistake: the statement wrapper (db/client.ts)
// refuses it as QueryError("validation") and Drizzle hands it on wrapped (DrizzleQueryError, the
// original as `cause`). Both error exits — the app's `handleError` and the auth layer's `guard()`
// — must answer it as the 400 it is: no Sentry event, no error metric. (H2 item F, Addendum 8.)
// The edge refusals of search / recent / starred (q, cursors, `%00` in the query string) are in
// tests/unit/search/refused-input.test.ts; the wrapper itself in tests/unit/db/nul-binds.test.ts.
import { env } from "cloudflare:workers";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "../../../src/worker/db/client";
import { QueryError } from "../../../src/worker/db/errors";
import * as sentry from "../../../src/worker/sentry";
import * as metrics from "../../../src/worker/services/metrics";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { newClient, send } from "../auth/helpers";
import { appWith, call, fakeCore, sameOrigin } from "./helpers";

vi.mock("../../../src/worker/sentry", async (original) => {
  const real = await original<typeof import("../../../src/worker/sentry")>();
  return { ...real, captureError: vi.fn() };
});
vi.mock("../../../src/worker/services/metrics", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/metrics")>();
  return { ...real, metric: vi.fn(real.metric), writeMetric: vi.fn(real.writeMetric) };
});

const captureError = vi.mocked(sentry.captureError);
/** The names of every data point written since the test began. */
const metricNames = () => [
  ...vi.mocked(metrics.metric).mock.calls.map((call) => call[0]),
  ...vi.mocked(metrics.writeMetric).mock.calls.map((call) => call[1]),
];

beforeEach(() => {
  vi.mocked(sentry.captureError).mockClear();
  vi.mocked(metrics.metric).mockClear();
  vi.mocked(metrics.writeMetric).mockClear();
});

/** A route that hands what it was given to a statement, as every route that queries does. */
function probeApp() {
  const router = new Hono<AppEnv>();
  const query = async (value: string) => {
    const { db, close } = createDb(env);
    try {
      return (await db.execute<{ v: string }>(sql`SELECT ${value}::text AS v`)).rows[0]!.v;
    } finally {
      await close();
    }
  };
  router.get("/nodes/nul-probe", async (c) => c.json({ v: await query(c.req.query("name") ?? "") }));
  router.post("/nodes/nul-probe", async (c) => {
    const body = (await c.req.json()) as { name: string };
    return c.json({ v: await query(body.name) });
  });
  router.get("/nodes/query-error/:code", (c) => {
    // A helper's QueryError thrown OUTSIDE Drizzle: unwrapped, exactly as before.
    throw new QueryError(c.req.param("code") as "not_found");
  });
  return appWith(fakeCore(), { extraRouters: [router] });
}

describe("through the app's error handler", () => {
  it("a NUL in a query string or a JSON body string → 400 validation, no Sentry event, no error metric", async () => {
    const app = probeApp();
    const answers = [
      await call(app, "/api/nodes/nul-probe?name=a%00b"),
      await call(app, "/api/nodes/nul-probe", {
        method: "POST",
        headers: { ...sameOrigin, "content-type": "application/json" },
        body: JSON.stringify({ name: "report\u0000.pdf" }),
      }),
    ];
    for (const { response, ctx } of answers) {
      await ctx.settle();
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toBe("validation");
    }
    expect(captureError).not.toHaveBeenCalled();
    expect(metricNames()).not.toContain("error");
    // The twin without the NUL is answered by the same route.
    const clean = await call(app, "/api/nodes/nul-probe?name=ab");
    expect(clean.response.status).toBe(200);
    expect(await clean.response.json()).toEqual({ v: "ab" });
  });

  it("a QueryError thrown by a helper outside Drizzle maps exactly as before", async () => {
    const app = probeApp();
    for (const [code, status] of [
      ["not_found", 404],
      ["conflict", 409],
      ["validation", 400],
    ] as const) {
      const { response, ctx } = await call(app, `/api/nodes/query-error/${code}`);
      await ctx.settle();
      expect(response.status, code).toBe(status);
      expect(((await response.json()) as { error: string }).error).toBe(code);
    }
    expect(captureError).not.toHaveBeenCalled();
  });
});

describe("through guard() — POST /api/auth-intent with a NUL in the invite code", () => {
  it("→ 400 validation, no Sentry event, no error metric (the invite lookup is where it met the database)", async () => {
    const client = newClient();
    const answer = await send(client, "/api/auth-intent", {
      json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: "a\u0000b" },
    });
    expect(answer.status).toBe(400);
    expect((answer.body as { error: string }).error).toBe("validation");
    expect(captureError).not.toHaveBeenCalled();
    expect(metricNames()).not.toContain("error");
    // The control: a code without the NUL is an ordinary refusal (unknown invite), also a 400 —
    // the route reached the same lookup.
    const unknown = await send(newClient(), "/api/auth-intent", {
      json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: "ab" },
    });
    expect(unknown.status).toBe(400);
  });
});
