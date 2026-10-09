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
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { appWith, call, fakeCore, sameOrigin, signIn, type CallOptions, type FakeCore } from "./helpers";

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

  it("never applies to GET", async () => {
    const { send } = setup();
    expect((await send("/api/nodes", { headers: { origin: "https://evil.example" } })).body.reached).toBe(
      "/api/nodes",
    );
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
      for (const path of ["/api/auth/get-session", "/api/auth/sign-out"]) {
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
      expect((await send("/api/auth/get-session")).body.user).toBeNull();
      expect((await send("/api/_guard/user")).status).toBe(401);
    });
  }

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
    const { fake, send } = setup();
    const denied = { limit: async () => ({ success: false }) };
    const answer = await send("/api/auth/get-session", { env: { RL_AUTH: denied } });
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
    const { fake, send } = setup();
    const api: string[] = [];
    const auth: string[] = [];
    const env = { RL_API: limiter(api), RL_AUTH: limiter(auth) };
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    await send("/api/nodes", { env, headers });
    signIn(fake);
    await send("/api/nodes", { env, headers });
    expect(api).toEqual(["ip:203.0.113.9", `u:${"u".repeat(32)}`]);
    expect(auth).toEqual([]);
    for (const path of ["/api/auth/get-session", "/api/auth-intent", "/api/invites/abc"])
      await send(path, { env, headers });
    expect(auth).toEqual(["ip:203.0.113.9", "ip:203.0.113.9", "ip:203.0.113.9"]);
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

describe("impersonation is read-only", () => {
  const impersonated = (fake: FakeCore) => signIn(fake, {}, { impersonatedBy: "a".repeat(32) });

  it("refuses every state-changing method on every non-public route of the app", async () => {
    const { fake, app, post, send } = setup();
    impersonated(fake);
    // Every route the app has, plus one representative path per registry area (the placeholders
    // declare almost nothing yet; at each wave integration the first list grows by itself).
    const fromApp = app.routes
      .filter(
        (route) => route.path.startsWith("/api/") && !route.path.includes("*") && !route.path.includes(":"),
      )
      .map((route) => route.path);
    const representative = [
      "/api/nodes/folder",
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
    ];
    const paths = [...new Set([...fromApp, ...representative])].filter(
      (path) => !path.startsWith("/api/public/") && !path.startsWith("/api/_test/") && path !== "/api/health",
    );
    expect(paths.length).toBeGreaterThan(10);
    for (const path of paths) {
      if (IMPERSONATION_EXEMPT_PATHS.includes(path)) continue;
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const answer = await send(path, { method, headers: sameOrigin });
        expect(answer.status, `${method} ${path}`).toBe(403);
        expect(answer.body.details, `${method} ${path}`).toEqual({ reason: "impersonation_read_only" });
      }
    }
    expect((await post("/api/nodes/folder")).status).toBe(403);
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

  it("reflects a settings override", async () => {
    const { fake, send } = setup();
    fake.state.settings = {
      signupMode: "open",
      termsVersion: "2027-01-01",
      uploadsEnabled: false,
      readOnly: true,
    };
    const config = PublicConfig.parse((await send("/api/public/config")).body);
    expect(config).toMatchObject({
      signupMode: "open",
      termsVersion: "2027-01-01",
      uploadsEnabled: false,
      linksEnabled: true,
      readOnly: true,
    });
  });

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
  it("{ ok: true, db: true, r2: true } when select 1 resolves (test doubles for both probes)", async () => {
    const { fake, send } = setup();
    const r2 = { head: async () => null };
    const answer = await send("/api/health", { env: { FILES: r2 } });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ ok: true, db: true, r2: true });
    expect(fake.calls).toEqual(["createDb", "query", "close"]);
  });

  it("503 when the database probe rejects", async () => {
    const { fake, send } = setup();
    fake.state.queryFails = true;
    const answer = await send("/api/health");
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ ok: false, db: false, r2: true });
  });

  it("503 when R2 throws, and the body carries no error text", async () => {
    const { send } = setup();
    const r2 = { head: async () => Promise.reject(new Error("r2 secret detail")) };
    const answer = await send("/api/health", { env: { FILES: r2 } });
    expect(answer.status).toBe(503);
    expect(answer.body).toEqual({ ok: false, db: true, r2: false });
  });
});
