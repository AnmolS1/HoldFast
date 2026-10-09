// What Sentry is handed when the Worker reports an error — for EVERY caller, not only the auth
// layer: `captureError` (src/worker/sentry.ts) is the one explicit exit and sends a sanitised
// copy, never the caught object. The SDK is replaced by a recorder; the callers are real.
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureError, sentryOptions } from "../../../src/worker/sentry";
import { audit } from "../../../src/worker/services/audit";
import { handlePlainError } from "../../../src/worker/services/errors";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { appWith, call, fakeCore, fakeCtx, testEnv } from "./helpers";

const captured = vi.hoisted(() => ({ errors: [] as unknown[], tags: [] as Array<[string, string]> }));

vi.mock("@sentry/cloudflare", () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
  withScope: (callback: (scope: { setTag(key: string, value: string): void }) => void) =>
    callback({ setTag: (key, value) => void captured.tags.push([key, value]) }),
  captureException: (error: unknown) => void captured.errors.push(error),
}));

const SENTINELS = [
  "SENTINEL-PARAM-ada@example.test",
  "SENTINEL-DETAIL",
  "SENTINEL-CAUSE",
  "SENTINEL-RESPONSE",
  "SENTINEL-REQUEST-COOKIE",
  "SENTINEL-TOKEN-abcdefghijklmnopqrstuvwxyz0123456789",
];

/** A driver-style error: the row in its message, and more of it in its own fields. */
function hostileError(): Error {
  const error = new Error(
    `Failed query: insert into "user" ("name", "email") values ($1, $2)\nparams: Sentinel Person,${SENTINELS[0]}`,
    {
      cause: new Error(`${SENTINELS[2]} at https://app.example/api/auth/verify-email?token=${SENTINELS[5]}`),
    },
  );
  Object.assign(error, {
    code: "23505",
    detail: `Key (email)=(${SENTINELS[1]}) already exists.`,
    parameters: ["Sentinel Person", SENTINELS[0]],
    response: { body: SENTINELS[3] },
    request: { headers: { cookie: SENTINELS[4] } },
    config: { headers: { authorization: `Bearer ${SENTINELS[5]}` } },
  });
  return error;
}

/** Everything reachable from a value, own and inherited, enumerable or not — as one string. */
function everythingIn(value: unknown, seen = new Set<unknown>()): string {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return String(value);
  if (seen.has(value)) return "";
  seen.add(value);
  const parts: string[] = [];
  for (let target: object | null = value; target && target !== Object.prototype;) {
    for (const key of Reflect.ownKeys(target)) {
      let item: unknown;
      try {
        item = (value as Record<PropertyKey, unknown>)[key];
      } catch {
        continue;
      }
      parts.push(String(key), everythingIn(item, seen));
    }
    target = Object.getPrototypeOf(target) as object | null;
  }
  return parts.join("\n");
}

function expectSanitised(original: Error): void {
  expect(captured.errors).toHaveLength(1);
  const sent = captured.errors[0];
  expect(sent, "the caught object itself was handed to Sentry").not.toBe(original);
  expect(sent).toBeInstanceOf(Error);
  const text = everythingIn(sent);
  for (const sentinel of [...SENTINELS, "Sentinel Person"]) expect(text, sentinel).not.toContain(sentinel);
  // What survives is what makes the event useful: the class, the code, the start of the message.
  expect((sent as Error & { code?: string }).code).toBe("23505");
  expect((sent as Error).message).toContain("Failed query");
  expect((sent as Error).message).toContain("params: [dropped]");
}

beforeEach(() => {
  captured.errors.length = 0;
  captured.tags.length = 0;
});

describe("an error on its way to Sentry", () => {
  it("captureError itself sends a copy: class, code, scanned message — none of the object's fields", () => {
    const original = hostileError();
    captureError(original, { kind: "direct" });
    expectSanitised(original);
    expect(captured.tags).toEqual([["kind", "direct"]]);
    // Something that is not an Error at all is described, not passed on.
    captured.errors.length = 0;
    const thrown = { password: SENTINELS[5], email: "ada@example.test" };
    captureError(thrown);
    expect(captured.errors[0]).not.toBe(thrown);
    expect(everythingIn(captured.errors[0])).not.toContain(SENTINELS[5]);
    expect(everythingIn(captured.errors[0])).not.toContain("ada@example.test");
  });

  it("a route that throws (the app's error handler): 500 with the envelope, and a sanitised report", async () => {
    const original = hostileError();
    const router = new Hono<AppEnv>();
    router.get("/nodes/boom", () => {
      throw original;
    });
    const { response, ctx } = await call(appWith(fakeCore(), { extraRouters: [router] }), "/api/nodes/boom");
    expect(response.status).toBe(500);
    const body = await response.text();
    for (const sentinel of SENTINELS) expect(body).not.toContain(sentinel);
    await ctx.settle();
    expectSanitised(original);
  });

  it("the files host's error handler reports the same way, and answers in plain text", async () => {
    const original = hostileError();
    const probe = new Hono<AppEnv>();
    probe.onError(handlePlainError);
    probe.get("/boom", () => {
      throw original;
    });
    const response = await probe.fetch(new Request(`${TEST_FILES_ORIGIN}/boom`), testEnv(), fakeCtx());
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
    const body = await response.text();
    for (const sentinel of SENTINELS) expect(body).not.toContain(sentinel);
    expectSanitised(original);
  });

  it("a failed audit write (deferred work, after the response): reported sanitised, the request unharmed", async () => {
    const original = hostileError();
    const fake = fakeCore();
    fake.core.insertAudit = async () => {
      throw original;
    };
    const router = new Hono<AppEnv>();
    router.get("/nodes/audited", (c) => {
      audit(c, "node.trashed", { type: "node", id: "n1" });
      return c.json({ ok: true });
    });
    const { response, ctx } = await call(appWith(fake, { extraRouters: [router] }), "/api/nodes/audited");
    expect(response.status).toBe(200);
    await ctx.settle();
    expectSanitised(original);
    expect(captured.tags).toEqual([["kind", "audit"]]);
  });

  it("an exception the SDK captured by itself has its message scanned on the way out", () => {
    const options = sentryOptions({
      SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/1",
      SENTRY_ENVIRONMENT: "dev",
    });
    const event = {
      exception: {
        values: [
          { type: "Error", value: hostileError().message },
          {
            type: "Error",
            value: `fetch https://app.example/api/auth/callback/google?state=${SENTINELS[5]} failed for 203.0.113.9`,
          },
        ],
      },
      tags: { requestId: "r-1" },
    };
    const frozen = JSON.stringify(event);
    const out = options!.beforeSend!(event as never, {}) as unknown as typeof event;
    expect(JSON.stringify(event)).toBe(frozen);
    const text = JSON.stringify(out);
    for (const leak of [...SENTINELS, "Sentinel Person", "203.0.113.9", "app.example"])
      expect(text).not.toContain(leak);
    expect(out.exception.values[0]!.value).toContain("params: [dropped]");
    expect(out.tags).toEqual({ requestId: "r-1" });
  });
});
