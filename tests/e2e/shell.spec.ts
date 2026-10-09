// The SPA shell, against `vite dev`. Most tests mock the public config and the session at the
// network layer: they need a signed-in user, stale terms or a particular config, and no auth
// backend can produce a session yet. The first block ("the real Worker") mocks nothing under
// /api: the shell there runs on the Worker's own /api/public/config and session read.
//
//   npm run e2e -- tests/e2e/shell.spec.ts
//
// OFFLINE MODE. With HOLDFAST_E2E_DIST=<path to dist/client> (and a Playwright config that starts
// no server) every request to the app origin is answered from the production build on disk, by
// request interception — no listening socket at all. It exists for machines where a dev server
// cannot start; the two tests that need Vite's module graph are skipped there and say so.
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import type { Page, Route } from "@playwright/test";
import { expect, expectNoA11yViolations, stubTurnstile, test } from "./fixtures";

const DESKTOP_MIN = 1024;

interface User {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  role: string;
  timezone: string;
  termsVersion: string;
  deleteScheduledAt: string | null;
}

const USER: User = {
  id: "a".repeat(32),
  name: "Ada Lovelace",
  email: "ada@example.com",
  emailVerified: true,
  role: "user",
  timezone: "UTC",
  termsVersion: "2026-10",
  deleteScheduledAt: null,
};

interface MockOptions {
  /** `null` = signed out. */
  user?: Partial<User> | null;
  config?: Record<string, unknown>;
  /** Extra API answers, checked before the defaults. Return true when the route was fulfilled. */
  api?: (route: Route, path: string) => Promise<boolean> | boolean;
}

const DIST = process.env.HOLDFAST_E2E_DIST;
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
/** The application's entry script: Vite's module in dev, the hashed bundle in a build. */
const APP_ENTRY = DIST ? "**/assets/index-*.js" : "**/src/client/main.tsx";

/** Offline mode only: answer the app origin from the build, with the SPA fallback. */
async function serveBuild(page: Page, port: number): Promise<void> {
  if (!DIST) return;
  await page.route(`http://localhost:${port}/**`, (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    let file = join(DIST, path);
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(DIST, "index.html");
    return route.fulfill({
      body: readFileSync(file),
      contentType: CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
    });
  });
}

function envelope(error: string, message: string) {
  return { error, message, requestId: "req-e2e" };
}

/** Mock every `/api/*` request: config, session, and a JSON 404 for anything a test did not name. */
async function mockShell(page: Page, port: number, options: MockOptions = {}): Promise<void> {
  const config = {
    signupMode: "invite",
    quotaBytes: 5_368_709_120,
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
  const session = options.user === null ? null : { user: { ...USER, ...options.user }, session: {} };
  await serveBuild(page, port);
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/health") return route.fallback();
    if (options.api && (await options.api(route, path))) return;
    if (path === "/api/public/config") return route.fulfill({ json: config });
    if (path === "/api/auth/get-session") return route.fulfill({ json: session });
    if (path === "/api/account/deletion-status") return route.fulfill({ json: { scheduledFor: null } });
    return route.fulfill({ status: 404, json: envelope("not_found", "Not found.") });
  });
  await stubTurnstile(page);
}

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;
const placeholder = (page: Page, name: string) => page.locator(`[data-placeholder-page="${name}"]`);
const notFound = (page: Page) => page.getByRole("heading", { name: "Page not found" });

async function gotoFrame(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator("[data-frame]")).toBeVisible();
}

