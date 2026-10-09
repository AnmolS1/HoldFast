// Linking a Google identity to an account that already exists — and the attack it must not
// complete ("pre-hijacking"): somebody signs up with a victim's address and a password of their
// own, the account sits unverified, and later the victim arrives with Google. If Google's
// identity were linked to that row as it is, the address would become verified with the
// stranger's password still opening the account.
//
// What Better Auth 1.7.7 does by itself (node_modules/better-auth/dist/oauth2/link-account.mjs):
//   :137-139  an implicit link is refused when the provider is not "trusted" and does not say the
//             address is verified, OR when `requireLocalEmailVerified` (default TRUE, :138) and
//             the local account is unverified, OR linking is disabled;
//   :188,:236 after a link it marks the local address verified when the provider verified it;
//   :43,:47   an explicit link (/link-social) needs a provider-verified address equal to the
//             account's unless `allowDifferentEmails`.
// So with the defaults the attack does not complete — the victim is simply refused, for good
// (the stranger's unverifiable account squats the address). The policy here instead lets the
// first person who PROVES the address have it, clean: auth/hooks.ts `account.create`.
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testGoogleCode, type TestGoogleProfile } from "../../../src/worker/auth/test-outbound";
import { passkey, session, twoFactor, user, verification } from "../../../src/worker/db/schema";
import {
  accountsOf,
  auditRows,
  createInvite,
  freshEmail,
  getSession,
  inviteRow,
  mailTo,
  newClient,
  PASSWORD,
  send,
  sessionsOf,
  signIn,
  signUp,
  testDb,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

const profileFor = (email: string, extra: Partial<TestGoogleProfile> = {}): TestGoogleProfile => ({
  sub: `g-${crypto.randomUUID()}`,
  email,
  name: "Vera Victim",
  ...extra,
});

const intent = (client: Client, inviteCode: string | null) =>
  send(client, "/api/auth-intent", {
    json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, ...(inviteCode ? { inviteCode } : {}) },
  });

async function google(client: Client, profile: TestGoogleProfile, start = "/api/auth/sign-in/social") {
  const begun = await send(client, start, {
    json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
  });
  expect(begun.status, begun.text).toBe(200);
  const state = new URL((begun.body as { url: string }).url).searchParams.get("state")!;
  const callback = await send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
  const location = new URL(callback.headers.get("location") ?? "/", "http://localhost");
  return { callback, path: location.pathname, error: location.searchParams.get("error") };
}

