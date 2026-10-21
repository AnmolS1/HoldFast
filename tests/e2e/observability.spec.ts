// Browser error reporting on a public link page (`/s/<token>`): what leaves for Sentry carries no
// link token. MOCKED (the SPA against the contract; nothing under /api reaches a server).
//
// NOTHING REACHES SENTRY. The public config is mocked with a made-up DSN on Sentry's ingest
// domain, and EVERY request to a `*.sentry.io` host is answered here (`route.fulfill`, never
// `continue`) — the dev deploy's real DSN (wrangler.jsonc SENTRY_DSN_WEB) is never used.
//
// HOW THE ERROR IS FORCED (T27 DECISIONS).
//  - The task's mechanism — an invalid `GET /api/public/links/:token` body, so that T08's
//    ErrorBoundary reports — does not report: the public-link page catches that failure in its
//    query and renders its own error state (features/public-link/PublicLinkPage.tsx,
//    `data-public-state="error"`); it never throws to the boundary. The spec still answers that
//    invalid body and checks the error state, then forces a truly uncaught error on the same page:
//    a timer that throws with the page's URL, token and all, in its message.
//  - Sentry starts only once the public config has loaded (router.tsx `loadConfig`), and the
//    public pages have no loader ("no loader, no session read"): a visitor whose FIRST page is
//    `/s/<token>` reports nothing at all (a SEAM in T27's report). So
//    the redaction test opens the app at `/login` (which loads the config) and moves to
//    `/s/<token>` through the app's own router — the token is then in the page URL, the
//    navigation breadcrumb, the fetch breadcrumb and the error message.
//  - The app's CSP admits only the server's own SENTRY_DSN_WEB origin: see `bypassCSP` below.
// No file of T24's or T08's is touched.
import type { Page, Route } from "@playwright/test";
import { expect, mockShell, test } from "./fixtures";
import { navigateInApp } from "./fixtures/navigate";

// A made-up link token with the real shape (16 random bytes, base64url: 22 characters).
const TOKEN = "Zq8RkT3vXw0pLmN4bC7yAa";
const FAKE_DSN = "https://e2epublickey@o0.ingest.sentry.io/0";
const SENTRY_HOST = /^https:\/\/[^/]*\.sentry\.io\//;
const MESSAGE = "forced observability error";

/** The mocked app (signed out, a DSN in its config) and a recorder of everything sent to Sentry. */
async function setUp(page: Page, port: number): Promise<string[]> {
  await mockShell(page, port, {
    user: null,
    config: { sentryDsnWeb: FAKE_DSN, sentryEnvironment: "test", release: "e2e" },
    api: async (route, path) => {
      if (path !== `/api/public/links/${TOKEN}`) return false;
      // Not a PublicLinkInfo: the contract refuses it (invalid_response).
      await route.fulfill({ json: { unexpected: true } });
      return true;
    },
  });
  // Registered AFTER mockShell, so asked FIRST: mockShell's `**/api/**` would otherwise also take
  // the ingest path (`/api/<project>/envelope/`).
  const envelopes: string[] = [];
  await page.route(SENTRY_HOST, async (route: Route) => {
    envelopes.push(route.request().postDataBuffer()?.toString("utf8") ?? "");
    await route.fulfill({ status: 200, json: {} });
  });
  return envelopes;
}

/** An uncaught error, its message carrying the page's URL — the token with it. */
async function forceError(page: Page): Promise<void> {
  await page.evaluate((message) => {
    setTimeout(() => {
      throw new Error(`${message} at ${window.location.href}`);
    }, 0);
  }, MESSAGE);
}

// The app's CSP admits the origin of the SERVER's SENTRY_DSN_WEB only (security-headers.ts
// `htmlCsp`), and the mocked config's DSN is a made-up one: the browser is told to ignore the CSP
// for this file. (Rewriting the document's header through `page.route` instead makes Chrome's
// local-network checks refuse Vite's HMR socket, and Vite then RELOADS the page.) What this file
// proves is the redaction of what is sent, not the policy — that is security-headers' own test.
test.use({ bypassCSP: true });

test("an error on a /s/<token> page reaches Sentry without the token", async ({ page, origins }) => {
  const envelopes = await setUp(page, origins.port);
  await page.goto("/login");
  // The SDK loads lazily once the config has: its first envelope (the session it starts) says it
  // is up — before that an error, a fetch or a navigation would not be seen by it at all.
  await expect.poll(() => envelopes.some((body) => body.includes('{"type":"session"}'))).toBe(true);

  await navigateInApp(page, `/s/${TOKEN}`);
  // The page's own answer to the invalid body: its error state (nothing thrown to the boundary).
  await expect(page.locator('[data-public-state="error"]')).toBeVisible();
  expect(page.url()).toContain(TOKEN);

  await forceError(page);
  await expect.poll(() => envelopes.filter((body) => body.includes(MESSAGE)).length).toBe(1);

  const event = envelopes.find((body) => body.includes(MESSAGE))!;
  // It is our event, from this page, with its release and environment, and its breadcrumbs.
  expect(event).toContain('"type":"event"');
  expect(event).toContain('"environment":"test"');
  expect(event).toContain('"release":"e2e"');
  expect(event).toContain("/s/");
  expect(event).toContain("/api/public/links/");
  // The token is in none of what left: not the message, not the request URL, not a breadcrumb.
  for (const body of envelopes) expect(body).not.toContain(TOKEN);
});
