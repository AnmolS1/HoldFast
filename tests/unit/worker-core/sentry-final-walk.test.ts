// The redaction that counts is the LAST one: `beforeSend` / `beforeBreadcrumb` walk the fully
// assembled event. By then the SDK has copied one value into several fields, so no earlier,
// per-helper redaction can be what keeps a secret in.
//
// Two halves:
//  1. a corpus — sentinels planted in every string-bearing field of an event (the fields of
//     @sentry/core 11.5.0's `Event`, `RequestEventData`, `Breadcrumb`, `Exception`, `StackFrame`,
//     `User`: build/types/types/{event,request,breadcrumb,exception,stackframe,user}.d.ts) —
//     through `redactEvent`: nothing survives, and redacting twice equals redacting once;
//  2. the real SDK (a `CloudflareClient` with a recording transport) fed by each producer the
//     Worker has — the app's error handler, the auth layer's `reportError`, a raw
//     `captureException` as library code would call it, a breadcrumb for a fetch to an auth URL —
//     and what reaches the TRANSPORT is searched.
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REDACTION_FAILED, redactEvent, redactText } from "../../../src/shared/sentry-redact";
import { reportError } from "../../../src/worker/auth/observe";
import { sentryOptions } from "../../../src/worker/sentry";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { appWith, call, fakeCore } from "./helpers";

// Every sentinel has a shape a scan can see: that is the claim under test. (A short word with no
// shape — a first name in a sentence — is not something any scan can find; such values arrive
// inside objects under keys, or in a URL's query, and those are dropped whole.)
const TOKEN = "SENTINELtok3nAbCdEfGhIjKlMnOpQrStUvWx";
const EMAIL = "sentinel.person@sentinel-mail.example";
const VERIFY_URL = `https://app.sentinel.example/api/auth/verify-email?token=${TOKEN}&callbackURL=%2F`;
const CALLBACK_URL = `https://app.sentinel.example/api/auth/callback/google?code=SENTINELcode&state=SENTINELstate`;
const RESET_URL = `https://app.sentinel.example/api/auth/reset-password/${TOKEN}?callbackURL=/x`;
const RELATIVE = `/login?error=denied&error_description=SENTINELdescription&state=SENTINELstate`;
const COOKIE = `__Secure-hf.session_token=${TOKEN}.SENTINELsig; hf_pending=SENTINELpending`;
const IP = "203.0.113.77";
const CODE = "48151623";

// What must not be found afterwards. Not the URLs' host: in a field that IS a URL the origin and
// the (scanned) path are kept on purpose — the secret of a link is its token, not its site.
const NEEDLES = ["SENTINEL", "sentinel.person", "sentinel-mail", IP, CODE] as const;

const SECRETS = [TOKEN, EMAIL, VERIFY_URL, CALLBACK_URL, RESET_URL, RELATIVE, COOKIE, IP, CODE] as const;
/** One sentence carrying every secret, as a library's error message might. */
const SENTENCE = `failed for ${EMAIL} from ${IP} at ${VERIFY_URL} then ${CALLBACK_URL} and ${RESET_URL} via ${RELATIVE} cookie ${COOKIE} code ${CODE} token ${TOKEN}`;

function expectClean(value: unknown, where: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const needle of NEEDLES) {
    const at = text.indexOf(needle);
    // On a failure, say WHERE: the text around the first survivor.
    expect(at === -1 ? "" : text.slice(Math.max(0, at - 120), at + 80), `${where}: ${needle}`).toBe("");
  }
}

