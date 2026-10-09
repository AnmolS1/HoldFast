// A2 — "an admin has two-factor" is a property of the SESSION, not of the account.
//
// Better Auth's two-factor plugin challenges only a password sign-in
// (better-auth/dist/plugins/two-factor/index.mjs — the after-hook matches `/sign-in/email`,
// `/sign-in/username`, `/sign-in/phone-number`). Every other way a session is made skips it.
// `session.secondFactorAt` (auth/second-factor.ts) says whether THIS session passed a second
// factor; the admin gate and `requireAdmin` require it, and answer `admin_requires_2fa` to an
// admin whose session has not.
//
// One case per way a session comes to exist — each made with a REAL sign-in, never by writing
// the column — plus the step-up, its attempt limit, and that a one-time code works once (A8).
// Passkeys (with and without user verification) need a browser: tests/e2e/auth.spec.ts.
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  SECOND_FACTOR_MAX_FAILURES,
  VERIFY_BACKUP_CODE_PATH,
  VERIFY_TOTP_PATH,
} from "../../../src/worker/auth/second-factor";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { session, twoFactor, user, verification } from "../../../src/worker/db/schema";
import {
  auditRows,
  CAPTCHA,
  enableTotp,
  freshIp,
  linkIn,
  newClient,
  nextTotp,
  PASSWORD,
  send,
  sessionsOf,
  signIn,
  testDb,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

const ADMIN_PATH = "/api/auth/admin/set-role";

/** An account with the admin role and a REAL TOTP enrolment; nobody is signed in afterwards. */
async function adminWithTotp() {
  const made = await verifiedUser();
  const { totpURI, backupCodes } = await enableTotp(made.client);
  await testDb().update(user).set({ role: "admin" }).where(eq(user.id, made.user.id));
  await send(made.client, "/api/auth/sign-out", { json: {} });
  expect(await sessionsOf(made.user.id)).toEqual([]);
  return { ...made, id: made.user.id, totpURI, backupCodes };
}

/** The one session of `userId`, straight from the table. */
async function onlySession(userId: string) {
  const rows = await sessionsOf(userId);
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

/** An admin call (it changes nothing: the target keeps its role). */
async function adminCall(client: Client) {
  const target = await verifiedUser();
  return send(client, ADMIN_PATH, { json: { userId: target.user.id, role: "user" } });
}

function expectNeedsSecondFactor(sent: Awaited<ReturnType<typeof send>>) {
  expect(sent.status, sent.text).toBe(403);
  expect(sent.body).toMatchObject({ code: "ADMIN_REQUIRES_2FA", error: "admin_requires_2fa" });
}

/** Password, then the code: a full sign-in. */
async function signInWithCode(client: Client, email: string, totpURI: string, extra: object = {}) {
  const first = await signIn(client, email);
  expect(first.status, first.text).toBe(200);
  expect(first.body).toMatchObject({ twoFactorRedirect: true });
  const second = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
    json: { code: await nextTotp(totpURI), ...extra },
  });
  expect(second.status, second.text).toBe(200);
  return second;
}

/** Google's part of a sign-in for an address that already has a (verified) account. */
async function signInWithGoogle(client: Client, email: string) {
  const start = await send(client, "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
  });
  expect(start.status, start.text).toBe(200);
  const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
  const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email, name: "G" });
  const callback = await send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
  expect(callback.status).toBe(302);
  expect(callback.headers.get("location")).toBe("/");
}

