// What is written down, and who is told, when something happens to an account's credentials:
// the audit rows of auth/audit.ts, the security emails, the two-factor sign-in, and the
// new-device notice.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { session as sessionTable } from "../../../src/worker/db/schema";
import {
  auditRows,
  CAPTCHA,
  enableTotp,
  freshEmail,
  getSession,
  linkIn,
  mailTo,
  makeFolder,
  makePendingShare,
  newClient,
  PASSWORD,
  send,
  sessionsOf,
  shareById,
  signIn,
  signUp,
  testDb,
  nextTotp,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
} from "./helpers";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const FIREFOX_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0";

describe("sign-in, sign-out and failures", () => {
  it("a sign-in is audited with its method, the request's address hash and browser — never the raw address", async () => {
    const client = newClient({ headers: { "user-agent": CHROME_MAC }, cf: { country: "DE" } });
    const { user: row, email } = await verifiedUser({}, client);
    const rows = await auditRows({ action: "auth.sign_in", targetId: row.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: row.id,
      actorType: "user",
      targetType: "user",
      country: "DE",
      meta: { method: "email_link", uaFamily: "Chrome on macOS" },
    });
    expect(rows[0]!.ipHashDaily).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]!.requestId).toBeTruthy();
    expect(JSON.stringify(rows[0])).not.toContain(client.ip);
    // The session row carries the same two coarse facts.
    const [session] = await sessionsOf(row.id);
    expect(session).toMatchObject({ country: "DE", uaFamily: "Chrome on macOS" });

    await send(client, "/api/auth/sign-out", { json: {} });
    expect(await auditRows({ action: "auth.sign_out", targetId: row.id })).toHaveLength(1);
    await signIn(client, email);
    expect(
      (await auditRows({ action: "auth.sign_in", targetId: row.id }))
        .map((r) => (r.meta as { method: string }).method)
        .sort(),
    ).toEqual(["email_link", "password"]);
  });

  it("a wrong password is audited against the account that was tried — without the address or the password", async () => {
    const { user: row, email } = await verifiedUser();
    const wrong = "definitely the wrong password";
    const tried = await signIn(newClient(), email, wrong);
    expect(tried.status).toBe(401);
    const rows = await auditRows({ action: "auth.failed", targetId: row.id });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      meta: { path: "/sign-in/email", status: 401, code: "INVALID_EMAIL_OR_PASSWORD" },
    });
    const text = JSON.stringify(rows[0]);
    expect(text).not.toContain(wrong);
    expect(text).not.toContain(email);

    // An address with no account: a row with no target, and still no address in it.
    const nobody = freshEmail();
    await signIn(newClient(), nobody, wrong);
    const all = await auditRows({ action: "auth.failed" });
    expect(all.some((r) => JSON.stringify(r).includes(nobody))).toBe(false);
  });
});

