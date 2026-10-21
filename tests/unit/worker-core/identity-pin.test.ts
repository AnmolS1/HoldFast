// W2S4, the identity pin: the SPA names the account its state belongs to in `X-Holdfast-User`; a
// request whose session is ANOTHER account (a second tab signed in as someone else, the cookie is
// shared) is refused before anything of that account runs. Driven through the real pipeline.
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { buildPipeline } from "../../../src/worker/app";
import { IDENTITY_HEADER } from "../../../src/worker/middleware/identity-pin";
import type { AppEnv } from "../../../src/worker/services/request-context";
import clientApiSource from "../../../src/client/lib/api.ts?raw";
import { appWith, call, fakeCore, sameOrigin, signIn, type CallOptions } from "./helpers";

// As in pipeline.test.ts: the real auth router is replaced by a stand-in that lets probes through.
vi.mock("../../../src/worker/routes/auth", async () => {
  const { Hono } = await import("hono");
  const router = new Hono();
  router.get("/auth/get-session", (c) => c.json(null));
  return { router };
});

const ME = "u".repeat(32);
const OTHER = "o".repeat(32);

function setup() {
  const fake = fakeCore();
  fake.state.settings = { termsVersion: "2026-10-01" };
  const router = new Hono<AppEnv>();
  router.all("/*", (c) => c.json({ reached: c.req.path, user: c.get("user")?.id ?? null }));
  const app = appWith(fake, { extraRouters: [router] });
  const send = async (path: string, options: CallOptions = {}) => {
    const { response, ctx } = await call(app, path, options);
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    await ctx.settle();
    return { status: response.status, body };
  };
  return { fake, send };
}

const claiming = (id: string, extra: Record<string, string> = {}) => ({ [IDENTITY_HEADER]: id, ...extra });

describe("identity pin", () => {
  it("the session is the account the client names: the request runs", async () => {
    const { fake, send } = setup();
    signIn(fake, { id: ME });
    const answer = await send("/api/nodes", { headers: claiming(ME) });
    expect(answer).toMatchObject({ status: 200, body: { reached: "/api/nodes", user: ME } });
  });

  it.each(["GET", "POST", "PATCH", "DELETE"])(
    "%s as another account: 403 forbidden identity_mismatch, and the route never runs",
    async (method) => {
      const { fake, send } = setup();
      signIn(fake, { id: OTHER });
      const answer = await send("/api/nodes/abc", { method, headers: claiming(ME, sameOrigin) });
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({ error: "forbidden", details: { reason: "identity_mismatch" } });
      expect(answer.body).not.toHaveProperty("reached");
    },
  );

  it("no header: passes (a client that names nobody — curl, tests, anything but the SPA)", async () => {
    const { fake, send } = setup();
    signIn(fake, { id: OTHER });
    expect((await send("/api/nodes")).body).toMatchObject({ user: OTHER });
  });

  it("a header and no session: passes to the route, whose own 401 opens the re-auth", async () => {
    const { send } = setup();
    expect((await send("/api/nodes", { headers: claiming(ME) })).body).toMatchObject({ user: null });
  });

  it("an empty header is a claim like any other: refused against a session", async () => {
    const { fake, send } = setup();
    signIn(fake, { id: ME });
    expect((await send("/api/nodes", { headers: claiming("") })).status).toBe(403);
  });

  it("not on /api/auth/*, /api/public/*, /api/health: they answer whoever asks", async () => {
    const { fake, send } = setup();
    signIn(fake, { id: OTHER });
    for (const path of ["/api/auth/ok", "/api/public/config-probe", "/api/health"]) {
      const answer = await send(path, { headers: claiming(ME) });
      expect(answer.status, path).not.toBe(403);
    }
  });

  it("refused before the other account's own gates (terms, impersonation, limits) are consulted", async () => {
    const { fake, send } = setup();
    // The other account has stale terms and is being impersonated: either gate would answer first
    // if the pin came later.
    signIn(fake, { id: OTHER, termsVersion: "old" }, { impersonatedBy: "a".repeat(32) });
    const answer = await send("/api/nodes/abc", { method: "POST", headers: claiming(ME, sameOrigin) });
    expect(answer.body).toMatchObject({ details: { reason: "identity_mismatch" } });
  });

  it("sits directly after session in the pipeline", () => {
    const names = buildPipeline(fakeCore().core).map((step) => step.name);
    expect(names.indexOf("identityPin")).toBe(names.indexOf("session") + 1);
  });

  it("the SPA's client sends the same header name", () => {
    expect(clientApiSource).toContain(`IDENTITY_HEADER = "${IDENTITY_HEADER}"`);
  });
});
