// Authentication end to end, against `vite dev`: the real screens, the real Worker, the real
// Better Auth handler, this checkout's local database, the mail in the Worker's memory outbox.
//
//   npm run e2e -- tests/e2e/auth.spec.ts
//
// What is NOT real: the Turnstile widget script is the stand-in that passes at once (the server
// still verifies its token with Cloudflare, under the published always-pass test secret); Google
// is never reached — the browser's trip to accounts.google.com is answered here, and the Worker's
// token exchange by its test-mode stand-in (src/worker/auth/test-outbound.ts); the breach lookup
// and the MX lookup are the same stand-ins. Passkeys use Chromium's virtual authenticator.
//
// Every test that signs in asks for `clientIp`: the Worker allows 20 auth writes a minute and
// 3 sign-ups a day per client address. Tests wait for SCREENS (a heading, a control), never for
// the router.
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { APIRequestContext, Page } from "@playwright/test";
import { hasAdminRole } from "../../src/shared/roles";
import {
  createInvite,
  FIXTURE_PASSWORD,
  freshEmail,
  localDb,
  signedInAdmin2fa,
  signedInUser,
  totpCode,
  TURNSTILE_TEST_TOKEN,
} from "../setup/auth-fixtures";
import { readVars } from "../setup/e2e-preflight";
import { localDbName, localDbUrl } from "../setup/local-env";
import { expect, latestMailTo, linksIn, test } from "./fixtures";

const run = promisify(execFile);

/**
 * The Turnstile widget script, replaced by a stand-in that passes at once — and passes AGAIN
 * after `reset()`, as the real widget does. (A form resets the widget after every submit: a
 * stand-in whose reset yields no new token leaves a second attempt waiting for ever.)
 */
async function stubTurnstile(page: Page): Promise<void> {
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body:
        "window.turnstile=(function(){var cb=null;function pass(){setTimeout(function(){if(cb)cb('XXXX.DUMMY.TOKEN.XXXX')},10)}" +
        "return{render:function(el,o){cb=o.callback;pass();return 'w'},reset:function(){pass()},remove:function(){cb=null}}})();",
    }),
  );
}
const DESKTOP_MIN = 1024;
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;

type Session = { user: Record<string, unknown>; session: Record<string, unknown> } | null;

const api = (origin: string, clientIp: string, extra: Record<string, string> = {}) => ({
  origin,
  "cf-connecting-ip": clientIp,
  ...extra,
});

async function sessionOf(request: APIRequestContext, fresh = false): Promise<Session> {
  const response = await request.get(`/api/auth/get-session${fresh ? "?disableCookieCache=true" : ""}`);
  expect(response.status()).toBe(200);
  return (await response.json()) as Session;
}

/** The app frame is on screen: only a signed-in, verified user with current terms gets it. */
async function expectSignedIn(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Account menu" }).first()).toBeVisible();
}

async function expectSignInScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
}

async function signOutThroughTheUi(page: Page): Promise<void> {
  if (isMobile(page)) await page.locator('[data-bottom-nav-item="account"]').click();
  else await page.locator("[data-user-menu]").click();
  await page.getByText("Sign out", { exact: true }).click();
  await expectSignInScreen(page);
}