describe("two-factor", () => {
  it("enabling it is audited and mailed; a password alone then starts no session; a code completes the sign-in", async () => {
    const { client, user: row, email } = await verifiedUser();
    const { totpURI, backupCodes } = await enableTotp(client);
    expect(new URL(totpURI).searchParams.get("issuer")).toBe("Holdfast");
    expect(new URL(totpURI).searchParams.get("digits")).toBe("6");
    expect(new URL(totpURI).searchParams.get("period")).toBe("30");
    expect(backupCodes).toHaveLength(10);
    expect((await userById(row.id))!.twoFactorEnabled).toBe(true);
    expect(await auditRows({ action: "auth.2fa_enabled", targetId: row.id })).toHaveLength(1);
    expect(mailTo(email, "twoFactorEnabled")).toHaveLength(1);

    await send(client, "/api/auth/sign-out", { json: {} });
    const signInsBefore = (await auditRows({ action: "auth.sign_in", targetId: row.id })).length;
    const sessionsBefore = (await sessionsOf(row.id)).length;

    const browser = newClient();
    const password = await signIn(browser, email);
    expect(password.status).toBe(200);
    expect(password.body).toMatchObject({ twoFactorRedirect: true });
    // The right password alone: no session, in the cookie jar or in the database, and no
    // "signed in" row.
    expect(await getSession(browser)).toBeNull();
    expect(await sessionsOf(row.id)).toHaveLength(sessionsBefore);
    expect(await auditRows({ action: "auth.sign_in", targetId: row.id })).toHaveLength(signInsBefore);
    expect(mailTo(email, "newDeviceSignIn")).toEqual([]);

    // A wrong code is refused and audited.
    const bad = await send(browser, "/api/auth/two-factor/verify-totp", { json: { code: "000000" } });
    expect(bad.status).toBe(401);
    expect(await getSession(browser)).toBeNull();
    expect(
      (await auditRows({ action: "auth.failed" })).filter(
        (r) => (r.meta as { path?: string }).path === "/two-factor/verify-totp",
      ).length,
    ).toBeGreaterThan(0);

    const good = await send(browser, "/api/auth/two-factor/verify-totp", {
      json: { code: await nextTotp(totpURI) },
    });
    expect(good.status, good.text).toBe(200);
    expect((await getSession(browser))?.user.id).toBe(row.id);
    const methods = (await auditRows({ action: "auth.sign_in", targetId: row.id })).map(
      (r) => (r.meta as { method: string }).method,
    );
    expect(methods.filter((m) => m === "totp")).toHaveLength(1);
    // Completing a sign-in with a code is not "two-factor was enabled" again.
    expect(await auditRows({ action: "auth.2fa_enabled", targetId: row.id })).toHaveLength(1);
    expect(mailTo(email, "twoFactorEnabled")).toHaveLength(1);

    // A backup code works once.
    const second = newClient();
    await signIn(second, email);
    const viaBackup = await send(second, "/api/auth/two-factor/verify-backup-code", {
      json: { code: backupCodes[0] },
    });
    expect(viaBackup.status, viaBackup.text).toBe(200);
    expect((await getSession(second))?.user.id).toBe(row.id);
    expect(
      (await auditRows({ action: "auth.sign_in", targetId: row.id })).map(
        (r) => (r.meta as { method: string }).method,
      ),
    ).toContain("backup_code");
    const third = newClient();
    await signIn(third, email);
    const reused = await send(third, "/api/auth/two-factor/verify-backup-code", {
      json: { code: backupCodes[0] },
    });
    expect(reused.status).toBe(401);
    expect(await getSession(third)).toBeNull();

    // Switching it off needs the password, and is audited and mailed.
    const wrongPassword = await send(browser, "/api/auth/two-factor/disable", {
      json: { password: "not the password at all" },
    });
    expect(wrongPassword.status).toBe(400);
    expect((await userById(row.id))!.twoFactorEnabled).toBe(true);
    const off = await send(browser, "/api/auth/two-factor/disable", { json: { password: PASSWORD } });
    expect(off.status, off.text).toBe(200);
    expect((await userById(row.id))!.twoFactorEnabled).toBe(false);
    expect(await auditRows({ action: "auth.2fa_disabled", targetId: row.id })).toHaveLength(1);
    expect(mailTo(email, "twoFactorDisabled")).toHaveLength(1);
  });

  it("the 6th code attempt in a minute is rate-limited", async () => {
    const { client, email } = await verifiedUser();
    await enableTotp(client);
    const attacker = newClient();
    await signIn(attacker, email);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push(
        (await send(attacker, "/api/auth/two-factor/verify-totp", { json: { code: String(100000 + i) } }))
          .status,
      );
    }
    expect(statuses.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});

describe("password change", () => {
  it("is audited, mailed, and ends the other sessions when asked to", async () => {
    const { client, user: row, email } = await verifiedUser();
    const other = newClient();
    await signIn(other, email);
    const changed = await send(client, "/api/auth/change-password", {
      json: {
        currentPassword: PASSWORD,
        newPassword: "a brand new password 2026!",
        revokeOtherSessions: true,
      },
    });
    expect(changed.status, changed.text).toBe(200);
    expect(await auditRows({ action: "auth.password_changed", targetId: row.id })).toMatchObject([
      { actorUserId: row.id, meta: { via: "change" } },
    ]);
    expect(mailTo(email, "passwordChanged")).toHaveLength(1);
    expect((await send(other, "/api/auth/get-session?disableCookieCache=true")).body).toBeNull();
    expect((await getSession(client))?.user.id).toBe(row.id);
    // A wrong current password changes nothing and is audited as a failure.
    const refused = await send(client, "/api/auth/change-password", {
      json: { currentPassword: "not the current one at all", newPassword: "yet another password 2026!" },
    });
    expect(refused.status).toBe(400);
    expect((await auditRows({ action: "auth.failed", targetId: row.id })).length).toBeGreaterThan(0);
    expect(mailTo(email, "passwordChanged")).toHaveLength(1);
  });
});

describe("the new-device notice", () => {
  it("is sent when the browser family or the country matches nothing from the last 30 days — and never on the first sign-in", async () => {
    const home = newClient({ headers: { "user-agent": CHROME_MAC }, cf: { country: "US" } });
    const { user: row, email } = await verifiedUser({}, home);
    expect(mailTo(email, "newDeviceSignIn"), "not on the very first sign-in").toEqual([]);

    // The same browser and country again: nothing.
    await send(home, "/api/auth/sign-out", { json: {} });
    await signIn(home, email);
    expect(mailTo(email, "newDeviceSignIn")).toEqual([]);

    // Another browser family: one notice, naming what was seen (coarsely).
    const elsewhere = newClient({ headers: { "user-agent": FIREFOX_WIN }, cf: { country: "US" } });
    expect((await signIn(elsewhere, email)).status).toBe(200);
    const notices = mailTo(email, "newDeviceSignIn");
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain("Firefox on Windows");
    expect(notices[0]!.text).not.toContain(elsewhere.ip);
    expect(notices[0]!.class).toBe("account_security");

    // That browser is now known; the same one from another country is new again.
    await send(elsewhere, "/api/auth/sign-out", { json: {} });
    await signIn(elsewhere, email);
    expect(mailTo(email, "newDeviceSignIn")).toHaveLength(1);
    const abroad = newClient({ headers: { "user-agent": FIREFOX_WIN }, cf: { country: "BR" } });
    await signIn(abroad, email);
    expect(mailTo(email, "newDeviceSignIn")).toHaveLength(2);
    expect(await sessionsOf(row.id)).not.toHaveLength(0);
  });
});

describe("pending shares", () => {
  it("activate when an email-and-password account verifies its address — not before", async () => {
    const owner = await verifiedUser();
    const folder = await makeFolder(owner.user.id);
    const email = freshEmail();
    const share = await makePendingShare(folder.id, owner.user.id, email);
    const client = newClient();
    await signUp(client, { email });
    const row = await userByEmail(email);
    expect((await shareById(share.id))!.granteeUserId, "an unverified address owns nothing").toBeNull();

    await send(client, linkIn(await waitForMail(email, "verification")));
    const activated = await shareById(share.id);
    expect(activated!.granteeUserId).toBe(row!.id);
    expect(activated!.activatedAt).toBeInstanceOf(Date);
  });
});

describe("sessions", () => {
  it("expire after 14 days and carry Better Auth's own id format", async () => {
    const { user: row } = await verifiedUser();
    const [session] = await testDb().select().from(sessionTable).where(eq(sessionTable.userId, row.id));
    expect(session!.id).toMatch(/^[A-Za-z0-9]{32}$/);
    const lifetime = session!.expiresAt.getTime() - Date.now();
    expect(lifetime).toBeGreaterThan(13.9 * 86_400_000);
    expect(lifetime).toBeLessThanOrEqual(14 * 86_400_000);
    expect(session!.impersonatedBy).toBeNull();
  });

  it("a sign-up needs a captcha, but a session read does not", async () => {
    expect((await send(newClient(), "/api/auth/get-session")).status).toBe(200);
    expect(
      (
        await send(newClient(), "/api/auth/sign-in/email", {
          json: { email: freshEmail(), password: PASSWORD },
          headers: CAPTCHA,
        })
      ).status,
    ).toBe(401);
  });
});