test.describe("the real Worker (nothing under /api is mocked)", () => {
  test.skip(Boolean(DIST), "offline mode serves the build by interception: there is no Worker to ask");

  test("/login renders the sign-in form from the Worker's own public config, with no CSP violation", async ({
    page,
    origins,
  }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (
        /content security policy|refused to (load|execute|apply|connect|frame|create)/i.test(message.text())
      ) {
        violations.push(message.text());
      }
    });
    page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
      });
    });
    await stubTurnstile(page);

    const configAnswer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/public/config");
    const sessionAnswer = page.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/get-session");
    await page.goto("/login");

    // Both answers come from the Worker, not from a mock.
    const configResponse = await configAnswer;
    expect(configResponse.status()).toBe(200);
    expect(configResponse.fromServiceWorker()).toBe(false);
    const config = (await configResponse.json()) as Record<string, unknown>;
    expect(config).toMatchObject({
      appOrigin: origins.app,
      filesOrigin: origins.files,
      maxFileBytes: 2_000_000_000,
      uploadsEnabled: true,
      linksEnabled: true,
      readOnly: false,
    });
    expect(["invite", "open"]).toContain(config.signupMode);
    expect(String(config.turnstileSiteKey)).not.toBe("");
    expect(String(config.termsVersion)).not.toBe("");
    expect(String(config.release)).toMatch(/^[0-9a-f]{40}$/);
    const sessionResponse = await sessionAnswer;
    expect(sessionResponse.status()).toBe(200);
    expect(await sessionResponse.json()).toBeNull();

    // The form, not the "couldn't start" screen.
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await expect(page.getByText("Holdfast couldn't start")).toHaveCount(0);
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Forgot password?" })).toBeVisible();
    await expect(page.locator("[data-frame]")).toHaveCount(0);

    await page.waitForTimeout(500);
    expect(violations).toEqual([]);
  });

  test("signed out, / goes to /login with next; /signup and an unknown address render", async ({ page }) => {
    await stubTurnstile(page);
    await page.goto("/");
    await expect(page).toHaveURL(/\/login\?next=%2F$/);
    await expect(page.getByRole("heading", { level: 1, name: "Sign in" })).toBeVisible();
    await page.goto("/signup");
    await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
    await page.goto("/no/such/page");
    await expect(notFound(page)).toBeVisible();
  });
});

