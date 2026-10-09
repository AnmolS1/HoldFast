// The parts of the auth layer the security review listed as NOT REVIEWED, held by test:
//   1. re-authentication for sensitive changes — a session alone is not enough to switch
//      two-factor off or on, change the password, add a passkey or delete the account;
//   2. what happens to sessions when two-factor is switched on, and around impersonation;
//   3. how much work an auth request leaves behind (deferred work has a budget: 100 tasks and
//      20 s per invocation — services/request-context.ts).
// (Already held elsewhere, and not repeated: a role change ends the account's sessions and a new
// set of backup codes needs the password — second-factor.test.ts; the impersonation audit rows,
// the 15-minute lifetime and its read-only rule — admin-gate.test.ts.)
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { session, twoFactor } from "../../../src/worker/db/schema";
import { MAX_DEFERRED_TASKS } from "../../../src/worker/services/request-context";
import {
  CAPTCHA,
  createInvite,
  enableTotp,
  freshEmail,
  getSession,
  linkIn,
  mailTo,
  measured,
  newClient,
  nextTotp,
  PASSWORD,
  promoteToAdmin,
  send,
  sessionsOf,
  signIn,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
  type SendOptions,
} from "./helpers";

const WRONG = "not the password at all 1!";
const NEW_PASSWORD = "another perfectly fine password 7!";

/** Better Auth's own per-address request rules (3 in 10 s on these paths) are not the subject. */
async function act(client: Client, path: string, options: SendOptions) {
  await testDb().execute(sql`DELETE FROM rate_limit WHERE key LIKE ${`${client.ip}|%`}`);
  return send(client, path, options);
}

describe("a session alone does not authorise a sensitive change", () => {
  it("two-factor is switched OFF only with the password — not without one, not with a wrong one", async () => {
    const owner = await verifiedUser();
    await enableTotp(owner.client);
    const disable = (body: Record<string, unknown>) =>
      act(owner.client, "/api/auth/two-factor/disable", { json: body });
    for (const [what, body] of [
      ["no password", {}],
      ["a wrong password", { password: WRONG }],
      ["an empty password", { password: "" }],
      ["a password that is not text", { password: 12345678901234 }],
    ] as const) {
      const refused = await disable(body);
      expect(refused.status, what).toBeGreaterThanOrEqual(400);
      expect(refused.status, what).toBeLessThan(500);
      expect((await userById(owner.user.id))!.twoFactorEnabled, what).toBe(true);
      expect(
        await testDb().select().from(twoFactor).where(eq(twoFactor.userId, owner.user.id)),
        what,
      ).toHaveLength(1);
    }
    // The control: with the password it is switched off.
    expect((await disable({ password: PASSWORD })).status).toBe(200);
    expect((await userById(owner.user.id))!.twoFactorEnabled).toBe(false);
  });

  it("two-factor is switched ON, and the password CHANGED, only with the current password", async () => {
    const owner = await verifiedUser();
    for (const body of [{}, { password: WRONG }]) {
      const refused = await act(owner.client, "/api/auth/two-factor/enable", { json: body });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, owner.user.id))).toEqual([]);
    }
    for (const body of [
      { newPassword: NEW_PASSWORD },
      { currentPassword: WRONG, newPassword: NEW_PASSWORD },
      { currentPassword: "", newPassword: NEW_PASSWORD },
    ]) {
      const refused = await act(owner.client, "/api/auth/change-password", { json: body });
      expect(refused.status).toBeGreaterThanOrEqual(400);
      expect(refused.status).toBeLessThan(500);
    }
    expect((await signIn(newClient(), owner.email, NEW_PASSWORD)).status).toBe(401);
    expect((await signIn(newClient(), owner.email, PASSWORD)).status).toBe(200);
    // The control.
    const changed = await act(owner.client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword: NEW_PASSWORD },
    });
    expect(changed.status, changed.text).toBe(200);
    expect((await signIn(newClient(), owner.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("a session that is not FRESH (a day old) cannot add a passkey or ask to delete the account without the password", async () => {
    const owner = await verifiedUser();
    // The control first: a fresh session may start a passkey registration.
    expect((await send(owner.client, "/api/auth/passkey/generate-register-options")).status).toBe(200);
    // The same session, two days on (a cookie lifted from an unattended browser).
    await testDb()
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(session.userId, owner.user.id));
    const passkey = await send(owner.client, "/api/auth/passkey/generate-register-options");
    expect(passkey.status).toBe(403);
    expect(passkey.body).toMatchObject({ code: "SESSION_NOT_FRESH" });
    // Deleting the account from such a session: a wrong password is refused; with none, nothing
    // is deleted or scheduled by the request — Better Auth mails a link to the OWNER's mailbox
    // (api/routes/update-user.mjs:302–316, before its own freshness check at :320), and only
    // following that link schedules the deletion. The mailbox is the second proof.
    const wrong = await act(owner.client, "/api/auth/delete-user", { json: { password: WRONG } });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
    expect(wrong.status).toBeLessThan(500);
    expect(mailTo(owner.email, "deleteAccountVerification")).toEqual([]);
    const asked = await act(owner.client, "/api/auth/delete-user", { json: {} });
    expect(asked.body).toMatchObject({ message: "Verification email sent" });
    await waitForMail(owner.email, "deleteAccountVerification");
    expect((await userById(owner.user.id))!.deleteScheduledAt).toBeNull();
  });

  it("deleting the account and changing its address are never done by the request itself: each needs a link from the mailbox", async () => {
    const owner = await verifiedUser();
    const asked = await act(owner.client, "/api/auth/delete-user", { json: { password: PASSWORD } });
    expect(asked.status, asked.text).toBe(200);
    expect((await userById(owner.user.id))!.deleteScheduledAt).toBeNull();
    const link = linkIn(await waitForMail(owner.email, "deleteAccountVerification"));
    expect(link).toMatch(/^\/api\/auth\/delete-user\/callback\?token=/);
    // (Following it schedules the deletion — deletion.test.ts.)
    const next = freshEmail();
    const change = await send(owner.client, "/api/auth/change-email", {
      json: { newEmail: next, callbackURL: "/" },
    });
    expect(change.status, change.text).toBe(200);
    expect((await userById(owner.user.id))!.email).toBe(owner.email);
    expect(mailTo(next)).toEqual([]);
    await waitForMail(owner.email, "changeEmailConfirmation");
  });
});

