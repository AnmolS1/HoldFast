// The allow-list for sessions in a restricted state under /api/auth/* (auth/endpoint-policy.ts),
// checked two ways:
//   1. against the INSTALLED Better Auth: the route table is read from the built instance of
//      auth/config.ts (the plugin list the runtime uses) and must equal the policy's table, row
//      for row, methods included. A Better Auth upgrade or a new plugin that adds, removes or
//      re-methods an endpoint fails here until someone decides what each state may do with it.
//   2. through the real pipeline: for every state and EVERY enumerated endpoint and method, the
//      request reaches the handler behind the pipeline, or is refused, exactly as the table says.
// Better Auth itself is not mounted yet: "reaches the handler" is a probe router standing where
// the auth handler will stand, so what is proven is the gate, not the handler behind it.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { auth } from "../../../src/worker/auth/config";
import {
  AUTH_ENDPOINTS,
  authGateDecision,
  type AuthGateDecision,
  type AuthGateState,
} from "../../../src/worker/auth/endpoint-policy";
import type { SessionInfo, SessionUser } from "../../../src/worker/auth/types";
import { IMPERSONATION_EXEMPT_PATHS } from "../../../src/worker/middleware/impersonation";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { appWith, call, fakeCore, signIn } from "./helpers";

type Endpoint = { path?: string; options?: { method?: string | string[] } };

/** `METHODS path` for every endpoint the installed Better Auth serves with this plugin list. */
function installed(): string[] {
  return Object.values(auth.api as unknown as Record<string, Endpoint>)
    .filter((endpoint) => typeof endpoint?.path === "string")
    .map(
      (endpoint) => `${([] as string[]).concat(endpoint.options?.method ?? []).join(",")} ${endpoint.path}`,
    )
    .sort();
}

const past = new Date(Date.now() - 86_400_000);
const STATES: Record<
  AuthGateState,
  { user: Partial<SessionUser>; session: Partial<SessionInfo>; column: 2 | 3 | 4 }
> = {
  deleted: { user: { deleteScheduledAt: past }, session: {}, column: 2 },
  suspended: { user: { suspendedAt: past }, session: {}, column: 3 },
  impersonating: { user: {}, session: { impersonatedBy: "a".repeat(32) }, column: 4 },
};
const DENIED: Record<AuthGateState, { status: number; error: string; reason?: string }> = {
  deleted: { status: 401, error: "unauthorized" },
  suspended: { status: 403, error: "forbidden", reason: "account_suspended" },
  impersonating: { status: 403, error: "forbidden", reason: "impersonation_read_only" },
};

/** Stands where the auth handler will: answers every method on every path under /api/auth. */
function setup() {
  const fake = fakeCore();
  fake.state.settings = { termsVersion: "2026-10-01" };
  const handler = new Hono<AppEnv>();
  handler.all("/auth/*", (c) => c.json({ reached: c.req.path, user: c.get("user")?.id ?? null }));
  // No registry routers in front: the placeholder session route must not answer for the handler.
  const app = appWith(fake, { extraRouters: [handler] });
  const send = async (method: string, path: string) => {
    const { response, ctx } = await call(app, path, {
      method,
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
    });
    const text = await response.text();
    await ctx.settle();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // HEAD has no body.
    }
    return {
      status: response.status,
      body: body as { reached?: string; error?: string; details?: { reason?: string } } | null,
    };
  };
  return { fake, send };
}

/**
 * What an allowed request is answered with in this test. One path is special until the auth task
 * lands: the registry's placeholder router answers `GET /api/auth/get-session` itself, with the
 * signed-out body, before the stand-in handler is reached.
 */
function reachedOrPlaceholder(method: string, path: string): unknown {
  if (path === "/api/auth/get-session" && (method === "GET" || method === "HEAD")) return null;
  return { reached: path, user: expect.toSatisfy((value) => value === null || typeof value === "string") };
}

