// What the Worker's Sentry SDK COLLECTS — before any redaction is asked to clean it up.
//
// @sentry/cloudflare 11.5 collects by default (@sentry/core
// build/esm/utils/data-collection/resolveDataCollectionOptions.js: `DEFAULTS`): up to 10 KB of
// every non-GET request body (cloudflare build/esm/prod/integrations/httpServer.js →
// `captureIncomingRequestBody`, read BEFORE the handler runs), every cookie, every request
// header, the query string and the client address. A sign-up body is a password, a name and a
// birth date; redaction cannot be what keeps those in — a name has no shape.
//
// So the Worker switches collection OFF (src/worker/sentry.ts `dataCollection`), and this file
// proves it against the REAL SDK: the real `Sentry.withSentry` wrapper around a handler, the
// Worker's own options, and a transport that records what would have been sent. Each capture
// path is exercised with a sign-up, a sign-in and a reset request:
//   - an error thrown out of the handler (the SDK's automatic capture),
//   - `captureError` (the Worker's one explicit exit),
//   - an error thrown in a route of the real app (the app's error handler),
//   - an event that carries a `fetch` breadcrumb.
// The control at the end runs the same requests with the SDK's defaults and no redaction, and
// must find the body in the event — so a pass above is known to be a pass of the options.
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { redactEvent } from "../../../src/shared/sentry-redact";
import { captureError, sentryOptions } from "../../../src/worker/sentry";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { ALLOW_ALL, appWith, fakeCore, fakeCtx, sameOrigin, testEnv } from "./helpers";

const DSN = "https://publickey@o1.ingest.sentry.example.test/1";

// Nothing below has a shape a scan would reliably catch on its own — that is the point.
const NAME = "Jane Zzyzxname";
const BIRTH_YEAR = 1987;
const PASSWORD_HEAD = "correct";
const PASSWORD_TAIL = "battery zzstaple";
const PASSWORD = `${PASSWORD_HEAD} "horse" ${PASSWORD_TAIL}`;
const SESSION_COOKIE = "zzcookievalue.zzsig";
const BEARER = "zzbearervalue";
const CAPTCHA = "zzcaptchavalue";
const CLIENT_IP = "203.0.113.94";
const RESET_TOKEN = "zzresettoken";

const NEEDLES = [
  NAME,
  "Zzyzxname",
  String(BIRTH_YEAR),
  PASSWORD_TAIL,
  "zzstaple",
  "horse",
  SESSION_COOKIE,
  "zzcookievalue",
  BEARER,
  CAPTCHA,
  CLIENT_IP,
  RESET_TOKEN,
  "jane.zz@mail.example",
] as const;

const HEADERS = {
  ...sameOrigin,
  cookie: `hf.session_token=${SESSION_COOKIE}; other=zzcookievalue2`,
  authorization: `Bearer ${BEARER}`,
  "x-captcha-response": CAPTCHA,
  "cf-connecting-ip": CLIENT_IP,
  "user-agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/141.0 Safari/537.36",
};

type Probe = { name: string; path: string; contentType: string; body: string };

const REQUESTS: Probe[] = [
  {
    name: "sign-up",
    path: "/api/auth/sign-up/email?invite=zzresettoken",
    contentType: "application/json",
    body: JSON.stringify({
      email: "jane.zz@mail.example",
      name: NAME,
      password: PASSWORD,
      birthYear: BIRTH_YEAR,
      birthMonth: 5,
      acceptTerms: true,
    }),
  },
  {
    name: "sign-in",
    path: "/api/auth/sign-in/email",
    contentType: "application/json",
    body: JSON.stringify({ email: "jane.zz@mail.example", password: PASSWORD }),
  },
  {
    name: "reset (form body)",
    path: "/api/auth/reset-password",
    contentType: "application/x-www-form-urlencoded",
    body: `newPassword=${encodeURIComponent(PASSWORD)}&token=${RESET_TOKEN}`,
  },
];

const sent: string[] = [];
const transport = () =>
  Sentry.createTransport({ recordDroppedEvent: () => {} }, async (request) => {
    sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
    return { statusCode: 200 };
  });

type Options = NonNullable<ReturnType<typeof sentryOptions>>;

/** The Worker's own options (what a deploy runs with), plus the recorder. */
function ownOptions(): Options {
  const options = sentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "test" })!;
  return { ...options, transport, cacheClient: false };
}

/** The SDK as it comes: default collection, and nothing redacted. */
function defaultOptions(): Options {
  return {
    dsn: DSN,
    environment: "test",
    tracesSampleRate: 0,
    transport,
    cacheClient: false,
    beforeSend: (event) => event,
    beforeBreadcrumb: (breadcrumb) => breadcrumb,
  };
}

type Producer = "thrown" | "captureError" | "route" | "breadcrumb";

/** A Worker handler that fails in the given way, wrapped by the real SDK. */
function worker(options: () => Options, producer: Producer): ExportedHandler<Env> {
  const boom = new Hono<AppEnv>();
  boom.all("/probe/boom", () => {
    throw new Error("the route failed");
  });
  const app = appWith(fakeCore(), { extraRouters: [boom] });
  return Sentry.withSentry<Env, unknown, unknown, ExportedHandler<Env>>(() => options(), {
    async fetch(request, env, ctx) {
      switch (producer) {
        case "thrown":
          throw new Error("the handler failed");
        case "captureError":
          captureError(new Error("reported by hand"), { kind: "probe" });
          return new Response("failed", { status: 500 });
        case "route":
          // Same method, headers and body, at a path the app has a (failing) route for.
          return app.fetch(new Request(`${TEST_APP_ORIGIN}/api/probe/boom`, request), env, ctx);
        case "breadcrumb":
          await fetch("https://api.pwnedpasswords.com/range/ABCDE");
          captureError(new Error("after an outbound call"), { kind: "probe" });
          return new Response("failed", { status: 500 });
      }
    },
  });
}