async function fillSignIn(page: Page, email: string, password: string): Promise<void> {
  await expectSignInScreen(page);
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function userRow(email: string) {
  const found = await localDb((db) =>
    db.query<{
      id: string;
      email_verified: boolean;
      role: string | null;
      two_factor_enabled: boolean | null;
      delete_scheduled_at: Date | null;
      terms_version: string | null;
    }>(
      'SELECT id, email_verified, role, two_factor_enabled, delete_scheduled_at, terms_version FROM "user" WHERE email = $1',
      [email.toLowerCase()],
    ),
  );
  return found.rows[0] ?? null;
}

/** The link in the newest mail to `address` whose subject matches. */
async function linkFromMail(address: string, subject: string | RegExp, contains: string): Promise<string> {
  const mail = await latestMailTo(address, { subject });
  const link = linksIn(mail).find((url) => url.includes(contains));
  if (!link) throw new Error(`no ${contains} link in the mail to ${address}`);
  return link;
}

/** Fills the sign-up form (everything but the Google / submit choice). */
async function fillSignUp(
  page: Page,
  input: { email: string; name?: string; invite?: string },
): Promise<void> {
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
  if (input.invite !== undefined) await page.getByLabel("Invite code").fill(input.invite);
  await page.getByLabel("Name").fill(input.name ?? "Ada Example");
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password").fill(FIXTURE_PASSWORD);
  await page.getByLabel("Month").fill("5");
  await page.getByLabel("Year").fill("1990");
  await page.getByRole("checkbox").check();
}

// No test here may leave an uncaught error in the page.
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const seen: string[] = [];
  pageErrors.set(page, seen);
  page.on("pageerror", (error) => seen.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], "uncaught errors in the page").toEqual([]);
});

