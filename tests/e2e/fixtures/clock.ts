// One moved clock for both sides of a test: the browser's (Playwright's `page.clock`) and the
// Worker's (`X-Holdfast-Test-Now`, src/worker/services/clock.ts — honoured only in test mode: the
// memory mail transport, outside production, on a plain-http origin; a deploy ignores it).
//
//   const clock = await testClock(page, new Date(Date.now() + 60 * 60_000));
//   await clock.advance(60_000);                       // a quiet minute, on both sides
//   await page.request.get("/api/…", { headers: clock.headers() });   // API calls: pass it yourself
//
// The browser's requests to the app and files origins carry the header from here on (a route on
// the page's context — `fallback`, so a spec's own routes and the `clientIp` address still apply).
// SQL `now()` is not moved: a test moves time only around its own rows (PLAN §6 rule 16).
import type { Page } from "@playwright/test";
import { appOrigin, e2ePort, filesOrigin } from "../../setup/local-env";
import { remoteMode } from "./remote";

/** src/worker/services/clock.ts `TEST_NOW_HEADER`. */
export const TEST_NOW_HEADER = "x-holdfast-test-now";

export interface TestClock {
  /** What both clocks read now. */
  now(): Date;
  /** Both clocks jump to `at` (the browser's timers then run from there). */
  set(at: Date): Promise<void>;
  /** Both clocks move on by `ms`, the browser's timers firing on the way. */
  advance(ms: number): Promise<void>;
  /** The header for a request made outside the page (`page.request`, an API context). */
  headers(): Record<string, string>;
}

export async function testClock(page: Page, start: Date): Promise<TestClock> {
  // A deploy ignores the header (not test mode), so a moved clock there would move only the
  // browser's — a test would compare a moved page with an unmoved Worker (review m7).
  if (remoteMode() !== null) throw new Error("testClock: a remote run cannot move the Worker's clock");
  let current = new Date(start.getTime());
  await page.clock.install({ time: current });
  const port = e2ePort();
  for (const origin of [appOrigin(port), filesOrigin(port)]) {
    await page.context().route(`${origin}/**`, (route) =>
      route.fallback({
        headers: { ...route.request().headers(), [TEST_NOW_HEADER]: current.toISOString() },
      }),
    );
  }
  return {
    now: () => new Date(current.getTime()),
    async set(at) {
      current = new Date(at.getTime());
      await page.clock.setSystemTime(current);
    },
    async advance(ms) {
      current = new Date(current.getTime() + ms);
      await page.clock.runFor(ms);
    },
    headers: () => ({ [TEST_NOW_HEADER]: current.toISOString() }),
  };
}
