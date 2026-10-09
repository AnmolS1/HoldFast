// The middleware pipeline of the app host, driven through the real app with a fake CoreDeps and
// a catch-all probe router mounted after the (placeholder) registry. `reached` in a probe answer
// means the request passed every middleware.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildPipeline } from "../../../src/worker/app";
import { requireSwitch } from "../../../src/worker/middleware/kill-switch";
import {
  forbidImpersonation,
  IMPERSONATION_EXEMPT_PATHS,
} from "../../../src/worker/middleware/impersonation";
import { requireAdmin, requireUser, requireVerified } from "../../../src/worker/middleware/guards";
import { PublicConfig } from "../../../src/shared/public-config";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { BA_ID_PARAM, TOKEN_PARAM, UUID_PARAM } from "../../../src/shared/ids";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import {
  ALLOW_ALL,
  appWith,
  call,
  fakeCore,
  fakeCtx,
  sameOrigin,
  signIn,
  testEnv,
  type CallOptions,
  type FakeCore,
} from "./helpers";
import { parsePath } from "./registry-check";

// Probes under /api/auth/ use paths the auth router does not declare (it answers only
// GET /auth/get-session until the auth task replaces it), so they fall through to the probe.
type Probe = { reached: string; user: string | null; impersonating: boolean; termsStale: boolean };
type Envelope = { error: string; message: string; requestId: string; details?: Record<string, unknown> };

function probeRouter() {
  const router = new Hono<AppEnv>();
  router.get("/_guard/user", (c) => c.json({ id: requireUser(c).id }));
  router.get("/_guard/verified", (c) => c.json({ id: requireVerified(c).id }));
  router.get("/_guard/admin", (c) => c.json({ id: requireAdmin(c).id }));
  router.get("/_guard/mint", (c) => {
    forbidImpersonation(c);
    return c.json({ minted: true });
  });
  router.post("/_switch/uploads", requireSwitch("uploadsEnabled"), (c) => c.json({ ok: true }));
  router.post("/_switch/links", requireSwitch("linksEnabled"), (c) => c.json({ ok: true }));
  router.all("/*", (c) =>
    c.json({
      reached: c.req.path,
      user: c.get("user")?.id ?? null,
      impersonating: c.get("impersonating"),
      termsStale: c.get("termsStale"),
    } satisfies Probe),
  );
  return router;
}

function setup() {
  const fake = fakeCore();
  fake.state.settings = { termsVersion: "2026-10-01" };
  const app = appWith(fake, { extraRouters: [probeRouter()] });
  const send = async (path: string, options: CallOptions = {}) => {
    const { response, ctx } = await call(app, path, options);
    const body = (await response.json().catch(() => null)) as unknown;
    await ctx.settle();
    return { status: response.status, body: body as Probe & Envelope, headers: response.headers };
  };
  const post = (path: string, options: CallOptions = {}) =>
    send(path, { method: "POST", ...options, headers: { ...sameOrigin, ...options.headers } });
  return { fake, app, send, post };
}

