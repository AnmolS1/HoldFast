// The watchdog around the auth handler (routes/auth.ts): detection for Better Auth issue #10315.
// If the handler does not answer — on a deployed Worker, a promise orphaned by an aborted
// request never settles — the request is answered 503 instead of hanging for ever.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/worker/app";
import { AUTH_HANDLER_TIMEOUT_MS, setAuthHandlerTimeoutForTests } from "../../../src/worker/routes/auth";
import { realCore } from "./helpers";

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** The real app, with an auth instance whose handler never answers (its session read does). */
function appWithHungHandler() {
  let handlerCalls = 0;
  const app = createApp({
    ...realCore,
    createAuth: () => ({
      api: { getSession: async () => null },
      handler: () => {
        handlerCalls += 1;
        return new Promise<Response>(() => {});
      },
    }),
  });
  return { app, calls: () => handlerCalls };
}

async function request(app: ReturnType<typeof createApp>, path: string) {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => void pending.push(p),
    passThroughOnException() {},
    props: {},
  };
  const response = await app.fetch(
    new Request(`${env.APP_ORIGIN}${path}`),
    env,
    ctx as unknown as ExecutionContext,
  );
  while (pending.length) await Promise.allSettled(pending.splice(0));
  return response;
}

describe("the auth handler watchdog", () => {
  it("is ten seconds", () => {
    expect(AUTH_HANDLER_TIMEOUT_MS).toBe(10_000);
  });

  it("a handler that never answers is a 503 with Retry-After, not a hung request", async () => {
    restore = setAuthHandlerTimeoutForTests(80);
    const { app, calls } = appWithHungHandler();
    const started = Date.now();
    const response = await request(app, "/api/auth/get-session");
    const elapsed = Date.now() - started;
    expect(calls()).toBe(1);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
    const body = (await response.json()) as { error: string; requestId: string };
    expect(body.error).toBe("internal");
    expect(body.requestId).toBeTruthy();
    expect(elapsed).toBeGreaterThanOrEqual(70);
    expect(elapsed).toBeLessThan(5_000);
  });

  it("a handler that answers in time is passed through untouched", async () => {
    restore = setAuthHandlerTimeoutForTests(2_000);
    const app = createApp({
      ...realCore,
      createAuth: () => ({
        api: { getSession: async () => null },
        handler: async () => new Response("answered", { status: 418, headers: { "x-from": "auth" } }),
      }),
    });
    const response = await request(app, "/api/auth/anything");
    expect(response.status).toBe(418);
    expect(response.headers.get("x-from")).toBe("auth");
    expect(await response.text()).toBe("answered");
  });
});