/** The attacker's side: an unverified account at the victim's address, with everything a stranger could leave on it. */
async function plantedAccount(victimEmail: string) {
  const attackerInvite = await createInvite();
  const attacker = newClient();
  const { sent } = await signUp(attacker, {
    email: victimEmail,
    name: "Mallory",
    inviteCode: attackerInvite,
  });
  expect(sent.status).toBe(200);
  const row = (await userByEmail(victimEmail))!;
  expect(row.emailVerified).toBe(false);
  // An unverified account has no session, so it cannot enrol a passkey or TOTP through the API.
  // The rows are planted directly: the cleanup must not depend on that being impossible.
  const stamp = new Date(Date.now() - 60_000);
  const token = `planted-${crypto.randomUUID()}`;
  await testDb()
    .insert(session)
    .values({
      id: crypto.randomUUID().replace(/-/g, ""),
      token,
      userId: row.id,
      expiresAt: new Date(Date.now() + 86_400_000),
      createdAt: stamp,
      updatedAt: stamp,
    });
  await testDb()
    .insert(passkey)
    .values({
      id: crypto.randomUUID(),
      publicKey: "planted",
      userId: row.id,
      credentialID: `cred-${crypto.randomUUID()}`,
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
  await testDb()
    .insert(twoFactor)
    .values({ id: crypto.randomUUID(), secret: "planted", backupCodes: "planted", userId: row.id });
  await testDb()
    .update(user)
    .set({ twoFactorEnabled: true, timezone: "Europe/Moscow", image: "https://evil.example/a.png" })
    .where(eq(user.id, row.id));
  await testDb()
    .insert(verification)
    .values({
      id: crypto.randomUUID(),
      identifier: `reset-password:${crypto.randomUUID()}`,
      value: row.id,
      expiresAt: new Date(Date.now() + 3_600_000),
      createdAt: stamp,
      updatedAt: stamp,
    });
  return { row, attacker, attackerInvite };
}

const planted = async (userId: string) => ({
  accounts: (await accountsOf(userId)).map((a) => a.providerId).sort(),
  sessions: (await sessionsOf(userId)).length,
  passkeys: (await testDb().select().from(passkey).where(eq(passkey.userId, userId))).length,
  twoFactor: (await testDb().select().from(twoFactor).where(eq(twoFactor.userId, userId))).length,
  tokens: (await testDb().select().from(verification).where(eq(verification.value, userId))).length,
});

describe("pre-hijacking: a stranger's unverified account at the victim's address", () => {
  it("the victim signs up with Google (intent step): the account is emptied, then theirs — the stranger's password, session, passkey and TOTP are dead", async () => {
    const email = freshEmail();
    const { row, attacker, attackerInvite } = await plantedAccount(email);
    expect(await planted(row.id)).toEqual({
      accounts: ["credential"],
      sessions: 1,
      passkeys: 1,
      twoFactor: 1,
      tokens: 1,
    });

    const inviter = (await verifiedUser()).user;
    const victimInvite = await createInvite({ createdBy: inviter.id });
    const victim = newClient();
    expect((await intent(victim, victimInvite)).status).toBe(200);
    const landed = await google(victim, profileFor(email));
    expect(landed.error, landed.callback.text).toBeNull();
    expect(landed.path).toBe("/");

    // The victim is signed in, in the SAME row (the address is theirs), and it is clean.
    expect((await getSession(victim))?.user.id).toBe(row.id);
    const after = (await userById(row.id))!;
    expect(after).toMatchObject({
      email,
      emailVerified: true,
      twoFactorEnabled: false,
      role: "user",
      image: null,
      timezone: null,
      locale: "en",
      invitedBy: inviter.id,
      termsVersion: "2026-10",
    });
    expect(after.name).not.toBe("Mallory");
    expect(after.ageVerifiedAt!.getTime()).toBeGreaterThan(row.ageVerifiedAt!.getTime());
    const now = await planted(row.id);
    expect(now).toEqual({ accounts: ["google"], sessions: 1, passkeys: 0, twoFactor: 0, tokens: 0 });
    expect((await sessionsOf(row.id)).every((s) => !s.token.startsWith("planted-"))).toBe(true);

    // The stranger: the password opens nothing, and the mail link they were sent verifies nothing new.
    const password = await signIn(newClient(), email, PASSWORD);
    expect(password.status).toBe(401);
    expect(await getSession(attacker)).toBeNull();
    // Their pending-address cookie cannot move the account either (it is verified now).
    const moved = await send(attacker, "/api/account/pending-email", {
      method: "PATCH",
      json: { email: freshEmail() },
    });
    expect(moved.status).toBe(200);
    expect((await userById(row.id))!.email).toBe(email);

    // Invites: the stranger's stays spent, the victim's is spent like any sign-up's.
    expect((await inviteRow(attackerInvite))!.uses).toBe(1);
    expect((await inviteRow(victimInvite))!.uses).toBe(1);
    // Audited with ids and counts only; and nobody is mailed "a new way to sign in was added"
    // (there was no proven owner before this sign-in).
    const audit = await auditRows({ action: "auth.prehijack_cleanup", targetId: row.id });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.meta).toEqual({ accounts: 1, sessions: 1, passkeys: 1, twoFactor: 1, tokens: 1 });
    expect(JSON.stringify(audit[0])).not.toContain(email);
    expect(mailTo(email, "signInMethodAdded")).toEqual([]);
  });

  it("without the intent step (the Google button on the sign-in screen): refused, and NOTHING is linked or removed", async () => {
    const email = freshEmail();
    const { row } = await plantedAccount(email);
    const before = await planted(row.id);
    const victim = newClient();
    const landed = await google(victim, profileFor(email));
    expect(landed.error).toBe("SIGNUP_INTENT_REQUIRED");
    expect(await getSession(victim)).toBeNull();
    expect(await planted(row.id)).toEqual(before);
    expect((await userById(row.id))!).toMatchObject({
      emailVerified: false,
      name: "Mallory",
      twoFactorEnabled: true,
    });
    expect(await auditRows({ action: "auth.prehijack_cleanup", targetId: row.id })).toEqual([]);
    // An intent whose invite is dead is no intent: the same.
    const spent = newClient();
    expect((await intent(spent, await createInvite({ revokedAt: new Date() }))).status).toBe(400);
    expect((await google(spent, profileFor(email))).error).toBe("SIGNUP_INTENT_REQUIRED");
    expect(await planted(row.id)).toEqual(before);
  });

  it("an address Google has NOT verified links to nothing — unverified or verified local account, with or without the intent", async () => {
    const email = freshEmail();
    const { row } = await plantedAccount(email);
    const before = await planted(row.id);
    const invite = await createInvite();
    const victim = newClient();
    expect((await intent(victim, invite)).status).toBe(200);
    const landed = await google(victim, profileFor(email, { email_verified: false }));
    expect(landed.error).not.toBeNull();
    expect(await getSession(victim)).toBeNull();
    expect(await planted(row.id)).toEqual(before);
    expect((await userById(row.id))!.emailVerified).toBe(false);
    expect((await inviteRow(invite))!.uses, "nothing was spent").toBe(0);

    const proven = await verifiedUser();
    const other = newClient();
    const refused = await google(other, profileFor(proven.email, { email_verified: false }));
    expect(refused.error).not.toBeNull();
    expect(await getSession(other)).toBeNull();
    expect((await accountsOf(proven.user.id)).map((a) => a.providerId)).toEqual(["credential"]);
  });
});

describe("linking to an account whose address IS proven", () => {
  it("links, keeps the existing credentials, tells the owner, and is audited", async () => {
    const owner = await verifiedUser();
    const before = mailTo(owner.email, "signInMethodAdded").length;
    const client = newClient();
    const landed = await google(client, profileFor(owner.email));
    expect(landed.error).toBeNull();
    expect((await getSession(client))?.user.id).toBe(owner.user.id);
    expect((await accountsOf(owner.user.id)).map((a) => a.providerId).sort()).toEqual([
      "credential",
      "google",
    ]);
    // The password still signs in; the name and the policy fields are the owner's own.
    expect((await signIn(newClient(), owner.email)).status).toBe(200);
    expect((await userById(owner.user.id))!).toMatchObject({
      name: owner.user.name,
      termsVersion: owner.user.termsVersion,
    });
    const mail = await waitForMail(owner.email, "signInMethodAdded");
    expect(mail.text).toContain("Google sign-in was connected");
    expect(mailTo(owner.email, "signInMethodAdded")).toHaveLength(before + 1);
    expect(await auditRows({ action: "auth.provider_linked", targetId: owner.user.id })).toMatchObject([
      { meta: { provider: "google", cleaned: false } },
    ]);
    expect(await auditRows({ action: "auth.prehijack_cleanup", targetId: owner.user.id })).toEqual([]);
    // A second Google sign-in is a sign-in, not a link: no second mail.
    expect(
      (
        await google(
          newClient(),
          profileFor(owner.email, {
            sub: (await accountsOf(owner.user.id)).find((a) => a.providerId === "google")!.accountId,
          }),
        )
      ).error,
    ).toBeNull();
    expect(mailTo(owner.email, "signInMethodAdded")).toHaveLength(before + 1);
  });

  it("a brand-new Google sign-up is not a 'link': no such mail, no such audit row", async () => {
    const email = freshEmail();
    const client = newClient();
    expect((await intent(client, await createInvite())).status).toBe(200);
    expect((await google(client, profileFor(email))).error).toBeNull();
    const row = (await userByEmail(email))!;
    expect(mailTo(email, "signInMethodAdded")).toEqual([]);
    expect(await auditRows({ action: "auth.provider_linked", targetId: row.id })).toEqual([]);
  });

  it("explicit linking from a session: only a Google identity whose verified address is the account's own", async () => {
    const owner = await verifiedUser();
    const link = (profile: TestGoogleProfile) => google(owner.client, profile, "/api/auth/link-social");
    // Another address, and the right address unverified by Google: neither is linked.
    expect((await link(profileFor(freshEmail()))).error).not.toBeNull();
    expect((await link(profileFor(owner.email, { email_verified: false }))).error).not.toBeNull();
    expect((await accountsOf(owner.user.id)).map((a) => a.providerId)).toEqual(["credential"]);
    // The account's own, verified by Google: linked.
    expect((await link(profileFor(owner.email))).error).toBeNull();
    expect((await accountsOf(owner.user.id)).map((a) => a.providerId).sort()).toEqual([
      "credential",
      "google",
    ]);
  });
});

describe("the reverse: the account was made with Google, and a stranger signs up with its address and a password", () => {
  it("the stranger gets the look-alike answer, no password is attached, and the owner is told", async () => {
    const email = freshEmail();
    const owner = newClient();
    expect((await intent(owner, await createInvite())).status).toBe(200);
    expect((await google(owner, profileFor(email))).error).toBeNull();
    const row = (await userByEmail(email))!;
    expect((await accountsOf(row.id)).map((a) => a.providerId)).toEqual(["google"]);

    const stranger = newClient();
    const fresh = await signUp(newClient(), { name: "Mallory" });
    const again = await signUp(stranger, { email, name: "Mallory", password: "the stranger's password 9!" });
    expect(again.sent.status).toBe(fresh.sent.status);
    expect(Object.keys(again.sent.body as object).sort()).toEqual(
      Object.keys(fresh.sent.body as object).sort(),
    );
    expect((again.sent.body as { user: { id: string } }).user.id).not.toBe(row.id);
    // Nothing was attached to the real account, and the stranger's password opens nothing.
    expect((await accountsOf(row.id)).map((a) => a.providerId)).toEqual(["google"]);
    expect((await userById(row.id))!.name).not.toBe("Mallory");
    expect((await signIn(newClient(), email, "the stranger's password 9!")).status).toBe(401);
    expect(await getSession(stranger)).toBeNull();
    const notice = await waitForMail(email, "signupAttempt");
    expect(notice.text).toContain("already has an account");
    // The owner's Google sign-in still works.
    expect(
      (await google(newClient(), profileFor(email, { sub: (await accountsOf(row.id))[0]!.accountId }))).error,
    ).toBeNull();
  });
});