test.describe("sign-up", () => {
  test("invite link → sign-up → verification mail → verified and signed in → passkey → TOTP → sign out → passkey sign-in", async ({
    page,
    clientIp,
    origins,
    virtualAuthenticator,
  }) => {
    await stubTurnstile(page);
    const invite = await createInvite();
    const email = freshEmail();

    // The invite link checks the code and hands it to the sign-up form.
    await page.goto(`/invite/${invite}`);
    await expect(page.getByText("This invite is valid.")).toBeVisible();
    await expect(page.getByLabel("Invite code")).toHaveValue(invite);
    await fillSignUp(page, { email });
    await page.getByRole("button", { name: "Create account" }).click();

    // "Check your email": no session yet, and the account is unverified.
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await expect(page.locator("[data-verify-email]")).toHaveText(email);
    expect(await sessionOf(page.request)).toBeNull();
    expect((await userRow(email))?.email_verified).toBe(false);

    // The verification link, opened in the same browser: verified and signed in.
    const link = await linkFromMail(email, "Confirm your email address", "/api/auth/verify-email");
    expect(link.startsWith(`${origins.app}/api/auth/verify-email?token=`)).toBe(true);
    await page.goto(link);
    await expectSignedIn(page);
    expect((await userRow(email))?.email_verified).toBe(true);
    const session = await sessionOf(page.request);
    expect(session?.user).toMatchObject({ email, emailVerified: true });
    // The session cookie is HttpOnly: script on the page cannot see it.
    const cookies = await page.context().cookies();
    const token = cookies.find((cookie) => cookie.name === "hf.session_token");
    expect(token).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/" });
    expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");

    // A passkey, registered through the client the app ships (the settings screen is a later task).
    const registered = await page.evaluate(async () => {
      // A module of the dev server, loaded in the page (not by this Node process).
      const path = "/src/client/lib/auth-client.ts";
      const { betterAuthClient } = (await import(/* @vite-ignore */ path)) as {
        betterAuthClient: {
          passkey: {
            addPasskey(input: {
              name: string;
            }): Promise<{ error?: { message?: string; code?: string } | null } | undefined>;
          };
        };
      };
      const result = await betterAuthClient.passkey.addPasskey({ name: "e2e key" });
      return result?.error ? String(result.error.message ?? result.error.code ?? "error") : "ok";
    });
    expect(registered).toBe("ok");
    expect(await virtualAuthenticator.credentials()).toHaveLength(1);
    await latestMailTo(email, { subject: "A passkey was added to your account" });

    // TOTP, enrolled through Better Auth's endpoints.
    const enabled = await page.request.post("/api/auth/two-factor/enable", {
      headers: api(origins.app, clientIp),
      data: { password: FIXTURE_PASSWORD },
    });
    expect(enabled.status()).toBe(200);
    const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
    const verified = await page.request.post("/api/auth/two-factor/verify-totp", {
      headers: api(origins.app, clientIp),
      data: { code: totpCode(totpURI) },
    });
    expect(verified.status()).toBe(200);
    expect(backupCodes).toHaveLength(10);
    expect((await userRow(email))?.two_factor_enabled).toBe(true);
    await latestMailTo(email, { subject: "Two-factor authentication is on" });

    // Sign out through the UI, then back in with the passkey alone.
    await page.goto("/");
    await expectSignedIn(page);
    await signOutThroughTheUi(page);
    expect(await sessionOf(page.request)).toBeNull();
    await page.getByRole("button", { name: "Continue with passkey" }).click();
    await expectSignedIn(page);
    expect((await sessionOf(page.request))?.user).toMatchObject({ email });

    // Nothing of the session is in Web Storage, and the auth library wrote nothing there.
    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      dump: JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }),
    }));
    expect(storage.local.filter((key) => /better-auth|session|token/i.test(key))).toEqual([]);
    expect(storage.session).toEqual([]);
    expect(storage.dump).not.toContain(token!.value.split(".")[0]!);
  });

  test("a sign-up without an invite, and one with a spent invite, are refused on the form", async ({
    page,
    clientIp,
  }) => {
    expect(clientIp).toBeTruthy();
    await stubTurnstile(page);
    const spent = await createInvite();
    await localDb((db) => db.query("UPDATE invites SET uses = max_uses WHERE code = $1", [spent]));
    const email = freshEmail();
    await page.goto("/signup");
    await fillSignUp(page, { email, invite: spent });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("This invite code isn't valid.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    expect(await userRow(email)).toBeNull();
  });

  test("resend: the verify screen sends a second link, and it works", async ({ page, clientIp }) => {
    expect(clientIp).toBeTruthy();
    await stubTurnstile(page);
    // The resend button has a 60-second cool-down; the page's clock is moved past it.
    await page.clock.install();
    const email = freshEmail();
    await page.goto(`/signup?invite=${await createInvite()}`);
    await fillSignUp(page, { email });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    await latestMailTo(email, { subject: "Confirm your email address" });

    const resend = page.getByRole("button", { name: /Send it again/ });
    await expect(resend).toBeDisabled();
    await page.clock.fastForward(61_000);
    await expect(resend).toBeEnabled();
    await resend.click();
    await expect(page.getByText("Sent. Check your inbox.")).toBeVisible();

    // Two mails now; the newest is the resend, and its link verifies.
    await expect
      .poll(async () => {
        const response = await page.request.get(`/api/_test/outbox?to=${encodeURIComponent(email)}`);
        return ((await response.json()) as { messages: unknown[] }).messages.length;
      })
      .toBe(2);
    const mail = await latestMailTo(email, { subject: "Confirm your email address" });
    expect(mail.text).toContain("Here is a new link");
    await page.goto(linksIn(mail).find((url) => url.includes("/api/auth/verify-email"))!);
    await expectSignedIn(page);
  });

  test("change the pending address: the new address gets the link, the old link is dead", async ({
    page,
    clientIp,
  }) => {
    expect(clientIp).toBeTruthy();
    await stubTurnstile(page);
    const typo = freshEmail();
    const right = freshEmail();
    await page.goto(`/signup?invite=${await createInvite()}`);
    await fillSignUp(page, { email: typo });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    const oldLink = await linkFromMail(typo, "Confirm your email address", "/api/auth/verify-email");

    await page.getByRole("button", { name: "Wrong address? Change it" }).click();
    await page.getByLabel("New email address").fill(right);
    await page.getByRole("button", { name: "Update and resend" }).click();
    await expect(page.getByText("Updated. We sent a link to the new address.")).toBeVisible();
    await expect(page.locator("[data-verify-email]")).toHaveText(right);
    expect(await userRow(typo)).toBeNull();
    expect((await userRow(right))?.email_verified).toBe(false);

    // The link that went to the mistyped address no longer verifies anything.
    const stale = await page.request.get(oldLink, { maxRedirects: 0 });
    expect(stale.headers().location ?? "").toContain("error=");
    expect((await userRow(right))?.email_verified).toBe(false);

    await page.goto(await linkFromMail(right, "Confirm your email address", "/api/auth/verify-email"));
    await expectSignedIn(page);
    expect((await sessionOf(page.request))?.user).toMatchObject({ email: right, emailVerified: true });
  });
});

