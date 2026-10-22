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
  maxGuessesPerWindow,
  SECOND_FACTOR_DEVICE_ATTEMPTS,
  SECOND_FACTOR_MAX_AGE_MS,
  SECOND_FACTOR_MAX_ATTEMPTS,
  SECOND_FACTOR_WINDOW_S,
  VERIFY_BACKUP_CODE_PATH,
  VERIFY_TOTP_PATH,
} from "../../../src/worker/auth/second-factor";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { rateLimit, session, twoFactor, user, verification } from "../../../src/worker/db/schema";
import {
  auditRows,
  CAPTCHA,
  enableTotp,
  freshIp,
  linkIn,
  mailTo,
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

const DEVICE = "hf_device";
const THROTTLED = "SECOND_FACTOR_THROTTLED";
/** The second-factor budgets of an account (rows of `rate_limit`), by what they are for. */
async function budgets(userId: string) {
  const rows = await testDb()
    .select()
    .from(rateLimit)
    .where(like(rateLimit.key, `2fa:${userId}:%`));
  return {
    /** Counted attempts from browsers nobody has seen — the account-wide budget. */
    account: rows.find((row) => row.key === `2fa:${userId}:new`)?.count ?? 0,
    devices: rows.filter((row) => row.key.startsWith(`2fa:${userId}:dev:`)).map((row) => row.count),
    rows,
  };
}
/** As if the budgets' window had begun `seconds` earlier. */
async function ageBudgets(userId: string, seconds: number) {
  for (const row of (await budgets(userId)).rows) {
    await testDb()
      .update(rateLimit)
      .set({ lastRequest: row.lastRequest - seconds * 1000 })
      .where(eq(rateLimit.id, row.id));
  }
}
const knownDeviceRows = async (userId: string) =>
  (await testDb().select().from(verification).where(like(verification.identifier, "known-device:%"))).filter(
    (row) => row.value === userId,
  );

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

    // The re-created session has no mark, so the password alone no longer switches the factor
    // off (R1) …
    const refused = await send(client, "/api/auth/two-factor/disable", { json: { password: newPassword } });
    expect(refused.status, refused.text).toBe(403);
    expect(refused.body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    // … it proves the factor again first; and the session `disable` then re-creates has none.
    const stepped = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(stepped.status, stepped.text).toBe(200);
    expect((await onlySession(admin.id)).secondFactorAt).toBeInstanceOf(Date);
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
    // The mark is gone, so the SAME session — right password and all — cannot re-issue them
    // again: the password is the first factor, not the second (R1). It proves the factor first.
    const unmarked = await send(bossClient, "/api/auth/two-factor/generate-backup-codes", {
      json: { password: PASSWORD },
    });
    expect(unmarked.status, unmarked.text).toBe(403);
    expect(unmarked.body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED" });
    const again = await send(bossClient, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(boss.totpURI) },
    });
    expect(again.status, again.text).toBe(200);
    // …and with the mark it still needs the password too. (Another address: Better Auth's own
    // per-address rule on this path would answer 429 before the endpoint is reached.)
    bossClient.ip = freshIp();
    const without = await send(bossClient, "/api/auth/two-factor/generate-backup-codes", { json: {} });
    expect(without.status).toBe(400);
    const wrong = await send(bossClient, "/api/auth/two-factor/generate-backup-codes", {
      json: { password: "not the password at all 1!" },
    });
    expect(wrong.status).toBe(400);
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

  it("under pressure from clients it has never seen, the owner at a browser that has passed the factor still gets in (R4)", async () => {
    const admin = await adminWithTotp();
    // The owner's own browser: it has passed this account's second factor before.
    const owner = newClient();
    await signInWithCode(owner, admin.email, admin.totpURI);
    await send(owner, "/api/auth/sign-out", { json: {} });
    // An attacker who knows the password (or holds any session): wrong codes, from fresh clients,
    // for as long as they like.
    for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS + 3; attempt++) {
      const attacker = newClient();
      expect((await signIn(attacker, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
      // (Wrong codes of BOTH kinds: a backup code is judged by Better Auth's own verifier, whose
      // own lock — check-then-count, on the account — must stay switched off.)
      const sent =
        attempt % 2 === 0
          ? await send(attacker, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
              json: { code: `nope${attempt}-nope${attempt}` },
            })
          : await send(attacker, `/api/auth${VERIFY_TOTP_PATH}`, {
              json: { code: String(600000 + attempt) },
            });
      expect(sent.status, `attempt ${attempt + 1}`).toBe(attempt < SECOND_FACTOR_MAX_ATTEMPTS ? 401 : 429);
    }
    // Nothing is written on the enrolment itself: there is no lock on the account.
    const [enrolment] = await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id));
    expect(enrolment!.lockedUntil).toBeNull();
    expect(enrolment!.failedVerificationCount ?? 0).toBe(0);
    // The owner is not refused: password, then the right code, at the known browser.
    expect((await signIn(owner, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
    const right = await send(owner, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(right.status, right.text).toBe(200);
    expect((await adminCall(owner)).status).toBe(200);
  });

  it(`a browser nobody has seen is bounded: ${SECOND_FACTOR_MAX_ATTEMPTS} wrong codes per window for the whole account, then even the right code is refused from such a browser — audited, mailed once, and over when the window ends`, async () => {
    const { admin, client } = await googleSession();
    expect(client.cookies.has(DEVICE)).toBe(false);
    for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS; attempt++) {
      // A guesser spreads over addresses; the limit is on the ACCOUNT.
      client.ip = freshIp();
      const sent = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
        json: { code: String(100000 + attempt) },
      });
      expect(sent.status, `attempt ${attempt + 1}: ${sent.text}`).toBe(401);
    }
    expect((await budgets(admin.id)).account).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    // Nothing is written on the enrolment: there is no lock on the account.
    const [enrolment] = await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id));
    expect(enrolment!.lockedUntil).toBeNull();

    client.ip = freshIp();
    const right = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(right.status).toBe(429);
    expect(right.body).toMatchObject({ code: THROTTLED });
    const wait = Number(right.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(SECOND_FACTOR_WINDOW_S - 60);
    expect(wait).toBeLessThanOrEqual(SECOND_FACTOR_WINDOW_S);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    expectNeedsSecondFactor(await adminCall(client));
    // A backup code is refused for as long, on the same budget — and is not used up by it.
    client.ip = freshIp();
    const backup = await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
      json: { code: admin.backupCodes[2] },
    });
    expect(backup.status).toBe(429);
    // The same budget for a NEW session and for the sign-in challenge, from another new browser.
    const elsewhere = newClient();
    expect((await signIn(elsewhere, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
    const challenge = await send(elsewhere, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(challenge.status).toBe(429);
    expect(elsewhere.cookies.has("hf.session_token")).toBe(false);
    // A refused attempt is not counted, and looks at nothing.
    expect((await budgets(admin.id)).account).toBe(SECOND_FACTOR_MAX_ATTEMPTS);

    // Audited without any code, and the owner is told — once.
    const failed = await auditRows({ action: "auth.second_factor_failed", targetId: admin.id });
    expect(failed).toHaveLength(SECOND_FACTOR_MAX_ATTEMPTS);
    expect(JSON.stringify(failed)).not.toMatch(/10000\d/);
    expect(await auditRows({ action: "auth.second_factor_exhausted", targetId: admin.id })).toHaveLength(1);
    const mail = await waitForMail(admin.email, "secondFactorLocked");
    expect(mail.text).toContain("15 minutes");

    // A real window: once it has ended, codes work again from such a browser, and the count
    // has started over.
    await ageBudgets(admin.id, SECOND_FACTOR_WINDOW_S + 1);
    client.ip = freshIp();
    const later = await send(client, `/api/auth${VERIFY_BACKUP_CODE_PATH}`, {
      json: { code: admin.backupCodes[2] },
    });
    expect(later.status, later.text).toBe(200);
    expect((await budgets(admin.id)).account).toBe(0);
    expect((await adminCall(client)).status).toBe(200);
  });

  it("fifty wrong codes at the same moment: no more than the cap are even looked at, the right code sent with them from a new browser is refused — and ONE mail", async () => {
    const { admin, client } = await googleSession();
    const from = (code: string) =>
      send({ ...client, ip: freshIp(), cookies: new Map(client.cookies) }, `/api/auth${VERIFY_TOTP_PATH}`, {
        json: { code },
      });
    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => from(String(300000 + index))));
    const statuses = answers.map((answer) => answer.status);
    const lookedAt = statuses.filter((status) => status === 401).length;
    const throttled = answers.filter(
      (answer) => answer.status === 429 && (answer.body as { code?: string })?.code === THROTTLED,
    ).length;
    expect(lookedAt, statuses.join(",")).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    expect(throttled).toBe(50 - SECOND_FACTOR_MAX_ATTEMPTS);
    expect((await budgets(admin.id)).account).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
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
    await waitForMail(admin.email, "secondFactorLocked");
    expect(mailTo(admin.email, "secondFactorLocked")).toHaveLength(1);
  });

  it("a known device's own budget is charged atomically too: forty wrong codes at once with ONE proof — exactly the device's cap are looked at, and none lands on the account's budget", async () => {
    const admin = await adminWithTotp();
    const known = newClient();
    await signInWithCode(known, admin.email, admin.totpURI);
    await send(known, "/api/auth/sign-out", { json: {} });
    expect((await signIn(known, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
    const before = await budgets(admin.id);
    const answers = await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        send({ ...known, ip: freshIp(), cookies: new Map(known.cookies) }, `/api/auth${VERIFY_TOTP_PATH}`, {
          json: { code: String(650000 + index) },
        }),
      ),
    );
    const statuses = answers.map((answer) => answer.status);
    expect(
      statuses.filter((status) => status === 401),
      statuses.join(","),
    ).toHaveLength(SECOND_FACTOR_DEVICE_ATTEMPTS);
    expect(statuses.filter((status) => status === 429)).toHaveLength(40 - SECOND_FACTOR_DEVICE_ATTEMPTS);
    const after = await budgets(admin.id);
    expect(after.account).toBe(before.account);
    expect(after.devices.filter((count) => count > 0)).toEqual([SECOND_FACTOR_DEVICE_ATTEMPTS]);
    expect(await auditRows({ action: "auth.second_factor_failed", targetId: admin.id })).toHaveLength(
      SECOND_FACTOR_DEVICE_ATTEMPTS,
    );
  });

  it("the exhaustion mail is sent at most once per window, whatever number of budgets run out in it", async () => {
    const admin = await adminWithTotp();
    // A known device, in the wrong hands, and fresh clients: two budgets run out in one window.
    const known = newClient();
    await signInWithCode(known, admin.email, admin.totpURI);
    await send(known, "/api/auth/sign-out", { json: {} });
    for (const client of [known, newClient()]) {
      await signIn(client, admin.email);
      for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS + 1; attempt++) {
        client.ip = freshIp();
        await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: String(700000 + attempt) } });
      }
    }
    expect(await auditRows({ action: "auth.second_factor_exhausted", targetId: admin.id })).toHaveLength(2);
    await waitForMail(admin.email, "secondFactorLocked");
    expect(mailTo(admin.email, "secondFactorLocked")).toHaveLength(1);
    // The next window may announce again.
    await ageBudgets(admin.id, SECOND_FACTOR_WINDOW_S + 1);
    const again = newClient();
    await signIn(again, admin.email);
    for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS; attempt++) {
      again.ip = freshIp();
      await send(again, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: String(710000 + attempt) } });
    }
    await waitForMail(admin.email, "secondFactorLocked", 2);
    expect(mailTo(admin.email, "secondFactorLocked")).toHaveLength(2);
  });

  it("the guess budget of an attacker with K stolen known-device proofs and unlimited fresh clients is bounded per window: 5 + 5K codes looked at", async () => {
    const admin = await adminWithTotp();
    const STOLEN = 2;
    expect(maxGuessesPerWindow(STOLEN)).toBe(15);
    expect(maxGuessesPerWindow(STOLEN)).toBe(
      SECOND_FACTOR_MAX_ATTEMPTS + STOLEN * SECOND_FACTOR_DEVICE_ATTEMPTS,
    );
    // Three browsers of the owner's have passed the factor; the attacker has copied the proof of two.
    const browsers: Client[] = [];
    for (let n = 0; n < STOLEN + 1; n++) {
      const browser = newClient();
      await signInWithCode(browser, admin.email, admin.totpURI);
      expect(browser.cookies.has(DEVICE)).toBe(true);
      await send(browser, "/api/auth/sign-out", { json: {} });
      browsers.push(browser);
    }
    // (and the browser that enrolled)
    expect(await knownDeviceRows(admin.id)).toHaveLength(STOLEN + 2);
    const stolen = browsers.slice(0, STOLEN).map((browser) => browser.cookies.get(DEVICE)!);
    const ownersOwn = browsers[STOLEN]!;
    // The attacker: every stolen proof, and no proof at all, in turn — far more than the bound.
    let lookedAt = 0;
    let refused = 0;
    for (let attempt = 0; attempt < 3 * maxGuessesPerWindow(STOLEN); attempt++) {
      const attacker = newClient();
      const proof = [...stolen, null][attempt % (STOLEN + 1)];
      if (proof) attacker.cookies.set(DEVICE, proof);
      expect((await signIn(attacker, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
      const sent = await send(attacker, `/api/auth${VERIFY_TOTP_PATH}`, {
        json: { code: String(800000 + attempt) },
      });
      if (sent.status === 401) lookedAt += 1;
      else {
        expect(sent.status, sent.text).toBe(429);
        expect(sent.body).toMatchObject({ code: THROTTLED });
        refused += 1;
      }
    }
    expect(lookedAt).toBe(maxGuessesPerWindow(STOLEN));
    expect(refused).toBe(2 * maxGuessesPerWindow(STOLEN));
    // Counted where a code is actually EVALUATED, not only by the answers: one audit row per
    // code that was looked at (written after the comparison), and none for a refused attempt.
    expect(await auditRows({ action: "auth.second_factor_failed", targetId: admin.id })).toHaveLength(
      maxGuessesPerWindow(STOLEN),
    );
    expect(
      (await auditRows({ action: "auth.second_factor_refused", targetId: admin.id })).filter(
        (row) => (row.meta as { reason?: string } | null)?.reason === "throttled",
      ),
    ).toHaveLength(2 * maxGuessesPerWindow(STOLEN));
    const spent = await budgets(admin.id);
    expect(spent.account).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    // The owner's third browser has a budget nobody else has touched: no row, or an empty one.
    expect(spent.devices.filter((count) => count > 0)).toEqual(
      Array.from({ length: STOLEN }, () => SECOND_FACTOR_DEVICE_ATTEMPTS),
    );
    // …so the owner, there, still gets in.
    expect((await signIn(ownersOwn, admin.email)).body).toMatchObject({ twoFactorRedirect: true });
    const right = await send(ownersOwn, `/api/auth${VERIFY_TOTP_PATH}`, {
      json: { code: await nextTotp(admin.totpURI) },
    });
    expect(right.status, right.text).toBe(200);
  });

  it("a proof is for ITS account, and counts only while its row exists: another account's, a forged one and a deleted one are a browser nobody has seen", async () => {
    const admin = await adminWithTotp();
    const other = await adminWithTotp();
    const otherBrowser = newClient();
    await signInWithCode(otherBrowser, other.email, other.totpURI);
    const own = newClient();
    await signInWithCode(own, admin.email, admin.totpURI);
    await send(own, "/api/auth/sign-out", { json: {} });
    const ownProof = own.cookies.get(DEVICE)!;
    const [body, mac] = ownProof.split(".");
    const forged = `${body}.${mac!.slice(0, -2)}${mac!.endsWith("AA") ? "BB" : "AA"}`;
    let expected = 0;
    for (const proof of [otherBrowser.cookies.get(DEVICE)!, forged]) {
      const client = newClient();
      client.cookies.set(DEVICE, proof);
      await signIn(client, admin.email);
      expect((await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: "900001" } })).status).toBe(
        401,
      );
      expected += 1;
      const spent = await budgets(admin.id);
      expect(spent.account).toBe(expected);
      expect(spent.devices.filter((count) => count > 0)).toEqual([]);
    }
    // Control: the real proof counts on its own budget.
    const real = newClient();
    real.cookies.set(DEVICE, ownProof);
    await signIn(real, admin.email);
    expect((await send(real, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: "900002" } })).status).toBe(401);
    expect(await budgets(admin.id)).toMatchObject({ account: expected, devices: [1] });
    // Its row deleted: the same cookie is a browser nobody has seen.
    await testDb().delete(verification).where(eq(verification.value, admin.id));
    const stale = newClient();
    stale.cookies.set(DEVICE, ownProof);
    await signIn(stale, admin.email);
    expect((await send(stale, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: "900003" } })).status).toBe(
      401,
    );
    expect(await budgets(admin.id)).toMatchObject({ account: expected + 1, devices: [1] });
  });

  it("every proof dies on a password reset, a password change, new backup codes, and switching the factor off", async () => {
    const proofsAfter = async (
      change: (admin: Awaited<ReturnType<typeof adminWithTotp>>, client: Client) => Promise<void>,
    ) => {
      const admin = await adminWithTotp();
      const client = newClient();
      await signInWithCode(client, admin.email, admin.totpURI);
      // (the enrolling browser and this one)
      expect((await knownDeviceRows(admin.id)).length).toBeGreaterThanOrEqual(2);
      await change(admin, client);
      return (await knownDeviceRows(admin.id)).length;
    };
    const ok = (sent: Awaited<ReturnType<typeof send>>) => expect(sent.status, sent.text).toBe(200);
    expect(
      await proofsAfter(async (admin) => {
        await send(newClient(), "/api/auth/request-password-reset", {
          json: { email: admin.email, redirectTo: "/reset-password" },
          headers: CAPTCHA,
        });
        const follow = await send(newClient(), linkIn(await waitForMail(admin.email, "passwordReset")));
        const token = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
        ok(
          await send(newClient(), "/api/auth/reset-password", {
            headers: CAPTCHA,
            json: { newPassword: "a reset long passphrase 61!", token },
          }),
        );
      }),
      "password reset",
    ).toBe(0);
    expect(
      await proofsAfter(async (_admin, client) =>
        ok(
          await send(client, "/api/auth/change-password", {
            json: { currentPassword: PASSWORD, newPassword: "a changed long passphrase 5!" },
          }),
        ),
      ),
      "password change",
    ).toBe(0);
    expect(
      await proofsAfter(async (_admin, client) =>
        ok(
          await send(client, "/api/auth/two-factor/generate-backup-codes", { json: { password: PASSWORD } }),
        ),
      ),
      "new backup codes",
    ).toBe(0);
    expect(
      await proofsAfter(async (_admin, client) =>
        ok(await send(client, "/api/auth/two-factor/disable", { json: { password: PASSWORD } })),
      ),
      "two-factor off",
    ).toBe(0);
  });

  it("'remember this device' does not outlive a two-factor change: new backup codes, and a new enrolment, end it (N4)", async () => {
    const trustRows = async (userId: string) =>
      (
        await testDb().select().from(verification).where(like(verification.identifier, "trust-device-%"))
      ).filter((row) => row.value === userId);
    for (const change of ["new backup codes", "off and on again"] as const) {
      // (Not an admin: an admin is never given the cookie.)
      const made = await verifiedUser();
      const { totpURI } = await enableTotp(made.client);
      await send(made.client, "/api/auth/sign-out", { json: {} });
      const remembered = newClient();
      await signInWithCode(remembered, made.email, totpURI, { trustDevice: true });
      expect(await trustRows(made.user.id), change).toHaveLength(1);
      await send(remembered, "/api/auth/sign-out", { json: {} });
      // Control: that browser now skips the challenge.
      expect((await signIn(remembered, made.email)).body, change).not.toMatchObject({
        twoFactorRedirect: true,
      });
      await send(remembered, "/api/auth/sign-out", { json: {} });
      // The owner changes the factor, from a session that has passed it.
      const owner = newClient();
      await signInWithCode(owner, made.email, totpURI);
      if (change === "new backup codes") {
        const done = await send(owner, "/api/auth/two-factor/generate-backup-codes", {
          json: { password: PASSWORD },
        });
        expect(done.status, done.text).toBe(200);
      } else {
        expect(
          (await send(owner, "/api/auth/two-factor/disable", { json: { password: PASSWORD } })).status,
        ).toBe(200);
        await enableTotp(owner);
      }
      expect(await trustRows(made.user.id), change).toEqual([]);
      // The remembered browser meets the challenge again.
      expect((await signIn(remembered, made.email)).body, change).toMatchObject({ twoFactorRedirect: true });
    }
  });

  it("the sign-in challenge spends the same budget, one per attempt — and a correct code gives back its own attempt, not the wrong ones", async () => {
    const admin = await adminWithTotp();
    const browser = newClient();
    await signIn(browser, admin.email);
    const count = async () => (await budgets(admin.id)).account;
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
    expect(await count()).toBe(3);
    // …and this browser is now a known device, with a budget of its own.
    expect(browser.cookies.has(DEVICE)).toBe(true);
  });

  it("a window is a window: wrong codes do not add up across it (R10)", async () => {
    const { admin, client } = await googleSession();
    for (let attempt = 0; attempt < SECOND_FACTOR_MAX_ATTEMPTS - 1; attempt++) {
      client.ip = freshIp();
      await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: String(200000 + attempt) } });
    }
    expect((await budgets(admin.id)).account).toBe(SECOND_FACTOR_MAX_ATTEMPTS - 1);
    // The window began with the FIRST of them; a later attempt does not move its end.
    await ageBudgets(admin.id, SECOND_FACTOR_WINDOW_S - 5);
    client.ip = freshIp();
    await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: "200010" } });
    expect((await budgets(admin.id)).account).toBe(SECOND_FACTOR_MAX_ATTEMPTS);
    await ageBudgets(admin.id, 10);
    // Months later, as it were: one mistake is one mistake — nothing is refused, nobody is mailed.
    client.ip = freshIp();
    const sent = await send(client, `/api/auth${VERIFY_TOTP_PATH}`, { json: { code: "200011" } });
    expect(sent.status).toBe(401);
    expect((await budgets(admin.id)).account).toBe(1);
    expect(await auditRows({ action: "auth.second_factor_exhausted", targetId: admin.id })).toHaveLength(1);
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

