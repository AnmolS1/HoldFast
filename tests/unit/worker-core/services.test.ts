// Errors, keys, IP hashes, metrics, the clock, the test outbox, audit and Sentry redaction.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ERROR_STATUS, isErrorCode, type ErrorCode } from "../../../src/shared/errors";
import { redactEvent, redactText, redactUrl } from "../../../src/shared/sentry-redact";
import { sentryOptions } from "../../../src/worker/sentry";
import { audit } from "../../../src/worker/services/audit";
import { isTestMode, now } from "../../../src/worker/services/clock";
import { AppError } from "../../../src/worker/services/errors";
import { dayUTC, ipHashDaily, ipHashStable, ipPrefix, normalise } from "../../../src/worker/services/ip-hash";
import { createKeys, hmacHex, KEY_PURPOSES } from "../../../src/worker/services/keys";
import { metric, writeMetric } from "../../../src/worker/services/metrics";
import * as outbox from "../../../src/worker/services/outbox";
import { jsonBody } from "../../../src/worker/services/body";
import { checkRateLimit, enforceRateLimit } from "../../../src/worker/services/ratelimit";
import {
  deps,
  keys,
  runBackground,
  type AppEnv,
  type ServiceDeps,
} from "../../../src/worker/services/request-context";
import { appWith, call, fakeCore, fakeCtx, sameOrigin, signIn, sleep, testEnv } from "./helpers";

const SECRET = "test-files-token-secret-000000000000000000000000";

describe("error envelope", () => {
  const router = new Hono<AppEnv>();
  router.get("/_err/:code", (c) => {
    throw new AppError(c.req.param("code") as ErrorCode, undefined, { reason: "because" });
  });
  router.get("/_boom", () => {
    throw new Error('SELECT * FROM "user" WHERE secret = hunter2 — connection string postgres://u:p@h/db');
  });
  router.post("/_zod", async (c) => {
    z.object({ name: z.string().min(1) }).parse(await jsonBody(c));
    return c.json({ ok: true });
  });
  router.post("/_json", async (c) => c.json({ got: await jsonBody(c) }));
  router.get("/_syntax-bug", () => {
    // A SyntaxError of the server's own (a bad stored value, say) is still a fault, not a 400.
    JSON.parse("{not json");
    throw new Error("unreachable");
  });
  const app = () => appWith(fakeCore(), { extraRouters: [router] });

  it("every code answers its status with { error, message, requestId, details }", async () => {
    const codes = Object.keys(ERROR_STATUS) as ErrorCode[];
    expect(codes).toHaveLength(19);
    for (const code of codes) {
      const { response, ctx } = await call(app(), `/api/_err/${code}`);
      expect(response.status, code).toBe(ERROR_STATUS[code]);
      expect(response.headers.get("content-type"), code).toMatch(/^application\/json/);
      const body = (await response.json()) as Record<string, unknown>;
      expect(Object.keys(body).sort(), code).toEqual(["details", "error", "message", "requestId"]);
      expect(body.error).toBe(code);
      expect(body.details).toEqual({ reason: "because" });
      expect(typeof body.message === "string" && body.message.length > 0).toBe(true);
      expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
      await ctx.settle();
    }
  });

  it("an unmatched /api path is a JSON 404, not the SPA shell", async () => {
    const { response } = await call(app(), "/api/does/not/exist");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "not_found" });
  });

  it("an unexpected error is a 500 that says nothing about what failed", async () => {
    const { response } = await call(app(), "/api/_boom");
    expect(response.status).toBe(500);
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["error", "message", "requestId"]);
    expect(body.error).toBe("internal");
    expect(isErrorCode(body.error)).toBe(false);
    for (const leak of ["SELECT", "hunter2", "postgres://", "stack", " at "])
      expect(text).not.toContain(leak);
  });

  it("a zod failure is a 400 validation with the failing paths", async () => {
    const { response } = await call(app(), "/api/_zod", {
      method: "POST",
      headers: { ...sameOrigin, "content-type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; details: { issues: Array<{ path: string }> } };
    expect(body.error).toBe("validation");
    expect(body.details.issues.map((issue) => issue.path)).toEqual(["name"]);
  });

  // The body is the client's: one that is not JSON is the client's mistake (400), not a fault
  // (500 and an error report per request).
  it("a request body that is not JSON is a 400 validation, never a 500", async () => {
    const post = (body: string | undefined, type = "application/json") =>
      call(app(), "/api/_json", { method: "POST", headers: { ...sameOrigin, "content-type": type }, body });
    for (const bad of ["{not json", "", "{", '{"a":1}trailing', "\u0000", "undefined", "'single'"]) {
      const { response, ctx } = await post(bad === "" ? undefined : bad);
      expect(response.status, JSON.stringify(bad)).toBe(400);
      const body = (await response.json()) as {
        error: string;
        details?: { reason?: string };
        message: string;
      };
      expect(body.error).toBe("validation");
      expect(body.details).toEqual({ reason: "malformed_json" });
      // Nothing of the parser's own message (it quotes the input).
      expect(body.message).not.toMatch(/token|position|JSON\.parse|Unexpected/i);
      await ctx.settle();
    }
    for (const good of ['{"a":1}', "[1,2]", '"text"', "null", "12"]) {
      const { response, ctx } = await post(good);
      expect(response.status, good).toBe(200);
      expect(await response.json()).toEqual({ got: JSON.parse(good) as unknown });
      await ctx.settle();
    }
  });

  it("a SyntaxError that is the server's own is still a 500", async () => {
    const { response, ctx } = await call(app(), "/api/_syntax-bug");
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: string }).error).toBe("internal");
    await ctx.settle();
  });

  it("AppError derives its status from the table and only from it", () => {
    expect(new AppError("password_required").status).toBe(403);
    expect(new AppError("link_paused").status).toBe(423);
    expect(new AppError("unauthorized").status).toBe(401);
  });
});

