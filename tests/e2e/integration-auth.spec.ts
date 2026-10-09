// Flows that cross tasks and could not exist before the real auth backend was mounted: the
// shell's 401 re-auth (T08) against a session that has REALLY ended on the server (T06/T07),
// with the identity guard; a session past its deletion date; the operator's bootstrap invite.
// Nothing under /api is mocked. The Turnstile widget script is the stand-in; Google is not used.
//
// "A session that has really ended": the session row is deleted in the database. The browser
// still sends its session cookie; the server — not a mock — reads the database, finds nobody,
// and answers 401 from the next request on.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { BrowserContext, Page } from "@playwright/test";
import {
  createInvite,
  FIXTURE_PASSWORD,
  freshEmail,
  localDb,
  signedInUser,
  TURNSTILE_TEST_TOKEN,
  type SignedInUser,
} from "../setup/auth-fixtures";
import { localDbUrl } from "../setup/local-env";
import { expect, latestMailTo, linksIn, stubTurnstile, test } from "./fixtures";

const run = promisify(execFile);

const expectSignedIn = (page: Page) =>
  expect(page.getByRole("button", { name: "Account menu" }).first()).toBeVisible();

async function sessionUser(page: Page): Promise<{ id: string; email: string } | null> {
  const response = await page.request.get("/api/auth/get-session?disableCookieCache=true");
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { user: { id: string; email: string } } | null;
  return body?.user ?? null;
}

const deletionDate = async (userId: string) =>
  (
    await localDb((db) =>
      db.query<{ delete_scheduled_at: Date | null }>('SELECT delete_scheduled_at FROM "user" WHERE id = $1', [
        userId,
      ]),
    )
  ).rows[0]?.delete_scheduled_at ?? null;

/**
 * Ends every session of the user for real: the rows are deleted. The browser keeps its session
 * cookie, which is worth nothing from the next request on: the server asks the database, and
 * there is no cookie cache (no signed copy of the session in the browser) to answer instead.
 */
async function endSessionsOf(context: BrowserContext, userId: string): Promise<void> {
  const cookies = await context.cookies();
  expect(cookies.some((cookie) => cookie.name.includes("session_token"))).toBe(true);
  expect(
    cookies.filter((cookie) => cookie.name.includes("session_data")),
    "no cookie cache is ever set",
  ).toEqual([]);
  const removed = await localDb((db) => db.query("DELETE FROM session WHERE user_id = $1", [userId]));
  expect(removed.rowCount, "the user had a session row").toBeGreaterThan(0);
}

/**
 * While it is in force, the shell's background read of the deletion status (refetched on focus
 * and when stale) does not reach the server — so that the request which meets the ended session
 * is the one the test makes, the person's own click, and not a read that happened to fire first
 * and opened the dialog by itself.
 */
async function holdBackgroundReads(page: Page): Promise<() => Promise<void>> {
  const pattern = "**/api/account/deletion-status";
  await page.route(pattern, (route) => route.abort());
  return () => page.unroute(pattern);
}

/** Schedules the signed-in user's deletion the real way: Better Auth's request, then the mailed link. */
async function scheduleDeletion(page: Page, user: SignedInUser, origin: string, clientIp: string) {
  const asked = await page.request.post("/api/auth/delete-user", {
    headers: { origin, "cf-connecting-ip": clientIp },
    data: {},
  });
  expect(asked.status()).toBe(200);
  const mail = await latestMailTo(user.email, { subject: "Confirm that you want to delete your account" });
  const link = linksIn(mail).find((url) => url.includes("/api/auth/delete-user/callback"));
  if (!link) throw new Error("no delete-callback link in the mail");
  await page.goto(link);
  await expect(page.getByText(/This account is scheduled for deletion on /)).toBeVisible();
  expect(await deletionDate(user.id)).not.toBeNull();
  // The landing re-reads the session and the deletion status and then takes `?deletion=scheduled`
  // out of the address — a navigation, whose guard reads the session once more. Let all of that
  // finish: a test that ends the session while it is still under way is racing the shell's own
  // session read, which (rightly) answers an ended session with the sign-in screen.
  await expect(page).toHaveURL(/\/account$/);
  await page.waitForLoadState("networkidle");
}