async function run(handler: ExportedHandler<Env>, probe: Probe): Promise<void> {
  const ctx = fakeCtx();
  const request = new Request(`${TEST_APP_ORIGIN}${probe.path}`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": probe.contentType },
    body: probe.body,
  });
  try {
    await handler.fetch!(request as never, testEnv({ ...ALLOW_ALL, SENTRY_DSN: DSN }), ctx);
  } catch {
    // "thrown": the wrapper captures and rethrows.
  }
  await ctx.settle();
}

/** The event items of everything the transport was handed. */
function events(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const envelope of sent) {
    const lines = envelope.split("\n").filter((line) => line !== "");
    for (let index = 1; index + 1 < lines.length; index += 2) {
      const header = JSON.parse(lines[index]!) as { type?: string };
      if (header.type === "event") out.push(JSON.parse(lines[index + 1]!) as Record<string, unknown>);
    }
  }
  return out;
}

const realFetch = globalThis.fetch;

describe("what the Worker's Sentry SDK collects from a request", () => {
  beforeAll(() => {
    // Before the SDK first instruments `fetch`: the outbound call of the breadcrumb producer.
    vi.stubGlobal("fetch", async () => new Response("0000:1\r\n", { status: 200 }));
  });
  afterAll(() => {
    vi.stubGlobal("fetch", realFetch);
  });
  beforeEach(() => {
    sent.length = 0;
  });

  it("the options switch every category of collected request data off, by its installed name", () => {
    const options = sentryOptions({ SENTRY_DSN: DSN, SENTRY_ENVIRONMENT: "test" })!;
    expect(options.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
    // And the SDK resolves them as written (a renamed option would silently fall back to "on").
    const client = new Sentry.CloudflareClient({
      ...options,
      transport,
      integrations: [],
      stackParser: () => [],
    } as ConstructorParameters<typeof Sentry.CloudflareClient>[0]);
    expect(client.getDataCollectionOptions()).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    });
  });

  describe.each(["thrown", "captureError", "route", "breadcrumb"] as const)(
    "capture path: %s",
    (producer) => {
      it.each(REQUESTS.map((probe) => [probe.name, probe] as const))(
        "%s — no body, cookie, header, query or address reaches the event",
        async (_name, probe) => {
          await run(worker(ownOptions, producer), probe);
          const captured = events();
          expect(captured.length, "the capture path produced an event").toBeGreaterThan(0);
          for (const event of captured) {
            const request = (event.request ?? {}) as Record<string, unknown>;
            expect(request, "request.data").not.toHaveProperty("data");
            expect(request, "request.cookies").not.toHaveProperty("cookies");
            expect(request, "request.headers").not.toHaveProperty("headers");
            expect(request, "request.query_string").not.toHaveProperty("query_string");
            expect((event.user ?? {}) as Record<string, unknown>).not.toHaveProperty("ip_address");
          }
          const wire = sent.join("\n");
          for (const needle of NEEDLES) {
            const at = wire.indexOf(needle);
            expect(at === -1 ? "" : wire.slice(Math.max(0, at - 100), at + 60), needle).toBe("");
          }
          if (producer === "breadcrumb") {
            const crumbs = captured.flatMap((event) => (event.breadcrumbs as unknown[] | undefined) ?? []);
            expect(JSON.stringify(crumbs)).toContain("api.pwnedpasswords.com");
          }
        },
      );
    },
  );

  it("the final walk replaces a request body whole, should anything ever attach one", () => {
    for (const probe of REQUESTS) {
      const out = redactEvent({
        request: { url: `${TEST_APP_ORIGIN}${probe.path}`, method: "POST", data: probe.body },
        extra: { normalizedRequest: { data: probe.body } },
      }) as { request: Record<string, unknown>; extra: { normalizedRequest: unknown } };
      expect(out.request.data).toBe("[redacted]");
      expect(out.extra.normalizedRequest).toEqual({ data: "[redacted]" });
      const text = JSON.stringify(out);
      for (const needle of NEEDLES) expect(text, `${probe.name}: ${needle}`).not.toContain(needle);
    }
    // A parsed body, cookies and a span's copy of the body go the same way.
    const out = redactEvent({
      request: { data: { name: NAME, birthYear: BIRTH_YEAR }, cookies: { theme: NAME } },
      spans: [{ data: { "http.request.body.data": `{"name":"${NAME}"}`, "http.request.body.size": 42 } }],
    });
    expect(out).toEqual({
      request: { data: "[redacted]", cookies: "[redacted]" },
      spans: [{ data: { "http.request.body.data": "[redacted]", "http.request.body.size": 42 } }],
    });
  });

  it("control — with the SDK's defaults and no redaction, the same request puts its body in the event", async () => {
    await run(worker(defaultOptions, "thrown"), REQUESTS[0]!);
    const captured = events();
    expect(captured.length).toBeGreaterThan(0);
    const request = captured[0]!.request as Record<string, unknown>;
    expect(typeof request.data).toBe("string");
    expect(String(request.data)).toContain(NAME);
    expect(String(request.data)).toContain(PASSWORD_TAIL);
    // (The SDK masks the values of `authorization` and `cookie` by name even by default; the
    // rest of the headers, the other cookies and the client address go as they are.)
    expect(JSON.stringify(request.headers)).toContain(CAPTCHA);
    expect(JSON.stringify(request.headers)).toContain(CLIENT_IP);
    expect(JSON.stringify(request.cookies)).toContain("zzcookievalue2");
    expect(String(request.query_string)).toContain(RESET_TOKEN);
  });
});
