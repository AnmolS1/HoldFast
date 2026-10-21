// CSRF coverage (T26 item 5): EVERY state-changing /api/* route of the real app — enumerated from
// `app.routes`, so a route added later is covered without editing this file — refuses a
// cross-site request with 403 `csrf`. The exemptions are an explicit list: a new route under an
// exempt prefix fails here until it is added to EXEMPT with its reason.
import { describe, expect, it } from "vitest";
import { BA_ID_PARAM, TOKEN_PARAM, UUID_PARAM } from "../../../src/shared/ids";
import { appWith, call, fakeCore, sameOrigin } from "../worker-core/helpers";
import { parsePath } from "../worker-core/registry-check";

const MUTATING = ["POST", "PUT", "PATCH", "DELETE"];

/**
 * Routes that take a cross-site request by design. Each line says why.
 *   /api/public/*  no session is ever read there (the pipeline skips it)
 *   /api/auth/*    Better Auth checks its own trusted origins (tests/unit/auth/session-policy.test.ts
 *                  "origins": a cross-site sign-in, sign-up or cookie-bearing write is refused)
 *   /api/_test/*   exists only in test mode (GET only today, so nothing is listed)
 */
const LINK = ":token{[A-Za-z0-9_-]{16,}}";
const EXEMPT = [
  "POST /api/public/csp-report", // browsers post CSP reports without credentials, from any page
  // The public link API: no session and no cookie; a password is proven by the link session in
  // the X-Holdfast-Link-Session header, which a cross-site page cannot send without a preflight.
  // Whoever can post here cross-site holds the link token and could post directly.
  `POST /api/public/links/${LINK}/download-url`,
  `POST /api/public/links/${LINK}/download-urls`,
  `POST /api/public/links/${LINK}/unlock`,
  `POST /api/public/links/${LINK}/zip-manifest`,
  "ALL /api/auth/*", // the Better Auth handler (method-agnostic: the canonical step admits only its own pairs)
].sort();

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

const isExemptPath = (path: string) =>
  path.startsWith("/api/public/") || path.startsWith("/api/auth/") || path.startsWith("/api/_test/");

function stateChangingRoutes() {
  const app = appWith(fakeCore());
  // app.routes holds the middleware registrations too (method ALL): those are not routes.
  const pipelinePaths = new Set(["*", "/api/*"]);
  const byPath = new Map<string, Set<string>>();
  for (const route of app.routes) {
    if (!route.path.startsWith("/api/")) continue;
    if (route.method === "ALL" && pipelinePaths.has(route.path)) continue;
    // The auth handler is listed as registered (ALL); every other method-agnostic route is probed
    // with each state-changing method.
    const auth = route.path === "/api/auth/*";
    const methods =
      auth || MUTATING.includes(route.method) ? [route.method] : route.method === "ALL" ? MUTATING : [];
    if (methods.length === 0) continue;
    const set = byPath.get(route.path) ?? new Set<string>();
    for (const method of methods) set.add(method);
    byPath.set(route.path, set);
  }
  return byPath;
}

describe("CSRF: every state-changing /api/* route outside the exemptions refuses a cross-site request", () => {
  it("the exempt routes are exactly the explicit list", () => {
    const exempt = [...stateChangingRoutes()]
      .filter(([path]) => isExemptPath(path))
      .map(([path, methods]) => `${[...methods].sort().join(",")} ${path}`)
      .sort();
    expect(exempt).toEqual(EXEMPT);
  });

  it("403 csrf for a cross-site Origin, for Sec-Fetch-Site: cross-site, and for neither header", async () => {
    const routes = [...stateChangingRoutes()].filter(([path]) => !isExemptPath(path));
    // The real registry (T11–T24, 29 state-changing patterns at 113011a); grows with every merge.
    expect(routes.length).toBeGreaterThanOrEqual(29);
    const fake = fakeCore();
    const app = appWith(fake);
    let checked = 0;
    for (const [pattern, methods] of routes) {
      const path = concrete(pattern);
      for (const method of methods) {
        for (const headers of [
          { origin: "https://evil.example", "content-type": "application/json" },
          { "sec-fetch-site": "cross-site", "content-type": "application/json" },
          { "sec-fetch-site": "same-site", origin: "https://sibling.localhost" },
          {} as Record<string, string>,
        ]) {
          const { response, ctx } = await call(app, path, { method, headers, body: "{}" });
          const body = (await response.json()) as { error?: string; details?: { reason?: string } };
          await ctx.settle();
          expect(response.status, `${method} ${pattern} ${JSON.stringify(headers)}`).toBe(403);
          expect(body.details?.reason, `${method} ${pattern}`).toBe("csrf");
          checked += 1;
        }
      }
    }
    // Refused before anything opened the database or read a session.
    expect(fake.calls).toEqual([]);
    expect(checked).toBeGreaterThanOrEqual(29 * 4);
  });

  it("control: the same requests from the app origin are not refused as cross-site", async () => {
    const routes = [...stateChangingRoutes()].filter(([path]) => !isExemptPath(path));
    const app = appWith(fakeCore());
    for (const [pattern, methods] of routes) {
      for (const method of methods) {
        const { response, ctx } = await call(app, concrete(pattern), {
          method,
          headers: sameOrigin,
          body: "{}",
        });
        const text = await response.text();
        await ctx.settle();
        expect(text, `${method} ${pattern}`).not.toContain('"reason":"csrf"');
      }
    }
  });

  it("the exempt routes are not refused as cross-site", async () => {
    const app = appWith(fakeCore());
    const { response, ctx } = await call(app, "/api/public/csp-report", {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "content-type": "application/csp-report",
      },
      body: JSON.stringify({ "csp-report": { "violated-directive": "img-src" } }),
    });
    expect(response.status).toBe(204);
    await response.text();
    await ctx.settle();
  });
});