test.describe("sign-in", () => {
  test("password + TOTP code; then password + a backup code (which works once)", async ({
    page,
    request,
    clientIp,
    origins,
  }) => {
    await stubTurnstile(page);
    // The account is made through its own request context: the page starts signed out.
    const user = await signedInUser(request, { clientIp });
    const enabled = await request.post("/api/auth/two-factor/enable", {
      headers: api(origins.app, clientIp),
      data: { password: user.password },
    });
    const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
    expect(
      (
        await request.post("/api/auth/two-factor/verify-totp", {
          headers: api(origins.app, clientIp),
          data: { code: totpCode(totpURI) },
        })
      ).status(),
    ).toBe(200);

    // Password first: the code screen, and no session yet.
    await page.goto("/login");
    await fillSignIn(page, user.email, user.password);
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    expect(await sessionOf(page.request)).toBeNull();
    // A wrong code stays on the screen.
    await page.getByLabel("Six-digit code").fill("000000");
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That code didn't work. Check it and try again.")).toBeVisible();
    await page.getByLabel("Six-digit code").fill(totpCode(totpURI));
    await page.getByRole("button", { name: "Continue" }).click();
    await expectSignedIn(page);

    // Again, with a backup code.
    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await expect(page.getByRole("heading", { name: "Enter your code" })).toBeVisible();
    await page.getByRole("button", { name: "Use a backup code instead" }).click();
    await page.getByLabel("Backup code").fill(backupCodes[0]!);
    await page.getByRole("button", { name: "Continue" }).click();
    await expectSignedIn(page);

    // The same backup code a second time is refused.
    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await page.getByRole("button", { name: "Use a backup code instead" }).click();
    await page.getByLabel("Backup code").fill(backupCodes[0]!);
    await page.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByText("That code didn't work. Check it and try again.")).toBeVisible();
    expect(await sessionOf(page.request)).toBeNull();
  });

  test("a wrong password says so, and a correct one before verification leads to the verify screen", async ({
    page,
    clientIp,
    origins,
  }) => {
    await stubTurnstile(page);
    const email = freshEmail();
    const signUp = await page.request.post("/api/auth/sign-up/email", {
      headers: api(origins.app, clientIp, { "x-captcha-response": TURNSTILE_TEST_TOKEN }),
      data: {
        email,
        password: FIXTURE_PASSWORD,
        name: "Unverified",
        inviteCode: await createInvite(),
        birthYear: 1990,
        birthMonth: 5,
        acceptTerms: true,
      },
    });
    expect(signUp.status()).toBe(200);
    await page.goto("/login");
    await fillSignIn(page, email, "not the password at all!");
    await expect(page.getByText("Wrong email or password.")).toBeVisible();
    await fillSignIn(page, email, FIXTURE_PASSWORD);
    await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
    expect(await sessionOf(page.request)).toBeNull();
  });

  test("password reset: the mailed link leads to a new password, which signs in; the old one does not", async ({
    page,
    request,
    clientIp,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(request, { clientIp });
    const newPassword = "a brand new password 2026!";
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "Reset your password" })).toBeVisible();
    await page.getByLabel("Email").fill(user.email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(page.getByText(/If that address has an account, a reset link is on its way/)).toBeVisible();

    await page.goto(await linkFromMail(user.email, "Reset your password", "/api/auth/reset-password/"));
    await expect(page.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
    await page.getByLabel("New password").fill(newPassword);
    await page.getByRole("button", { name: "Change password" }).click();
    await expect(page.getByText("Password changed. Sign in with the new one.")).toBeVisible();
    // Every session the account had is gone, and the owner has been told.
    expect(await sessionOf(request, true)).toBeNull();
    await latestMailTo(user.email, { subject: "Your password was changed" });

    await fillSignIn(page, user.email, user.password);
    await expect(page.getByText("Wrong email or password.")).toBeVisible();
    await fillSignIn(page, user.email, newPassword);
    await expectSignedIn(page);
  });
});