/** An event with `plant` in every string-bearing field the installed SDK's types have. */
function corpusEvent(plant: string): Record<string, unknown> {
  return {
    event_id: "0123456789abcdef0123456789abcdef",
    timestamp: 1_760_000_000,
    level: "error",
    platform: "javascript",
    release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
    environment: "dev",
    message: plant,
    logentry: { message: plant, params: [plant, 7, { nested: plant }] },
    transaction: `GET ${plant}`,
    fingerprint: ["{{ default }}", plant],
    exception: {
      values: [
        {
          type: "Error",
          value: plant,
          module: plant,
          mechanism: { type: "generic", handled: true, data: { note: plant } },
          stacktrace: {
            frames: [
              {
                filename: "file:///worker/index.js",
                function: "handleError",
                lineno: 10,
                colno: 4,
                in_app: true,
                context_line: `const x = "${plant}";`,
                pre_context: [plant],
                post_context: [plant],
                vars: { local: plant, deep: { more: [plant] } },
              },
            ],
          },
        },
      ],
    },
    threads: { values: [{ name: plant, stacktrace: { frames: [{ vars: { v: plant } }] } }] },
    request: {
      url: plant,
      method: "POST",
      query_string: plant,
      headers: {
        cookie: plant,
        authorization: plant,
        "x-forwarded-for": plant,
        "cf-connecting-ip": plant,
        "user-agent": plant,
        referer: plant,
        "x-anything-else": plant,
      },
      cookies: { "hf.session_token": plant },
      env: { REMOTE_ADDR: plant },
      data: { email: plant, password: plant, name: plant, code: plant, anything: [plant, { again: plant }] },
    },
    breadcrumbs: [
      {
        type: "http",
        category: "fetch",
        message: plant,
        data: { url: plant, method: "GET", "url.query": plant },
      },
      { category: "console", level: "error", message: plant, data: { arguments: [plant, { o: plant }] } },
      { category: "navigation", data: { from: plant, to: plant } },
    ],
    tags: { route: plant, kind: plant, requestId: plant },
    extra: {
      anything: plant,
      nested: { list: [plant], more: { evenMore: plant } },
      [plant]: "a key is text too",
    },
    contexts: {
      trace: { trace_id: plant, span_id: plant, op: plant },
      app: { note: plant },
      [plant]: { x: 1 },
    },
    user: { id: plant, email: plant, username: plant, ip_address: plant, geo: { city: plant } },
    spans: [{ description: plant, op: plant, data: { "http.url": plant, other: plant } }],
    sdkProcessingMetadata: { normalizedRequest: { url: plant, headers: { cookie: plant, other: plant } } },
  };
}