describe("sessions around a change of trust", () => {
  it("switching two-factor on replaces the session that did it, and every OTHER session of the account loses the standing of one that passed a second factor", async () => {
    const owner = await verifiedUser();
    const elsewhere = newClient();
    expect((await signIn(elsewhere, owner.email)).status).toBe(200);
    const before = await getSession(owner.client);
    const otherBefore = await getSession(elsewhere);
    expect(await sessionsOf(owner.user.id)).toHaveLength(2);

    await enableTotp(owner.client);

    const after = await getSession(owner.client);
    expect(after?.user.id).toBe(owner.user.id);
    // Rotated: a new session id and token for the browser that enrolled; the old row is gone.
    expect(after!.session.id).not.toBe(before!.session.id);
    const rows = await sessionsOf(owner.user.id);
    expect(rows.map((row) => row.id)).not.toContain(before!.session.id);
    // The other device is still signed in (it is the owner's) — but it has passed no second
    // factor, and only the enrolling session carries the mark.
    const other = rows.find((row) => row.id === otherBefore!.session.id);
    expect(other).toBeDefined();
    expect(other!.secondFactorAt).toBeNull();
    expect(rows.find((row) => row.id === after!.session.id)!.secondFactorAt).toBeInstanceOf(Date);
  });

  it("impersonation is a session of its own: it leaves the admin's and the target's sessions alone, and stopping it removes it", async () => {
    const admin = await verifiedUser();
    await promoteToAdmin(admin.user.id);
    const target = await verifiedUser();
    const adminSession = (await getSession(admin.client))!.session.id as string;
    const targetSessions = (await sessionsOf(target.user.id)).map((row) => row.id);

    const started = await send(admin.client, "/api/auth/admin/impersonate-user", {
      json: { userId: target.user.id },
    });
    expect(started.status, started.text).toBe(200);
    const impersonating = (await getSession(admin.client))!.session;
    expect(impersonating.id).not.toBe(adminSession);
    expect(impersonating.impersonatedBy).toBe(admin.user.id);
    // The admin's own session still exists (it is what "stop" returns to); the target's own
    // sessions are untouched, and the impersonation session carries no second-factor mark.
    expect((await sessionsOf(admin.user.id)).map((row) => row.id)).toContain(adminSession);
    const during = await sessionsOf(target.user.id);
    expect(during.map((row) => row.id)).toEqual(expect.arrayContaining(targetSessions));
    expect(during.find((row) => row.id === impersonating.id)!.secondFactorAt).toBeNull();
    // The target's own browser is not signed out by being looked at.
    expect((await getSession(target.client))?.session.id).toBe(targetSessions[0]);

    const stopped = await send(admin.client, "/api/auth/admin/stop-impersonating", { json: {} });
    expect(stopped.status, stopped.text).toBe(200);
    expect((await getSession(admin.client))!.session.id).toBe(adminSession);
    expect((await sessionsOf(target.user.id)).map((row) => row.id).sort()).toEqual(
      [...targetSessions].sort(),
    );
    // The cookie of the impersonation session is worth nothing afterwards.
    const replay = newClient({
      cookies: new Map([
        [
          "hf.session_token",
          String(started.setCookies.join(";").match(/hf\.session_token=([^;]+)/)?.[1] ?? ""),
        ],
      ]),
    });
    expect(await getSession(replay)).toBeNull();
  });
});