test.describe("Google", () => {
  /** Answers the browser's trip to Google: straight back to our callback with a code for `profile`. */
  async function standInForGoogle(
    page: Page,
    origin: string,
    profile: { sub: string; email: string; name: string },
  ) {
    const code = `test.${Buffer.from(JSON.stringify(profile)).toString("base64url")}`;
    let visits = 0;
    await page.route("https://accounts.google.com/**", (route) => {
      visits += 1;
      const state = new URL(route.request().url()).searchParams.get("state") ?? "";
      return route.fulfill({
        status: 302,
        headers: {
          location: `${origin}/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
        },
      });
    });
    return { visits: () => visits };
  }

  test("without the intent step (the button on the sign-in screen, no account yet): refused, nothing created", async ({
    page,
    clientIp,
    origins,
  }) => {
    expect(clientIp).toBeTruthy();
    await stubTurnstile(page);
    const email = freshEmail();
    const google = await standInForGoogle(page, origins.app, {
      sub: `g-${Date.now()}-${Math.random()}`,
      email,
      name: "Gina Google",
    });
    await page.goto("/login");
    await expectSignInScreen(page);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    // Back on the sign-in screen, with the refusal in the address — and no account, no session.
    await expect(page).toHaveURL(/\/login\?error=SIGNUP_INTENT_REQUIRED/);
    await expectSignInScreen(page);
    expect(google.visits()).toBe(1);
    expect(new URL(page.url()).searchParams.get("error_description")).toBe(
      "Start sign-up from the Holdfast sign-up page.",
    );
    expect(await userRow(email)).toBeNull();
    expect(await sessionOf(page.request)).toBeNull();
  });

  test("with the intent step (the button on the sign-up screen): an account under the policy, signed in", async ({
    page,
    clientIp,
    origins,
  }) => {
    expect(clientIp).toBeTruthy();
    await stubTurnstile(page);
    const email = freshEmail();
    const invite = await createInvite();
    await standInForGoogle(page, origins.app, {
      sub: `g-${Date.now()}-${Math.random()}`,
      email,
      name: "Gina Google",
    });
    await page.goto("/signup");
    await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();
    // Only what the intent needs: invite, age, assent.
    await page.getByLabel("Invite code").fill(invite);
    await page.getByLabel("Month").fill("5");
    await page.getByLabel("Year").fill("1990");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Continue with Google" }).click();
    await expectSignedIn(page);
    expect(await userRow(email)).toMatchObject({
      email_verified: true,
      role: "user",
      terms_version: expect.any(String),
    });
    const used = await localDb((db) =>
      db.query<{ uses: number }>("SELECT uses FROM invites WHERE code = $1", [invite]),
    );
    expect(used.rows[0]?.uses).toBe(1);
    // The intent cookie was single-use and is gone.
    expect((await page.context().cookies()).some((cookie) => cookie.name === "hf_intent")).toBe(false);
  });
});

test.describe("account state", () => {
  test("suspension: the session ends and signing in says why", async ({ page, clientIp }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await page.goto("/");
    await expectSignedIn(page);
    // What suspendUser does (the admin console that calls it is a later task): the flag, and
    // every session row gone.
    await localDb(async (db) => {
      await db.query(
        `UPDATE "user" SET suspended_at = (now() AT TIME ZONE 'UTC'), suspended_reason = 'e2e' WHERE id = $1`,
        [user.id],
      );
      await db.query("DELETE FROM session WHERE user_id = $1", [user.id]);
    });
    expect(await sessionOf(page.request, true)).toBeNull();
    await page.context().clearCookies();
    await page.goto("/login");
    await fillSignIn(page, user.email, user.password);
    await expect(page.getByText("This account is suspended. Contact support.")).toBeVisible();
    expect(await sessionOf(page.request)).toBeNull();
  });

  test("deletion: requested by mail link → scheduled → banner survives a new sign-in → cancelled only by the banner", async ({
    page,
    clientIp,
    origins,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    // The request (the screen that sends it is a later task): Better Auth's own endpoint.
    const asked = await page.request.post("/api/auth/delete-user", {
      headers: api(origins.app, clientIp),
      data: {},
    });
    expect(asked.status()).toBe(200);
    expect(await asked.json()).toEqual({ success: true, message: "Verification email sent" });
    expect((await userRow(user.email))?.delete_scheduled_at).toBeNull();

    // The mailed link, opened in the signed-in page: the account page, with the banner.
    await page.goto(
      await linkFromMail(
        user.email,
        "Confirm that you want to delete your account",
        "/api/auth/delete-user/callback",
      ),
    );
    await expect(page).toHaveURL(/\/account\?deletion=scheduled$/);
    const banner = page.getByText(/This account is scheduled for deletion on /);
    await expect(banner).toBeVisible();
    await expectSignedIn(page);
    expect((await userRow(user.email))?.delete_scheduled_at).not.toBeNull();
    await latestMailTo(user.email, { subject: "Your account is scheduled for deletion" });

    // Signing out and in again cancels nothing.
    await signOutThroughTheUi(page);
    await fillSignIn(page, user.email, user.password);
    await expectSignedIn(page);
    await expect(banner).toBeVisible();
    expect((await userRow(user.email))?.delete_scheduled_at).not.toBeNull();

    // The explicit cancel.
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    await expect(page.getByText("Deletion cancelled.")).toBeVisible();
    await expect(banner).toHaveCount(0);
    expect((await userRow(user.email))?.delete_scheduled_at).toBeNull();
    await latestMailTo(user.email, { subject: "Account deletion cancelled" });
    // …and it stays gone after a reload.
    await page.reload();
    await expectSignedIn(page);
    await expect(banner).toHaveCount(0);
  });

  test("terms: a newer version blocks the app and every mutation until it is accepted", async ({
    page,
    clientIp,
    origins,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    // This account accepted an older version (the setting itself is shared by every test).
    await localDb((db) => db.query(`UPDATE "user" SET terms_version = '2001-01' WHERE id = $1`, [user.id]));
    // The cookie cache catches up (60 s in real time).
    expect((await sessionOf(page.request, true))?.user.termsVersion).toBe("2001-01");

    const mutate = () =>
      page.request.post("/api/auth-intent", {
        headers: api(origins.app, clientIp),
        data: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: "none" },
      });
    const blocked = await mutate();
    expect(blocked.status()).toBe(403);
    expect(((await blocked.json()) as { error: string }).error).toBe("terms_required");

    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "We've updated the Terms and Privacy Policy." }),
    ).toBeVisible();
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Accept and continue" }).click();
    await expectSignedIn(page);
    expect((await userRow(user.email))?.terms_version).not.toBe("2001-01");
    // At once: the next mutation is no longer a terms refusal.
    const after = await mutate();
    expect(((await after.json()) as { error?: string }).error).not.toBe("terms_required");
  });
});

test.describe("the fixtures", () => {
  test("signedInUser is verified; signedInAdmin2fa is an admin with two-factor on an ordinary session", async ({
    page,
    request,
    clientIp,
    origins,
  }) => {
    const user = await signedInUser(request, { clientIp });
    const plain = await sessionOf(request);
    // What requireVerified asks.
    expect(plain?.user).toMatchObject({ id: user.id, emailVerified: true });
    expect(hasAdminRole(String(plain?.user.role))).toBe(false);

    const admin = await signedInAdmin2fa(page, { clientIp });
    const session = await sessionOf(page.request, true);
    // What requireAdmin asks: the role, two-factor, and not an impersonated session.
    expect(session?.user.id).toBe(admin.id);
    expect(hasAdminRole(String(session?.user.role))).toBe(true);
    expect(session?.user.twoFactorEnabled).toBe(true);
    expect(session?.session.impersonatedBy ?? null).toBeNull();
    expect(session?.user.emailVerified).toBe(true);

    // And the gate in front of the admin plugin, which applies that same rule, lets it through —
    // while the plain user, and any endpoint outside the allow-list, are refused.
    const allowed = await page.request.post("/api/auth/admin/set-role", {
      headers: api(origins.app, clientIp),
      data: { userId: user.id, role: "user" },
    });
    expect(allowed.status()).toBe(200);
    const asUser = await request.post("/api/auth/admin/set-role", {
      headers: api(origins.app, clientIp),
      data: { userId: user.id, role: "admin" },
    });
    expect(asUser.status()).toBe(403);
    const removed = await page.request.post("/api/auth/admin/remove-user", {
      headers: api(origins.app, clientIp),
      data: { userId: user.id },
    });
    expect(removed.status()).toBe(403);
    expect(await userRow(user.email)).toMatchObject({ role: "user" });
  });
});

test.describe("scripts/create-session.ts", () => {
  test("create → the dev server accepts the cookie → --delete", async ({ request, origins }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "a Node script: one run is enough");
    const dir = mkdtempSync(join(tmpdir(), "holdfast-session-"));
    const out = join(dir, "session.json");
    const email = `remote-spec-${Date.now()}@holdfast-e2e.example`;
    // The secret is read for the child process only; it is never printed.
    const secret =
      readVars(join(process.cwd(), ".dev.vars"), ["BETTER_AUTH_SECRET"]).BETTER_AUTH_SECRET ?? "";
    expect(secret.length).toBeGreaterThan(0);
    const env = {
      ...process.env,
      DATABASE_URL_DIRECT: localDbUrl(localDbName()),
      BETTER_AUTH_SECRET: secret,
    };
    const script = ["tsx", "scripts/create-session.ts"];
    try {
      const created = await run(
        "npx",
        [
          ...script,
          "--origin",
          origins.app,
          "--out",
          out,
          "--email",
          email,
          "--role",
          "admin",
          "--two-factor",
        ],
        { env },
      );
      // Nothing secret on either stream.
      expect(created.stdout).toBe("");
      expect(created.stderr).not.toContain(secret);
      expect(statSync(out).mode & 0o777).toBe(0o600);
      const file = JSON.parse(readFileSync(out, "utf8")) as {
        header: string;
        user: { id: string; email: string };
      };
      expect(created.stderr).not.toContain(file.header.split("=")[1]!);
      expect(file.user.id).toMatch(/^[A-Za-z0-9]{32}$/);

      const accepted = await request.get("/api/auth/get-session", { headers: { cookie: file.header } });
      const session = (await accepted.json()) as Session;
      expect(session?.user).toMatchObject({
        id: file.user.id,
        email,
        emailVerified: true,
        role: "admin",
        twoFactorEnabled: true,
      });
      expect(String(session?.session.id)).toMatch(/^[A-Za-z0-9]{32}$/);
      // One of our own routes accepts it too.
      const ours = await request.get("/api/account/deletion-status", { headers: { cookie: file.header } });
      expect(ours.status()).toBe(200);

      await run("npx", [...script, "--delete", "--email", email], { env });
      const gone = await request.get("/api/auth/get-session?disableCookieCache=true", {
        headers: { cookie: file.header },
      });
      expect(await gone.json()).toBeNull();
      expect(await userRow(email)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