describe("the final walk over a fully assembled event", () => {
  it.each([...SECRETS, SENTENCE].map((secret) => [secret.slice(0, 40), secret]))(
    "nothing of %s survives in any field, as a whole value",
    (_label, secret) => {
      expectClean(redactEvent(corpusEvent(secret)), "whole value");
    },
  );

  it.each([...SECRETS].map((secret) => [secret.slice(0, 40), secret]))(
    "nor of %s inside a sentence, or as a query, in any field",
    (_label, secret) => {
      expectClean(redactEvent(corpusEvent(`could not finish: ${secret} (try again)`)), "in a sentence");
      expectClean(
        redactEvent(corpusEvent(`/somewhere?next=${encodeURIComponent(secret)}&x=1`)),
        "as a query",
      );
    },
  );

  it("is idempotent: redacting twice equals redacting once — for the event and for a string", () => {
    for (const secret of [...SECRETS, SENTENCE, `x ${SENTENCE} `.repeat(40), "", "plain words stay"]) {
      const once = redactEvent(corpusEvent(secret));
      expect(redactEvent(once), secret.slice(0, 30)).toEqual(once);
      expect(redactText(redactText(secret))).toBe(redactText(secret));
    }
  });

  it("is order-independent: an early redaction of one copy changes nothing about the result", () => {
    // What a helper does first (scan the message, or a URL) and what the walk does last commute.
    const raw = corpusEvent(SENTENCE);
    const early = {
      ...corpusEvent(SENTENCE),
      message: redactText(SENTENCE),
      transaction: `GET ${redactText(SENTENCE)}`,
    };
    expect(redactEvent(early)).toEqual(redactEvent(raw));
  });

  it("keeps what makes an event usable: ids in their own shape, the release, code positions, a URL's path", () => {
    const out = redactEvent({
      event_id: "0123456789abcdef0123456789abcdef",
      release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
      environment: "dev",
      tags: { requestId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e", route: "/api/nodes/:id", kind: "unhandled" },
      contexts: { trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" } },
      request: { url: "https://holdfast.example/api/nodes/folder?x=1", method: "POST" },
      exception: {
        values: [
          {
            type: "QueryFailedError",
            value: "INVALID_EMAIL_OR_PASSWORD",
            stacktrace: {
              frames: [
                {
                  filename: "file:///worker/assets/index-AbCdEf12.js",
                  function: "handleError",
                  lineno: 3,
                },
              ],
            },
          },
        ],
      },
    });
    expect(out).toEqual({
      event_id: "0123456789abcdef0123456789abcdef",
      release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
      environment: "dev",
      tags: { requestId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e", route: "/api/nodes/:id", kind: "unhandled" },
      contexts: { trace: { trace_id: "0123456789abcdef0123456789abcdef", span_id: "0123456789abcdef" } },
      request: { url: "https://holdfast.example/api/nodes/folder", method: "POST" },
      exception: {
        values: [
          {
            type: "QueryFailedError",
            value: "INVALID_EMAIL_OR_PASSWORD",
            stacktrace: {
              frames: [
                {
                  filename: "file:///worker/assets/index-AbCdEf12.js",
                  function: "handleError",
                  lineno: 3,
                },
              ],
            },
          },
        ],
      },
    });
  });

  it("an exemption holds only where the SDK puts the field, and an id only in its own shape", () => {
    // The same key names inside request data, extras, tags and breadcrumbs are scanned as text.
    const out = redactEvent({
      request: {
        data: { release: TOKEN, function: TOKEN, sdk: { name: TOKEN }, frames: [{ function: TOKEN }] },
      },
      extra: { release: TOKEN, exception: { values: [{ stacktrace: { frames: [{ module: TOKEN }] } }] } },
      tags: { requestId: TOKEN, environment: TOKEN },
      breadcrumbs: [{ data: { platform: TOKEN, debug_id: TOKEN } }],
      event_id: TOKEN,
      // Hex-like, but not the id's shape (one character short, one too long): scanned as text.
      contexts: {
        trace: { trace_id: "0123456789abcdef0123456789abcde", span_id: `${TOKEN}0123456789abcdef` },
      },
    });
    expectClean(out, "exempt names elsewhere");
    expect(JSON.stringify(out)).not.toContain("0123456789abcdef0123456789abcde");
  });

  it("is cycle-safe, and never opens what is not data: an Error, a Map, a Date, a function, a getter", () => {
    const cyclic: Record<string, unknown> = { note: TOKEN };
    cyclic.self = cyclic;
    const withGetter = {};
    Object.defineProperty(withGetter, "trap", {
      enumerable: true,
      get() {
        throw new Error(TOKEN);
      },
    });
    const out = redactEvent({
      extra: {
        cyclic,
        withGetter,
        error: Object.assign(new Error(TOKEN), { detail: TOKEN }),
        map: new Map([[TOKEN, TOKEN]]),
        date: new Date(0),
        bytes: new Uint8Array(4),
        instance: new (class Custom {
          secret = TOKEN;
          toJSON() {
            return TOKEN;
          }
        })(),
        fn: () => TOKEN,
        big: `${"word ".repeat(2000)}${TOKEN}`,
        count: 10n,
      },
    }) as { extra: Record<string, unknown> };
    expectClean(out, "not data");
    expect(out.extra).toMatchObject({
      cyclic: { note: "[token]", self: "[cycle]" },
      withGetter: { trap: "[getter]" },
      error: "[Error]",
      map: "[Map]",
      date: "[Date]",
      bytes: "[bytes]",
      instance: "[object]",
      count: "[bigint]",
    });
    expect("fn" in out.extra && out.extra.fn).toBeFalsy();
    expect((out.extra.big as string).length).toBeLessThanOrEqual(1001);
    expect(redactEvent(out)).toEqual(out);
  });

  it("past a bound it FAILS CLOSED: the marker event, built from nothing of the payload, and the failure is counted", () => {
    let deep: Record<string, unknown> = { leaf: TOKEN };
    for (let i = 0; i < 40; i++) deep = { next: deep };
    const safe = {
      release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
      environment: "dev",
      tags: { requestId: "0199c6f0-7b1e-7c3a-9d2e-4f5a6b7c8d9e", route: TOKEN },
      message: SENTENCE,
    };
    const tooBig: Array<[string, Record<string, unknown>]> = [
      ["depth", { ...safe, extra: { deep } }],
      [
        "keys",
        { ...safe, extra: Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [`k${i}`, TOKEN])) },
      ],
      ["array", { ...safe, extra: { list: Array.from({ length: 5000 }, () => TOKEN) } }],
      [
        "values",
        {
          ...safe,
          extra: { grid: Array.from({ length: 400 }, () => Array.from({ length: 400 }, () => TOKEN)) },
        },
      ],
    ];
    for (const [what, event] of tooBig) {
      const counted: string[] = [];
      const out = redactEvent(event, (kind) => counted.push(kind));
      expect(out, what).toEqual({
        message: REDACTION_FAILED,
        level: "error",
        release: safe.release,
        environment: "dev",
        tags: { requestId: safe.tags.requestId },
      });
      expect(counted, what).toEqual(["event"]);
      expect(redactEvent(out), `${what}: the marker is itself a fixed point`).toEqual(out);
    }
    // The marker takes a field only in exactly its own shape — never "whatever was there".
    const hostile = redactEvent({
      release: SENTENCE,
      environment: VERIFY_URL,
      tags: { requestId: TOKEN },
      extra: { deep },
    });
    expect(hostile).toEqual({ message: REDACTION_FAILED, level: "error" });
    // A counter that throws does not turn the failure into an exception or a raw event.
    expect(
      redactEvent({ extra: { deep } }, () => {
        throw new Error("the metric is down");
      }),
    ).toEqual({ message: REDACTION_FAILED, level: "error" });
  });
});

// ── the real SDK: what reaches the transport ─────────────────────────────────────────────────

type Hooks = Pick<
  NonNullable<ReturnType<typeof sentryOptions>>,
  "beforeSend" | "beforeSendTransaction" | "beforeBreadcrumb"
>;

const sent: string[] = [];

function startClient(hooks: Hooks): Sentry.CloudflareClient {
  const client = new Sentry.CloudflareClient({
    dsn: "https://publickey@o1.ingest.sentry.example.test/1",
    environment: "test",
    release: "03e19b8f6c1d4e5a9b7c2d3e4f5a6b7c8d9e0f1a",
    tracesSampleRate: 0,
    stackParser: () => [],
    // The integrations that COPY data into an event: linked errors (an error's `cause` becomes a
    // second exception value), request data (the scope's request becomes `event.request`), and
    // extra error data (an error's own fields become `contexts`/`extra`) — the last is not a
    // default, and is here because it is the worst case for a differential.
    integrations: [
      Sentry.linkedErrorsIntegration(),
      Sentry.requestDataIntegration(),
      Sentry.extraErrorDataIntegration({ depth: 5 }),
    ],
    transport: () =>
      Sentry.createTransport({ recordDroppedEvent: () => {} }, async (request) => {
        sent.push(typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body));
        return { statusCode: 200 };
      }),
    ...hooks,
  } as ConstructorParameters<typeof Sentry.CloudflareClient>[0]);
  Sentry.setCurrentClient(client);
  client.init();
  return client;
}

