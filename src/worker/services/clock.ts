// The one server-side clock. Code that compares a stored timestamp IN APPLICATION CODE calls
// `now(c)`; SQL `now()` is not affected, so a helper that needs an overridable time takes a Date.
//
// Test override: in test mode only, the request header `X-Holdfast-Test-Now: <ISO-8601>` sets
// what `now(c)` returns for that request. Everywhere else the header is ignored.
// Background code (queue, cron) has no request and always gets real time.
//
// TEST MODE is an allow-list of three conditions, all required (the same gate as the test outbox):
//   EMAIL_TRANSPORT is "memory", SENTRY_ENVIRONMENT is not "production", and APP_ORIGIN is a
//   plain-http origin.
// Every deploy is served over https and local development and the tests over http, so the third
// condition is what makes the gate fail CLOSED: one wrong var on a deploy — the memory transport
// left on, a misspelt environment name — does not open the mail outbox or the clock to the
// internet. An absent or unreadable APP_ORIGIN is not test mode.

import type { Context } from "hono";
import type { AppEnv } from "./request-context";

export const TEST_NOW_HEADER = "x-holdfast-test-now";

type ModeEnv = { EMAIL_TRANSPORT?: string; SENTRY_ENVIRONMENT?: string; APP_ORIGIN?: string };

/** True for `http://host[:port]` and nothing else: not https, not scheme-less, not absent. */
function isPlainHttpOrigin(origin: unknown): boolean {
  if (typeof origin !== "string" || !origin.startsWith("http://")) return false;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && url.hostname !== "";
  } catch {
    return false;
  }
}

/** Gates every test-only seam. See the header for the three conditions. */
export function isTestMode(env: ModeEnv): boolean {
  return (
    env.EMAIL_TRANSPORT === "memory" &&
    env.SENTRY_ENVIRONMENT !== "production" &&
    isPlainHttpOrigin(env.APP_ORIGIN)
  );
}

export function now(c?: Context<AppEnv>): Date {
  if (c && isTestMode(c.env)) {
    const header = c.req.header(TEST_NOW_HEADER);
    if (header) {
      const forced = new Date(header);
      if (!Number.isNaN(forced.getTime())) return forced;
    }
  }
  return new Date();
}