/** A concrete path for a table path: `:id` → a value. */
const concrete = (path: string) => `/api/auth${path.replace(/:[A-Za-z]+/g, "abc123")}`;

describe("the policy table is the installed Better Auth's route table", () => {
  it("has one row per endpoint, with the same methods — no endpoint without a decision", () => {
    const table = AUTH_ENDPOINTS.map(([methods, path]) => `${methods} ${path}`).sort();
    expect(table).toEqual(installed());
    expect(new Set(table).size).toBe(table.length);
    expect(table.length).toBeGreaterThanOrEqual(60);
  });

  it("the control: an endpoint the table does not have would fail the comparison", () => {
    const table = AUTH_ENDPOINTS.map(([methods, path]) => `${methods} ${path}`).sort();
    expect([...installed(), "POST /brand-new/endpoint"].sort()).not.toEqual(table);
    expect(installed().filter((row) => row !== "GET /verify-email")).not.toEqual(table);
    // A method added to an existing endpoint is a difference too.
    expect(installed().map((row) => (row === "POST /sign-out" ? "GET,POST /sign-out" : row))).not.toEqual(
      table,
    );
  });

  it("allows exactly what was decided, and nothing by default", () => {
    const allowed = (state: AuthGateState) =>
      AUTH_ENDPOINTS.filter((row) => row[STATES[state].column] !== "deny")
        .map((row) => `${row[1]}=${row[STATES[state].column]}`)
        .sort();
    expect(allowed("deleted")).toEqual([
      "/error=allow",
      "/get-session=signed_out",
      "/ok=allow",
      "/sign-out=allow",
    ]);
    expect(allowed("suspended")).toEqual([
      "/error=allow",
      "/get-session=allow",
      "/ok=allow",
      "/sign-out=allow",
    ]);
    expect(allowed("impersonating")).toEqual([
      "/admin/stop-impersonating=allow",
      "/error=allow",
      "/get-session=allow",
      "/ok=allow",
      "/sign-out=allow",
    ]);
  });
});