describe("rate-limit wrapper", () => {
  const allow = { limit: async () => ({ success: true }) };
  const deny = { limit: async () => ({ success: false }) };

  it("throws 429 rate_limited with Retry-After when the binding refuses", async () => {
    await expect(enforceRateLimit({ RL_LINKS: allow }, "RL_LINKS", "ip:1")).resolves.toBeUndefined();
    const error = await enforceRateLimit({ RL_LINKS: deny }, "RL_LINKS", "ip:1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).status).toBe(429);
    expect((error as AppError).headers).toEqual({ "Retry-After": "60" });
  });

  it("allows when the binding is missing or broken", async () => {
    expect(await checkRateLimit({}, "RL_API", "k")).toBe(true);
    const broken = { limit: async () => Promise.reject(new Error("down")) };
    expect(await checkRateLimit({ RL_API: broken }, "RL_API", "k")).toBe(true);
  });

  it("works against the real local binding", async () => {
    expect(await checkRateLimit(testEnv(), "RL_LINKS", `t07-${crypto.randomUUID()}`)).toBe(true);
  });
});

describe("purpose keys (HKDF)", () => {
  it("derives a different key for every purpose, and the same key every time", async () => {
    const holder = createKeys(SECRET);
    const signing = KEY_PURPOSES.filter((purpose) => purpose !== "link-token-enc");
    const macs = await Promise.all(signing.map((purpose) => hmacHex(holder, purpose, "same message")));
    expect(new Set(macs).size).toBe(signing.length);
    for (const mac of macs) expect(mac).toMatch(/^[0-9a-f]{64}$/);
    const again = await Promise.all(
      signing.map((purpose) => hmacHex(createKeys(SECRET), purpose, "same message")),
    );
    expect(again).toEqual(macs);
  });

  it("never uses the raw secret: no purpose key equals HMAC under the secret itself", async () => {
    const raw = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const direct = [...new Uint8Array(await crypto.subtle.sign("HMAC", raw, new TextEncoder().encode("m")))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const holder = createKeys(SECRET);
    for (const purpose of KEY_PURPOSES) {
      if (purpose === "link-token-enc") continue;
      expect(await hmacHex(holder, purpose, "m")).not.toBe(direct);
    }
  });

  it("a different secret gives different keys", async () => {
    expect(await hmacHex(createKeys(SECRET), "download-token", "m")).not.toBe(
      await hmacHex(createKeys(`${SECRET}x`), "download-token", "m"),
    );
  });

  it("link-token-enc is an AES-GCM key that round-trips; the others are HMAC and not extractable", async () => {
    const holder = createKeys(SECRET);
    const aes = await holder.get("link-token-enc");
    expect(aes.algorithm.name).toBe("AES-GCM");
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      aes,
      new TextEncoder().encode("token"),
    );
    expect(new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, aes, sealed))).toBe(
      "token",
    );
    const hmac = await holder.get("download-token");
    expect(hmac.algorithm.name).toBe("HMAC");
    expect(hmac.extractable).toBe(false);
    expect(await holder.get("download-token")).toBe(hmac);
  });

  it("refuses an empty secret and an unknown purpose", async () => {
    expect(() => createKeys("")).toThrow();
    await expect(createKeys(SECRET).get("nope" as never)).rejects.toThrow("unknown key purpose");
  });
});

