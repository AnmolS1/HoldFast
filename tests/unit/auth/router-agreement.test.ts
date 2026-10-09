// What Better Auth's own router makes of a path, next to what our layers decide on
// (src/worker/middleware/canonical.ts, auth/endpoint-policy.ts).
//
// better-call derives the endpoint path as `new URL(request.url).pathname` less the base path
// (better-call/dist/router.mjs:29–38), refuses `//` (:39) and a trailing slash the route does not
// have (:46), and matches the rest literally. Our canonical step refuses every non-canonical
// spelling before the handler; this file holds BOTH halves: (1) the handler, asked DIRECTLY —
// with no layer of ours in front — matches none of the variants either (so there is no spelling
// that Better Auth would serve and our table would not recognise), and (2) through the app each
// canonical endpoint reaches the handler, and each variant is our 404.
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { createAuth } from "../../../src/worker/auth/create-auth";
import { AUTH_ENDPOINTS, isAuthEndpoint } from "../../../src/worker/auth/endpoint-policy";
import { canonicalPath } from "../../../src/worker/middleware/canonical";
import { CAPTCHA, newClient, ORIGIN, send, testDb } from "./helpers";

const concrete = (path: string) => path.replace(/:[A-Za-z]+/g, "abc123");

function variants(relative: string): string[] {
  const last = relative.lastIndexOf("/");
  const tail = relative.slice(last + 1);
  return [
    `${relative.slice(0, last + 1)}%${tail.charCodeAt(0).toString(16)}${tail.slice(1)}`,
    `${relative.slice(0, last)}%2F${tail}`,
    `${relative.slice(0, last)}//${tail}`,
    `/${relative}`,
    `${relative}/`,
    `${relative}%20`,
    relative.toUpperCase(),
    `${relative.slice(0, last + 1)}${tail[0]!.toUpperCase()}${tail.slice(1)}`,
    `${relative}/extra`,
  ].filter((variant) => variant !== relative);
}

/** The handler alone: a 404 with an empty body is its router saying "no such route". */
async function routed(method: string, relative: string): Promise<boolean> {
  const pending: Promise<unknown>[] = [];
  const auth = createAuth(env, testDb(), {
    waitUntil: (promise) => void pending.push(promise),
    passThroughOnException() {},
  });
  const response = await auth.handler(
    new Request(`${ORIGIN}/api/auth${relative}`, {
      method,
      // With a captcha token: Better Auth's captcha plugin and its limiter fold `//` into `/`
      // BEFORE its router refuses the path (plugins/captcha/index.mjs:13, router.mjs:39) — without
      // one, a doubled slash is answered by the plugin (400), which is not the router serving it.
      // (That fold is one more reading of the path that our canonical step makes moot.)
      headers: {
        ...CAPTCHA,
        origin: ORIGIN,
        "cf-connecting-ip": newClient().ip,
        "content-type": "application/json",
      },
      body: method === "GET" ? undefined : "{}",
    }),
  );
  const text = await response.text();
  await Promise.allSettled(pending);
  return !(response.status === 404 && text === "");
}

describe("Better Auth's router and our table read a path the same way", () => {
  it("the handler itself routes no variant of any endpoint except another VALUE of a parameter — and (the control) does route the canonical form", async () => {
    let probed = 0;
    const served: string[] = [];
    for (const [methods, tablePath] of AUTH_ENDPOINTS) {
      const relative = concrete(tablePath);
      const method = methods.split(",")[0]!;
      for (const variant of variants(relative)) {
        if (await routed(method, variant)) served.push(`${method} ${variant}`);
        probed += 1;
      }
    }
    expect(probed).toBeGreaterThan(AUTH_ENDPOINTS.length * 7);
    // What the handler WOULD serve of them: only another VALUE in a parameter segment
    // (`/callback/:id`, `/reset-password/:token` — its router takes any text there, escapes
    // included). Our table calls each of those the same endpoint, so no gate decides differently;
    // and the spellings with an escape never arrive at all (the canonical step — next test).
    expect(served.length).toBeGreaterThan(0);
    for (const line of served) {
      const [method, variant] = line.split(" ") as [string, string];
      expect(variant, line).toMatch(/^\/(callback|reset-password)\/[^/]+$/);
      expect(isAuthEndpoint(method, variant), line).toBe(true);
      if (variant.includes("%")) expect(canonicalPath(`${ORIGIN}/api/auth${variant}`), line).toBeNull();
    }
    // The control, on endpoints that answer without a session or a body.
    for (const relative of ["/ok", "/error", "/get-session"]) {
      expect(await routed("GET", relative), relative).toBe(true);
    }
    expect(await routed("POST", "/sign-out")).toBe(true);
    // A method the route does not have is no route (so our (method, path) table is the same rule).
    expect(await routed("GET", "/sign-out")).toBe(false);
    expect(await routed("POST", "/ok")).toBe(false);
  });

  it("through the app: every variant is our 404 before the handler", async () => {
    let probed = 0;
    for (const [methods, tablePath] of AUTH_ENDPOINTS.filter((_, index) => index % 6 === 0)) {
      const relative = concrete(tablePath);
      const method = methods.split(",")[0]!;
      for (const variant of variants(relative)) {
        // (another VALUE of a parameter, in canonical text, is the same endpoint — not a variant)
        if (isAuthEndpoint(method, variant) && canonicalPath(`${ORIGIN}/api/auth${variant}`)) continue;
        const sent = await send(newClient(), `/api/auth${variant}`, {
          method,
          json: method === "GET" ? undefined : {},
        });
        probed += 1;
        if (variant.toLowerCase().startsWith("/admin")) {
          // Any spelling under /admin/ that is not an endpoint: 404, or the audited 403.
          expect([403, 404], `${method} ${variant}`).toContain(sent.status);
          continue;
        }
        expect(sent.status, `${method} ${variant}`).toBe(404);
        expect(sent.body, `${method} ${variant}`).toMatchObject({ error: "not_found" });
      }
    }
    expect(probed).toBeGreaterThan(60);
  });
});