describe("the password is the FIRST factor: it cannot read, re-issue, replace or switch off the second (R1)", () => {
  const MANAGE = ["get-totp-uri", "generate-backup-codes", "disable", "enable"] as const;
  const NEW_PASSWORD = "set by whoever reads the mailbox 7!";
  const factorRow = async (userId: string) =>
    (await testDb().select().from(twoFactor).where(eq(twoFactor.userId, userId)))[0];

  function expectSecondFactorRequired(sent: Awaited<ReturnType<typeof send>>, what: string) {
    expect(sent.status, `${what}: ${sent.text}`).toBe(403);
    expect(sent.body).toMatchObject({ code: "SECOND_FACTOR_REQUIRED", error: "second_factor_required" });
  }

  it("control of an admin's mailbox is not admin: reset the password, sign in with Google, ask for the TOTP secret — refused", async () => {
    const admin = await adminWithTotp();
    const before = (await factorRow(admin.id))!;
    // 1–2. The attacker controls the mailbox (nothing else): a reset mail, a password of their own.
    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email: admin.email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const mail = await waitForMail(admin.email, "passwordReset");
    const follow = await send(newClient(), linkIn(mail));
    const token = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
    const reset = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: NEW_PASSWORD, token },
    });
    expect(reset.status, reset.text).toBe(200);
    // (A password sign-in stops at the challenge.)
    expect((await signIn(newClient(), admin.email, NEW_PASSWORD)).body).toMatchObject({
      twoFactorRedirect: true,
    });
    // 3. A Google identity for the address: a session, one factor.
    const attacker = newClient();
    await signInWithGoogle(attacker, admin.email);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    // 4. The TOTP secret, for the password. REFUSED — this is where the attack ends.
    const secret = await send(attacker, "/api/auth/two-factor/get-totp-uri", {
      json: { password: NEW_PASSWORD },
    });
    expectSecondFactorRequired(secret, "get-totp-uri");
    expect(secret.text).not.toContain("otpauth://");
    // The other three ways the password could have produced a factor.
    for (const path of MANAGE) {
      const sent = await send(attacker, `/api/auth/two-factor/${path}`, { json: { password: NEW_PASSWORD } });
      expectSecondFactorRequired(sent, path);
      expect(sent.text).not.toContain("otpauth://");
      expect(sent.text).not.toContain("backupCodes");
    }
    // Nothing about the enrolment moved, and the session is still one-factor.
    const after = (await factorRow(admin.id))!;
    expect(after.secret).toBe(before.secret);
    expect(after.backupCodes).toBe(before.backupCodes);
    expect(after.verified).toBe(true);
    expect((await userById(admin.id))!.twoFactorEnabled).toBe(true);
    expect((await onlySession(admin.id)).secondFactorAt).toBeNull();
    // 5. No admin action.
    expectNeedsSecondFactor(await adminCall(attacker));
    // Each refusal is in the audit log.
    const refusals = (await auditRows({ action: "auth.second_factor_refused", targetId: admin.id })).filter(
      (row) => (row.meta as { reason?: string } | null)?.reason === "needs_second_factor",
    );
    expect(refusals.length).toBe(MANAGE.length + 1);
  });

  it("control: a session that HAS passed the factor reads the secret and re-issues the codes with the password — each audited", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    const uri = await send(client, "/api/auth/two-factor/get-totp-uri", { json: { password: PASSWORD } });
    expect(uri.status, uri.text).toBe(200);
    expect((uri.body as { totpURI: string }).totpURI).toContain("otpauth://");
    expect(await auditRows({ action: "auth.totp_secret_viewed", targetId: admin.id })).toHaveLength(1);
    const codes = await send(client, "/api/auth/two-factor/generate-backup-codes", {
      json: { password: PASSWORD },
    });
    expect(codes.status, codes.text).toBe(200);
    expect(await auditRows({ action: "auth.backup_codes_regenerated", targetId: admin.id })).toHaveLength(1);
    // A refused call writes neither.
    const wrong = await send(client, "/api/auth/two-factor/get-totp-uri", {
      json: { password: "not the password at all 1!" },
    });
    expect(wrong.status).toBe(403);
    expect(await auditRows({ action: "auth.totp_secret_viewed", targetId: admin.id })).toHaveLength(1);
  });

  it("the first enrolment needs only the password (there is nothing else to prove) — and the owner is told: mail + audit row", async () => {
    const made = await verifiedUser();
    expect(await factorRow(made.user.id)).toBeUndefined();
    await enableTotp(made.client);
    expect((await factorRow(made.user.id))!.verified).toBe(true);
    const mail = await waitForMail(made.email, "twoFactorEnabled");
    expect(mail.class).toBe("account_security");
    expect(await auditRows({ action: "auth.2fa_enabled", targetId: made.user.id })).toHaveLength(1);
    // An enrolment that was begun and never confirmed is not a factor yet: the password may
    // still look at it and start it again.
    const other = await verifiedUser();
    const begun = await send(other.client, "/api/auth/two-factor/enable", { json: { password: PASSWORD } });
    expect(begun.status).toBe(200);
    const seen = await send(other.client, "/api/auth/two-factor/get-totp-uri", {
      json: { password: PASSWORD },
    });
    expect(seen.status, seen.text).toBe(200);
    expect(
      (await send(other.client, "/api/auth/two-factor/enable", { json: { password: PASSWORD } })).status,
    ).toBe(200);
  });

  it("a re-enrolment — switch off, then enrol again — is for a session that has passed the factor; the owner is told each time", async () => {
    const admin = await adminWithTotp();
    const client = newClient();
    await signInWithCode(client, admin.email, admin.totpURI);
    // (Better Auth itself refuses `enable` over a confirmed enrolment: TOTP_ALREADY_ENABLED,
    // plugins/two-factor/index.mjs — replacing a factor is always "off, then on".)
    const off = await send(client, "/api/auth/two-factor/disable", { json: { password: PASSWORD } });
    expect(off.status, off.text).toBe(200);
    await waitForMail(admin.email, "twoFactorDisabled");
    expect(await factorRow(admin.id)).toBeUndefined();
    const { totpURI } = await enableTotp(client);
    expect(totpURI).not.toBe(admin.totpURI);
    await waitForMail(admin.email, "twoFactorEnabled", 2);
    expect(await auditRows({ action: "auth.2fa_enabled", targetId: admin.id })).toHaveLength(2);
    expect(await auditRows({ action: "auth.2fa_disabled", targetId: admin.id })).toHaveLength(1);
  });
});