describe("the work an auth request leaves behind stays far inside the deferred-work budget", () => {
  // The budget (services/request-context.ts): 100 deferred tasks and 20 s of drain per invocation.
  const TASKS_ALLOWED = MAX_DEFERRED_TASKS / 5;
  const DRAIN_ALLOWED_MS = 5_000;

  it("every endpoint a stranger or a signed-in user can call: at most 20 deferred tasks, drained in under 5 s", async () => {
    const owner = await verifiedUser();
    const pending = newClient();
    const pendingEmail = freshEmail();
    const json = (body: unknown, headers: Record<string, string> = CAPTCHA): SendOptions => ({
      json: body,
      headers,
    });
    const signUpBody = {
      email: pendingEmail,
      password: PASSWORD,
      name: "Budget Test",
      inviteCode: await createInvite(),
      birthYear: 1990,
      birthMonth: 5,
      acceptTerms: true,
    };
    const cases: Array<[string, Client, string, SendOptions]> = [
      ["sign-up (a mail)", pending, "/api/auth/sign-up/email", json(signUpBody)],
      [
        "sign-up again (the look-alike: a notice to the owner)",
        newClient(),
        "/api/auth/sign-up/email",
        json({ ...signUpBody, email: owner.email, inviteCode: await createInvite() }),
      ],
      ["sign-in", newClient(), "/api/auth/sign-in/email", json({ email: owner.email, password: PASSWORD })],
      [
        "sign-in, wrong password",
        newClient(),
        "/api/auth/sign-in/email",
        json({ email: owner.email, password: WRONG }),
      ],
      [
        "reset request, an account",
        newClient(),
        "/api/auth/request-password-reset",
        json({ email: owner.email }),
      ],
      [
        "reset request, nobody",
        newClient(),
        "/api/auth/request-password-reset",
        json({ email: freshEmail() }),
      ],
      ["resend", newClient(), "/api/auth/send-verification-email", json({ email: pendingEmail })],
      ["session read", owner.client, "/api/auth/get-session", {}],
      [
        "change of address",
        owner.client,
        "/api/auth/change-email",
        json({ newEmail: freshEmail(), callbackURL: "/" }, {}),
      ],
      ["enable two-factor", owner.client, "/api/auth/two-factor/enable", json({ password: PASSWORD }, {})],
      [
        "change password (a notice, other sessions ended)",
        owner.client,
        "/api/auth/change-password",
        json({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD }, {}),
      ],
      ["sign-out", owner.client, "/api/auth/sign-out", json({}, {})],
    ];
    const seen: Record<string, { deferred: number; ms: number; status: number }> = {};
    for (const [what, client, path, options] of cases) {
      const started = Date.now();
      // (`measured` returns once everything the request deferred has settled.)
      const done = await measured(client, path, options);
      seen[what] = { deferred: done.deferred, ms: Date.now() - started, status: done.sent.status };
      expect(done.sent.status, `${what}: ${done.sent.text}`).toBeLessThan(500);
      expect(done.deferred, `${what}: deferred tasks`).toBeLessThanOrEqual(TASKS_ALLOWED);
      expect(Date.now() - started, `${what}: request + drain`).toBeLessThan(DRAIN_ALLOWED_MS);
    }
    // The measure is real: a request that mails does defer work, and the table is not all zeros.
    expect(seen["sign-up (a mail)"]!.deferred).toBeGreaterThan(0);
    expect(Math.max(...Object.values(seen).map((entry) => entry.deferred))).toBeGreaterThanOrEqual(2);
    // Printed once for the report (counts and milliseconds only).
    console.log(`deferred-work per auth request: ${JSON.stringify(seen)}`);
  });

  it("a second factor locked by wrong codes (audit rows, a lock notice) stays inside it too", async () => {
    const owner = await verifiedUser();
    const { totpURI } = await enableTotp(owner.client);
    void totpURI;
    void nextTotp;
    const client = newClient();
    expect((await signIn(client, owner.email)).body).toMatchObject({ twoFactorRedirect: true });
    let worst = 0;
    for (let attempt = 1; attempt <= 6; attempt++) {
      const done = await measured(client, "/api/auth/two-factor/verify-totp", { json: { code: "000000" } });
      worst = Math.max(worst, done.deferred);
      expect(done.deferred, `attempt ${attempt}`).toBeLessThanOrEqual(TASKS_ALLOWED);
    }
    expect(worst).toBeGreaterThan(0);
    await waitForMail(owner.email, "secondFactorLocked");
  });
});