test.describe("re-authentication after the session really ended", () => {
  test("the same person signs in again in the dialog: the held request is replayed, once", async ({
    page,
    clientIp,
    origins,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await scheduleDeletion(page, user, origins.app, clientIp);
    const release = await holdBackgroundReads(page);
    await endSessionsOf(page.context(), user.id);

    // The request the person makes next is answered 401 by the server…
    const cancels: number[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith("/api/account/deletion/cancel")) cancels.push(response.status());
    });
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    // …and the shell asks for the password over the page, instead of losing the click.
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Your session ended")).toBeVisible();
    await release();
    expect(cancels).toEqual([401]);
    expect(await deletionDate(user.id), "nothing was cancelled by the refused request").not.toBeNull();
    await expect(dialog.getByLabel("Email")).toHaveValue(user.email);

    await dialog.getByLabel("Password").fill(user.password);
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    // Signed in as the same account: the cancel is sent again and this time it is done.
    await expect(page.getByText("Deletion cancelled.")).toBeVisible();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText(/This account is scheduled for deletion on /)).toHaveCount(0);
    expect(cancels).toEqual([401, 200]);
    expect(await deletionDate(user.id)).toBeNull();
    expect((await sessionUser(page))?.id).toBe(user.id);
  });

  test("a wrong password in the dialog replays nothing", async ({ page, clientIp, origins }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await scheduleDeletion(page, user, origins.app, clientIp);
    const release = await holdBackgroundReads(page);
    await endSessionsOf(page.context(), user.id);
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Your session ended")).toBeVisible();
    await release();
    await dialog.getByLabel("Password").fill("not the password at all!");
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(
      "That didn't work. Check your password and try again.",
    );
    expect(await deletionDate(user.id)).not.toBeNull();
    expect(await sessionUser(page)).toBeNull();
    // The dialog is still there, and a second attempt (a fresh human-check token) works.
    await dialog.getByLabel("Password").fill(user.password);
    await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Deletion cancelled.")).toBeVisible();
    expect(await deletionDate(user.id)).toBeNull();
  });

  test("ANOTHER person signs in through the dialog (their passkey): nothing is replayed, and the first account's state is gone", async ({
    page,
    clientIp,
    origins,
    virtualAuthenticator,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "one virtual authenticator, one project");
    await stubTurnstile(page);
    // B: an account with a passkey on this device.
    const other = await signedInUser(page, { clientIp });
    await page.goto("/");
    await expectSignedIn(page);
    const registered = await page.evaluate(async () => {
      const path = "/src/client/lib/auth-client.ts";
      const { betterAuthClient } = (await import(/* @vite-ignore */ path)) as {
        betterAuthClient: {
          passkey: { addPasskey(input: { name: string }): Promise<{ error?: unknown } | undefined> };
        };
      };
      const result = await betterAuthClient.passkey.addPasskey({ name: "the other person's key" });
      return result?.error ? "error" : "ok";
    });
    expect(registered).toBe("ok");
    expect(await virtualAuthenticator.credentials()).toHaveLength(1);
    expect(
      (
        await page.request.post("/api/auth/sign-out", {
          headers: { origin: origins.app, "cf-connecting-ip": clientIp },
          data: {},
        })
      ).status(),
    ).toBe(200);

    // A: signs in on the same browser, schedules a deletion, and their session ends.
    const user = await signedInUser(page, { clientIp });
    expect(user.id).not.toBe(other.id);
    await scheduleDeletion(page, user, origins.app, clientIp);
    const release = await holdBackgroundReads(page);
    await endSessionsOf(page.context(), user.id);
    const cancels: number[] = [];
    page.on("response", (response) => {
      if (response.url().endsWith("/api/account/deletion/cancel")) cancels.push(response.status());
    });
    await page.getByRole("button", { name: "Cancel deletion" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByText("Your session ended")).toBeVisible();
    await release();

    // The passkey on this device is B's. B is who is signed in afterwards…
    await dialog.getByRole("button", { name: "Continue with passkey" }).click();
    await expect.poll(async () => (await sessionUser(page))?.id).toBe(other.id);
    await expect(page).toHaveURL(new RegExp(`^${origins.app}/$`));
    await expectSignedIn(page);
    // …and A's click was NOT carried out in B's name or anyone's: one refused request, no second.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(cancels).toEqual([401]);
    expect(await deletionDate(user.id), "A's deletion is still scheduled").not.toBeNull();
    expect(await deletionDate(other.id)).toBeNull();
    // Nothing of A is on B's screen: no banner about a deletion B never asked for, no A address.
    await expect(page.getByText(/This account is scheduled for deletion on /)).toHaveCount(0);
    expect(await page.evaluate(() => document.body.innerText)).not.toContain(user.email);
  });
});