describe("which sessions carry a second factor", () => {
  it("password + TOTP code: carried — and the admin call passes", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    // The password alone makes no session at all.
    expect((await signIn(client, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionsOf(admin.id)).toEqual([]);
    await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: await nextTotp(admin.totpURI) } });
    expect((await onlySession(admin.id)).secondFactorAt).toBeInstanceOf(Date);
    expect((await adminCall(client)).status).toBe(200);
  });

  it("password + backup code: carried", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signIn(client, admin.email);
    const sent = await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
      json: { code: admin.backupCodes[0] },
    });
    expect(sent.status, sent.text).toBe(200);
    expect((await onlySession(admin.id)).secondFactorAt).toBeInstanceOf(Date);
    expect((await adminCall(client)).status).toBe(200);
  });

  it("the enrolment itself (password re-entered, then the first code): carried", async () => {
    const made = await verifiedUser();
    expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
    await enableTotp(made.client);
    expect((await onlySession(made.user.id)).secondFactorAt).toBeInstanceOf(Date);
  });

  it("Google, for an admin who has TOTP: NOT carried — admin_requires_2fa, with an audit row", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithGoogle(client, admin.email);
    // A real session of the admin account, made without any code being asked.
    const row = await onlySession(admin.id);
    expect(row.secondFactorAt).toBeNull();
    expect((await userById(admin.id))!).toMatchObject({ role: "admin", twoFactorEnabled: true });
    const refused = await adminCall(client);
    expectNeedsSecondFactor(refused);
    expect(
      (await auditRows({ action: "auth.admin_endpoint_denied", actorUserId: admin.id })).length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("a trusted device (password, no code asked): NOT carried", async () => {
    // "Remember this device" is granted to an ordinary user…
    const made = await verifiedUser();
    const { totpURI } = await enableTotp(made.client);
    await send(made.client, "/api/auth/sign-out", { json: {} });
    const browser = newClient();
    const trusted = await signInWithCode(browser, made.email, totpURI, { trustDevice: true });
    expect(trusted.setCookies.join("\n")).toContain("hf.trust_device=");
    await send(browser, "/api/auth/sign-out", { json: {} });
    // …who is later made an admin. The next sign-in on that device asks for no code.
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, made.user.id));
    const again = await signIn(browser, made.email);
    expect(again.status).toBe(200);
    expect(again.body).not.toMatchObject({ twoFactorRedirect: true });
    expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(browser));
  });

  it("an admin is never given 'remember this device': the next sign-in asks for the code again", async () => {
    const admin = await adminWithTotp();
    const browser = newClient();
    const sent = await signInWithCode(browser, admin.email, admin.totpURI, { trustDevice: true });
    expect(sent.setCookies.join("\n")).not.toContain("trust_device");
    expect(
      await testDb()
        .select()
        .from(verification)
        .where(and(eq(verification.value, admin.id), like(verification.identifier, "trust-device-%"))),
    ).toEqual([]);
    await send(browser, "/api/auth/sign-out", { json: {} });
    expect((await signIn(browser, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
  });

  it("the verification link's session, and flags written to the database: NOT carried", async () => {
    // What the old tests called "an admin with two-factor": the role and the account flag on a
    // session that never met a second factor.
    const made = await verifiedUser();
    await testDb()
      .update(user)
      .set({ role: "admin", twoFactorEnabled: true })
      .where(eq(user.id, made.user.id));
    expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(made.client));
  });

  it("an impersonated session: NOT carried (and it is never an admin session)", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    const puppet = await verifiedUser();
    const started = await send(client, "/api/auth/admin/impersonate-user", {
      json: { userId: puppet.user.id },
    });
    expect(started.status, started.text).toBe(200);
    const impersonated = (await sessionsOf(puppet.user.id)).find((row) => row.impersonatedBy === admin.id)!;
    expect(impersonated.secondFactorAt).toBeNull();
    // Stopping gives the admin's own session back, as it was: still carrying its second factor.
    expect((await send(client, "/api/auth/admin/stop-impersonating", { json: {} })).status).toBe(200);
    expect((await adminCall(client)).status).toBe(200);
  });

  it("sessions Better Auth re-creates from another (password change, two-factor off) do not inherit it", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    const other = newClient();
    await signInWithCode(other, admin.email, admin.totpURI);
    expect(await sessionsOf(admin.id)).toHaveLength(2);

    const newPassword = "a changed long passphrase 5!";
    // The client does NOT ask for the other sessions to end; they end anyway (A8).
    const changed = await send(client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword },
    });
    expect(changed.status, changed.text).toBe(200);
    const after = await onlySession(admin.id);
    expect(after.secondFactorAt).toBeNull();
    expect((await send(other, "/api/auth/get-session")).body).toBeNull();
    expectNeedsSecondFactor(await adminCall(client));

    const off = await send(client, "/api/auth/two-factor/disable", { json: { password: newPassword } });
    expect(off.status, off.text).toBe(200);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
  });

  it("no request body sets it: /update-session takes no such field", async () => {
    const made = await verifiedUser();
    const sent = await send(made.client, "/api/auth/update-session", {
      json: { secondFactorAt: new Date().toISOString() },
    });
    expect(sent.status).toBeGreaterThanOrEqual(200);
    expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
    const snake = await send(made.client, "/api/auth/update-session", {
      json: { second_factor_at: new Date().toISOString(), uaFamily: "x" },
    });
    expect(snake.status).toBeGreaterThanOrEqual(200);
    expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
  });
});