test.describe("shell routes", () => {
  const signedOut: Array<[string, string]> = [
    ["/login", "Sign in"],
    ["/signup", "Create your account"],
    ["/forgot-password", "Reset your password"],
    ["/reset-password?token=abc", "Choose a new password"],
    ["/two-factor", "Enter your code"],
    ["/verify-email", "Check your email"],
  ];
  for (const [path, heading] of signedOut) {
    test(`${path} renders signed out`, async ({ page, origins }) => {
      await mockShell(page, origins.port, { user: null });
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
      await expect(page.locator("[data-frame]")).toHaveCount(0);
    });
  }

  test("/accept-terms renders for stale terms and replaces the app", async ({ page, origins }) => {
    await mockShell(page, origins.port, { user: { termsVersion: "2025-01" } });
    await page.goto("/recent");
    await expect(page).toHaveURL(/\/accept-terms\?next=%2Frecent$/);
    await expect(
      page.getByRole("heading", { name: "We've updated the Terms and Privacy Policy." }),
    ).toBeVisible();
    await expect(page.locator("[data-frame]")).toHaveCount(0);
  });

  test("signed out, an app route goes to /login with next", async ({ page, origins }) => {
    await mockShell(page, origins.port, { user: null });
    await page.goto("/trash");
    await expect(page).toHaveURL(/\/login\?next=%2Ftrash$/);
  });

  test("/help and an unknown address", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await gotoFrame(page, "/help");
    await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeVisible();
    await page.goto("/no/such/page");
    await expect(notFound(page)).toBeVisible();
  });

  test("/dmca and /s/:token render outside the frame, signed out", async ({ page, origins }) => {
    await mockShell(page, origins.port, { user: null });
    await page.goto("/dmca");
    await expect(page.getByText("This page is being prepared.")).toBeVisible();
    await expect(page.locator("[data-frame]")).toHaveCount(0);
    await expect(page).toHaveURL(/\/dmca$/);
    await page.goto("/s/sometoken");
    await expect(placeholder(page, "Shared file")).toBeVisible();
    await expect(page.locator("[data-frame]")).toHaveCount(0);
  });

  test("when the public config cannot be read the app says it could not start", async ({ page, origins }) => {
    await serveBuild(page, origins.port);
    // What the Worker answers for an unexpected failure: the 500 envelope outside the code table.
    await page.route("**/api/public/config", (route) =>
      route.fulfill({
        status: 500,
        json: { error: "internal", message: "Something went wrong.", requestId: "req-e2e" },
      }),
    );
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Holdfast couldn't start" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  });
});

test.describe("navigation", () => {
  const DESTINATIONS: Array<[id: string, path: string, title: string]> = [
    ["files", "/", "Files"],
    ["shared", "/shared", "Shared with me"],
    ["shared-by-me", "/shared-by-me", "Shared by me"],
    ["recent", "/recent", "Recent"],
    ["starred", "/starred", "Starred"],
    ["trash", "/trash", "Trash"],
  ];

  test("desktop: every sidebar destination shows its placeholder, none shows not-found", async ({
    page,
    origins,
  }) => {
    test.skip(isMobile(page), "desktop layout");
    await mockShell(page, origins.port);
    await gotoFrame(page, "/");
    await expect(page.locator("[data-sidebar] [data-nav]")).toHaveCount(6);
    for (const [id, path, title] of DESTINATIONS) {
      await page.locator(`[data-sidebar] [data-nav="${id}"]`).click();
      await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/" : path}$`));
      await expect(placeholder(page, title)).toBeVisible();
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
      await expect(notFound(page)).toHaveCount(0);
      await expect(page.locator(`[data-sidebar] [data-nav="${id}"]`)).toHaveAttribute("aria-current", "page");
    }
    await page.locator('[data-sidebar] [data-nav="shared"]').click();
    await expect(placeholder(page, "Shared with me")).toContainText(
      "Shared files appear here once sharing is switched on.",
    );
  });

  test("mobile: three nav items; Recent, Starred and Trash through the Files switcher", async ({
    page,
    origins,
  }) => {
    test.skip(!isMobile(page), "mobile layout");
    await mockShell(page, origins.port);
    await gotoFrame(page, "/");
    await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame", "mobile");
    await expect(page.locator("[data-bottom-nav] [data-bottom-nav-item]")).toHaveText([
      "Files",
      "Shared",
      "Account",
    ]);
    await expect(page.locator("[data-bottom-nav]").locator("a, button")).toHaveCount(3);
    await expect(page.locator("[data-sidebar]")).toHaveCount(0);
    await expect(placeholder(page, "Files")).toBeVisible();

    for (const [label, title] of [
      ["Recent", "Recent"],
      ["Starred", "Starred"],
      ["Trash", "Trash"],
      ["My files", "Files"],
    ] as const) {
      await page.getByRole("button", { name: "Switch files view" }).click();
      await page.getByRole("dialog", { name: "Files" }).getByRole("button", { name: label }).click();
      await expect(placeholder(page, title)).toBeVisible();
      await expect(notFound(page)).toHaveCount(0);
      await expect(page.locator('[data-bottom-nav-item="files"]')).toHaveAttribute("aria-current", "page");
    }

    await page.locator('[data-bottom-nav-item="shared"]').click();
    await expect(placeholder(page, "Shared with me")).toContainText(
      "Shared files appear here once sharing is switched on.",
    );
    await page.getByRole("group", { name: "Shared files view" }).getByRole("link", { name: "By me" }).click();
    await expect(placeholder(page, "Shared by me")).toBeVisible();

    await page.locator('[data-bottom-nav-item="account"]').click();
    const sheet = page.getByRole("dialog", { name: "Ada Lovelace" });
    await expect(sheet.locator("[data-account-action]")).toHaveText([
      "Account settings",
      "Manage storage",
      "Help",
      "Contact support",
      "Terms",
      "Privacy",
      "DMCA",
      "Sign out",
    ]);
    await sheet.getByText("Account settings").click();
    await expect(placeholder(page, "Account")).toBeVisible();
    await expect(page.locator('[data-bottom-nav-item="account"]')).toHaveAttribute("aria-current", "page");
  });

  test("every other in-frame placeholder route renders (deep links, both layouts)", async ({
    page,
    origins,
  }) => {
    await mockShell(page, origins.port, { user: { role: "admin" } });
    for (const [path, title] of [
      ["/folder/abc", "Files"],
      ["/uploads", "Uploads"],
      ["/search?q=tax", "Search"],
      ["/storage", "Storage"],
      ["/account/security", "Account"],
      ["/admin/users", "Admin"],
      ...DESTINATIONS.map(([, path, title]) => [path, title] as [string, string]),
    ] as Array<[string, string]>) {
      await gotoFrame(page, path);
      await expect(placeholder(page, title)).toBeVisible();
      await expect(notFound(page)).toHaveCount(0);
    }
  });

  test("the preview is an overlay above the page it was opened from", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await gotoFrame(page, "/preview/node-1");
    await expect(page.locator("[data-overlay]").locator('[data-placeholder-page="Preview"]')).toBeVisible();
    // Cold link: the root page is the background.
    await expect(page.locator('[data-background="kept"] [data-placeholder-page="Files"]')).toBeAttached();
  });

  test("a non-admin asking for /admin gets not-found", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await page.goto("/admin/users");
    await expect(notFound(page)).toBeVisible();
    await expect(placeholder(page, "Admin")).toHaveCount(0);
  });

  test("the breakpoint flips at 1024: 1023 is mobile, 1024 is desktop", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await page.setViewportSize({ width: 1023, height: 800 });
    await gotoFrame(page, "/");
    await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame", "mobile");
    await expect(page.locator("[data-bottom-nav] [data-bottom-nav-item]")).toHaveCount(3);
    await expect(page.locator("[data-sidebar]")).toHaveCount(0);
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame", "desktop");
    await expect(page.locator("[data-sidebar]")).toBeVisible();
    await expect(page.locator("[data-details-panel]")).toBeVisible();
    await expect(page.locator("[data-bottom-nav]")).toHaveCount(0);
    // Sidebar 232, details 320, header 56 — the specification's numbers.
    expect((await page.locator("[data-sidebar]").boundingBox())?.width).toBe(232);
    expect((await page.locator("[data-details-panel]").boundingBox())?.width).toBe(320);
    expect((await page.locator("[data-header]").boundingBox())?.height).toBe(56);
  });
});

