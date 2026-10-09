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
import { env } from "cloudflare:workers";
import { and, eq, like } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createAuth } from "../../../src/worker/auth/create-auth";
import { createScope } from "../../../src/worker/auth/scope";
import {
  afterSecondFactor,
  ENROL_PROOF_S,
  SECOND_FACTOR_LOCK_S,
  SECOND_FACTOR_MAX_AGE_MS,
  SECOND_FACTOR_MAX_ATTEMPTS,
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
  signUp,
  testDb,
  totp,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

// These tests use REAL one-time codes: a code belongs to a 30-second step, a step is accepted
// once, and `nextTotp` never hands out a code that is about to go stale — so a test that needs a
// third code for one authenticator may have to wait for the next step to begin (up to 30 s).
vi.setConfig({ testTimeout: 75_000 });

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

/** Refused by the gate, for whatever reason (not an admin, an impersonated session, …). */
function expectRefused(sent: Awaited<ReturnType<typeof send>>) {
  expect(sent.status, sent.text).toBe(403);
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

  it("an impersonated session: NOT carried, cannot step up — and stopping takes the admin's own mark away", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    // The target has TOTP too (and is made an admin once the impersonation runs — the plugin
    // will not start one on an admin): the strongest thing an impersonated session could be.
    const puppet = await adminWithTotp();
    await testDb().update(user).set({ role: "user" }).where(eq(user.id, puppet.id));
    const started = await send(client, "/api/auth/admin/impersonate-user", { json: { userId: puppet.id } });
    expect(started.status, started.text).toBe(200);
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, puppet.id));
    const impersonated = (await sessionsOf(puppet.id)).find((row) => row.impersonatedBy === admin.id)!;
    expect(impersonated.secondFactorAt).toBeNull();
    // It cannot step up — not through the pipeline (the allow-list for impersonated sessions),
    // and not with the target's own correct code.
    const attempt = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(puppet.totpURI) },
    });
    expect(attempt.status).toBe(403);
    expect(
      (await sessionsOf(puppet.id)).find((row) => row.id === impersonated.id)!.secondFactorAt,
    ).toBeNull();
    expectRefused(await adminCall(client));

    // Stopping gives the admin's own session back WITHOUT its mark: the factor is proven again
    // before the next admin action.
    expect((await send(client, "/api/auth/admin/stop-impersonating", { json: {} })).status).toBe(200);
    expect((await sessionsOf(admin.id)).map((row) => row.secondFactorAt)).toEqual([null]);
    expectNeedsSecondFactor(await adminCall(client));
    await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: await nextTotp(admin.totpURI) } });
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

  it("no request body sets it: update-session, update-user, sign-up and sign-in all refuse or ignore the field", async () => {
    const made = await verifiedUser();
    const stamp = new Date().toISOString();
    for (const body of [{ secondFactorAt: stamp }, { second_factor_at: stamp, secondFactorAt: stamp }]) {
      const sent = await send(made.client, "/api/auth/update-session", { json: body });
      expect(sent.status, sent.text).toBe(400);
      expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
    }
    // The user row's flags are no more settable than the session's.
    const flags = await send(made.client, "/api/auth/update-user", {
      json: { name: "X", role: "admin", twoFactorEnabled: true, secondFactorAt: stamp },
    });
    expect(flags.status).toBe(400);
    expect(await userById(made.user.id)).toMatchObject({ role: "user", twoFactorEnabled: false });
    // A sign-in and a sign-up that carry it: a session without it, or no session.
    const browser = newClient();
    const signedIn = await send(browser, "/api/auth/sign-in/email", {
      json: {
        email: made.email,
        password: PASSWORD,
        secondFactorAt: stamp,
        session: { secondFactorAt: stamp },
      },
      headers: CAPTCHA,
    });
    expect(signedIn.status, signedIn.text).toBe(200);
    for (const row of await sessionsOf(made.user.id)) expect(row.secondFactorAt).toBeNull();
    const signedUp = await signUp(newClient(), { extra: { secondFactorAt: stamp, role: "admin" } });
    if (signedUp.sent.status === 200) {
      const row = (await userByEmail(signedUp.email))!;
      expect(row.role).toBe("user");
      expect(await sessionsOf(row.id)).toEqual([]);
    } else expect(signedUp.sent.status).toBe(400);
  });

  it("it has a maximum age: a mark older than twelve hours no longer opens an admin action", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    expect((await adminCall(client)).status).toBe(200);
    const row = await onlySession(admin.id);
    const set = (ms: number) =>
      testDb()
        .update(session)
        .set({ secondFactorAt: new Date(Date.now() - ms) })
        .where(eq(session.id, row.id));
    await set(SECOND_FACTOR_MAX_AGE_MS - 60_000);
    expect((await adminCall(client)).status).toBe(200);
    await set(SECOND_FACTOR_MAX_AGE_MS + 60_000);
    expectNeedsSecondFactor(await adminCall(client));
    // A step-up renews it.
    await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: await nextTotp(admin.totpURI) } });
    expect((await adminCall(client)).status).toBe(200);
  });

  it("a role change ends the account's sessions; a new set of backup codes takes the mark off", async () => {
    const boss = await adminWithTotp();
    const bossClient = newClient();
    await signInWithCode(bossClient, boss.email, boss.totpURI);
    const other = await adminWithTotp();
    const otherClient = newClient();
    await signInWithCode(otherClient, other.email, other.totpURI);
    expect((await onlySession(other.id)).secondFactorAt).toBeInstanceOf(Date);
    // A change of privilege: the account signs in again, as what it now is.
    const changed = await send(bossClient, ADMIN_PATH, { json: { userId: other.id, role: "admin" } });
    expect(changed.status, changed.text).toBe(200);
    expect(await sessionsOf(other.id)).toEqual([]);
    expect((await adminCall(otherClient)).status).toBe(403);

    const regenerated = await send(bossClient, "/api/auth/two-factor/generate-backup-codes", {
      json: { password: PASSWORD },
    });
    expect(regenerated.status, regenerated.text).toBe(200);
    expect((await onlySession(boss.id)).secondFactorAt).toBeNull();
    // …and re-issuing them needs the password: a session alone cannot mint itself backup codes.
    const without = await send(bossClient, "/api/auth/two-factor/generate-backup-codes", { json: {} });
    expect(without.status).toBe(400);
    const wrong = await send(bossClient, "/api/auth/two-factor/generate-backup-codes", {
      json: { password: "not the password at all 1!" },
    });
    expect(wrong.status).toBeGreaterThanOrEqual(400);
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

  it(`after ${SECOND_FACTOR_MAX_ATTEMPTS} wrong codes the account is locked: even the right code is refused — audited, mailed, and bounded`, async () => {
    const { admin, client } = await googleSession();
    for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS; attempt++) {
      // A guesser spreads over addresses; the limit is on the ACCOUNT.
      client.ip = freshIp();
      const sent = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
        json: { code: String(100000 + attempt) },
      });
      expect(sent.status, `attempt ${attempt + 1}: ${sent.text}`).toBe(401);
    }
    const lockRow = async () =>
      (await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id)))[0]!;
    expect((await lockRow()).failedVerificationCount).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    const until = (await lockRow()).lockedUntil!.getTime();
    expect(until).toBeGreaterThan(Date.now() + (SECOND_FACTOR_LOCK_S - 60) * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + (SECOND_FACTOR_LOCK_S + 60) * 1000);

    client.ip = freshIp();
    const right = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(right.status).toBe(429);
    expect(right.body).toMatchObject({ code: "ACCOUNT_TEMPORARILY_LOCKED" });
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(client));
    // A backup code is refused for as long, on the same budget — and is not used up by it.
    client.ip = freshIp();
    const backup = await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
      json: { code: admin.backupCodes[2] },
    });
    expect(backup.status).toBe(429);
    // The lock holds for a NEW session and for the sign-in challenge too (one budget per account).
    const elsewhere = newClient();
    expect((await signIn(elsewhere, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
    const challenge = await send(elsewhere, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(challenge.status).toBe(429);
    expect(elsewhere.cookies.has("hf.session_token")).toBe(false);

    // Audited without any code, and the owner is told.
    const failed = await auditRows({ action: "auth.second_factor_failed", targetId: admin.id });
    expect(failed).toHaveLength(SECOND_FACTOR_MAX_ATTEMPTS);
    expect(JSON.stringify(failed)).not.toMatch(/10000\d/);
    expect(await auditRows({ action: "auth.second_factor_locked", targetId: admin.id })).toHaveLength(1);
    const mail = await waitForMail(admin.email, "secondFactorLocked");
    expect(mail.text).toContain("15 minutes");

    // Bounded: once the lock has run out, codes work again and the count starts over.
    await testDb()
      .update(twoFactor)
      .set({ lockedUntil: new Date(Date.now() - 1000) })
      .where(eq(twoFactor.userId, admin.id));
    client.ip = freshIp();
    const later = await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
      json: { code: admin.backupCodes[2] },
    });
    expect(later.status, later.text).toBe(200);
    expect(await lockRow()).toMatchObject({ failedVerificationCount: 0, lockedUntil: null });
    expect((await adminCall(client)).status).toBe(200);
  });

  it("fifty wrong codes at the same moment: no more than the cap are even looked at, and the right code sent with them is refused once it is spent", async () => {
    const { admin, client } = await googleSession();
    const from = (code: string) =>
      send({ ...client, ip: freshIp(), cookies: new Map(client.cookies) }, `/api/auth${VERIFY_TOTP_PATH}`, {
        json: { code },
      });
    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => from(String(300000 + index))));
    const statuses = answers.map((answer) => answer.status);
    const lookedAt = statuses.filter((status) => status === 401).length;
    const locked = answers.filter(
      (answer) =>
        answer.status === 429 && (answer.body as { code?: string })?.code === "ACCOUNT_TEMPORARILY_LOCKED",
    ).length;
    expect(lookedAt, statuses.join(",")).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    expect(locked).toBe(50 - SECOND_FACTOR_MAX_ATTEMPTS);
    const [row] = await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id));
    expect(row!.failedVerificationCount).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    expect(await auditRows({ action: "auth.second_factor_failed", targetId: admin.id })).toHaveLength(
      SECOND_FACTOR_MAX_ATTEMPTS,
    );
    // The correct code, sent while the guesses are still arriving: refused like the rest.
    const [right, ...more] = await Promise.all([
      from(await nextTotp(admin.totpURI)),
      ...Array.from({ length: 10 }, (_, index) => from(String(400000 + index))),
    ]);
    expect(right!.status).toBe(429);
    expect(more.every((answer) => answer.status === 429)).toBe(true);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(client));
  });

  it("the sign-in challenge spends the same budget, one per attempt — and its own correct code clears it", async () => {
    const admin = await adminWithTotp();
    const browser = newClient();
    await signIn(browser, admin.email);
    const count = async () =>
      (await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id)))[0]!
        .failedVerificationCount;
    for (const code of ["500001", "500002"]) {
      expect((await send(browser, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code } })).status).toBe(401);
    }
    // Exactly one per attempt: there is ONE accounting (the plugin's own is switched off).
    expect(await count()).toBe(2);
    expect(
      (await send(browser, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, { json: { code: "nope1-nope2" } })).status,
    ).toBe(401);
    expect(await count()).toBe(3);
    expect(
      (await send(browser, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: await nextTotp(admin.totpURI) } }))
        .status,
    ).toBe(200);
    expect(await count()).toBe(0);
  });

  it("a correct code starts the count again", async () => {
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

describe("the code endpoints themselves refuse — not only the pipeline in front of them", () => {
  /** A request straight to Better Auth's handler: no session middleware, no endpoint allow-list. */
  async function direct(client: Client, path: string, json: unknown) {
    const auth = createAuth(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} });
    const response = await auth.handler(
      new Request(`http://localhost/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost",
          "cf-connecting-ip": freshIp(),
          cookie: [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
        },
        body: JSON.stringify(json),
      }),
    );
    return {
      status: response.status,
      body: (await response.json().catch(() => null)) as { code?: string } | null,
    };
  }

  it("an impersonated session with the target's own correct code: 403, and no mark", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    const puppet = await adminWithTotp();
    await testDb().update(user).set({ role: "user" }).where(eq(user.id, puppet.id));
    expect(
      (await send(client, "/api/auth/admin/impersonate-user", { json: { userId: puppet.id } })).status,
    ).toBe(200);
    const answer = await direct(client, VERIFY_TOTP_PATH, { code: await nextTotp(puppet.totpURI) });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ code: "SECOND_FACTOR_NOT_AVAILABLE" });
    for (const row of await sessionsOf(puppet.id)) expect(row.secondFactorAt).toBeNull();
    const backup = await direct(client, VERIFY_BACKUP_CODE_PATH, { code: puppet.backupCodes[0] });
    expect(backup.status).toBe(403);
    for (const row of await sessionsOf(puppet.id)) expect(row.secondFactorAt).toBeNull();
  });

  it("a suspended account's session: 403, and no mark", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithGoogle(client, admin.email);
    await testDb().update(user).set({ suspendedAt: new Date() }).where(eq(user.id, admin.id));
    const answer = await direct(client, VERIFY_TOTP_PATH, { code: await nextTotp(admin.totpURI) });
    expect(answer.status).toBe(403);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
  });

  it("control: the same direct request from an ordinary session of the account steps up", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithGoogle(client, admin.email);
    const answer = await direct(client, VERIFY_TOTP_PATH, { code: await nextTotp(admin.totpURI) });
    expect(answer.status).toBe(200);
    expect((await onlySession(admin.id)).secondFactorAt).toBeInstanceOf(Date);
  });
});

describe("a session cannot hand itself a second factor", () => {
  it("a stolen session without the password cannot enrol, switch off or re-issue the factor", async () => {
    // The owner has a password; whoever holds this Google-made session does not know it.
    const made = await verifiedUser();
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, made.user.id));
    const stolen = newClient();
    await signInWithGoogle(stolen, made.email);
    for (const body of [{}, { password: "a guess at the password 1!" }]) {
      const sent = await send(stolen, "/api/auth/two-factor/enable", { json: body });
      expect(sent.status, JSON.stringify(body)).toBe(400);
    }
    expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, made.user.id))).toEqual([]);
    expect((await userById(made.user.id))!.twoFactorEnabled).not.toBe(true);
    expectRefused(await adminCall(stolen));
  });

  it("an enrolment begun elsewhere: confirming it from a session that did not prove the password gives that session no mark", async () => {
    const made = await verifiedUser();
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, made.user.id));
    // The owner starts enrolling (password proven on the OWNER's session) and is shown the secret…
    const enabled = await send(made.client, "/api/auth/two-factor/enable", { json: { password: PASSWORD } });
    const { totpURI } = enabled.body as { totpURI: string };
    // …which somebody with another (stolen) session of the account has seen.
    const stolen = newClient();
    await signInWithGoogle(stolen, made.email);
    const confirmed = await send(stolen, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(totpURI) },
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect((await userById(made.user.id))!.twoFactorEnabled).toBe(true);
    // Two-factor is on, and NO session of the account carries a second factor.
    for (const row of await sessionsOf(made.user.id)) expect(row.secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(stolen));
  });

  it("the proof of the password is for ten minutes and one session: an old one marks nothing", async () => {
    const made = await verifiedUser();
    const enabled = await send(made.client, "/api/auth/two-factor/enable", { json: { password: PASSWORD } });
    const { totpURI } = enabled.body as { totpURI: string };
    const proofs = () =>
      testDb().select().from(verification).where(like(verification.identifier, "2fa-enrol:%"));
    const mine = (await proofs()).filter((row) => row.value === made.user.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(ENROL_PROOF_S * 1000);
    await testDb()
      .update(verification)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(verification.id, mine[0]!.id));
    const confirmed = await send(made.client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(totpURI) },
    });
    expect(confirmed.status, confirmed.text).toBe(200);
    expect((await onlySession(made.user.id)).secondFactorAt).toBeNull();
  });

  it("enabling two-factor takes the mark off every OTHER session of the account", async () => {
    // A session can carry a mark before two-factor exists only if it is written there: this
    // shows the rule, not a path to it.
    const made = await verifiedUser();
    const other = newClient();
    expect((await signIn(other, made.email)).status).toBe(200);
    await testDb()
      .update(session)
      .set({ secondFactorAt: new Date() })
      .where(eq(session.userId, made.user.id));
    await enableTotp(made.client);
    const rows = await sessionsOf(made.user.id);
    expect(rows.filter((row) => row.secondFactorAt !== null)).toHaveLength(1);
    const mine = (await send(made.client, "/api/auth/get-session")).body as { session: { id: string } };
    expect(rows.find((row) => row.secondFactorAt !== null)!.id).toBe(mine.session.id);
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

  it("a step is spent per account: the same six digits are another account's own (wrong) code", async () => {
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

describe("TOTP steps only move forward", () => {
  it("after a newer step was accepted, an older one that is still inside the window is refused", async () => {
    const admin = await adminWithTotp();
    const current = Math.floor(Date.now() / 30_000);
    const browser = newClient();
    await signIn(browser, admin.email);
    const newer = await send(browser, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await totp(admin.totpURI, (current + 1) * 30_000) },
    });
    expect(newer.status, newer.text).toBe(200);
    const second = newClient();
    await signIn(second, admin.email);
    const older = await send(second, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await totp(admin.totpURI, current * 30_000) },
    });
    expect(older.status).toBe(401);
    expect(second.cookies.has("hf.session_token")).toBe(false);
    const stored = await testDb()
      .select()
      .from(verification)
      .where(eq(verification.identifier, `totp-step:${admin.id}`));
    expect(stored.map((row) => row.value)).toEqual([String(current + 1)]);
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
    const reset = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword, token },
    });
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

describe("the only writers of secondFactorAt (source scan)", () => {
  const sources = {
    ...import.meta.glob("../../../src/**/*.ts", { query: "?raw", import: "default", eager: true }),
    ...import.meta.glob("../../../src/**/*.tsx", { query: "?raw", import: "default", eager: true }),
    ...import.meta.glob("../../../scripts/*.ts", { query: "?raw", import: "default", eager: true }),
  };
  const mentions = (pattern: RegExp) =>
    Object.entries(sources)
      .flatMap(([file, text]) =>
        text
          .split("\n")
          .filter((line) => pattern.test(line) && !/^\s*(?:\/\/|\*|\/\*)/.test(line))
          .map((line) => `${file.replace(/^(?:\.\.\/)+/, "")}: ${line.trim()}`),
      )
      .sort();

  it("every line of the Worker, the client and the scripts that names the field is one of these", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(80);
    expect(Object.keys(sources).some((file) => file.endsWith("scripts/create-session.ts"))).toBe(true);
    const outside = mentions(/secondFactorAt|second_factor_at/).filter(
      (line) => !line.startsWith("src/worker/auth/second-factor.ts:"),
    );
    expect(outside).toEqual([
      // read
      "src/worker/auth/admin-gate.ts: hasSecondFactor(session.session as { secondFactorAt?: unknown });",
      // declared: not settable by any request body
      'src/worker/auth/fields.ts: secondFactorAt: { type: "date", required: false, input: false },',
      // WRITE 1: every new session, from the grants of this request (null otherwise)
      "src/worker/auth/hooks.ts: secondFactorAt: secondFactorOfNewSession(scope, session),",
      "src/worker/auth/types.ts: secondFactorAt?: Date | null;",
      'src/worker/db/auth-schema.ts: secondFactorAt: timestamp("second_factor_at"),',
      // WRITE 2: stampSecondFactor (step-up); then clearSecondFactor, which only ever removes it
      "src/worker/db/queries/auth-lifecycle.ts: .set({ secondFactorAt: at })",
      "src/worker/db/queries/auth-lifecycle.ts: .set({ secondFactorAt: null })",
      "src/worker/db/queries/auth-lifecycle.ts: isNotNull(session.secondFactorAt),",
    ]);
    // Inside the module itself the field is only read; it writes through the two functions above.
    const inside = mentions(/secondFactorAt/).filter((line) =>
      line.startsWith("src/worker/auth/second-factor.ts:"),
    );
    for (const line of inside) expect(line, line).not.toMatch(/secondFactorAt\s*[:=][^=]/);
  });

  it("stampSecondFactor has one caller (the step-up), and no raw SQL anywhere names the column", () => {
    expect(mentions(/stampSecondFactor\(/).filter((line) => !/export async function/.test(line))).toEqual([
      "src/worker/auth/second-factor.ts: if (await stampSecondFactor(scope.db, attempt.sessionId, attempt.userId, now())) {",
    ]);
    expect(mentions(/second_factor_at/)).toEqual([
      'src/worker/db/auth-schema.ts: secondFactorAt: timestamp("second_factor_at"),',
    ]);
  });
});

describe("fail-closed: the attempt count starts again only on proof of a valid factor", () => {
  const ctxFor = (path: string, returned: unknown) =>
    ({ path, context: { returned } }) as unknown as Parameters<typeof afterSecondFactor>[1];
  const attemptOf = (
    account: { id: string; email: string },
    method: "totp" | "backup_code",
    backupCodesBefore: string | null,
    proved: boolean,
  ) => ({
    userId: account.id,
    sessionId: null,
    mode: "sign_in" as const,
    method,
    lockedNow: false,
    grantsNewSession: false,
    proved,
    backupCodesBefore,
    email: account.email,
    name: "x",
  });
  const counted = async (userId: string) =>
    (await testDb().select().from(twoFactor).where(eq(twoFactor.userId, userId)))[0]!;

  it("an answer that is not an error but proves nothing — an unused backup code, an unverified TOTP — is refused, audited, and stays counted", async () => {
    const admin = await adminWithTotp();
    await testDb()
      .update(twoFactor)
      .set({ failedVerificationCount: 3 })
      .where(eq(twoFactor.userId, admin.id));
    const stored = (await counted(admin.id)).backupCodes;
    for (const [method, path] of [
      ["backup_code", VERIFY_BACKUP_CODE_PATH],
      ["totp", VERIFY_TOTP_PATH],
    ] as const) {
      const pending: Promise<unknown>[] = [];
      const scope = createScope(env, testDb(), {
        waitUntil: (promise) => void pending.push(promise),
        passThroughOnException() {},
      });
      scope.facts.secondFactor = attemptOf(admin, method, method === "backup_code" ? stored : null, false);
      // The endpoint "succeeded" — and no code of this account was used, no TOTP step was proved.
      const thrown = await afterSecondFactor(scope, ctxFor(path, { token: "t", user: {} })).then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.allSettled(pending);
      expect(thrown, method).toMatchObject({ statusCode: 401 });
      expect((await counted(admin.id)).failedVerificationCount, method).toBe(3);
    }
    expect(
      (await auditRows({ action: "auth.second_factor_failed", targetId: admin.id })).filter(
        (row) => (row.meta as { reason?: string }).reason === "unproven",
      ),
    ).toHaveLength(2);
  });

  it("the control: with the proof — a TOTP step we verified, or backup codes that changed — the count starts again", async () => {
    const admin = await adminWithTotp();
    for (const [method, path, before, proved] of [
      ["totp", VERIFY_TOTP_PATH, null, true],
      ["backup_code", VERIFY_BACKUP_CODE_PATH, "what was stored before a code was used", false],
    ] as const) {
      await testDb()
        .update(twoFactor)
        .set({ failedVerificationCount: 3 })
        .where(eq(twoFactor.userId, admin.id));
      const scope = createScope(env, testDb(), { waitUntil() {}, passThroughOnException() {} });
      scope.facts.secondFactor = attemptOf(admin, method, before, proved);
      await afterSecondFactor(scope, ctxFor(path, { token: "t", user: {} }));
      expect((await counted(admin.id)).failedVerificationCount, method).toBe(0);
    }
  });
});