/** A library-style error: secrets in its message, its cause and its own fields. */
function hostileError(): Error {
  const error = new Error(`Failed query: select 1\nparams: Sentinel,${EMAIL},${TOKEN}`, {
    cause: new Error(SENTENCE),
  });
  Object.assign(error, {
    detail: SENTENCE,
    parameters: [EMAIL, TOKEN],
    response: { url: VERIFY_URL, headers: { "set-cookie": COOKIE } },
    request: { url: CALLBACK_URL, headers: { cookie: COOKIE } },
  });
  return error;
}

const requestOnScope = {
  url: CALLBACK_URL,
  method: "GET",
  query_string: "code=SENTINELcode&state=SENTINELstate",
  headers: {
    cookie: COOKIE,
    "cf-connecting-ip": IP,
    "user-agent": "Mozilla/5.0 SENTINELagent",
    referer: VERIFY_URL,
  },
  cookies: { "hf.session_token": TOKEN },
  data: { email: EMAIL, password: TOKEN, code: CODE },
};

/** The four producers, each run inside its own scope. Returns how many events they made. */
async function runProducers(client: Sentry.CloudflareClient): Promise<number> {
  // 1. The app's error handler (services/errors.ts → captureError), on a request scope the SDK
  //    has put the request on, as its request wrapper does.
  await Sentry.withIsolationScope(async (scope) => {
    scope.setSDKProcessingMetadata({ normalizedRequest: requestOnScope });
    const router = new Hono<AppEnv>();
    router.get("/nodes/boom", () => {
      throw hostileError();
    });
    const { ctx } = await call(appWith(fakeCore(), { extraRouters: [router] }), "/api/nodes/boom");
    await ctx.settle();
  });
  // 2. The auth layer's own exit.
  await Sentry.withIsolationScope(async (scope) => {
    scope.setSDKProcessingMetadata({ normalizedRequest: requestOnScope });
    reportError(hostileError(), { kind: "auth_handler" });
  });
  // 3. Library code calling the SDK directly, with everything a scope can carry.
  await Sentry.withIsolationScope(async (scope) => {
    scope.setSDKProcessingMetadata({ normalizedRequest: requestOnScope });
    scope.setTag("where", SENTENCE);
    scope.setExtra("context", { url: VERIFY_URL, note: SENTENCE });
    scope.setUser({ id: TOKEN, email: EMAIL, ip_address: IP, username: EMAIL });
    // Better Auth's `state` is 32 random characters: it has a shape. (A short, shapeless value
    // under an arbitrary key is beyond any scan; in a URL's query it goes with the query.)
    scope.setContext("oauth", { callback: CALLBACK_URL, state: TOKEN });
    scope.setTransactionName(`GET ${RESET_URL}`);
    scope.setFingerprint([RESET_URL, EMAIL]);
    Sentry.captureException(hostileError());
  });
  // 4. A breadcrumb for a fetch to an auth URL, a console breadcrumb, then a message.
  await Sentry.withIsolationScope(async () => {
    Sentry.addBreadcrumb({
      type: "http",
      category: "fetch",
      data: { url: CALLBACK_URL, method: "GET", status_code: 302 },
    });
    Sentry.addBreadcrumb({
      category: "console",
      level: "error",
      message: SENTENCE,
      data: { arguments: [SENTENCE, VERIFY_URL] },
    });
    Sentry.captureMessage(SENTENCE);
  });
  await client.flush(2000);
  return 4;
}

