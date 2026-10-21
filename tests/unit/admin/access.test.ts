// Who reaches the admin console's API: an admin whose SESSION passed a second factor, and nobody
// else — the test iterates the router, so a route added later is covered by itself.
import { describe, expect, it } from "vitest";
import { uuidv7 } from "../../../src/worker/db/ids";
import { router } from "../../../src/worker/routes/admin";
import { adminCall, admin, baId, call, member, type Who } from "./helpers";

/** Every (method, path) the router declares, its parameters filled with well-formed made-up values. */
function declared() {
  const seen = new Set<string>();
  return router.routes
    .filter((route) => route.method !== "ALL")
    .map((route) => ({
      method: route.method,
      template: route.path,
      path: route.path
        .split("/")
        .map((segment) => {
          if (!segment.startsWith(":")) return segment;
          const name = segment.slice(1).split("{")[0];
          if (name === "userId") return baId();
          if (name === "name") return "purge";
          if (name === "code") return "MADEUP-CODE";
          return uuidv7();
        })
        .join("/"),
    }))
    .filter((route) => {
      const key = `${route.method} ${route.template}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

const bodyFor = (method: string) => (method === "GET" ? undefined : {});

describe("every /api/admin route asks requireAdmin", () => {
  const routes = declared();

  it("the router declares the console's routes (the list the iterations below walk)", () => {
    expect(routes.length).toBeGreaterThan(40);
    for (const route of routes) expect(route.template.startsWith("/admin/"), route.template).toBe(true);
  });

  it("signed out → 401; a signed-in non-admin → 403 forbidden, on every route", async () => {
    const someone = await member();
    for (const route of routes) {
      const out = await call(null, route.method, route.path, { body: bodyFor(route.method) });
      expect(out.status, `${route.method} ${route.template}`).toBe(401);
      const user = await call(someone.as, route.method, route.path, { body: bodyFor(route.method) });
      expect([user.status, user.body?.error], `${route.method} ${route.template}`).toEqual([
        403,
        "forbidden",
      ]);
    }
  });

  it("an admin without two-factor on the account, and one whose SESSION never passed it → 403 admin_requires_2fa", async () => {
    const no2fa = await admin({ twoFactorEnabled: false });
    const passed = await admin();
    const unproven: Who = { ...passed.as, secondFactorAt: null };
    // More than 12 hours ago is not fresh either.
    const stale: Who = { ...passed.as, secondFactorAt: new Date(Date.now() - 13 * 3_600_000) };
    for (const route of routes) {
      for (const who of [no2fa.as, unproven, stale]) {
        const answer = await adminCall(who, route.method, route.path.slice("/admin".length), {
          body: bodyFor(route.method),
        });
        expect([answer.status, answer.body?.error], `${route.method} ${route.template}`).toEqual([
          403,
          "admin_requires_2fa",
        ]);
      }
    }
  });

  it("an impersonated session never passes — the impersonating admin's own role does not count", async () => {
    const target = await admin();
    const impersonated: Who = { ...target.as, impersonatedBy: baId() };
    for (const route of routes) {
      const answer = await call(impersonated, route.method, route.path, { body: bodyFor(route.method) });
      expect([answer.status, answer.body?.details?.reason], `${route.method} ${route.template}`).toEqual([
        403,
        "impersonation_read_only",
      ]);
    }
  });

  it("control: the same requests from a 2FA admin are past the guard (no 401, no 403)", async () => {
    const ok = await admin();
    for (const route of routes) {
      const answer = await call(ok.as, route.method, route.path, { body: bodyFor(route.method) });
      expect([401, 403], `${route.method} ${route.template}: ${answer.text.slice(0, 200)}`).not.toContain(
        answer.status,
      );
    }
  });
});

describe("user ids are Better Auth ids (ruling 3)", () => {
  it("a uuid-shaped :userId matches no route (404); a 32-character id resolves", async () => {
    const who = await admin();
    const target = await member();
    expect((await adminCall(who.as, "GET", `/users/${uuidv7()}`)).status).toBe(404);
    const found = await adminCall(who.as, "GET", `/users/${target.id}`);
    expect(found.status).toBe(200);
    expect(found.body.user.id).toBe(target.id);
  });
});
