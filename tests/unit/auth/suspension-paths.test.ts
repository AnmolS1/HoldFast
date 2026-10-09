// A suspended account cannot START a session — by any way a session comes into being.
//
// There is one gate: `checkSessionStart` (services/signup-policy.ts), called from Better Auth's
// `databaseHooks.session.create.before` (auth/hooks.ts), which every path that makes a session
// row goes through. One test with a password proves the gate; it does not prove that the
// passkey, the second factor, Google or a mailed link reach it. Each path has its own case here
// (the passkey, which needs an authenticator, is tests/e2e/integration-auth.spec.ts), and the
// control for all of them is the same one-line mutant: remove the suspension refusal from
// `checkSessionStart` and every case below fails.
//
// And the enumeration rule: "suspended" is said only AFTER the right credential. A wrong password
// for a suspended account is the answer any wrong password gets.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { user } from "../../../src/worker/db/schema";
import { suspendUser, SYSTEM_ACTOR } from "../../../src/worker/services/account-state";
import {
  CAPTCHA,
  enableTotp,
  getSession,
  linkIn,
  newClient,
  PASSWORD,
  promoteToAdmin,
  send,
  serviceDeps,
  sessionsOf,
  signIn,
  signUp,
  testDb,
  nextTotp,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
  type Sent,
} from "./helpers";

async function suspend(userId: string): Promise<void> {
  const { deps, settle } = serviceDeps();
  expect(await suspendUser(deps, userId, "test", SYSTEM_ACTOR)).toBe(true);
  await settle();
  expect(await sessionsOf(userId), "suspension ends every session").toEqual([]);
}

/** Makes browsers that hold exactly the cookies `client` holds NOW (same address too). */
function sameCookies(client: Client): () => Client {
  const held = new Map(client.cookies);
  return () => {
    const browser = newClient({ ip: client.ip });
    for (const [name, value] of held) browser.cookies.set(name, value);
    return browser;
  };
}

const SUSPENDED = { code: "ACCOUNT_SUSPENDED", message: "This account is suspended. Contact support." };

/** No session row, no session for the browser, whatever the answer was. */
async function expectNoSession(client: Client, userId: string, path: string): Promise<void> {
  expect(await sessionsOf(userId), `${path}: no session row`).toEqual([]);
  expect(await getSession(client), `${path}: the browser has no session`).toBeNull();
}