describe("a session cannot hand itself a second factor", () => {
  it("a stolen session without the password cannot enrol the factor on an account that has none", async () => {
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
    ...import.meta.glob("../../../scripts/lib/*.ts", { query: "?raw", import: "default", eager: true }),
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
      // WRITE 3 (T26B SEAM 1): create-session.ts --two-factor seeds an admin's session as one that
      // passed a code now — a script run against a database, never reachable from a request
      "scripts/lib/seed-session.ts: secondFactorAt: options.twoFactor ? now : null,",
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

describe("fail-closed: an attempt is given back only on proof of a valid factor", () => {
  const cookiesSet: string[] = [];
  const ctxFor = (path: string, returned: unknown) =>
    ({
      path,
      context: { returned },
      setCookie: (name: string) => void cookiesSet.push(name),
    }) as unknown as Parameters<typeof afterSecondFactor>[1];
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
    budget: { key: `2fa:${account.id}:new`, known: false },
    exhaustedNow: false,
    grantsNewSession: false,
    proved,
    backupCodesBefore,
    email: account.email,
    name: "x",
  });
  /** Three counted attempts on the account's budget, as three wrong codes leave it. */
  async function threeCounted(userId: string) {
    await testDb()
      .delete(rateLimit)
      .where(like(rateLimit.key, `2fa:${userId}:%`));
    await testDb()
      .insert(rateLimit)
      .values({ id: crypto.randomUUID(), key: `2fa:${userId}:new`, count: 3, lastRequest: Date.now() });
  }

  it("an answer that is not an error but proves nothing — an unused backup code, an unverified TOTP — is refused, audited, stays counted, and makes no known device", async () => {
    const admin = await adminWithTotp();
    await threeCounted(admin.id);
    const devicesBefore = (await knownDeviceRows(admin.id)).length;
    const [stored] = await testDb().select().from(twoFactor).where(eq(twoFactor.userId, admin.id));
    cookiesSet.length = 0;
    for (const [method, path] of [
      ["backup_code", VERIFY_BACKUP_CODE_PATH],
      ["totp", VERIFY_TOTP_PATH],
    ] as const) {
      const pending: Promise<unknown>[] = [];
      const scope = createScope(env, testDb(), {
        waitUntil: (promise) => void pending.push(promise),
        passThroughOnException() {},
      });
      scope.facts.secondFactor = attemptOf(
        admin,
        method,
        method === "backup_code" ? stored!.backupCodes : null,
        false,
      );
      // The endpoint "succeeded" — and no code of this account was used, no TOTP step was proved.
      const thrown = await afterSecondFactor(scope, ctxFor(path, { token: "t", user: {} })).then(
        () => null,
        (error: unknown) => error,
      );
      await Promise.allSettled(pending);
      expect(thrown, method).toMatchObject({ statusCode: 401 });
      expect((await budgets(admin.id)).account, method).toBe(3);
    }
    expect(cookiesSet).toEqual([]);
    expect((await knownDeviceRows(admin.id)).length).toBe(devicesBefore);
    expect(
      (await auditRows({ action: "auth.second_factor_failed", targetId: admin.id })).filter(
        (row) => (row.meta as { reason?: string }).reason === "unproven",
      ),
    ).toHaveLength(2);
  });

  it("the control: with the proof — a TOTP step we verified, or backup codes that changed — that one attempt is given back and the browser becomes a known device", async () => {
    const admin = await adminWithTotp();
    for (const [method, path, before, proved] of [
      ["totp", VERIFY_TOTP_PATH, null, true],
      ["backup_code", VERIFY_BACKUP_CODE_PATH, "what was stored before a code was used", false],
    ] as const) {
      await threeCounted(admin.id);
      const devicesBefore = (await knownDeviceRows(admin.id)).length;
      cookiesSet.length = 0;
      const scope = createScope(env, testDb(), { waitUntil() {}, passThroughOnException() {} });
      scope.facts.secondFactor = attemptOf(admin, method, before, proved);
      await afterSecondFactor(scope, ctxFor(path, { token: "t", user: {} }));
      expect((await budgets(admin.id)).account, method).toBe(2);
      expect(cookiesSet, method).toEqual([DEVICE]);
      expect((await knownDeviceRows(admin.id)).length, method).toBe(devicesBefore + 1);
    }
  });
});