describe("IP hashes", () => {
  const holder = createKeys(SECRET);

  it("daily differs across days; stable does not rotate; the two never coincide", async () => {
    const day1 = await ipHashDaily(holder, "203.0.113.9", "2026-10-08");
    const day2 = await ipHashDaily(holder, "203.0.113.9", "2026-10-09");
    expect(day1).not.toBe(day2);
    expect(await ipHashDaily(holder, "203.0.113.9", "2026-10-08")).toBe(day1);
    const stable = await ipHashStable(holder, "203.0.113.9");
    expect(await ipHashStable(holder, "203.0.113.9")).toBe(stable);
    expect(stable).not.toBe(day1);
    expect(await ipHashStable(holder, "203.0.113.10")).not.toBe(stable);
    expect(dayUTC(new Date("2026-10-08T23:59:59.999Z"))).toBe("2026-10-08");
    expect(dayUTC(new Date("2026-10-09T00:00:00.000Z"))).toBe("2026-10-09");
  });

  it("collapses an IPv6 address to its /64, whatever its spelling", async () => {
    expect(normalise("2001:db8:0:1:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64");
    expect(normalise("2001:0DB8:0000:0001::1")).toBe("2001:db8:0:1::/64");
    expect(normalise("[2001:db8:0:1::ffff]")).toBe("2001:db8:0:1::/64");
    expect(normalise("2001:db8:0:2::1")).toBe("2001:db8:0:2::/64");
    expect(normalise("::1")).toBe("0:0:0:0::/64");
    expect(normalise("fe80::1%en0")).toBe("fe80:0:0:0::/64");
    const a = await ipHashStable(holder, "2001:db8:0:1:aaaa:bbbb:cccc:dddd");
    expect(await ipHashStable(holder, "2001:0db8:0000:0001::1")).toBe(a);
    expect(await ipHashStable(holder, "2001:db8:0:2::1")).not.toBe(a);
    expect(await ipHashDaily(holder, "2001:db8:0:1::5", "2026-10-08")).toBe(
      await ipHashDaily(holder, "2001:DB8:0:1:9:9:9:9", "2026-10-08"),
    );
  });

  it("keeps IPv4 whole, and reads an IPv4-mapped address as IPv4", () => {
    expect(normalise("203.0.113.9")).toBe("203.0.113.9");
    expect(normalise(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(normalise("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalise("::ffff:cb00:7109")).toBe("203.0.113.9");
    expect(normalise("not an address")).toBe("not an address");
    expect(normalise("999.1.1.1")).toBe("999.1.1.1");
  });

  it("ipPrefix is the /24 or the /48", () => {
    expect(ipPrefix("203.0.113.9")).toBe("203.0.113.0/24");
    expect(ipPrefix("2001:db8:7:1::5")).toBe("2001:db8:7::/48");
    expect(ipPrefix("::ffff:203.0.113.9")).toBe("203.0.113.0/24");
  });
});

describe("metrics", () => {
  it("writes the fixed positional layout", () => {
    const points: unknown[] = [];
    const METRICS = {
      writeDataPoint: (point: unknown) => points.push(point),
    } as unknown as AnalyticsEngineDataset;
    writeMetric(
      { METRICS, SENTRY_ENVIRONMENT: "test" },
      "upload",
      { outcome: "ok", kind: "multipart", route: "/api/uploads", ms: 12 },
      3,
    );
    writeMetric({ METRICS, SENTRY_ENVIRONMENT: "test" }, "job", { kind: "backup" });
    expect(points).toEqual([
      {
        indexes: ["upload"],
        blobs: ["upload", "ok", "multipart", "", "/api/uploads", "test"],
        doubles: [3, 12],
      },
      { indexes: ["job"], blobs: ["job", "", "backup", "", "", "test"], doubles: [1, 0] },
    ]);
  });

  it("never throws: missing binding, missing env, a binding that throws", () => {
    const throwing = {
      writeDataPoint: () => {
        throw new Error("analytics engine down");
      },
    } as unknown as AnalyticsEngineDataset;
    expect(() => writeMetric(undefined, "error")).not.toThrow();
    expect(() => writeMetric({}, "error", { kind: "x" })).not.toThrow();
    expect(() => writeMetric({ METRICS: throwing }, "error")).not.toThrow();
    expect(() => metric("request", { outcome: "2xx" })).not.toThrow();
  });

  it("the request middleware emits `request` with the status class and the route PATTERN", async () => {
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const METRICS = { writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => points.push(point) };
    const router = new Hono<AppEnv>();
    router.get("/_things/:id{[0-9]+}", (c) => c.json({ ok: true }));
    const app = appWith(fakeCore(), { extraRouters: [router] });
    const { response, ctx } = await call(app, "/api/_things/12345", { env: { METRICS } });
    await response.text();
    await ctx.settle();
    const request = points.find((point) => point.blobs[0] === "request");
    expect(request?.blobs).toEqual(["request", "2xx", "", "", "/api/_things/:id", "test"]);
    expect(JSON.stringify(points)).not.toContain("12345");
    const missing = await call(app, "/api/nope", { env: { METRICS } });
    await missing.response.text();
    expect(points.at(-1)?.blobs.slice(0, 2)).toEqual(["request", "4xx"]);
  });
});

describe("clock", () => {
  const app = () => {
    const router = new Hono<AppEnv>();
    router.get("/_now", (c) => c.json({ now: now(c).toISOString() }));
    return appWith(fakeCore(), { extraRouters: [router] });
  };
  const forced = "2031-05-06T07:08:09.000Z";
  const ask = async (env: Record<string, unknown>, value = forced) => {
    const { response, ctx } = await call(app(), "/api/_now", {
      env,
      headers: { "x-holdfast-test-now": value },
    });
    const body = (await response.json()) as { now: string };
    await ctx.settle();
    return body.now;
  };

  it("honours X-Holdfast-Test-Now under the memory transport outside production", async () => {
    expect(await ask({})).toBe(forced);
    expect(await ask({ SENTRY_ENVIRONMENT: "dev" })).toBe(forced);
  });

  it("ignores it in production, with another transport, and when it is not a date", async () => {
    const near = (iso: string) => Math.abs(new Date(iso).getTime() - Date.now()) < 5_000;
    expect(near(await ask({ SENTRY_ENVIRONMENT: "production" }))).toBe(true);
    expect(near(await ask({ EMAIL_TRANSPORT: "resend" }))).toBe(true);
    expect(near(await ask({}, "yesterday-ish"))).toBe(true);
    expect(Math.abs(now().getTime() - Date.now())).toBeLessThan(5_000);
  });

  it("isTestMode is the one gate", () => {
    const http = "http://localhost:5173";
    expect(isTestMode({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT: "test", APP_ORIGIN: http })).toBe(
      true,
    );
    expect(
      isTestMode({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT: "production", APP_ORIGIN: http }),
    ).toBe(false);
    expect(isTestMode({ EMAIL_TRANSPORT: "resend", SENTRY_ENVIRONMENT: "dev", APP_ORIGIN: http })).toBe(
      false,
    );
    expect(isTestMode({})).toBe(false);
  });

  // Fail closed: every deploy is served over https, so one wrong var on a deploy (the memory
  // transport, a misspelt environment name) must not be enough to open the test seams.
  const NOT_PLAIN_HTTP = [
    "https://holdfast-dev.ponderance.dev",
    "https://holdfast.ponderance.dev",
    "HTTPS://holdfast-dev.ponderance.dev",
    " https://holdfast-dev.ponderance.dev",
    "https://localhost:5173",
    "//holdfast-dev.ponderance.dev",
    "holdfast-dev.ponderance.dev",
    "localhost:5173",
    "http:",
    "ftp://localhost",
    "",
    undefined,
  ];

  it("isTestMode needs a plain-http APP_ORIGIN, whatever the other two vars say", () => {
    for (const SENTRY_ENVIRONMENT of ["dev", "test", "prodution", undefined]) {
      for (const APP_ORIGIN of NOT_PLAIN_HTTP) {
        expect(
          isTestMode({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT, APP_ORIGIN }),
          `${String(APP_ORIGIN)} / ${String(SENTRY_ENVIRONMENT)}`,
        ).toBe(false);
      }
      for (const APP_ORIGIN of ["http://localhost", "http://localhost:5173", "http://127.0.0.1:5180"]) {
        expect(isTestMode({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT, APP_ORIGIN }), APP_ORIGIN).toBe(
          true,
        );
      }
    }
  });

  it("the clock header is dead on an https origin even under the memory transport", async () => {
    const near = (iso: string) => Math.abs(new Date(iso).getTime() - Date.now()) < 5_000;
    // (Without any APP_ORIGIN the app cannot answer at all; isTestMode's own test covers that.)
    for (const APP_ORIGIN of NOT_PLAIN_HTTP.filter((origin) => origin !== undefined)) {
      const seen = await ask({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT: "dev", APP_ORIGIN });
      expect(near(seen), String(APP_ORIGIN)).toBe(true);
    }
    expect(
      await ask({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT: "dev", APP_ORIGIN: "http://localhost" }),
    ).toBe(forced);
  });
});

describe("test outbox", () => {
  const get = async (path: string, env: Record<string, unknown> = {}) => {
    const { response, ctx } = await call(appWith(fakeCore()), path, { env });
    const body = (await response.json()) as { messages?: outbox.OutboxMessage[]; error?: string };
    await ctx.settle();
    return { status: response.status, body };
  };

  it("lists, filters by recipient and clears", async () => {
    outbox.clear();
    outbox.push({ to: "a@example.test", subject: "one" });
    outbox.push({ to: ["b@example.test", "A@example.test"], subject: "two" });
    outbox.push({ to: "c@example.test", subject: "three" });
    expect((await get("/api/_test/outbox")).body.messages?.map((m) => m.subject)).toEqual([
      "one",
      "two",
      "three",
    ]);
    expect((await get("/api/_test/outbox?to=a@example.test")).body.messages?.map((m) => m.subject)).toEqual([
      "one",
      "two",
    ]);
    expect((await get("/api/_test/outbox?clear=1")).body.messages).toHaveLength(3);
    expect((await get("/api/_test/outbox")).body.messages).toEqual([]);
  });

  it("keeps the last 200 messages", () => {
    outbox.clear();
    for (let i = 0; i < 205; i += 1) outbox.push({ to: "x@example.test", subject: String(i) });
    expect(outbox.list()).toHaveLength(200);
    expect(outbox.list()[0]?.subject).toBe("5");
    outbox.clear();
  });

  it("is a 404 unless the transport is memory and the environment is not production", async () => {
    outbox.push({ to: "secret@example.test", subject: "must not leak" });
    for (const env of [
      { SENTRY_ENVIRONMENT: "production" },
      { EMAIL_TRANSPORT: "resend" },
      { EMAIL_TRANSPORT: "" },
    ]) {
      const answer = await get("/api/_test/outbox", env);
      expect(answer.status, JSON.stringify(env)).toBe(404);
      expect(answer.body.error).toBe("not_found");
      expect(JSON.stringify(answer.body)).not.toContain("must not leak");
    }
    expect((await get("/api/_test/outbox")).status).toBe(200);
    outbox.clear();
  });

  it("is a 404 on an https origin even under the memory transport", async () => {
    outbox.clear();
    outbox.push({ to: "secret@example.test", subject: "must not leak" });
    for (const APP_ORIGIN of [
      "https://holdfast-dev.ponderance.dev",
      "https://holdfast.ponderance.dev",
      "HTTPS://holdfast-dev.ponderance.dev",
      "holdfast-dev.ponderance.dev",
      "",
    ]) {
      for (const SENTRY_ENVIRONMENT of ["dev", "prodution"]) {
        const env = { EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT, APP_ORIGIN };
        for (const path of ["/api/_test/outbox", "/api/_test/outbox?clear=1", "/api/_test/anything"]) {
          const answer = await get(path, env);
          expect(answer.status, `${path} ${JSON.stringify(env)}`).toBe(404);
          expect(JSON.stringify(answer.body)).not.toContain("must not leak");
        }
      }
    }
    // Nothing was cleared by the refused `clear=1`.
    expect(outbox.list()).toHaveLength(1);
    expect((await get("/api/_test/outbox")).body.messages).toHaveLength(1);
    outbox.clear();
  });
});

describe("audit", () => {
  it("from a request: deferred past the handler, with the ip hash, request id and actor", async () => {
    const fake = fakeCore();
    fake.state.settings = { termsVersion: "2026-10-01" };
    signIn(fake);
    let expectedHash = "";
    const router = new Hono<AppEnv>();
    router.post("/_audit", async (c) => {
      expectedHash = await ipHashDaily(keys(c), "203.0.113.9", dayUTC(new Date()));
      audit(c, "node.trashed", { type: "node", id: "n1" }, { count: 3 });
      fake.calls.push("handler:end");
      return c.json({ requestId: c.get("requestId") });
    });
    const { response, ctx } = await call(appWith(fake, { extraRouters: [router] }), "/api/_audit", {
      method: "POST",
      headers: { ...sameOrigin, "cf-connecting-ip": "203.0.113.9", "user-agent": "vitest" },
    });
    expect(response.status).toBe(200);
    const { requestId } = (await response.json()) as { requestId: string };
    await ctx.settle();
    expect(fake.audits).toEqual([
      {
        action: "node.trashed",
        targetType: "node",
        targetId: "n1",
        meta: { count: 3 },
        actorUserId: "u".repeat(32),
        actorType: "user",
        ipHashDaily: expectedHash,
        ua: "vitest",
        country: null,
        requestId,
      },
    ]);
    expect(fake.audits[0]?.ipHashDaily).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(fake.audits)).not.toContain("203.0.113.9");
    expect(fake.calls.slice(-2)).toEqual(["insertAudit", "close"]);
    expect(fake.calls.indexOf("handler:end")).toBeLessThan(fake.calls.indexOf("insertAudit"));
  });

  it("an impersonated session is recorded as the admin behind it", async () => {
    const fake = fakeCore();
    signIn(fake, {}, { impersonatedBy: "a".repeat(32) });
    const router = new Hono<AppEnv>();
    router.get("/_audit", (c) => {
      audit(c, "admin.viewed", null);
      return c.json({});
    });
    const { response, ctx } = await call(appWith(fake, { extraRouters: [router] }), "/api/_audit");
    await response.text();
    await ctx.settle();
    expect(fake.audits[0]).toMatchObject({
      actorUserId: "a".repeat(32),
      actorType: "admin",
      targetType: null,
    });
  });

  it("from a ServiceDeps (deps(c), a BackgroundContext, a hand-built one): request fields are null", async () => {
    const fake = fakeCore();
    const router = new Hono<AppEnv>();
    router.get("/_audit", (c) => {
      audit(deps(c), "strike.added", { type: "user", id: "u1" }, null, {
        actorUserId: "adm",
        actorType: "admin",
      });
      return c.json({});
    });
    const app = appWith(fake, { extraRouters: [router] });
    const { response, ctx } = await call(app, "/api/_audit");
    await response.text();
    await ctx.settle();

    await runBackground(
      testEnv(),
      fakeCtx(),
      async (bg) => audit(bg, "job.ran", null, { name: "purge" }),
      fake.core,
    );

    // What a hook builds for itself: it collects its own deferred work and drains it.
    const local: Promise<unknown>[] = [];
    const handle = fake.core.createDb(testEnv());
    const own: ServiceDeps = { db: handle.db, env: testEnv(), defer: (p) => void local.push(p) };
    audit(own, "account.deletion_scheduled", { type: "user", id: "u2" });
    expect(local).toHaveLength(1);
    await Promise.all(local);

    const requestless = { ipHashDaily: null, ua: null, country: null, requestId: null };
    expect(fake.audits).toEqual([
      {
        action: "strike.added",
        targetType: "user",
        targetId: "u1",
        meta: null,
        actorUserId: "adm",
        actorType: "admin",
        ...requestless,
      },
      {
        action: "job.ran",
        targetType: null,
        targetId: null,
        meta: { name: "purge" },
        actorUserId: null,
        actorType: "system",
        ...requestless,
      },
      {
        action: "account.deletion_scheduled",
        targetType: "user",
        targetId: "u2",
        meta: null,
        actorUserId: null,
        actorType: "system",
        ...requestless,
      },
    ]);
  });

  it("a failed insert is swallowed, and the pool still closes", async () => {
    const fake = fakeCore();
    fake.core.insertAudit = async () => {
      await sleep(1);
      throw new Error("insert failed");
    };
    const router = new Hono<AppEnv>();
    router.get("/_audit", (c) => {
      audit(deps(c), "x", null);
      return c.json({});
    });
    const { response, ctx } = await call(appWith(fake, { extraRouters: [router] }), "/api/_audit");
    expect(response.status).toBe(200);
    await response.text();
    await ctx.settle();
    expect(fake.calls.at(-1)).toBe("close");
  });
});

describe("Sentry redaction", () => {
  it("replaces what follows a token-bearing path segment", () => {
    expect(redactUrl("https://holdfastusercontent.com/d/0199c6f0-aaaa/eyJhbGciOi.sig?x=1")).toBe(
      "https://holdfastusercontent.com/d/[redacted]?x=1",
    );
    expect(redactUrl("/i/node/tok")).toBe("/i/[redacted]");
    expect(redactUrl("/t/node/256/tok")).toBe("/t/[redacted]");
    expect(redactUrl("https://app.example/s/AbCdEfGhIjKlMnOp#frag")).toBe(
      "https://app.example/s/[redacted]#frag",
    );
    expect(redactUrl("/api/public/links/AbCdEfGhIjKlMnOp/files")).toBe("/api/public/links/[redacted]");
    expect(redactUrl("/api/invites/CODE-123")).toBe("/api/invites/[redacted]");
    expect(redactUrl("/invite/CODE-123")).toBe("/invite/[redacted]");
  });

  it("leaves ordinary paths alone", () => {
    for (const url of [
      "/api/nodes/0199c6f0/links",
      "/assets/index-abc.js",
      "/files/folder/sub",
      "/api/health",
      "/settings",
    ]) {
      expect(redactUrl(url)).toBe(url);
    }
  });

  it("drops token, code and password query values", () => {
    expect(redactUrl("/api/auth/delete-user/callback?token=SECRET&callbackURL=/x")).toBe(
      "/api/auth/delete-user/callback?token=[redacted]&callbackURL=/x",
    );
    expect(redactUrl("/cb?state=1&code=4/0AbC&password=hunter2")).toBe(
      "/cb?state=1&code=[redacted]&password=[redacted]",
    );
    expect(redactUrl("token=abc&x=1")).toBe("token=[redacted]&x=1");
    expect(redactUrl("/x?barcode=1")).toBe("/x?barcode=1");
  });

  it("replaces email addresses in text", () => {
    expect(redactText("user Alice.Smith+tag@example.co.uk could not sign in")).toBe(
      "user [email] could not sign in",
    );
  });

  it("redacts a whole event: URL, query string, headers, cookies, body fields, breadcrumbs, messages", () => {
    const event = {
      message: "download failed for bob@example.test at /d/node1/tok123",
      request: {
        url: "https://files.example/d/node1/tok123",
        query_string: "token=abc&x=1",
        headers: {
          Cookie: "__Secure-hf.session_token=abc",
          authorization: "Bearer abc",
          "X-Captcha-Response": "turnstile-token",
          "user-agent": "Mozilla",
        },
        cookies: { "hf.session_token": "abc" },
        data: { email: "bob@example.test", password: "hunter2", newPassword: "hunter3", name: "Bob" },
      },
      breadcrumbs: [
        { category: "fetch", data: { url: "/api/public/links/AbCdEfGhIjKlMnOp", status_code: 200 } },
      ],
      exception: {
        values: [{ type: "Error", value: "invite /invite/CODE-1 rejected for eve@example.test" }],
      },
      tags: { requestId: "r-1" },
      timestamp: 1,
    };
    const frozen = JSON.stringify(event);
    const out = redactEvent(event);
    expect(JSON.stringify(event)).toBe(frozen);
    expect(out).toEqual({
      message: "download failed for [email] at /d/[redacted]",
      request: {
        url: "https://files.example/d/[redacted]",
        query_string: "token=[redacted]&x=1",
        headers: { "user-agent": "Mozilla" },
        cookies: "[redacted]",
        data: { email: "[email]", password: "[redacted]", newPassword: "[redacted]", name: "Bob" },
      },
      breadcrumbs: [{ category: "fetch", data: { url: "/api/public/links/[redacted]", status_code: 200 } }],
      exception: { values: [{ type: "Error", value: "invite /invite/[redacted] rejected for [email]" }] },
      tags: { requestId: "r-1" },
      timestamp: 1,
    });
    const text = JSON.stringify(out);
    for (const leak of [
      "tok123",
      "hunter",
      "session_token",
      "Bearer",
      "turnstile-token",
      "bob@",
      "eve@",
      "CODE-1",
      "AbCdEf",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  it("the Worker's Sentry options run every event and breadcrumb through it, and are off without a DSN", () => {
    expect(sentryOptions({ SENTRY_DSN: "", SENTRY_ENVIRONMENT: "test" })).toBeUndefined();
    const options = sentryOptions({
      SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/1",
      SENTRY_ENVIRONMENT: "dev",
    });
    expect(options).toMatchObject({ environment: "dev", tracesSampleRate: 0 });
    type Hook = (value: unknown, hint: unknown) => unknown;
    const send = options?.beforeSend as unknown as Hook;
    const crumb = options?.beforeBreadcrumb as unknown as Hook;
    expect(send({ request: { url: "/s/AbCdEfGhIjKlMnOp", headers: { cookie: "a=b" } } }, {})).toEqual({
      request: { url: "/s/[redacted]", headers: {} },
    });
    expect(crumb({ data: { url: "/d/a/b?token=x" } }, {})).toEqual({
      data: { url: "/d/[redacted]?token=[redacted]" },
    });
  });
});