describe("what reaches the transport, whichever helper made the event", () => {
  const previous = Sentry.getClient();
  beforeAll(() => {
    expect(sentryOptions({ SENTRY_DSN: "", SENTRY_ENVIRONMENT: "test" })).toBeUndefined();
  });
  beforeEach(() => {
    sent.length = 0;
  });
  afterAll(() => {
    if (previous) Sentry.setCurrentClient(previous);
  });

  it("with the Worker's own options: four events, and no sentinel in any of them", async () => {
    const options = sentryOptions({
      SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/1",
      SENTRY_ENVIRONMENT: "test",
    })!;
    const client = startClient({
      beforeSend: options.beforeSend,
      beforeSendTransaction: options.beforeSendTransaction,
      beforeBreadcrumb: options.beforeBreadcrumb,
    });
    const produced = await runProducers(client);
    expect(sent).toHaveLength(produced);
    for (const [index, body] of sent.entries()) expectClean(body, `event ${index + 1}`);
    // The events are real ones, with the parts a differential would hide in.
    const all = sent.join("\n");
    expect(all).toContain('"exception"');
    expect(all).toContain('"breadcrumbs"');
    expect(all).toContain('"request"');
    expect(all).toContain("params: [dropped]");
    await client.close(100);
  });

  it("an event the Worker cannot redact: the marker is what is sent, and the failure is a metric", () => {
    const points: Array<{ blobs?: unknown[] }> = [];
    const options = sentryOptions({
      SENTRY_DSN: "https://k@o1.ingest.sentry.example.test/1",
      SENTRY_ENVIRONMENT: "test",
      METRICS: { writeDataPoint: (point: { blobs?: unknown[] }) => void points.push(point) },
    } as unknown as Parameters<typeof sentryOptions>[0])!;
    const tooLong = Array.from({ length: 5000 }, () => SENTENCE);
    const sentInstead = options.beforeSend!({ message: SENTENCE, extra: { tooLong } } as never, {});
    expect(sentInstead).toEqual({ message: REDACTION_FAILED, level: "error" });
    expect(
      options.beforeSendTransaction!({ transaction: SENTENCE, extra: { tooLong } } as never, {}),
    ).toEqual({
      message: REDACTION_FAILED,
      level: "error",
    });
    expect(options.beforeBreadcrumb!({ message: SENTENCE, data: { tooLong } } as never)).toBeNull();
    const counted = points.map((point) =>
      (point.blobs ?? []).filter((blob) => typeof blob === "string" && blob !== ""),
    );
    expect(counted.map((blobs) => blobs.slice(0, 1))).toEqual([["error"], ["error"], ["error"]]);
    expect(counted.map((blobs) => blobs.includes("redaction_failed"))).toEqual([true, true, true]);
    expect(counted.map((blobs) => blobs.filter((blob) => blob === "event" || blob === "breadcrumb"))).toEqual(
      [["event"], ["event"], ["breadcrumb"]],
    );
    expectClean(points, "the metric");
    // An ordinary event writes no such metric.
    points.length = 0;
    options.beforeSend!({ message: "ok" } as never, {});
    expect(points).toEqual([]);
  });

  it("control — without the final walk the same producers leak, although the early redaction is still there", async () => {
    // Identity hooks: `captureError` and the auth layer still sanitise the error they are given
    // (defence in depth). It is not enough: the request the SDK attached, the scope's data, the
    // breadcrumbs and a raw captureException are copies nothing earlier ever saw.
    const client = startClient({
      beforeSend: (event) => event,
      beforeSendTransaction: (event) => event,
      beforeBreadcrumb: (breadcrumb) => breadcrumb,
    });
    await runProducers(client);
    expect(sent).toHaveLength(4);
    const leaks = sent.map((body) => NEEDLES.some((needle) => body.includes(needle)));
    expect(leaks, "every one of the four events leaks without the final walk").toEqual([
      true,
      true,
      true,
      true,
    ]);
    await client.close(100);
  });
});
