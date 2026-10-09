// The one server-side clock. Code that compares a stored timestamp IN APPLICATION CODE calls
// `now(c)`; SQL `now()` is not affected, so a helper that needs an overridable time takes a Date.
//
// Test override: in test mode only, the request header `X-Holdfast-Test-Now: <ISO-8601>` sets
// what `now(c)` returns for that request. Test mode is EMAIL_TRANSPORT=memory outside production
// (the same gate as the test outbox). Everywhere else the header is ignored.
// Background code (queue, cron) has no request and always gets real time.

import type { Context } from "hono";
import type { AppEnv } from "./request-context";

export const TEST_NOW_HEADER = "x-holdfast-test-now";

type ModeEnv = { EMAIL_TRANSPORT?: string; SENTRY_ENVIRONMENT?: string };

/** True only under the in-memory mail transport outside production. Gates every test-only seam. */
export function isTestMode(env: ModeEnv): boolean {
  return env.EMAIL_TRANSPORT === "memory" && env.SENTRY_ENVIRONMENT !== "production";
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