describe("csrf", () => {
  it("refuses a cross-site POST before anything touches the database", async () => {
    const { fake, send } = setup();
    const answer = await send("/api/nodes/folder", {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ error: "forbidden", details: { reason: "csrf" } });
    expect(fake.calls).toEqual([]);
  });

  it("refuses cross-site by Sec-Fetch-Site, and a request with neither header", async () => {
    const { send } = setup();
    const cases: Array<Record<string, string>> = [
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      {},
    ];
    for (const headers of cases) {
      const answer = await send("/api/nodes/folder", { method: "POST", headers });
      expect(answer.status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("lets the app origin through to the router (placeholder → 404, not 403)", async () => {
    const fake = fakeCore();
    // No probe router here: the real registry, where /nodes is still an empty placeholder.
    const { response, ctx } = await call(appWith(fake), "/api/nodes/folder", {
      method: "POST",
      headers: { origin: TEST_APP_ORIGIN, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
    await ctx.settle();
  });

  it("accepts Sec-Fetch-Site same-origin or none, and Origin alone", async () => {
    const { send } = setup();
    const cases: Array<Record<string, string>> = [
      { "sec-fetch-site": "same-origin" },
      { "sec-fetch-site": "none" },
      { origin: TEST_APP_ORIGIN },
    ];
    for (const headers of cases) {
      const answer = await send("/api/nodes/folder", { method: "POST", headers });
      expect(answer.body.reached, JSON.stringify(headers)).toBe("/api/nodes/folder");
    }
  });

  it("exempts /api/public/* and /api/auth/* but not /api/auth-intent", async () => {
    const { send } = setup();
    const evil = { origin: "https://evil.example" };
    expect((await send("/api/public/report", { method: "POST", headers: evil })).body.reached).toBe(
      "/api/public/report",
    );
    expect((await send("/api/auth/sign-in/email", { method: "POST", headers: evil })).body.reached).toBe(
      "/api/auth/sign-in/email",
    );
    expect((await send("/api/public/csp-report", { method: "POST", headers: evil })).status).toBe(204);
    expect((await send("/api/auth-intent", { method: "POST", headers: evil })).status).toBe(403);
  });

  it("never applies to GET or HEAD, and does apply to every other method", async () => {
    const { send } = setup();
    const evil = { origin: "https://evil.example" };
    expect((await send("/api/nodes", { headers: evil })).body.reached).toBe("/api/nodes");
    expect((await send("/api/nodes", { method: "HEAD", headers: evil })).status).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      expect((await send("/api/nodes", { method, headers: evil })).status, method).toBe(403);
    }
  });
});

describe("session", () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);

  it("no session → user = null, and requireUser answers 401", async () => {
    const { send } = setup();
    expect((await send("/api/nodes")).body).toMatchObject({
      user: null,
      impersonating: false,
      termsStale: false,
    });
    const refused = await send("/api/_guard/user");
    expect(refused.status).toBe(401);
    expect(refused.body.error).toBe("unauthorized");
  });

  it("a session → the user, on c.var", async () => {
    const { fake, send } = setup();
    signIn(fake);
    expect((await send("/api/nodes")).body.user).toBe("u".repeat(32));
    expect((await send("/api/_guard/user")).status).toBe(200);
  });

  it("does not look for a session on /api/public/*, /api/health or /api/_test/*", async () => {
    const { fake, send } = setup();
    signIn(fake);
    expect((await send("/api/public/anything")).body.user).toBeNull();
    await send("/api/_test/outbox");
    await send("/api/health");
    expect(fake.calls).not.toContain("getSession");
  });

  for (const [label, flags] of [
    ["suspended", { suspendedAt: past }],
    ["banned with no expiry", { banned: true, banExpires: null }],
    ["banned until a future date", { banned: true, banExpires: future }],
    // Through the cookie cache these dates arrive as ISO strings, not Dates.
    [
      "banned until a future date (string)",
      { banned: true, banExpires: future.toISOString() as unknown as Date },
    ],
    ["suspended (string)", { suspendedAt: past.toISOString() as unknown as Date }],
  ] as const) {
    it(`${label} → 403 account_suspended on an app route, signed out on /api/auth/*`, async () => {
      const { fake, send } = setup();
      signIn(fake, flags);
      const app = await send("/api/nodes");
      expect(app.status).toBe(403);
      expect(app.body).toMatchObject({ error: "forbidden", details: { reason: "account_suspended" } });
      for (const path of ["/api/auth/list-sessions", "/api/auth/sign-out"]) {
        const auth = await send(path, {
          method: path.endsWith("sign-out") ? "POST" : "GET",
          headers: sameOrigin,
        });
        expect(auth.status).toBe(200);
        expect(auth.body).toMatchObject({ reached: path, user: null });
      }
    });
  }

  for (const [label, flags] of [
    ["an expired ban", { banned: true, banExpires: past }],
    ["an expired ban (string)", { banned: true, banExpires: past.toISOString() as unknown as Date }],
    ["a deletion scheduled in the future", { deleteScheduledAt: future }],
    [
      "a deletion scheduled in the future (string)",
      { deleteScheduledAt: future.toISOString() as unknown as Date },
    ],
  ] as const) {
    it(`${label} → passes as the user`, async () => {
      const { fake, send } = setup();
      signIn(fake, flags);
      const answer = await send("/api/nodes");
      expect(answer.status).toBe(200);
      expect(answer.body.user).toBe("u".repeat(32));
    });
  }

  for (const [label, value] of [
    ["a Date", past],
    ["a string", past.toISOString() as unknown as Date],
    ["an unreadable value", "not-a-date" as unknown as Date],
  ] as const) {
    it(`a deletion date in the past (${label}) → no user anywhere, 401 on an app route`, async () => {
      const { fake, send } = setup();
      signIn(fake, { deleteScheduledAt: value });
      expect((await send("/api/nodes")).body.user).toBeNull();
      expect((await send("/api/auth/list-sessions")).body.user).toBeNull();
      expect((await send("/api/_guard/user")).status).toBe(401);
    });
  }

  // Better Auth still honours the cookie of an account whose deletion date has passed (nothing
  // revokes its sessions until the purge runs — and a held account is never purged). On our own
  // routes that user is nobody; under /api/auth/* the same must hold for anything that changes
  // the account.
  for (const [label, value] of [
    ["a Date", past],
    ["an unreadable value", "not-a-date" as unknown as Date],
  ] as const) {
    it(`a deletion date in the past (${label}) → writes under /api/auth/* are refused, 401`, async () => {
      const { fake, send, post } = setup();
      signIn(fake, { deleteScheduledAt: value });
      for (const path of [
        "/api/auth/change-email",
        "/api/auth/change-password",
        "/api/auth/update-user",
        "/api/auth/delete-user",
        "/api/auth/passkey/add-passkey",
        "/api/auth/two-factor/disable",
        "/api/auth/revoke-sessions",
        "/api/auth/sign-outx",
        "/api/auth/sign-in",
      ]) {
        for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
          const answer = await post(path, { method });
          expect(answer.status, `${method} ${path}`).toBe(401);
          expect(answer.body.error).toBe("unauthorized");
          expect(answer.body.reached).toBeUndefined();
        }
      }
      // Leaving, and signing in (as anyone), do not act on the dead account: they pass.
      for (const path of ["/api/auth/sign-out", "/api/auth/sign-in/email", "/api/auth/sign-up/email"]) {
        const answer = await post(path);
        expect(answer.body, path).toMatchObject({ reached: path, user: null });
      }
      // Reads pass to the auth layer as before, with no user on the context.
      expect((await send("/api/auth/list-sessions")).body).toMatchObject({ user: null });
      expect((await send("/api/auth/get-session")).status).toBe(200);
    });
  }

  it("a deletion date in the future, or none, changes nothing for writes under /api/auth/*", async () => {
    const { fake, post } = setup();
    signIn(fake, { deleteScheduledAt: future });
    expect((await post("/api/auth/change-email")).body).toMatchObject({ reached: "/api/auth/change-email" });
    signIn(fake);
    expect((await post("/api/auth/change-email")).body).toMatchObject({ reached: "/api/auth/change-email" });
    fake.state.session = null;
    expect((await post("/api/auth/change-email")).body).toMatchObject({ reached: "/api/auth/change-email" });
  });

  it("the user on c.var has real Dates even when the cache delivered strings", async () => {
    const fake = fakeCore();
    const router = new Hono<AppEnv>();
    router.get("/_probe/dates", (c) => c.json({ isDate: c.get("user")?.deleteScheduledAt instanceof Date }));
    signIn(fake, { deleteScheduledAt: new Date(Date.now() + 1000).toISOString() as unknown as Date });
    const { response, ctx } = await call(appWith(fake, { extraRouters: [router] }), "/api/_probe/dates");
    expect(await response.json()).toEqual({ isDate: true });
    await ctx.settle();
  });

  it("marks an impersonated session and stale terms", async () => {
    const { fake, send } = setup();
    signIn(fake, { termsVersion: "2025-01-01" }, { impersonatedBy: "a".repeat(32) });
    expect((await send("/api/nodes")).body).toMatchObject({ impersonating: true, termsStale: true });
    signIn(fake, { termsVersion: "2026-10-01" });
    expect((await send("/api/nodes")).body).toMatchObject({ impersonating: false, termsStale: false });
  });

  it("moves with the test clock only in test mode", async () => {
    const { fake, send } = setup();
    signIn(fake, { deleteScheduledAt: future });
    const later = { "x-holdfast-test-now": new Date(Date.now() + 2 * 86_400_000).toISOString() };
    expect((await send("/api/nodes", { headers: later })).body.user).toBeNull();
    // A production-configured Worker ignores the header.
    expect(
      (await send("/api/nodes", { headers: later, env: { SENTRY_ENVIRONMENT: "production" } })).body.user,
    ).toBe("u".repeat(32));
  });
});

describe("guards", () => {
  it("requireVerified → 403 for an unverified address", async () => {
    const { fake, send } = setup();
    signIn(fake, { emailVerified: false });
    const refused = await send("/api/_guard/verified");
    expect(refused.status).toBe(403);
    expect(refused.body.details).toEqual({ reason: "email_unverified" });
    signIn(fake);
    expect((await send("/api/_guard/verified")).status).toBe(200);
  });

  it("requireAdmin → admin role AND two-factor, never an impersonated session", async () => {
    const { fake, send } = setup();
    expect((await send("/api/_guard/admin")).status).toBe(401);
    signIn(fake, { role: "user", twoFactorEnabled: true });
    expect((await send("/api/_guard/admin")).body.error).toBe("forbidden");
    signIn(fake, { role: "admin", twoFactorEnabled: false });
    const no2fa = await send("/api/_guard/admin");
    expect(no2fa.status).toBe(403);
    expect(no2fa.body.error).toBe("admin_requires_2fa");
    signIn(fake, { role: "admin", twoFactorEnabled: true });
    expect((await send("/api/_guard/admin")).status).toBe(200);
    signIn(fake, { role: "admin", twoFactorEnabled: true }, { impersonatedBy: "a".repeat(32) });
    expect((await send("/api/_guard/admin")).status).toBe(403);
  });
});

describe("middleware order", () => {
  it("is the documented sequence, with session before rateLimit", () => {
    const names = buildPipeline(fakeCore().core).map((step) => step.name);
    expect(names).toEqual([
      "requestContext",
      "securityHeaders",
      "csrf",
      "session",
      "impersonationReadOnly",
      "termsGate",
      "killSwitch",
      "rateLimit",
    ]);
    expect(names.indexOf("session")).toBeLessThan(names.indexOf("rateLimit"));
    expect(names.indexOf("csrf")).toBeLessThan(names.indexOf("session"));
  });

  it("a rate-limited auth request has still been through getSession", async () => {
    const { fake, post } = setup();
    const denied = { limit: async () => ({ success: false }) };
    const answer = await post("/api/auth/sign-in/email", { env: { RL_AUTH: denied } });
    expect(answer.status).toBe(429);
    expect(fake.calls).toContain("getSession");
  });
});

describe("rate limit", () => {
  const limiter = (seen: string[], success = true) => ({
    limit: async ({ key }: { key: string }) => {
      seen.push(key);
      return { success };
    },
  });

  it("429 rate_limited with Retry-After", async () => {
    const { send } = setup();
    const answer = await send("/api/nodes", { env: { RL_API: limiter([], false) } });
    expect(answer.status).toBe(429);
    expect(answer.body.error).toBe("rate_limited");
    expect(answer.headers.get("retry-after")).toBe("60");
  });

  it("keys RL_API by user when signed in, by IP otherwise; RL_AUTH by IP on the auth paths only", async () => {
    const { fake, send, post } = setup();
    const api: string[] = [];
    const auth: string[] = [];
    const env = { RL_API: limiter(api), RL_AUTH: limiter(auth) };
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    await send("/api/nodes", { env, headers });
    signIn(fake);
    await send("/api/nodes", { env, headers });
    expect(api).toEqual(["ip:203.0.113.9", `u:${"u".repeat(32)}`]);
    expect(auth).toEqual([]);
    await post("/api/auth/sign-in/email", { env, headers });
    await post("/api/auth-intent", { env, headers });
    await send("/api/invites/abc", { env, headers });
    expect(auth).toEqual(["ip:203.0.113.9", "ip:203.0.113.9", "ip:203.0.113.9"]);
  });

  // The shell reads the session in every route guard and on every window focus. Counted against
  // the 20-a-minute sign-in bucket, three people behind one address lock each other out of /login.
  it("RL_AUTH is for state-changing auth requests: a session read spends RL_API only", async () => {
    const { send, post } = setup();
    const api: string[] = [];
    const auth: string[] = [];
    const exhausted = { RL_API: limiter(api), RL_AUTH: limiter(auth, false) };
    const headers = { "cf-connecting-ip": "203.0.113.9" };

    // 30 session reads from one address while its auth bucket is empty: every one answers.
    for (let n = 0; n < 30; n++) {
      const read = await send("/api/auth/get-session", { env: exhausted, headers });
      expect(read.status, `read ${n + 1}`).toBe(200);
      expect(read.body).toBeNull();
    }
    expect((await send("/api/auth/list-sessions", { env: exhausted, headers })).status).toBe(200);
    expect(
      (await send("/api/auth/get-session", { method: "HEAD", env: exhausted, headers })).status,
    ).not.toBe(429);
    expect(auth).toEqual([]);
    expect(api).toHaveLength(32);
    expect(new Set(api)).toEqual(new Set(["ip:203.0.113.9"]));

    // The same address, the same empty bucket: every write under /api/auth/ is refused …
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const write = await post("/api/auth/sign-in/email", { method, env: exhausted, headers });
      expect(write.status, method).toBe(429);
      expect(write.body.error).toBe("rate_limited");
    }
    expect(auth).toHaveLength(4);
    // … and so are the two unauthenticated lookups that are not under /api/auth/, GET included:
    // an invite code is guessable, so reading one is throttled like a sign-in.
    expect((await send("/api/invites/abc", { env: exhausted, headers })).status).toBe(429);
    expect((await post("/api/auth-intent", { env: exhausted, headers })).status).toBe(429);
  });

  // A home IPv6 connection is a /64: 2^64 source addresses. Keyed by the raw address, each one is
  // a fresh bucket and no limit ever applies.
  it("keys by the normalised address: IPv4 whole, IPv6 by its /64", async () => {
    const { post } = setup();
    const api: string[] = [];
    const auth: string[] = [];
    const env = { RL_API: limiter(api), RL_AUTH: limiter(auth) };
    const from = (ip: string) => ({ env, headers: { "cf-connecting-ip": ip } });

    await post("/api/auth/sign-in/email", from("203.0.113.9"));
    await post("/api/auth/sign-in/email", from("203.0.113.10"));
    await post("/api/auth/sign-in/email", from("2001:db8:0:1::1"));
    await post("/api/auth/sign-in/email", from("2001:DB8:0:1:ffff:ffff:ffff:ffff"));
    await post("/api/auth/sign-in/email", from("2001:db8:0:2::1"));
    await post("/api/auth/sign-in/email", from("::ffff:203.0.113.9"));
    const expected = [
      "ip:203.0.113.9",
      "ip:203.0.113.10",
      "ip:2001:db8:0:1::/64",
      "ip:2001:db8:0:1::/64",
      "ip:2001:db8:0:2::/64",
      "ip:203.0.113.9",
    ];
    expect(auth).toEqual(expected);
    expect(api).toEqual(expected);
  });

  it("takes the client address from cf-connecting-ip only", async () => {
    const { send } = setup();
    const api: string[] = [];
    await send("/api/nodes", {
      env: { RL_API: limiter(api) },
      headers: { "x-forwarded-for": "198.51.100.7" },
    });
    expect(api).toEqual(["ip:127.0.0.1"]);
  });

  it("lets the request through when a limiter throws", async () => {
    const { send } = setup();
    const broken = { limit: async () => Promise.reject(new Error("limiter down")) };
    expect((await send("/api/nodes", { env: { RL_API: broken } })).status).toBe(200);
  });
});

// A request refused before any handler read its body (CSRF, a 404, a 429 …) leaves that body on
// the connection, and the server in front then closes the connection instead of reusing it. Under
// `vite dev` the proxy's connection pool hands the dying socket to the next request, which fails
// with "fetch failed" → 500: one early-refused POST poisons an unrelated request.
describe("a request body nobody read", () => {
  const send = async (init: { method: string; body?: string; length?: string; origin?: string }) => {
    const fake = fakeCore();
    const app = appWith(fake, { extraRouters: [probeRouter()] });
    const request = new Request(`${TEST_APP_ORIGIN}/api/nodes/folder`, {
      method: init.method,
      headers: {
        origin: init.origin ?? "https://evil.example",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.length === undefined ? {} : { "content-length": init.length }),
      },
      body: init.body,
    });
    const ctx = fakeCtx();
    const response = await app.fetch(request, testEnv(ALLOW_ALL), ctx);
    await response.text();
    await ctx.settle();
    return { request, status: response.status };
  };

  it("is read to its end before the refusal is answered, when it is small", async () => {
    const refused = await send({ method: "POST", body: '{"name":"x"}', length: "12" });
    expect(refused.status).toBe(403);
    expect(refused.request.bodyUsed).toBe(true);
  });

  it("is left alone when it is large or of unknown length (an upload is never buffered to refuse it)", async () => {
    const large = await send({ method: "POST", body: "x".repeat(70_000), length: "70000" });
    expect(large.status).toBe(403);
    expect(large.request.bodyUsed).toBe(false);
    const unknown = await send({ method: "POST", body: "{}" });
    expect(unknown.status).toBe(403);
    expect(unknown.request.bodyUsed).toBe(false);
    const lying = await send({ method: "POST", body: "{}", length: "not-a-number" });
    expect(lying.request.bodyUsed).toBe(false);
  });

  it("changes nothing for a request without a body", async () => {
    const read = await send({ method: "GET" });
    expect(read.status).toBe(200);
    expect(read.request.bodyUsed).toBe(false);
  });
});

describe("impersonation is read-only", () => {
  const impersonated = (fake: FakeCore) => signIn(fake, {}, { impersonatedBy: "a".repeat(32) });

  /** A concrete path for a route pattern: every parameter filled with a value its own pattern accepts. */
  const concrete = (pattern: string) =>
    "/" +
    parsePath(pattern)
      .map((segment) => {
        if (segment.kind === "static") return segment.value;
        if (segment.kind === "wild") return "x";
        if (segment.pattern === UUID_PARAM) return "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e";
        if (segment.pattern === BA_ID_PARAM) return "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL";
        if (segment.pattern === TOKEN_PARAM) return "AbCdEfGhIjKlMnOpQrSt";
        return "x";
      })
      .join("/");
  const sessionless = (path: string) =>
    path.startsWith("/api/public/") || path.startsWith("/api/_test/") || path === "/api/health";

  it("refuses every state-changing method on every route of the app that reads a session", async () => {
    const { fake, app, post, send } = setup();
    impersonated(fake);
    const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];
    // Every route the app has — parameterised ones included, with their parameters filled in —
    // under its own method (all four for a GET or method-agnostic entry: the middleware must
    // refuse the path whatever a later router registers on it). At each wave integration this
    // list grows by itself with the real routers.
    const qualifying = app.routes.filter(
      (route) => route.path.startsWith("/api/") && !sessionless(route.path),
    );
    const fromApp = qualifying.map((route) => ({
      path: concrete(route.path),
      methods: MUTATING.includes(route.method) ? [route.method] : MUTATING,
    }));
    expect(fromApp).toHaveLength(qualifying.length);
    expect(fromApp.length).toBeGreaterThanOrEqual(8);
    // Plus one representative path per registry area, since the placeholders declare almost nothing yet.
    const representative = [
      "/api/nodes/folder",
      "/api/nodes/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e/trash",
      "/api/uploads",
      "/api/trash",
      "/api/shares/x",
      "/api/links/x",
      "/api/account/password",
      "/api/reports",
      "/api/admin/users",
      "/api/auth-intent",
      "/api/auth/change-password",
      "/api/auth/delete-user",
      "/api/auth/passkey/add-passkey",
      "/api/auth/admin/ban-user",
    ].map((path) => ({ path, methods: MUTATING }));

    let checked = 0;
    for (const { path, methods } of [...fromApp, ...representative]) {
      if (IMPERSONATION_EXEMPT_PATHS.includes(path) || sessionless(path)) continue;
      for (const method of methods) {
        const answer = await send(path, { method, headers: sameOrigin });
        expect(answer.status, `${method} ${path}`).toBe(403);
        expect(answer.body.details, `${method} ${path}`).toEqual({ reason: "impersonation_read_only" });
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect((await post("/api/nodes/folder")).status).toBe(403);
  });

  it("fills route parameters with values their patterns accept", async () => {
    const router = new Hono<AppEnv>();
    router.post(`/nodes/:id{${UUID_PARAM}}/copy`, (c) => c.json({ reached: "copy" }));
    router.delete(`/account/sessions/:id{${BA_ID_PARAM}}`, (c) => c.json({ reached: "session" }));
    const fake = fakeCore();
    fake.state.settings = { termsVersion: "2026-10-01" };
    const app = appWith(fake, { extraRouters: [router] });
    const routes = app.routes.filter((route) => route.path.includes(":"));
    expect(routes.map((route) => `${route.method} ${concrete(route.path)}`)).toEqual([
      "POST /api/nodes/0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e/copy",
      "DELETE /api/account/sessions/aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0xL",
    ]);
    // Signed in normally they are reached; impersonated they are refused.
    for (const [who, expected] of [
      [() => signIn(fake), 200],
      [() => impersonated(fake), 403],
    ] as const) {
      who();
      for (const route of routes) {
        const { response, ctx } = await call(app, concrete(route.path), {
          method: route.method,
          headers: sameOrigin,
        });
        expect(response.status, `${route.method} ${route.path}`).toBe(expected);
        await response.text();
        await ctx.settle();
      }
    }
  });

  it("stays read-only when the impersonated user is suspended, banned or past its deletion date", async () => {
    const past = new Date(Date.now() - 86_400_000);
    for (const flags of [
      { suspendedAt: past },
      { banned: true, banExpires: null },
      { deleteScheduledAt: past },
    ]) {
      const { fake, post, send } = setup();
      signIn(fake, flags, { impersonatedBy: "a".repeat(32) });
      const label = JSON.stringify(Object.keys(flags));
      // Not put on c.var as a user — and still an impersonated session.
      expect((await send("/api/auth/list-sessions")).body, label).toMatchObject({
        user: null,
        impersonating: true,
      });
      for (const path of [
        "/api/auth/change-password",
        "/api/auth/delete-user",
        "/api/auth/passkey/add-passkey",
      ]) {
        const refused = await post(path);
        expect(refused.status, `${label} ${path}`).toBe(403);
        expect(refused.body.details, `${label} ${path}`).toEqual({ reason: "impersonation_read_only" });
      }
      for (const path of IMPERSONATION_EXEMPT_PATHS)
        expect((await post(path)).body.reached, label).toBe(path);
    }
  });

  it("lets stop-impersonating and sign-out through, and every GET", async () => {
    const { fake, post, send } = setup();
    impersonated(fake);
    expect(IMPERSONATION_EXEMPT_PATHS).toEqual(["/api/auth/admin/stop-impersonating", "/api/auth/sign-out"]);
    for (const path of IMPERSONATION_EXEMPT_PATHS) expect((await post(path)).body.reached).toBe(path);
    expect((await send("/api/nodes")).body.reached).toBe("/api/nodes");
  });

  it("does not affect an ordinary session", async () => {
    const { fake, post } = setup();
    signIn(fake);
    expect((await post("/api/nodes/folder")).body.reached).toBe("/api/nodes/folder");
  });

  it("forbidImpersonation refuses a GET that mints content access", async () => {
    const { fake, send } = setup();
    impersonated(fake);
    const refused = await send("/api/_guard/mint");
    expect(refused.status).toBe(403);
    expect(refused.body.details).toEqual({ reason: "impersonation_read_only" });
    signIn(fake);
    expect((await send("/api/_guard/mint")).status).toBe(200);
  });
});

describe("terms gate", () => {
  it("stale terms → 403 terms_required on a state change; reads pass", async () => {
    const { fake, post, send } = setup();
    signIn(fake, { termsVersion: "2025-01-01" });
    fake.state.termsVersionInDb = "2025-01-01";
    const refused = await post("/api/nodes/folder");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("terms_required");
    expect((await send("/api/nodes")).body).toMatchObject({ reached: "/api/nodes", termsStale: true });
  });

  it("exempts auth, public, accept-terms and the deletion routes", async () => {
    const { fake, post } = setup();
    signIn(fake, { termsVersion: "2025-01-01" });
    fake.state.termsVersionInDb = "2025-01-01";
    for (const path of [
      "/api/auth/sign-out",
      "/api/public/report",
      "/api/account/accept-terms",
      "/api/account/deletion",
      "/api/account/deletion/cancel",
    ]) {
      expect((await post(path)).body.reached, path).toBe(path);
    }
    expect((await post("/api/account/deletion-status")).status).toBe(403);
  });

  it("a current value in the database overrides a stale cached user", async () => {
    const { fake, post } = setup();
    signIn(fake, { termsVersion: "2025-01-01" });
    fake.state.termsVersionInDb = "2026-10-01";
    const answer = await post("/api/nodes/folder");
    expect(answer.status).toBe(200);
    expect(answer.body.termsStale).toBe(false);
    expect(fake.calls).toContain("termsVersionOf");
  });

  it("does not read the database when the terms are current", async () => {
    const { fake, post } = setup();
    signIn(fake);
    await post("/api/nodes/folder");
    expect(fake.calls).not.toContain("termsVersionOf");
  });
});

describe("kill switches", () => {
  it("readOnly → 503 read_only on a state change; reads pass", async () => {
    const { fake, post, send } = setup();
    fake.state.settings = { readOnly: true };
    const refused = await post("/api/nodes/folder");
    expect(refused.status).toBe(503);
    expect(refused.body.error).toBe("read_only");
    expect((await send("/api/nodes")).status).toBe(200);
    expect((await post("/api/auth-intent")).status).toBe(503);
    expect((await post("/api/public/report")).status).toBe(503);
  });

  it("exempts all of /api/auth/*, /api/admin/* and the CSP report", async () => {
    const { fake, post } = setup();
    fake.state.settings = { readOnly: true };
    for (const path of [
      "/api/auth/sign-in/email",
      "/api/auth/two-factor/verify-totp",
      "/api/auth/passkey/verify-authentication",
      "/api/admin/settings",
    ]) {
      expect((await post(path)).body.reached, path).toBe(path);
    }
    expect((await post("/api/public/csp-report")).status).toBe(204);
  });

  it("under readOnly a sign-in POST reaches the real (placeholder) router, not 503", async () => {
    const fake = fakeCore();
    fake.state.settings = { readOnly: true };
    for (const path of ["/api/auth/sign-in/email", "/api/auth/two-factor/verify-totp"]) {
      const { response, ctx } = await call(appWith(fake), path, { method: "POST", headers: sameOrigin });
      const body = (await response.json()) as Envelope;
      await ctx.settle();
      // The auth router is an empty placeholder in this task, so "reached the router" is its 404.
      expect(response.status, path).toBe(404);
      expect(body.error).toBe("not_found");
    }
  });

  it("requireSwitch → 503 feature_disabled with the reason", async () => {
    const { fake, post } = setup();
    expect((await post("/api/_switch/uploads")).status).toBe(200);
    expect((await post("/api/_switch/links")).status).toBe(200);
    fake.state.settings = { uploadsEnabled: false, linksEnabled: false };
    const uploads = await post("/api/_switch/uploads");
    expect(uploads.status).toBe(503);
    expect(uploads.body).toMatchObject({
      error: "feature_disabled",
      details: { reason: "uploads_disabled" },
    });
    expect((await post("/api/_switch/links")).body.details).toEqual({ reason: "links_disabled" });
  });
});

describe("GET /api/public/config", () => {
  it("validates against PublicConfig and comes from the env by default", async () => {
    const { fake, send } = setup();
    fake.state.settings = {};
    const answer = await send("/api/public/config");
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    const config = PublicConfig.parse(answer.body);
    expect(config).toMatchObject({
      signupMode: "invite",
      maxFileBytes: 2_000_000_000,
      partBytes: 67_108_864,
      appOrigin: TEST_APP_ORIGIN,
      filesOrigin: "http://files.localhost",
      uploadsEnabled: true,
      linksEnabled: true,
      readOnly: false,
      sentryDsnWeb: null,
      sentryEnvironment: "test",
      turnstileSiteKey: "1x00000000000000000000AA",
    });
    expect(Object.keys(config).sort()).toEqual(Object.keys(PublicConfig.shape).sort());
    expect(fake.calls).not.toContain("getSession");
  });

  // "Reflects a settings override" is proven against the real settings table in
  // integration.test.ts (a row written through setSetting), not against a fake here.

  it("carries no secret", async () => {
    const { send } = setup();
    const text = JSON.stringify((await send("/api/public/config")).body);
    for (const secret of [
      "test-better-auth-secret",
      "test-files-token-secret",
      "test-resend-api-key",
      '0AA"}',
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("1x0000000000000000000000000000000AA");
  });
});

describe("GET /api/health", () => {
  // The 200 and the dead-database 503 run against real Postgres and Miniflare's R2 in
  // integration.test.ts. What stays here is the half no real binding can produce: R2 failing.
  it("503 when R2 throws, and the body carries no error text", async () => {
    const { send } = setup();
    const r2 = { head: async () => Promise.reject(new Error("r2 secret detail")) };
    const answer = await send("/api/health", { env: { FILES: r2 } });
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ ok: false, db: true, r2: false });
  });
});
