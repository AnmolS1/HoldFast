// The account page end to end, against `vite dev`: the real screens, the real Worker, the real
// Better Auth handler, this checkout's local database, mail in the Worker's memory outbox.
//
//   npm run e2e -- tests/e2e/account.spec.ts
//
// Not real: the Turnstile widget (the stand-in that passes at once) and the passkey authenticator
// (Chromium's virtual one). Every test that signs in asks for `clientIp`. Tests wait for SCREENS,
// never for the router. Each test loads the app document at most four times; pages that are not
// the subject are reached with navigateInApp.
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import {
  FIXTURE_PASSWORD,
  freshEmail,
  localDb,
  nextTotpCode,
  signedInUser,
  TURNSTILE_TEST_TOKEN,
} from "../setup/auth-fixtures";
import {
  expect,
  expectNoA11yViolations,
  latestMailTo,
  linksIn,
  navigateInApp,
  stubTurnstile,
  test,
} from "./fixtures";

const DESKTOP_MIN = 1024;
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;

async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Account menu" }).first()).toBeVisible();
}

async function signOutThroughTheUi(page: Page): Promise<void> {
  if (isMobile(page)) await page.locator('[data-bottom-nav-item="account"]').click();
  else await page.locator("[data-user-menu]").click();
  await page.getByText("Sign out", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

async function fillSignIn(page: Page, email: string, password: string): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function sessionOf(request: APIRequestContext) {
  const response = await request.get("/api/auth/get-session?disableCookieCache=true");
  expect(response.status()).toBe(200);
  return (await response.json()) as { user: { id: string; email: string } } | null;
}

async function userRow(id: string) {
  const found = await localDb((db) =>
    db.query<{
      email: string;
      timezone: string | null;
      delete_scheduled_at: Date | null;
      two_factor_enabled: boolean | null;
    }>('SELECT email, timezone, delete_scheduled_at, two_factor_enabled FROM "user" WHERE id = $1', [id]),
  );
  return found.rows[0] ?? null;
}

/** Another browser (a second device), signed in to the same account with its password. */
async function secondDevice(browser: Browser, origin: string, email: string, ip: string) {
  const context = await browser.newContext();
  await context.route(`${origin}/**`, (route) =>
    route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
  );
  const signedIn = await context.request.post("/api/auth/sign-in/email", {
    headers: { origin, "cf-connecting-ip": ip, "x-captcha-response": TURNSTILE_TEST_TOKEN },
    data: { email, password: FIXTURE_PASSWORD },
  });
  expect(signedIn.status()).toBe(200);
  const page = await context.newPage();
  await stubTurnstile(page);
  return { context, page };
}

/** The link in the newest mail to `address` whose subject matches. */
async function linkFromMail(address: string, subject: string | RegExp, contains: string): Promise<string> {
  const mail = await latestMailTo(address, { subject });
  const link = linksIn(mail).find((url) => url.includes(contains));
  if (!link) throw new Error(`no ${contains} link in the mail to ${address}`);
  return link;
}

const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const seen: string[] = [];
  pageErrors.set(page, seen);
  page.on("pageerror", (error) => seen.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], "uncaught errors in the page").toEqual([]);
});