describe("step-up: a code on a session that exists", () => {
  /** A Google-made session of an admin with TOTP: signed in, second factor not passed. */
  async function googleSession() {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithGoogle(client, admin.email);
    expectNeedsSecondFactor(await adminCall(client));
    return { admin, client };
  }

  it("a correct TOTP code marks THAT session, and the admin call then passes", async () => {
    const { admin, client } = await googleSession();
    const before = await onlySession(admin.id);
    const sent = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(sent.status, sent.text).toBe(200);
    const after = await onlySession(admin.id);
    // The same session row — not a new one — now carries it.
    expect(after.id).toBe(before.id);
    expect(after.secondFactorAt).toBeInstanceOf(Date);
    expect((await adminCall(client)).status).toBe(200);
    expect(await auditRows({ action: "auth.second_factor_step_up", targetId: admin.id })).toHaveLength(1);
  });

  it("a backup code does the same, once", async () => {
    const { admin, client } = await googleSession();
    const code = admin.backupCodes[1]!;
    expect((await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, { json: { code } })).status).toBe(200);
    expect((await onlySession(admin.id)).secondFactorAt).toBeInstanceOf(Date);
    // Spent: it does not step up a second session.
    const second = newClient();
    await signInWithGoogle(second, admin.email);
    expect((await send(second, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, { json: { code } })).status).toBe(401);
    expectNeedsSecondFactor(await adminCall(second));
  });

  it("a wrong code marks nothing — and does not use up the right one", async () => {
    const { admin, client } = await googleSession();
    const wrong = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: "000000" } });
    expect(wrong.status).toBe(401);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(client));
    const right = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(right.status, right.text).toBe(200);
  });

  it(`after ${SECOND_FACTOR_MAX_FAILURES} wrong codes the account is locked: even the right code is refused`, async () => {
    const { admin, client } = await googleSession();
    for (let attempt = 0; attempt < SECOND_FACTOR_MAX_FAILURES; attempt++) {
      // A guesser spreads over addresses; the limit is on the ACCOUNT.
      client.ip = freshIp();
      const sent = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
        json: { code: String(100000 + attempt) },
      });
      expect(sent.status, `attempt ${attempt + 1}: ${sent.text}`).toBe(401);
    }
    const [row] = await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id));
    expect(row!.failedVerificationCount).toBeGreaterThanOrEqual(SECOND_FACTOR_MAX_FAILURES);
    expect(row!.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
    client.ip = freshIp();
    const right = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(right.status).toBe(429);
    expect(right.body).toMatchObject({ code: "ACCOUNT_TEMPORARILY_LOCKED" });
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(client));
    // A backup code is refused for as long, on the same budget.
    client.ip = freshIp();
    const backup = await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
      json: { code: admin.backupCodes[2] },
    });
    expect(backup.status).toBe(429);
  });

  it("a correct code clears the count of wrong ones", async () => {
    const { admin, client } = await googleSession();
    for (let attempt = 0; attempt < 3; attempt++) {
      await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: String(200000 + attempt) } });
    }
    const count = async () =>
      (await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id)))[0]!
        .failedVerificationCount;
    expect(await count()).toBe(3);
    await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: await nextTotp(admin.totpURI) } });
    expect(await count()).toBe(0);
  });
});

describe("a one-time code works once (A8)", () => {
  it("the same TOTP code does not complete a second sign-in inside its window; the next code does", async () => {
    const admin = await adminWithTotp();
    const code = await nextTotp(admin.totpURI);
    const first = newClient();
    await signIn(first, admin.email);
    expect((await send(first, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })).status).toBe(200);

    // Somebody who saw that code (and has the password) tries it again.
    const second = newClient();
    await signIn(second, admin.email);
    const replay = await send(second, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } });
    expect(replay.status).toBe(401);
    expect(replay.body).toMatchObject({ code: "INVALID_CODE" });
    expect(second.cookies.has("hf.session_token")).toBe(false);
    expect(await sessionsOf(admin.id)).toHaveLength(1);
    // The challenge is still open, and a code not yet used completes it.
    const fresh = await send(second, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(fresh.status, fresh.text).toBe(200);
  });

  it("nor does a code that signed in then step up another session", async () => {
    const admin = await adminWithTotp();
    const code = await nextTotp(admin.totpURI);
    const first = newClient();
    await signIn(first, admin.email);
    expect((await send(first, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })).status).toBe(200);
    const google = newClient();
    await signInWithGoogle(google, admin.email);
    expect((await send(google, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })).status).toBe(401);
    const stolen = (await sessionsOf(admin.id)).find((row) => row.secondFactorAt === null);
    expect(stolen).toBeDefined();
    expectNeedsSecondFactor(await adminCall(google));
  });

  it("two requests with the same code at the same moment: exactly one is accepted", async () => {
    const admin = await adminWithTotp();
    const code = await nextTotp(admin.totpURI);
    const clients = [newClient(), newClient(), newClient(), newClient()];
    for (const client of clients) await signIn(client, admin.email);
    const answers = await Promise.all(
      clients.map((client) => send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })),
    );
    expect(answers.map((answer) => answer.status).sort()).toEqual([200, 401, 401, 401]);
    expect(await sessionsOf(admin.id)).toHaveLength(1);
  });

  it("the claim is per account: the same six digits are another account's own code", async () => {
    const one = await adminWithTotp();
    const code = await nextTotp(one.totpURI);
    const first = newClient();
    await signIn(first, one.email);
    expect((await send(first, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })).status).toBe(200);
    // Another account sending the same digits is judged on its own secret: simply a wrong code,
    // and its own right code still works.
    const two = await adminWithTotp();
    const other = newClient();
    await signIn(other, two.email);
    expect((await send(other, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })).status).toBe(401);
    expect(
      (await send(other, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: await nextTotp(two.totpURI) } }))
        .status,
    ).toBe(200);
  });
});