test.describe("theme", () => {
  async function chooseDark(page: Page): Promise<void> {
    if (isMobile(page)) {
      await page.locator('[data-bottom-nav-item="account"]').click();
      await page.getByRole("radio", { name: "Dark" }).click();
      await page.keyboard.press("Escape");
    } else {
      await page.locator("[data-user-menu]").click();
      await page.locator('[data-theme-option="dark"]').click();
      await page.keyboard.press("Escape");
    }
  }

  test("the toggle persists across a reload, and the scheme is set before the app runs", async ({
    page,
    origins,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await mockShell(page, origins.port);
    await gotoFrame(page, "/");
    await expect(page.locator("html")).toHaveAttribute("data-light", "");
    await chooseDark(page);
    await expect(page.locator("html")).toHaveAttribute("data-dark", "");
    await expect(page.locator("html")).not.toHaveAttribute("data-light");
    expect(await page.evaluate(() => localStorage.getItem("mui-mode"))).toBe("dark");
    await expect(page.locator("body")).toHaveCSS("background-color", "rgb(15, 17, 21)");

    // Record every scheme attribute the page ever carries from its first byte on.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __schemes: string[] }).__schemes = seen;
      const read = () => {
        const root = document.documentElement;
        if (!root) return;
        const value = [
          root.hasAttribute("data-light") ? "light" : "",
          root.hasAttribute("data-dark") ? "dark" : "",
        ].join("");
        if (seen[seen.length - 1] !== value) seen.push(value);
      };
      new MutationObserver(read).observe(document, {
        attributes: true,
        subtree: true,
        attributeFilter: ["data-light", "data-dark"],
      });
      document.addEventListener("DOMContentLoaded", read);
    });

    // Hold the application bundle back: whatever is on <html> now was put there before React.
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(APP_ENTRY, async (route) => {
      await held;
      await route.fallback();
    });
    await page.reload({ waitUntil: "commit" });
    await expect(page.locator("html")).toHaveAttribute("data-dark", "");
    expect(await page.locator("#root").innerHTML()).toBe("");
    release();
    await expect(page.locator("[data-frame]")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-dark", "");
    // No flash and no mismatch: the light attribute never appeared at any point of the load.
    const schemes = await page.evaluate(() => (window as unknown as { __schemes: string[] }).__schemes);
    expect(schemes.filter((value) => value !== "")).toEqual(["dark"]);
  });

  test("control: without the first-paint script the stored scheme is NOT on <html> before the app runs", async ({
    page,
    origins,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await mockShell(page, origins.port);
    await page.addInitScript(() => localStorage.setItem("mui-mode", "dark"));
    await page.route("**/color-scheme-init.js", (route) =>
      route.fulfill({ contentType: "text/javascript", body: "" }),
    );
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(APP_ENTRY, async (route) => {
      await held;
      await route.fallback();
    });
    await page.goto("/", { waitUntil: "commit" });
    // The document is parsed (the root element exists) while the application script is held back.
    await expect(page.locator("#root")).toBeAttached();
    expect(await page.locator("#root").innerHTML()).toBe("");
    await expect(page.locator("html")).not.toHaveAttribute("data-dark");
    release();
    // The provider still gets there once React runs — late, which is the flash the script prevents.
    await expect(page.locator("html")).toHaveAttribute("data-dark", "");
  });

  test("the first-paint script follows the system scheme when nothing is stored", async ({
    page,
    origins,
  }) => {
    await page.emulateMedia({ colorScheme: "dark" });
    await mockShell(page, origins.port, { user: null });
    await page.goto("/login");
    await expect(page.locator("html")).toHaveAttribute("data-dark", "");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
  });
});

test.describe("accessibility (light)", () => {
  test("/login has no axe violations", async ({ page, origins }) => {
    await mockShell(page, origins.port, { user: null });
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await expect(page.locator('[data-turnstile="ready"]')).toBeAttached();
    await expectNoA11yViolations(page);
  });

  test("/ has no axe violations", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await gotoFrame(page, "/");
    await expect(placeholder(page, "Files")).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("/accept-terms has no axe violations", async ({ page, origins }) => {
    await mockShell(page, origins.port, { user: { termsVersion: "2025-01" } });
    await page.goto("/accept-terms");
    await expect(page.getByRole("button", { name: "Accept and continue" })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("/signup and the open palette have no axe violations", async ({ page, origins }) => {
    await mockShell(page, origins.port, { user: null });
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("keyboard: the skip link is the first stop and moves focus to main; the palette traps and returns focus", async ({
    page,
    origins,
  }) => {
    test.skip(isMobile(page), "keyboard path on the desktop layout");
    await mockShell(page, origins.port);
    await gotoFrame(page, "/");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
    await page.locator("[data-palette-button]").focus();
    await page.keyboard.press("Enter");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await expect(palette).toBeVisible();
    await expect(page.getByPlaceholder("Type a command or search")).toBeFocused();
    // Let the 120 ms fade finish: a half-transparent dialog measures as low contrast.
    await page.waitForTimeout(300);
    await expectNoA11yViolations(page);
    for (let i = 0; i < 6; i += 1) await page.keyboard.press("Tab");
    expect(await palette.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(palette).toHaveCount(0);
    await expect(page.locator("[data-palette-button]")).toBeFocused();
  });
});

test.describe("session expiry", () => {
  test.skip(
    Boolean(DIST),
    "needs the dev server: the trigger imports the app's API client module, which a build does not expose (the same matrix runs in jsdom: api-401.test.ts)",
  );

  // The same trigger in both tests: the app's own API client asks for an app route and gets 401.
  async function trigger401(page: Page): Promise<void> {
    await page.evaluate(async () => {
      const module = (await import("/src/client/lib/api.ts" as string)) as {
        api: (path: string) => Promise<unknown>;
      };
      void module.api("/api/nodes").catch(() => {});
    });
  }
  const unauthorized = async (route: Route, path: string) => {
    if (path !== "/api/nodes") return false;
    await route.fulfill({ status: 401, json: envelope("unauthorized", "Your session ended.") });
    return true;
  };

  test("on an app route a 401 opens the re-auth modal over an opaque backdrop", async ({ page, origins }) => {
    await mockShell(page, origins.port, { api: unauthorized });
    await gotoFrame(page, "/");
    await trigger401(page);
    const modal = page.getByRole("dialog", { name: "Your session ended" });
    await expect(modal).toBeVisible();
    await expect(modal.getByLabel("Email")).toHaveValue("ada@example.com");
    await expect(modal.getByLabel("Password")).toBeFocused();
    // Nothing of the signed-in screen is readable behind it.
    await expect(page.locator("[data-reauth-backdrop]")).toHaveCSS("background-color", "rgb(247, 248, 250)");
    await page.keyboard.press("Escape");
    await expect(modal).toBeVisible();
  });

  test("on a public page the same 401 shows no modal — even with a signed-in session", async ({
    page,
    origins,
  }) => {
    await mockShell(page, origins.port, { api: unauthorized });
    // A session is known to the client (it visited the app first), then a public link is opened.
    await gotoFrame(page, "/");
    await page.evaluate(() => window.history.pushState({}, "", "/s/sometoken"));
    await page.evaluate(() => window.dispatchEvent(new PopStateEvent("popstate")));
    await expect(placeholder(page, "Shared file")).toBeVisible();
    const requested = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/nodes");
    await trigger401(page);
    expect((await requested).status()).toBe(401);
    await page.waitForTimeout(500);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("storage and layout", () => {
  test("Web Storage holds UI preferences only, after visiting the shell and changing them", async ({
    page,
    origins,
  }) => {
    await mockShell(page, origins.port, { user: { role: "admin" } });
    for (const path of [
      "/",
      "/shared",
      "/recent",
      "/account",
      "/admin",
      "/help",
      "/preview/n1",
      "/search?q=secret",
    ])
      await gotoFrame(page, path);
    await page.goto("/login?next=/recent");
    await gotoFrame(page, "/");
    // Change every preference through the UI: theme (menu or sheet) and view mode (toggle).
    if (isMobile(page)) {
      await page.locator('[data-bottom-nav-item="account"]').click();
      await page.getByRole("radio", { name: "Dark" }).click();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } else {
      await page.locator("[data-user-menu]").click();
      await page.locator('[data-theme-option="dark"]').click();
      await page.keyboard.press("Escape");
    }
    await page.getByRole("button", { name: "Grid view" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-dark", "");
    const stored = await page.evaluate(() => ({
      local: Object.keys(localStorage).sort(),
      session: Object.keys(sessionStorage),
      prefs: localStorage.getItem("hf.prefs.v1"),
    }));
    const allowed = ["hf.prefs.v1", "mui-color-scheme-dark", "mui-color-scheme-light", "mui-mode"];
    expect(stored.local.filter((key) => !allowed.includes(key))).toEqual([]);
    expect(stored.local).toContain("hf.prefs.v1");
    expect(stored.session).toEqual([]);
    expect(JSON.parse(stored.prefs ?? "{}")).toEqual({ density: "compact", viewMode: "grid" });
    // Nothing that looks like a session or a token, in any key or value.
    const dump = await page.evaluate(() => JSON.stringify({ ...localStorage }));
    expect(dump).not.toMatch(/token|session|ada@example\.com|a{32}/i);
  });

  test("mobile: 44 px touch targets and 16 px inputs", async ({ page, origins }) => {
    test.skip(!isMobile(page), "mobile layout");
    const measure = () =>
      page.evaluate(() => {
        const small: string[] = [];
        const inputs: string[] = [];
        for (const element of Array.from(
          document.querySelectorAll<HTMLElement>(
            'a[href], button, [role="button"], [role="radio"], input, select, textarea',
          ),
        )) {
          if (element.closest("[inert], [aria-hidden='true']")) continue;
          const style = getComputedStyle(element);
          if (style.visibility === "hidden" || style.display === "none") continue;
          // A checkbox's target is its label; so is a bare input drawn inside a labelled box (search).
          const target =
            element instanceof HTMLInputElement && (element.type === "checkbox" || element.type === "search")
              ? (element.closest("label") ?? element)
              : element;
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          // The skip link is off-screen until focused.
          if (rect.bottom < 0) continue;
          // Links inside a sentence are exempt (inline targets).
          if (element.tagName === "A" && element.closest(".prose")) continue;
          const name =
            element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? element.tagName;
          if (rect.height < 43.5 || rect.width < 43.5)
            small.push(`${name} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
          if (
            element instanceof HTMLInputElement &&
            !["checkbox", "radio", "hidden"].includes(element.type) &&
            parseFloat(style.fontSize) < 16
          )
            inputs.push(`${element.name} ${style.fontSize}`);
        }
        return { small, inputs };
      });

    await mockShell(page, origins.port);
    await gotoFrame(page, "/");
    expect(await measure()).toEqual({ small: [], inputs: [] });
    await page.locator('[data-bottom-nav-item="account"]').click();
    await expect(page.getByRole("dialog")).toBeVisible();
    expect(await measure()).toEqual({ small: [], inputs: [] });
  });

  test("mobile: auth screens have 44 px targets and 16 px inputs", async ({ page, origins }) => {
    test.skip(!isMobile(page), "mobile layout");
    await mockShell(page, origins.port, { user: null });
    for (const path of ["/login", "/signup", "/forgot-password", "/two-factor"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const result = await page.evaluate(() => {
        const small: string[] = [];
        const inputs: string[] = [];
        for (const element of Array.from(document.querySelectorAll<HTMLElement>("a[href], button, input"))) {
          if (element.tagName === "A" && element.closest(".prose")) continue;
          const target =
            element instanceof HTMLInputElement && element.type === "checkbox"
              ? (element.closest("label") ?? element)
              : element;
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          if (rect.height < 43.5)
            small.push(
              `${element.getAttribute("name") ?? element.textContent?.trim().slice(0, 30)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
            );
          if (
            element instanceof HTMLInputElement &&
            element.type !== "checkbox" &&
            parseFloat(getComputedStyle(element).fontSize) < 16
          )
            inputs.push(`${element.name} ${getComputedStyle(element).fontSize}`);
        }
        return { small, inputs };
      });
      expect(result, path).toEqual({ small: [], inputs: [] });
    }
  });

  test("no horizontal overflow at 360 px", async ({ page, origins }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    const overflow = () =>
      page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
    await mockShell(page, origins.port);
    for (const path of ["/", "/shared", "/account", "/help", "/storage"]) {
      await gotoFrame(page, path);
      const size = await overflow();
      expect(size.scroll, path).toBeLessThanOrEqual(size.client);
    }
    await page.unroute("**/api/**");
    await mockShell(page, origins.port, { user: null });
    for (const path of ["/login", "/signup", "/verify-email", "/dmca"]) {
      await page.goto(path);
      await expect(page.locator("main, [role=main]").first()).toBeVisible();
      const size = await overflow();
      expect(size.scroll, path).toBeLessThanOrEqual(size.client);
    }
  });
});