describe("the gate, for every endpoint and method of the route table", () => {
  for (const state of Object.keys(STATES) as AuthGateState[]) {
    it(`${state}: each endpoint is allowed or refused as the table says`, async () => {
      const { fake, send } = setup();
      signIn(fake, STATES[state].user, STATES[state].session);
      let checked = 0;
      for (const row of AUTH_ENDPOINTS) {
        const decision: AuthGateDecision = row[STATES[state].column];
        const path = concrete(row[1]);
        // The endpoint's own methods, and the others too: the decision is by path.
        for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]) {
          const answer = await send(method, path);
          const label = `${state} ${method} ${path}`;
          const write = method !== "GET" && method !== "HEAD";
          if (
            decision === "allow" &&
            state === "impersonating" &&
            write &&
            !IMPERSONATION_EXEMPT_PATHS.includes(path)
          ) {
            // Allowed by path here, then narrowed by the read-only rule for impersonated sessions:
            // only its two exempt paths may be written to.
            expect(answer.status, label).toBe(403);
            expect(answer.body?.details?.reason, label).toBe("impersonation_read_only");
          } else if (decision === "allow") {
            expect(answer.status, label).toBe(200);
            if (method !== "HEAD") expect(answer.body, label).toEqual(reachedOrPlaceholder(method, path));
          } else if (decision === "signed_out") {
            expect(answer.status, label).toBe(200);
            if (method !== "HEAD") expect(answer.body, label).toBeNull();
          } else {
            expect(answer.status, label).toBe(DENIED[state].status);
            if (method !== "HEAD") {
              expect(answer.body?.error, label).toBe(DENIED[state].error);
              expect(answer.body?.details?.reason, label).toBe(DENIED[state].reason);
              expect(answer.body?.reached, label).toBeUndefined();
            }
          }
          checked += 1;
        }
      }
      expect(checked).toBe(AUTH_ENDPOINTS.length * 6);
    });

    it(`${state}: a path the table does not spell is refused (default deny)`, async () => {
      const { fake, send } = setup();
      signIn(fake, STATES[state].user, STATES[state].session);
      for (const path of [
        "/api/auth/brand-new/endpoint",
        "/api/auth/sign-out/",
        "/api/auth/Sign-Out",
        "/api/auth/sign-out/extra",
        "/api/auth//sign-out",
        "/api/auth/sign%2Dout",
        "/api/auth/get-session/",
        "/api/auth/GET-SESSION",
        "/api/auth/ok/../change-email",
        "/api/auth/callback/google/extra",
        "/api/auth/x",
      ]) {
        for (const method of ["GET", "POST"]) {
          const answer = await send(method, path);
          expect(answer.status, `${state} ${method} ${path}`).toBe(DENIED[state].status);
          expect(answer.body?.reached, `${state} ${method} ${path}`).toBeUndefined();
        }
        expect(authGateDecision(state, path), path).toBe("deny");
      }
      expect(authGateDecision(state, "/api/nodes")).toBe("deny");
    });
  }

  it("impersonation outranks the account's own state: the admin can always stop", async () => {
    for (const user of [STATES.deleted.user, STATES.suspended.user, { banned: true, banExpires: null }]) {
      const { fake, send } = setup();
      signIn(fake, user, STATES.impersonating.session);
      expect((await send("POST", "/api/auth/admin/stop-impersonating")).body).toMatchObject({
        reached: "/api/auth/admin/stop-impersonating",
      });
      const refused = await send("GET", "/api/auth/list-sessions");
      expect(refused.status).toBe(403);
      expect(refused.body?.details?.reason).toBe("impersonation_read_only");
    }
  });

  it("a banned account is the suspended state; an expired ban is no state at all", async () => {
    const { fake, send } = setup();
    signIn(fake, { banned: true, banExpires: null });
    expect((await send("GET", "/api/auth/list-sessions")).status).toBe(403);
    expect((await send("POST", "/api/auth/sign-out")).status).toBe(200);
    signIn(fake, { banned: true, banExpires: past });
    expect((await send("GET", "/api/auth/list-sessions")).body).toMatchObject({
      reached: "/api/auth/list-sessions",
    });
  });

  it("no session, and an ordinary session, are not restricted: every endpoint reaches the handler", async () => {
    for (const signedIn of [false, true]) {
      const { fake, send } = setup();
      if (signedIn) signIn(fake);
      for (const [methods, tablePath] of AUTH_ENDPOINTS) {
        const path = concrete(tablePath);
        for (const method of methods.split(",")) {
          const answer = await send(method, path);
          expect(answer.body, `${signedIn} ${method} ${path}`).toEqual(reachedOrPlaceholder(method, path));
        }
      }
      expect((await send("POST", "/api/auth/brand-new/endpoint")).body).toMatchObject({
        reached: "/api/auth/brand-new/endpoint",
      });
    }
  });

  // The read-only kill switch exempts /api/auth/* as a whole (middleware/kill-switch.ts): the
  // admins who must switch it off have to be able to sign in, with every factor.
  it("read-only mode: every auth endpoint still reaches the handler", async () => {
    const { fake, send } = setup();
    fake.state.settings = { termsVersion: "2026-10-01", readOnly: true };
    signIn(fake);
    for (const [methods, tablePath] of AUTH_ENDPOINTS) {
      const path = concrete(tablePath);
      for (const method of methods.split(",")) {
        expect((await send(method, path)).body, `${method} ${path}`).toEqual(
          reachedOrPlaceholder(method, path),
        );
      }
    }
    // The control: outside /api/auth the same switch does refuse a write.
    const { response, ctx } = await call(appWith(fake), "/api/nodes/folder", {
      method: "POST",
      headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
    });
    expect(response.status).toBe(503);
    await response.text();
    await ctx.settle();
  });
});
