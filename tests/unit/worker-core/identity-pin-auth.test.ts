// The identity pin under /api/auth/* (review M2): every endpoint of the INSTALLED Better Auth is
// either pinned — a request naming another account than the session's is refused before Better
// Auth runs — or named in PIN_EXEMPT_AUTH_ROUTES with its reason. The route table is read from the
// built instance of auth/config.ts, so an upgrade or a new plugin fails here until it is decided.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { auth } from "../../../src/worker/auth/config";
import { IDENTITY_HEADER, PIN_EXEMPT_AUTH_ROUTES } from "../../../src/worker/middleware/identity-pin";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { appWith, call, fakeCore, signIn } from "./helpers";

vi.mock("../../../src/worker/routes/auth", async () => {
  const { Hono } = await import("hono");
  const router = new Hono();
  router.get("/auth/get-session", (c) => c.json(null));
  return { router };
});

type Endpoint = { path?: string; options?: { method?: string | string[] } };

const routes = Object.values(auth.api as unknown as Record<string, Endpoint>)
  .filter((endpoint) => typeof endpoint?.path === "string")
  .map((endpoint) => ({
    path: endpoint.path!,
    methods: ([] as string[]).concat(endpoint.options?.method ?? []).filter((m) => m !== "*"),
  }));

/** A concrete path for a route pattern (`:id` → a value). */
const concrete = (pattern: string) => pattern.replace(/:[^/]+/g, "x1");

const ME = "u".repeat(32);
const OTHER = "o".repeat(32);

function setup() {
  const fake = fakeCore();
  fake.state.settings = { termsVersion: "2026-10-01" };
  const handler = new Hono<AppEnv>();
  handler.all("/auth/*", (c) => c.json({ reached: c.req.path }));
  const app = appWith(fake, { extraRouters: [handler] });
  signIn(fake, { id: OTHER });
  return async (method: string, path: string) => {
    const { response, ctx } = await call(app, path, {
      method,
      headers: {
        origin: "http://localhost",
        "sec-fetch-site": "same-origin",
        [IDENTITY_HEADER]: ME,
      },
    });
    const body = (await response.json().catch(() => null)) as { details?: { reason?: string } } | null;
    await ctx.settle();
    return { status: response.status, reason: body?.details?.reason };
  };
}

describe("identity pin: the Better Auth endpoints", () => {
  it("found the installed route table", () => {
    expect(routes.length).toBeGreaterThan(50);
  });

  it("every exempt route is a route of the installed Better Auth (no stale name)", () => {
    const paths = new Set(routes.map((route) => route.path));
    expect(Object.keys(PIN_EXEMPT_AUTH_ROUTES).filter((path) => !paths.has(path))).toEqual([]);
  });

  it("every other route is pinned: a request naming another account is refused, every method", async () => {
    const send = setup();
    const wrong: string[] = [];
    for (const route of routes) {
      const exempt = route.path in PIN_EXEMPT_AUTH_ROUTES;
      for (const method of route.methods) {
        const answer = await send(method, `/api/auth${concrete(route.path)}`);
        const refused = answer.status === 403 && answer.reason === "identity_mismatch";
        if (refused === exempt)
          wrong.push(`${method} ${route.path}: ${exempt ? "exempt but refused" : "not pinned"}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a stale tab can still sign in, sign out and read the session: those are reached with any claim", async () => {
    const send = setup();
    for (const [method, path] of [
      ["POST", "/api/auth/sign-out"],
      ["GET", "/api/auth/get-session"],
      ["POST", "/api/auth/sign-in/email"],
      ["POST", "/api/auth/two-factor/verify-totp"],
      ["GET", "/api/auth/reset-password/tok"],
    ] as const) {
      expect((await send(method, path)).reason, path).toBeUndefined();
    }
  });

  it("the account mutations the review names are among the pinned", () => {
    for (const path of [
      "/change-password",
      "/change-email",
      "/update-user",
      "/delete-user",
      "/two-factor/enable",
      "/two-factor/disable",
      "/passkey/verify-registration",
      "/passkey/delete-passkey",
      "/list-sessions",
      "/revoke-sessions",
      "/admin/impersonate-user",
      "/admin/stop-impersonating",
    ]) {
      expect(path in PIN_EXEMPT_AUTH_ROUTES, path).toBe(false);
    }
  });
});