test.describe("a suspended account", () => {
  test("cannot sign in with its passkey; the session it had is nobody on the next request", async ({
    page,
    clientIp,
    origins,
    virtualAuthenticator,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "one virtual authenticator, one project");
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await page.goto("/");
    await expectSignedIn(page);
    const registered = await page.evaluate(async () => {
      const path = "/src/client/lib/auth-client.ts";
      const { betterAuthClient } = (await import(/* @vite-ignore */ path)) as {
        betterAuthClient: {
          passkey: { addPasskey(input: { name: string }): Promise<{ error?: unknown } | undefined> };
        };
      };
      return (await betterAuthClient.passkey.addPasskey({ name: "key" }))?.error ? "error" : "ok";
    });
    expect(registered).toBe("ok");
    expect(await virtualAuthenticator.credentials()).toHaveLength(1);

    // Control: in good standing the passkey signs in.
    await page.request.post("/api/auth/sign-out", {
      headers: { origin: origins.app, "cf-connecting-ip": clientIp },
      data: {},
    });
    await page.goto("/login");
    await page.getByRole("button", { name: "Continue with passkey" }).click();
    await expectSignedIn(page);
    expect((await sessionUser(page))?.id).toBe(user.id);

    // What suspendUser does (the admin console that calls it is a later task): the flag, and
    // every session row gone. The browser keeps its session cookie.
    await localDb(async (db) => {
      await db.query(
        `UPDATE "user" SET suspended_at = (now() AT TIME ZONE 'UTC'), suspended_reason = 'e2e' WHERE id = $1`,
        [user.id],
      );
      await db.query("DELETE FROM session WHERE user_id = $1", [user.id]);
    });
    // The very next request with that cookie is nobody: there is no grace period of any kind.
    const next = await page.request.get("/api/account/deletion-status");
    expect(next.status()).toBe(401);
    const write = await page.request.post("/api/auth/update-user", {
      headers: { origin: origins.app, "cf-connecting-ip": clientIp },
      data: { name: "Still Here" },
    });
    expect(write.status()).toBe(401);

    // And the passkey starts no session.
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByRole("button", { name: "Continue with passkey" }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect(await sessionUser(page)).toBeNull();
    expect(
      (await localDb((db) => db.query("SELECT 1 FROM session WHERE user_id = $1", [user.id]))).rowCount,
    ).toBe(0);
  });
});

test.describe("a session past its deletion date", () => {
  test("resolves to nobody on the live handler, is revoked on first sight, and the shell shows the sign-in screen", async ({
    page,
    clientIp,
    origins,
  }) => {
    await stubTurnstile(page);
    const user = await signedInUser(page, { clientIp });
    await page.goto("/");
    await expectSignedIn(page);
    // The date passed an hour ago (a held account would look exactly like this, with no purge).
    await localDb((db) =>
      db.query(
        `UPDATE "user" SET delete_scheduled_at = (now() AT TIME ZONE 'UTC') - interval '1 hour' WHERE id = $1`,
        [user.id],
      ),
    );

    expect(await sessionUser(page)).toBeNull();
    // A write under /api/auth with that cookie changes nothing (endpoint-policy: only sign-out).
    const write = await page.request.post("/api/auth/update-user", {
      headers: { origin: origins.app, "cf-connecting-ip": clientIp },
      data: { name: "Still Here" },
    });
    expect(write.status()).toBe(401);
    await expect
      .poll(
        async () =>
          (await localDb((db) => db.query("SELECT 1 FROM session WHERE user_id = $1", [user.id]))).rowCount,
      )
      .toBe(0);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    // Signing in again is the ordinary wrong-credentials answer: the account behaves as deleted.
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("Wrong email or password.")).toBeVisible();
  });
});

test.describe("bootstrap", () => {
  test("a code made by scripts/create-invite.ts admits exactly one sign-up", async ({
    request,
    clientIp,
    origins,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "a script run, not a browser test");
    const { stdout, stderr } = await run(
      "npx",
      ["tsx", "scripts/create-invite.ts", "--uses", "1", "--note", "e2e bootstrap"],
      {
        env: {
          ...process.env,
          DATABASE_URL_DIRECT: localDbUrl(),
          CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: "false",
        },
      },
    );
    const code = stdout.trim();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{5}(-[A-HJKMNP-Z2-9]{5}){3}$/);
    // The code goes to stdout alone; the summary (with the HOST, never the URL) to stderr.
    expect(stderr).toMatch(/created 1 invite code\(s\) on (localhost|127\.0\.0\.1)/);
    expect(stderr).not.toContain(code);
    expect(stderr).not.toContain("postgres://");
    const signUp = (email: string) =>
      request.post("/api/auth/sign-up/email", {
        headers: {
          origin: origins.app,
          "cf-connecting-ip": clientIp,
          "x-captcha-response": TURNSTILE_TEST_TOKEN,
        },
        data: {
          email,
          password: FIXTURE_PASSWORD,
          name: "First Admin",
          inviteCode: code,
          birthYear: 1990,
          birthMonth: 5,
          acceptTerms: true,
        },
      });
    expect((await signUp(freshEmail())).status()).toBe(200);
    const again = await signUp(freshEmail());
    expect(again.status()).toBe(400);
    expect(await again.json()).toMatchObject({ code: "INVITE_INVALID" });
    const row = await localDb((db) =>
      db.query<{ uses: number; note: string }>("SELECT uses, note FROM invites WHERE code = $1", [code]),
    );
    expect(row.rows[0]).toEqual({ uses: 1, note: "e2e bootstrap" });
    expect(await createInvite()).toMatch(/^E2E-/);
  });
});