describe("a suspended account cannot start a session", () => {
  it("email + password: the right password is told 'suspended'; a wrong one is told what any wrong password is told", async () => {
    const { user: row, email } = await verifiedUser();
    const other = await verifiedUser();
    await suspend(row.id);

    const right = newClient();
    const refused = await signIn(right, email);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject(SUSPENDED);
    await expectNoSession(right, row.id, "password");

    // The wrong password: status, body and cookies are those of an ordinary account's wrong password.
    const wrongHere = await signIn(newClient(), email, "not the password at all!");
    const wrongThere = await signIn(newClient(), other.email, "not the password at all!");
    expect(wrongHere.status).toBe(401);
    expect(wrongHere.status).toBe(wrongThere.status);
    expect(wrongHere.body).toEqual(wrongThere.body);
    expect(wrongHere.setCookies).toEqual(wrongThere.setCookies);
    expect(JSON.stringify(wrongHere.body)).not.toMatch(/suspend/i);
  });

  it("the second factor: a TOTP code, and a backup code, after the password step — no session", async () => {
    for (const factor of ["totp", "backup"] as const) {
      const { client, user: row, email } = await verifiedUser();
      const { totpURI, backupCodes } = await enableTotp(client);
      await send(client, "/api/auth/sign-out", { json: {} });
      // The password step passes while the account is in good standing…
      const browser = newClient();
      const first = await signIn(browser, email);
      expect(first.status, first.text).toBe(200);
      expect(first.body).toMatchObject({ twoFactorRedirect: true });
      expect(await sessionsOf(row.id)).toEqual([]);
      // …the account is suspended, and the code that would have finished the sign-in does not.
      await suspend(row.id);
      const second: Sent =
        factor === "totp"
          ? await send(browser, "/api/auth/two-factor/verify-totp", {
              json: { code: await nextTotp(totpURI) },
            })
          : await send(browser, "/api/auth/two-factor/verify-backup-code", {
              json: { code: backupCodes[0] },
            });
      expect(second.status, `${factor}: ${second.text}`).toBeGreaterThanOrEqual(400);
      await expectNoSession(browser, row.id, factor);
      // And from the start: the password step itself is refused now.
      const again = await signIn(newClient(), email);
      expect(again.status).toBe(403);
      expect(again.body).toMatchObject(SUSPENDED);
    }
  });

  it("Google: an existing account that signs in with Google gets no session", async () => {
    const { user: row, email } = await verifiedUser();
    const profile = { sub: `g-${crypto.randomUUID()}`, email, name: "Gina Google" };
    const roundTrip = async (client: Client) => {
      const start = await send(client, "/api/auth/sign-in/social", {
        json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
      });
      expect(start.status, start.text).toBe(200);
      const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
      return send(
        client,
        `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
        { browser: false },
      );
    };
    // In good standing it works (and links the Google identity): the control for this path.
    const before = newClient();
    expect((await roundTrip(before)).headers.get("location")).toBe("/");
    expect((await getSession(before))?.user.id).toBe(row.id);

    await suspend(row.id);
    const after = newClient();
    const callback = await roundTrip(after);
    expect(callback.status).toBe(302);
    const location = new URL(callback.headers.get("location") ?? "/", "http://localhost");
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).not.toBeNull();
    await expectNoSession(after, row.id, "google");
  });

  it("the verification link (which signs in): the address is confirmed, and no session starts", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const row = await userByEmail(email);
    const link = linkIn(await waitForMail(email, "verification"));
    // Suspended before the address was ever confirmed (no session to end yet).
    const { deps, settle } = serviceDeps();
    expect(await suspendUser(deps, row!.id, "test", SYSTEM_ACTOR)).toBe(true);
    await settle();
    await send(client, link);
    await expectNoSession(client, row!.id, "verification link");
    // With the address now confirmed or not, a password sign-in still starts nothing.
    const signedIn = await signIn(newClient(), email);
    expect(signedIn.status).toBe(403);
    expect(await sessionsOf(row!.id)).toEqual([]);
  });

  it("a password reset: the new password is set, every session stays ended, and it starts none", async () => {
    const { client, user: row, email } = await verifiedUser();
    await suspend(row.id);
    const asked = await send(newClient(), "/api/auth/request-password-reset", {
      json: { email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    expect(asked.status).toBe(200);
    const mailed = linkIn(await waitForMail(email, "passwordReset"));
    const token = /reset-password\/([^?/]+)/.exec(mailed)?.[1] ?? "";
    expect(token).not.toBe("");
    const reset = await send(client, "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: "a brand new password 42!", token },
    });
    expect(reset.status, reset.text).toBe(200);
    expect(await sessionsOf(row.id), "the reset started no session").toEqual([]);
    expect(
      reset.setCookies.filter((cookie) => cookie.includes("session_token") && !/max-age=0/i.test(cookie)),
    ).toEqual([]);
    const withNew = await signIn(newClient(), email, "a brand new password 42!");
    expect(withNew.status).toBe(403);
    expect(withNew.body).toMatchObject(SUSPENDED);
    expect(await sessionsOf(row.id)).toEqual([]);
  });

  it("a session that existed before the suspension is gone, and the cookie it left resolves to nobody", async () => {
    const { client, user: row } = await verifiedUser();
    expect((await getSession(client))?.user.id).toBe(row.id);
    await suspend(row.id);
    // NO COOKIE-CACHE WINDOW: the cache is off (auth/create-auth.ts), so the browser holds no
    // signed copy of the session, and both the pipeline and the auth handler resolve the session
    // from the database. The very next request — an app route, an auth write, even the session
    // read the shell draws from — finds nobody.
    expect([...client.cookies.keys()].filter((name) => name.includes("session_data"))).toEqual([]);
    // One browser per request, each holding the same cookies as they were at the suspension: an
    // answer that deletes the cookies (Better Auth does, once it finds nobody) must not be what
    // makes the NEXT request fail.
    const asThen = sameCookies(client);
    const appRead = await send(asThen(), "/api/account/deletion-status");
    const appWrite = await send(asThen(), "/api/account/deletion/cancel", { json: {} });
    const authWrite = await send(asThen(), "/api/auth/update-user", { json: { name: "Still Here" } });
    const authRead = await send(asThen(), "/api/auth/list-sessions");
    const sessionRead = await send(asThen(), "/api/auth/get-session");
    expect({
      sessionRead: sessionRead.body,
      appRead: appRead.status,
      appWrite: appWrite.status,
      authWrite: authWrite.status,
      authRead: authRead.status,
    }).toEqual({ sessionRead: null, appRead: 401, appWrite: 401, authWrite: 401, authRead: 401 });
    expect((await userById(row.id))!.name).not.toBe("Still Here");
  });

  it("control: the same requests from an account in good standing all answer", async () => {
    const { client, user: row } = await verifiedUser();
    expect(((await send(client, "/api/auth/get-session")).body as { user: { id: string } }).user.id).toBe(
      row.id,
    );
    expect((await send(client, "/api/account/deletion-status")).status).toBe(200);
    expect((await send(client, "/api/auth/update-user", { json: { name: "Renamed" } })).status).toBe(200);
    expect((await send(client, "/api/auth/list-sessions")).status).toBe(200);
    expect((await userById(row.id))!.name).toBe("Renamed");
  });

  it("a password reset ends the sessions on every other device at once — not after the cache's minute", async () => {
    const { client: laptop, user: row, email } = await verifiedUser();
    const phone = newClient();
    expect((await signIn(phone, email)).status).toBe(200);
    expect(await sessionsOf(row.id)).toHaveLength(2);
    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const token =
      /reset-password\/([^?/]+)/.exec(linkIn(await waitForMail(email, "passwordReset")))?.[1] ?? "";
    const reset = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: "a brand new password 42!", token },
    });
    expect(reset.status, reset.text).toBe(200);
    expect(await sessionsOf(row.id), "every session row of the account is gone").toEqual([]);
    for (const [device, browser] of [
      ["laptop", laptop],
      ["phone", phone],
    ] as const) {
      // Each request with the device's cookies as they were (see the suspension case above).
      const asThen = sameCookies(browser);
      expect((await send(asThen(), "/api/account/deletion-status")).status, device).toBe(401);
      expect((await send(asThen(), "/api/auth/update-user", { json: { name: "x" } })).status, device).toBe(
        401,
      );
      expect((await send(asThen(), "/api/auth/get-session")).body, device).toBeNull();
    }
    // The old password no longer signs in; the new one does.
    expect((await signIn(newClient(), email)).status).toBe(401);
    expect((await signIn(newClient(), email, "a brand new password 42!")).status).toBe(200);
  });

  it("an admin cannot start an impersonated session of a suspended account either (stricter than the plan allows — reported)", async () => {
    const admin = await verifiedUser();
    await promoteToAdmin(admin.user.id);
    // The admin's own session must carry the role and two-factor: sign in again after promotion.
    const target = await verifiedUser();
    await suspend(target.user.id);
    const adminClient = newClient();
    await testDb().update(user).set({ twoFactorEnabled: false }).where(eq(user.id, admin.user.id));
    expect((await signIn(adminClient, admin.email, PASSWORD)).status).toBe(200);
    await testDb().update(user).set({ twoFactorEnabled: true }).where(eq(user.id, admin.user.id));
    const impersonate = await send(adminClient, "/api/auth/admin/impersonate-user", {
      json: { userId: target.user.id },
    });
    expect(impersonate.status).toBeGreaterThanOrEqual(400);
    expect(await sessionsOf(target.user.id)).toEqual([]);
  });
});
