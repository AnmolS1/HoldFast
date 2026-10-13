// A signed-in SPA with no backend: every `/api/*` request is answered in the browser — the public
// config, the session, and a JSON 404 for anything a spec did not name. For specs of the SPA
// itself (the shell, the explorer, the uploader, previews, the views) in MOCKED mode (see
// ./mode.ts); a spec in REAL mode signs in with tests/setup/auth-fixtures.ts instead.
//
//   await mockShell(page, origins.port);                                  signed in as MOCK_USER
//   await mockShell(page, origins.port, { user: null });                  signed out
//   await mockShell(page, origins.port, { user: { role: "admin" } });
//   await mockShell(page, origins.port, { config: { uploadsEnabled: false } });
//   await mockShell(page, origins.port, { api: (route, path) => … });     a spec's own answers
//
// A spec's own answers: either `options.api` (asked first; return true once the route is
// fulfilled), or its own `page.route("**/api/nodes/**", …)` registered AFTER this call — Playwright
// asks the route registered last first, and `route.fallback()` hands on to this one.
//
// OFFLINE MODE. With HOLDFAST_E2E_DIST=<path to dist/client> (and a Playwright config that starts
// no server) every request to the app origin is answered from the production build on disk, by
// request interception — no listening socket at all. It exists for machines where a dev server
// cannot start.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { stubTurnstile } from "./turnstile";

export interface MockUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  timezone: string;
  termsVersion: string;
  deleteScheduledAt: string | null;
}

/** Who `mockShell` signs in. A made-up person on a reserved domain. */
export const MOCK_USER: MockUser = {
  id: "a".repeat(32),
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  role: "user",
  timezone: "UTC",
  termsVersion: "2026-10",
  deleteScheduledAt: null,
};

export interface MockShellOptions {
  /** Fields to change on `MOCK_USER`; `null` = signed out. */
  user?: Partial<MockUser> | null;
  /** Fields to change on the public config. */
  config?: Record<string, unknown>;
  /** Extra API answers, checked before the defaults. Return true when the route was fulfilled. */
  api?: (route: Route, path: string) => Promise<boolean> | boolean;
}

/** Set in offline mode: the directory of the production build that stands in for the server. */
export const E2E_DIST = process.env.HOLDFAST_E2E_DIST;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

/** Offline mode only: answer the app origin from the build, with the SPA fallback. */
export async function serveBuild(page: Page, port: number): Promise<void> {
  if (!E2E_DIST) return;
  const dist = E2E_DIST;
  await page.route(`http://localhost:${port}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let file = join(dist, path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, "index.html");
    return route.fulfill({
      body: readFileSync(file),
      contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
  });
}

/** The app host's error body, as a mock answers it. */
export function mockEnvelope(error: string, message: string) {
  return { error, message, requestId: "req-e2e" };
}

/** Mock every `/api/*` request: config, session, and a JSON 404 for anything a test did not name. */
export async function mockShell(page: Page, port: number, options: MockShellOptions = {}): Promise<void> {
  const config = {
    signupMode: "invite",
    quotaBytes: 5_000_000_000,
    maxFileBytes: 2_000_000_000,
    partBytes: 67_108_864,
    turnstileSiteKey: "1x00000000000000000000AA",
    appOrigin: `http://localhost:${port}`,
    filesOrigin: `http://files.localhost:${port}`,
    termsVersion: "2026-10",
    uploadsEnabled: true,
    linksEnabled: true,
    readOnly: false,
    sentryDsnWeb: null,
    sentryEnvironment: "test",
    release: "e2e",
    ...options.config,
  };
  const session = options.user === null ? null : { user: { ...MOCK_USER, ...options.user }, session: {} };
  await serveBuild(page, port);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fallback();
    if (options.api && (await options.api(route, path))) return;
    if (path === "/api/public/config") return route.fulfill({ json: config });
    if (path === "/api/auth/get-session") return route.fulfill({ json: session });
    if (path === "/api/account/deletion-status") return route.fulfill({ json: { scheduledFor: null } });
    return route.fulfill({ status: 404, json: mockEnvelope("not_found", "Not found.") });
  });
  await stubTurnstile(page);
}
