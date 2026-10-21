// The Worker's Sentry wiring, end to end: the options `withSentry` is given (sentry.ts
// `sentryOptions` — DSN, environment, release, `dataCollection`, the three redaction hooks)
// installed by the SDK's own `withSentry` wrapper around the real app, one failing request, and
// what reaches the TRANSPORT. Only the transport is a stand-in (it records instead of sending).
//
// The per-field cases are not repeated here: worker-core/sentry-{final-walk,data-collection,
// redact-*}.test.ts own them. This file asks the one question those leave to the observability
// task — does an event built from a real request through the real wrapper leave without the
// request's token, cookie and email — with a control that the same run, its hooks switched off,
// DOES carry them (so their absence is the redaction's doing, not an empty envelope's).
import * as Sentry from "@sentry/cloudflare";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { buildMeta } from "../../../src/worker/meta";
import { sentryOptions } from "../../../src/worker/sentry";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { ALLOW_ALL, appWith, fakeCore, fakeCtx, testEnv } from "../worker-core/helpers";

// Made up, and each has a shape a scan can see (a 22-character base64url link token, a session
// cookie, an address on a reserved domain).
const TOKEN = "SENTINELq7Wk2pXr9ZbLm4N";
const COOKIE_VALUE = "SENTINELsessionAbCdEfGhIjKlMnOpQr.SENTINELsig";
const EMAIL = "sentinel.owner@sentinel-mail.example";
const NEEDLES = [TOKEN, "SENTINELsession", "SENTINELsig", EMAIL, "sentinel-mail"];

/** A made-up DSN on a reserved domain: nothing is ever sent anywhere — the transport records. */
const FAKE_DSN = "https://publickey@o1.ingest.sentry.example.test/1";

type Hooks = "redacting" | "control";

/** One request to a failing route, through Sentry's own `withSentry`. Returns the envelopes sent. */
async function failingRequest(hooks: Hooks): Promise<string[]> {
  const sent: string[] = [];
  const router = new Hono<AppEnv>();
  // A route under the link prefix whose handler fails with the token and an address in the error.
  router.get("/public/links/:token/boom", (c) => {
    // A breadcrumb as library code would leave one: the address is in it.
    Sentry.addBreadcrumb({ category: "console", level: "warning", message: `notice for ${EMAIL}` });
    throw new Error(`lookup failed for ${c.req.param("token")} owned by ${EMAIL}`);
  });
  const app = appWith(fakeCore(), { extraRouters: [router] });
  const handler = Sentry.withSentry<Env, unknown, unknown, ExportedHandler<Env>>(
    (env) => {
      const options = sentryOptions({ ...env, SENTRY_DSN: FAKE_DSN })!;
      return {
        ...options,
        ...(hooks === "control"
          ? {
              beforeSend: (event) => event,
              beforeSendTransaction: (event) => event,
              beforeBreadcrumb: (breadcrumb) => breadcrumb,
            }
          : {}),
        transport: () =>
          Sentry.createTransport({ recordDroppedEvent: () => {} }, async (request) => {
            sent.push(
              typeof request.body === "string" ? request.body : new TextDecoder().decode(request.body),
            );
            return { statusCode: 200 };
          }),
      } satisfies Sentry.CloudflareOptions;
    },
    { fetch: (request, env, ctx) => app.fetch(request, env, ctx) },
  );
  const ctx = fakeCtx();
  const request = new Request(
    `${TEST_APP_ORIGIN}/api/public/links/${TOKEN}/boom?token=${TOKEN}&to=${EMAIL}`,
    {
      headers: {
        cookie: `__Secure-hf.session_token=${COOKIE_VALUE}`,
        referer: `${TEST_APP_ORIGIN}/s/${TOKEN}`,
        "cf-connecting-ip": "203.0.113.9",
      },
    },
  );
  const response = await handler.fetch!(request as never, testEnv(ALLOW_ALL), ctx);
  expect(response.status).toBe(500);
  await ctx.settle();
  await Sentry.flush(2000);
  // The wrapper keeps ONE client per isolate (@sentry/cloudflare 11.5 clientCache.js, global key
  // `__SENTRY_CLOUDFLARE_CLIENT__`) — so in production the first request's options are the
  // isolate's. The next run here must build its own, with its own transport.
  await Sentry.getClient()?.close(2000);
  delete (globalThis as Record<string, unknown>).__SENTRY_CLOUDFLARE_CLIENT__;
  return sent;
}

describe("a captured Worker event, through sentryOptions and the SDK's own wrapper", () => {
  it("leaves without the request's token, cookie and email; release and environment are set", async () => {
    const sent = await failingRequest("redacting");
    // The event is there: one envelope, an error event, from this app's build and environment.
    const events = sent.filter((body) => body.includes('"type":"event"'));
    expect(events).toHaveLength(1);
    const body = events[0]!;
    expect(body).toContain(`"release":"${buildMeta().commit}"`);
    expect(body).toContain('"environment":"test"');
    expect(body).toContain("lookup failed for");
    // Nothing of the three secrets, in any field the SDK copied them into.
    for (const needle of NEEDLES) expect(body, needle).not.toContain(needle);
    // Tracing is off (R-3): no transaction envelope was made at all.
    expect(sent.some((item) => item.includes('"type":"transaction"'))).toBe(false);
  });

  it("CONTROL: the same request with the hooks switched off carries the token and the email", async () => {
    const sent = await failingRequest("control");
    const all = sent.join("\n");
    // The URL's path copy (the query is never collected) and the breadcrumb. The error's own
    // message is scanned before it is captured (captureError → safeError), so it is not a copy.
    expect(all).toContain(`/api/public/links/${TOKEN}/boom`);
    expect(all).toContain(`notice for ${EMAIL}`);
  });
});