describe("'remember this device' does not outlive the password (A8)", () => {
  /** A user with TOTP whose `browser` holds a trusted-device cookie; signed out. */
  async function trustedBrowser() {
    const made = await verifiedUser();
    const { totpURI } = await enableTotp(made.client);
    await send(made.client, "/api/auth/sign-out", { json: {} });
    const browser = newClient();
    await signInWithCode(browser, made.email, totpURI, { trustDevice: true });
    expect(browser.cookies.has("hf.trust_device")).toBe(true);
    return { ...made, totpURI, browser };
  }
  const trustRows = (userId: string) =>
    testDb()
      .select()
      .from(verification)
      .where(and(eq(verification.value, userId), like(verification.identifier, "trust-device-%")));

  it("control: with the password unchanged the device is trusted — no code is asked", async () => {
    const made = await trustedBrowser();
    await send(made.browser, "/api/auth/sign-out", { json: {} });
    expect(await trustRows(made.user.id)).toHaveLength(1);
    expect((await signIn(made.browser, made.email)).body).not.toMatchObject({ twoFactorRedirect: true });
  });

  it("a password RESET forgets every trusted device: the next sign-in asks for the code", async () => {
    const made = await trustedBrowser();
    await send(made.browser, "/api/auth/sign-out", { json: {} });
    const asked = await send(newClient(), "/api/auth/request-password-reset", {
      json: { email: made.email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    expect(asked.status, asked.text).toBe(200);
    const link = linkIn(await waitForMail(made.email, "passwordReset"));
    const token = /reset-password\/([^?/]+)/.exec(link)![1]!;
    const newPassword = "after the reset, another 4!";
    const reset = await send(newClient(), "/api/auth/reset-password", { json: { newPassword, token } });
    expect(reset.status, reset.text).toBe(200);
    expect(await trustRows(made.user.id)).toEqual([]);
    // Whoever holds the old trust cookie and the NEW password is still asked for the code.
    const again = await signIn(made.browser, made.email, newPassword);
    expect(again.body).toMatchObject({ twoFactorRedirect: true });
    expect(await sessionsOf(made.user.id)).toEqual([]);
  });

  it("a password CHANGE does the same", async () => {
    const made = await trustedBrowser();
    const newPassword = "after the change, another 4!";
    const changed = await send(made.browser, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword },
    });
    expect(changed.status, changed.text).toBe(200);
    expect(await trustRows(made.user.id)).toEqual([]);
    await send(made.browser, "/api/auth/sign-out", { json: {} });
    expect((await signIn(made.browser, made.email, newPassword)).body).toMatchObject({
      twoFactorRedirect: true,
    });
  });
});

describe("what a session answer shows", () => {
  it("get-session carries secondFactorAt, so the shell can ask for a code before an admin action", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    const answer = (await send(client, "/api/auth/get-session")).body as {
      session: { secondFactorAt?: string };
    };
    expect(typeof answer.session.secondFactorAt).toBe("string");
    const google = newClient();
    await signInWithGoogle(google, admin.email);
    const plain = (await send(google, "/api/auth/get-session")).body as {
      session: { secondFactorAt?: unknown };
    };
    expect(plain.session.secondFactorAt ?? null).toBeNull();
    expect(await testDb().select().from(session).where(eq(session.userId, admin.id))).toHaveLength(2);
  });
});