test.describe("preferences and profile", () => {
  test("density, theme and time zone change the UI and are there on a second device — and after its reload", async ({
    page,
    browser,
    clientIp,
    origins,
  }) => {
    const user = await signedInUser(page, { clientIp });
    await page.goto("/account/preferences");
    const saved = page.waitForResponse(
      (response) => response.url().endsWith("/api/account/prefs") && response.request().method() === "PATCH",
    );
    await page.getByRole("radio", { name: "Dark" }).check();
    await page.getByRole("radio", { name: "Comfortable" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-density", "comfortable");
    await expect(page.locator("html[data-dark]")).toHaveCount(1);
    expect((await saved).status()).toBe(200);

    await navigateInApp(page, "/account");
    await page.getByRole("combobox", { name: "Time zone" }).selectOption("Asia/Tokyo");
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect.poll(async () => (await userRow(user.id))?.timezone).toBe("Asia/Tokyo");
    // What the shell's date formatter reads (session.user.timezone), without signing out.
    const session = (await (await page.request.get("/api/auth/get-session")).json()) as {
      user: { timezone: string | null };
    };
    expect(session.user.timezone).toBe("Asia/Tokyo");

    // The second device starts from its own (default) preferences; the server's copy wins.
    const other = await secondDevice(browser, origins.app, user.email, clientIp);
    await other.page.goto("/account/preferences");
    await expect(other.page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await expect(other.page.getByRole("radio", { name: "Comfortable" })).toBeChecked();
    await expect(other.page.locator("html")).toHaveAttribute("data-density", "comfortable");
    await expect(other.page.locator("html[data-dark]")).toHaveCount(1);
    await other.page.reload();
    await expect(other.page.getByRole("radio", { name: "Dark" })).toBeChecked();
    await navigateInApp(other.page, "/account");
    await expect(other.page.getByRole("combobox", { name: "Time zone" })).toHaveValue("Asia/Tokyo");
    await other.context.close();
  });

  test("a change of address waits for the new address to be verified", async ({ page, clientIp }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    const next = freshEmail();
    await page.goto("/account");
    await page.getByRole("button", { name: "Change email" }).click();
    await page.getByLabel("New email address").fill(next);
    await page.getByLabel("Your password").fill(user.password);
    await page.getByRole("button", { name: "Send confirmation" }).click();
    await expect(page.getByText(`Check ${user.email} for a link to confirm the change.`)).toBeVisible();
    expect((await userRow(user.id))?.email).toBe(user.email);

    // The current address confirms; the new one gets its own link; only that link changes it.
    await page.goto(
      await linkFromMail(user.email, "Confirm the change of your email address", "/api/auth/verify-email"),
    );
    await page.getByRole("button", { name: "Confirm the change" }).click();
    await expect(
      page.getByText("Confirmed. Open the link we sent to the new address", { exact: false }),
    ).toBeVisible();
    expect((await userRow(user.id))?.email).toBe(user.email);
    await page.goto(await linkFromMail(next, "Confirm your new email address", "/api/auth/verify-email"));
    await expect.poll(async () => (await userRow(user.id))?.email).toBe(next);
  });
});

test.describe("security", () => {
  test("a passkey added on the Security page signs in; removing it mails the owner", async ({
    page,
    clientIp,
    virtualAuthenticator,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Add passkey" }).click();
    const dialog = page.getByRole("dialog", { name: "Add passkey" });
    await dialog.getByLabel("Passkey name").fill("E2E laptop");
    await dialog.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Passkey added.")).toBeVisible();
    await expect(page.locator("[data-passkeys]")).toContainText("E2E laptop");
    await expect(
      page.getByText("You can now sign in with this passkey instead of your password.", { exact: false }),
    ).toBeVisible();
    expect(await virtualAuthenticator.credentials()).toHaveLength(1);
    await latestMailTo(user.email, { subject: "A passkey was added to your account" });

    await signOutThroughTheUi(page);
    await page.getByRole("button", { name: "Continue with passkey" }).click();
    await expectSignedIn(page);
    expect((await sessionOf(page.request))?.user.id).toBe(user.id);

    await navigateInApp(page, "/account/security");
    await page.getByRole("button", { name: "Remove: E2E laptop" }).click();
    await page
      .getByRole("dialog", { name: "Remove this passkey?" })
      .getByRole("button", { name: "Remove" })
      .click();
    await expect(page.getByText("Passkey removed.")).toBeVisible();
    await expect(page.getByText("No passkeys yet.")).toBeVisible();
    await latestMailTo(user.email, { subject: /passkey was removed/i });
  });

  test("two-factor turned on from Security: sign-in then needs a code; a backup code works once", async ({
    page,
    clientIp,
  }) => {
    test.slow();
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await page.goto("/account/security");
    await page.getByRole("button", { name: "Turn on" }).click();
    const ask = page.getByRole("dialog", { name: "Set up two-factor authentication" });
    await ask.getByLabel("Your password").fill(user.password);
    await ask.getByRole("button", { name: "Continue" }).click();
    const secret = (await page.locator("[data-totp-secret]").textContent())!.trim();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
    await page.getByLabel("6-digit code").fill(await nextTotpCode(secret));
    await page.getByRole("button", { name: "Verify" }).click();
    await expect(page.locator("[data-backup-codes]")).toBeVisible();
    const codes = await page.locator("[data-backup-codes] li").allTextContents();
    expect(codes).toHaveLength(10);
    await page.getByRole("button", { name: "I've saved my codes" }).click();
    await expect(page.getByText("On. Signing in with your password also asks for a code.")).toBeVisible();
    expect((await userRow(user.id))?.two_factor_enabled).toBe(true);
    await latestMailTo(user.email, { subject: "Two-factor authentication is on" });

    // Password alone is not enough now.
    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    expect(await sessionOf(page.request)).toBeNull();
    await page.getByLabel("Six-digit code").fill(await nextTotpCode(secret));
    await page.getByRole("button", { name: "Continue" }).click();
    await expectSignedIn(page);

    // A backup code, once.
    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await page.getByRole("button", { name: "Use a backup code instead" }).click();
    await page.getByLabel("Backup code").fill(codes[0]!.trim());
    await page.getByRole("button", { name: "Continue" }).click();
    await expectSignedIn(page);
    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await page.getByRole("button", { name: "Use a backup code instead" }).click();
    await page.getByLabel("Backup code").fill(codes[0]!.trim());
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That code didn't work. Check it and try again.")).toBeVisible();
    expect(await sessionOf(page.request)).toBeNull();
  });
});

test.describe("devices", () => {
  test("signing out of all other devices signs the second browser out (well within 60 s)", async ({
    page,
    browser,
    clientIp,
    origins,
  }) => {
    const user = await signedInUser(page, { clientIp });
    const other = await secondDevice(browser, origins.app, user.email, clientIp);
    expect((await sessionOf(other.context.request))?.user.id).toBe(user.id);
    await page.goto("/account/devices");
    await expect(page.locator('[data-session="other"]')).toHaveCount(1);
    await expect(page.locator('[data-session="current"]')).toHaveCount(1);
    // Never an address on the screen; the country only, marked approximate.
    await expect(page.locator("[data-sessions]")).not.toContainText(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    await page.getByRole("button", { name: "Sign out of all other devices" }).click();
    await expect(page.getByText("Signed out of 1 other device.")).toBeVisible();
    await expect.poll(async () => sessionOf(other.context.request), { timeout: 60_000 }).toBeNull();
    expect((await sessionOf(page.request))?.user.id).toBe(user.id);
    await expect(page.locator('[data-session="other"]')).toHaveCount(0);
    // The activity lists the sign-ins.
    await navigateInApp(page, "/account/preferences");
    await navigateInApp(page, "/account/devices");
    await expect(page.locator('[data-activity="auth.sign_in"]').first()).toBeVisible();
    await other.context.close();
  });
});

test.describe("your data", () => {
  test("deletion: requested from Your data → banner → a new sign-in cancels nothing → Cancel in Your data → no banner, no date", async ({
    page,
    clientIp,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await page.goto("/account/data");
    await page.getByRole("button", { name: "Delete account" }).click();
    const dialog = page.getByRole("dialog", { name: "Delete your account?" });
    await expect(dialog).toContainText("Open it in this browser, where you're signed in — it works once.");
    await dialog.getByRole("button", { name: "Email me the link" }).click();
    await expect(
      page.getByText("Check your email. Open the link in this browser", { exact: false }),
    ).toBeVisible();
    expect((await userRow(user.id))?.delete_scheduled_at).toBeNull();

    await page.goto(
      await linkFromMail(
        user.email,
        "Confirm that you want to delete your account",
        "/api/auth/delete-user/callback",
      ),
    );
    const banner = page.getByText(/This account is scheduled for deletion on /);
    await expect(banner).toBeVisible();
    await navigateInApp(page, "/account/data");
    await expect(page.locator("[data-deletion-scheduled]")).toContainText("Your account will be deleted on");

    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await expectSignedIn(page);
    await expect(banner).toBeVisible();
    expect((await userRow(user.id))?.delete_scheduled_at).not.toBeNull();

    await navigateInApp(page, "/account/data");
    await page.locator("[data-deletion-scheduled]").getByRole("button", { name: "Cancel deletion" }).click();
    await expect(page.getByText("Deletion cancelled.")).toBeVisible();
    await expect(banner).toHaveCount(0);
    await expect(page.locator("[data-deletion-scheduled]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete account" })).toBeVisible();
    expect((await userRow(user.id))?.delete_scheduled_at).toBeNull();
    await latestMailTo(user.email, { subject: "Account deletion cancelled" });
  });
});

test.describe("accessibility", () => {
  test("every section of the account page is axe-clean (light)", async ({ page, clientIp }) => {
    await signedInUser(page, { clientIp });
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Profile picture" })).toBeVisible();
    await expectNoA11yViolations(page);
    for (const [path, heading] of [
      ["/account/preferences", "Appearance"],
      ["/account/security", "Passkeys"],
      ["/account/devices", "Where you're signed in"],
      ["/account/data", "Export your data"],
    ] as const) {
      await navigateInApp(page, path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expectNoA11yViolations(page);
    }
  });
});
