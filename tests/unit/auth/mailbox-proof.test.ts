// A1 — a verification link proves a MAILBOX, not the browser that chose the password.
//
// Anyone can sign up with somebody else's address and a password of their own; the mail goes to
// the owner. Better Auth's link is a stateless token over the address alone
// (better-auth/dist/api/routes/email-verification.mjs: `updateUserByEmail(parsed.email,
// { emailVerified: true })` then `createSession(user.user.id)`), so the owner's click would
// verify an account that still opens with the stranger's password — and sign the owner in to it.
//
// The rule (auth/mailbox-proof.ts):
//   the click comes from the browser that signed up   (it holds the `hf_pending` proof for that
//                                                     very account) → the password stays, the
//                                                     browser is signed in;
//   the click comes from anywhere else               → the GET changes NOTHING (a mail scanner
//                                                     fetches every link); it lands on our
//                                                     set-password page, whose button sends ONE
//                                                     same-origin POST that proves the mailbox:
//                                                     the creator's credentials are deleted, the
//                                                     address is verified, the terms / age
//                                                     statement becomes the prover's, and the
//                                                     password they typed is set. No session.
// The admin role is never granted by the click itself — only by a sign-in after it.
import { safeLabel } from "../../../src/worker/services/email";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { VERIFY_LINK_EXPIRES_IN_S } from "../../../src/worker/auth/mailbox-proof";
import { LINK_ERROR_BUDGET, STATEMENT_BUDGET } from "../../../src/worker/auth/parity";
import { PENDING_COOKIE } from "../../../src/worker/auth/signed-cookie";
import { purgeAuthRows } from "../../../src/worker/db/queries/auth-lifecycle";
import { passkey, twoFactor, user, verification } from "../../../src/worker/db/schema";
import {
  accountsOf,
  auditRows,
  CAPTCHA,
  createInvite,
  freshEmail,
  getSession,
  linkIn,
  makeFolder,
  makePendingShare,
  mailTo,
  measured,
  newClient,
  PASSWORD,
  pressConfirmChange,
  send,
  sessionsOf,
  shareById,
  signIn,
  signUp,
  testDb,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

const NEW_PASSWORD = "a different long passphrase 7!";
const SESSION_COOKIE = "hf.session_token";

/** A stranger's sign-up with `email`, and the link that was mailed to that address. */
async function strangerSignsUp(email = freshEmail(), stranger: Client = newClient()) {
  const { sent } = await signUp(stranger, { email, name: "Planted Name" });
  expect(sent.status, sent.text).toBe(200);
  const link = linkIn(await waitForMail(email, "verification"));
  const row = (await userByEmail(email))!;
  return { stranger, email, link, id: row.id };
}

const STATEMENT = { acceptTerms: true, birthYear: 1990, birthMonth: 5 };
const CONFIRM = "/api/account/confirm-email";

/** A link opened elsewhere lands on our page, carrying the link's own token in the fragment. */
function landing(location: string | null, link: string): string {
  const token = new URL(link, "http://localhost").searchParams.get("token")!;
  expect(location).toBe(`http://localhost/set-password#token=${token}`);
  return token;
}

/** The button on that page: one same-origin POST. */
const confirm = (client: Client, token: string, extra: Record<string, unknown> = {}) =>
  send(client, CONFIRM, {
    headers: CAPTCHA,
    json: { token, newPassword: NEW_PASSWORD, ...STATEMENT, ...extra },
  });

/** The whole path of a link opened in a browser that did not sign up: the click, then the button. */
async function confirmElsewhere(client: Client, link: string): Promise<string> {
  const clicked = await send(client, link);
  expect(clicked.status).toBe(302);
  const token = landing(clicked.headers.get("location"), link);
  const done = await confirm(client, token);
  expect(done.status, done.text).toBe(200);
  expect(done.body).toEqual({ ok: true });
  return token;
}

function expectLinkInvalid(sent: Awaited<ReturnType<typeof send>>) {
  expect(sent.status, sent.text).toBe(403);
  expect(sent.body).toMatchObject({ error: "invalid_token", message: "This link is no longer valid." });
}

describe("a GET of the verification link never does anything destructive (R2)", () => {
  it("a mail scanner's cookieless GET (and a HEAD) changes no row; the sign-up browser's own click then verifies, and the password still works", async () => {
    const browser = newClient();
    const { email, link, id } = await strangerSignsUp(freshEmail(), browser);
    const rows = async () => ({
      user: await userById(id),
      accounts: await accountsOf(id),
      sessions: await sessionsOf(id),
      tokens: await testDb().select().from(verification).where(eq(verification.value, id)),
    });
    const before = await rows();
    expect(before.accounts.map((row) => row.providerId)).toEqual(["credential"]);

    // The gateway fetches the link before delivery: no cookies, not a browser — and again.
    for (const method of ["GET", "HEAD", "GET"]) {
      const fetched = await send(newClient(), link, { method, browser: false });
      expect(fetched.status, method).toBeLessThan(500);
      expect(fetched.setCookies.join("\n"), method).not.toContain("session_token");
      expect(await rows(), method).toEqual(before);
    }
    expect(await auditRows({ action: "auth.prehijack_cleanup", targetId: id })).toHaveLength(0);

    // The person clicks, in the browser they signed up in.
    const clicked = await send(browser, link);
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get("location")).toBe("/login?reason=verified");
    expect((await getSession(browser))?.user).toMatchObject({ email, emailVerified: true });
    // The password they chose a minute ago is the account's password.
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(200);
    expect((await userById(id))!.name).toBe("Planted Name");
    await purgeAuthRows(testDb(), id);
  });
});

describe("a verification link opened in a browser that did not sign up", () => {
  it("the click changes nothing; the button's POST verifies the address, removes the stranger's password and sets the owner's — no session, and the statement on the row is the owner's", async () => {
    const { stranger, email, link, id } = await strangerSignsUp();
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);
    const planted = (await userById(id))!;
    const strangersPassword = (await accountsOf(id))[0]!.password;

    const victim = newClient();
    const clicked = await send(victim, link);
    expect(clicked.status).toBe(302);
    const token = landing(clicked.headers.get("location"), link);
    // The GET did nothing at all.
    expect(await userById(id)).toEqual(planted);
    expect((await accountsOf(id))[0]!.password).toBe(strangersPassword);

    // The POST is refused — and changes nothing — without the statement, under age, without a
    // captcha token, from another site, or with a password that is too short.
    const refusals: Array<[string, Promise<Awaited<ReturnType<typeof send>>>, number]> = [
      ["no assent", confirm(victim, token, { acceptTerms: "true" }), 400],
      ["no birth date", confirm(victim, token, { birthYear: undefined }), 400],
      ["under thirteen", confirm(victim, token, { birthYear: new Date().getUTCFullYear() - 5 }), 400],
      ["a short password", confirm(victim, token, { newPassword: "short" }), 400],
      [
        "no captcha",
        send(victim, CONFIRM, { json: { token, newPassword: NEW_PASSWORD, ...STATEMENT } }),
        400,
      ],
      [
        "a challenge Turnstile refuses",
        // (Cloudflare's published always-fail test secret — not a real one.)
        send(newClient({ env: { TURNSTILE_SECRET: "2x0000000000000000000000000000000AA" } }), CONFIRM, {
          headers: CAPTCHA,
          json: { token, newPassword: NEW_PASSWORD, ...STATEMENT },
        }),
        403,
      ],
      [
        "another site",
        send(victim, CONFIRM, {
          browser: false,
          headers: { ...CAPTCHA, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          json: { token, newPassword: NEW_PASSWORD, ...STATEMENT },
        }),
        403,
      ],
    ];
    for (const [what, pending, status] of refusals) expect((await pending).status, what).toBe(status);
    expect(await userById(id)).toEqual(planted);
    expect((await accountsOf(id))[0]!.password).toBe(strangersPassword);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const done = await confirm(victim, token);
    expect(done.status, done.text).toBe(200);
    // Verified, with nothing left that its creator chose, and nobody signed in.
    const row = (await userById(id))!;
    expect(row).toMatchObject({ emailVerified: true, name: email.split("@")[0], role: "user" });
    // What the STRANGER stated is not what the owner stated: the statement is new, the invite
    // reference is gone.
    expect(row.termsAcceptedAt!.getTime()).toBeGreaterThan(planted.termsAcceptedAt!.getTime());
    expect(row.ageVerifiedAt!.getTime()).toBeGreaterThan(planted.ageVerifiedAt!.getTime());
    expect(row.termsVersion).toBe("2026-10");
    expect(row.invitedBy).toBeNull();
    const credentials = await accountsOf(id);
    expect(credentials.map((account) => account.providerId)).toEqual(["credential"]);
    expect(credentials[0]!.password).not.toBe(strangersPassword);
    expect(await sessionsOf(id)).toEqual([]);
    expect(victim.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(done.setCookies.join("\n")).not.toContain("session_token");
    expect(await getSession(victim)).toBeNull();
    expect(await auditRows({ action: "auth.prehijack_cleanup", targetId: id })).toHaveLength(1);
    // No password-setting token was handed to anybody: none is left, and none was in the answer.
    expect(await testDb().select().from(verification).where(eq(verification.value, id))).toEqual([]);
    expect(done.text).toBe('{"ok":true}');

    // The stranger's password is dead — answered like any wrong password.
    const strangerSignIn = await signIn(stranger, email);
    expect(strangerSignIn.status).toBe(401);
    expect(strangerSignIn.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    // …and so is the stranger's hold on the pending address.
    const moved = await send(stranger, "/api/account/pending-email", {
      headers: CAPTCHA,
      method: "PATCH",
      json: { email: freshEmail() },
    });
    expect(moved.status).toBe(200);
    expect((await userById(id))!.email).toBe(email);

    // The owner signs in with the password they chose.
    expect((await signIn(victim, email, NEW_PASSWORD)).status).toBe(200);
    expect((await getSession(victim))?.user).toMatchObject({ email, emailVerified: true });
    // The link's token did this once: again, it is "no longer valid", and changes nothing.
    expectLinkInvalid(await confirm(newClient(), token, { newPassword: "yet another long passphrase 3!" }));
    expect((await signIn(newClient(), email, NEW_PASSWORD)).status).toBe(200);
    await purgeAuthRows(testDb(), id);
  });

  it("the confirmation does a fixed amount of work before it answers; a link that can do nothing does the fixed amount of a dead link — and neither sends a statement before the limiter and the captcha", async () => {
    const { link, id } = await strangerSignsUp();
    const token = new URL(link, "http://localhost").searchParams.get("token")!;
    const json = { token, newPassword: NEW_PASSWORD, ...STATEMENT };
    // Refused for free: no captcha header, a bad statement, a token nobody signed.
    for (const [what, options] of [
      ["no captcha", { json }],
      ["no assent", { headers: CAPTCHA, json: { ...json, acceptTerms: false } }],
      ["a forged token", { headers: CAPTCHA, json: { ...json, token: `${token.slice(0, -4)}AAAA` } }],
    ] as const) {
      const refused = await measured(newClient(), CONFIRM, options);
      expect(refused.sent.status, what).toBeGreaterThanOrEqual(400);
      expect(refused.statementsTotal, what).toBe(0);
    }
    const worked = await measured(newClient(), CONFIRM, { headers: CAPTCHA, json });
    expect(worked.sent.status, worked.sent.text).toBe(200);
    expect(worked.statements).toBe(STATEMENT_BUDGET["/account/confirm-email"]);
    const dead = await measured(newClient(), CONFIRM, { headers: CAPTCHA, json });
    expectLinkInvalid(dead.sent);
    expect(dead.statements).toBe(LINK_ERROR_BUDGET);
    await purgeAuthRows(testDb(), id);
  });

  it("a look-alike `hf_pending` (the owner tried to sign up too) is not a proof: same outcome", async () => {
    const { email, link, id } = await strangerSignsUp();
    // The owner's own sign-up with the same address gets the look-alike answer and a cookie that
    // names nobody.
    const victim = newClient();
    const second = await signUp(victim, { email, password: NEW_PASSWORD });
    expect(second.sent.status).toBe(200);
    expect(victim.cookies.has("hf_pending")).toBe(true);
    await confirmElsewhere(victim, link);
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
    expect(await sessionsOf(id)).toEqual([]);
    await purgeAuthRows(testDb(), id);
  });

  it("removes everything else that names the account too: passkeys, two-factor, tokens", async () => {
    const { link, id } = await strangerSignsUp();
    // Nothing of this can be planted through the API while the account is unverified (no
    // session); the rows are planted directly to show the cleanup does not depend on that.
    await testDb()
      .insert(passkey)
      .values({
        id: crypto.randomUUID().replace(/-/g, ""),
        userId: id,
        publicKey: "planted",
        credentialID: crypto.randomUUID(),
        counter: 0,
        deviceType: "singleDevice",
        backedUp: false,
      });
    await testDb()
      .insert(twoFactor)
      .values({
        id: crypto.randomUUID().replace(/-/g, ""),
        userId: id,
        secret: "planted",
        backupCodes: "planted",
      });
    await testDb()
      .insert(verification)
      .values({
        id: crypto.randomUUID().replace(/-/g, ""),
        identifier: `reset-password:planted-${id}`,
        value: id,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
    await testDb().update(user).set({ twoFactorEnabled: true }).where(eq(user.id, id));

    // The click alone removes none of it…
    const clicked = await send(newClient(), link);
    const token = landing(clicked.headers.get("location"), link);
    expect(await testDb().select().from(passkey).where(eq(passkey.userId, id))).toHaveLength(1);
    expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, id))).toHaveLength(1);
    // …the confirmation removes all of it.
    expect((await confirm(newClient(), token)).status).toBe(200);
    expect(await testDb().select().from(passkey).where(eq(passkey.userId, id))).toEqual([]);
    expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, id))).toEqual([]);
    expect(await testDb().select().from(verification).where(eq(verification.value, id))).toEqual([]);
    expect((await userById(id))!.twoFactorEnabled).toBe(false);
    await purgeAuthRows(testDb(), id);
  });

  it("the link again — from anyone — does nothing more: no session, no second confirmation, the owner's password stands", async () => {
    const { stranger, email, link, id } = await strangerSignsUp();
    const victim = newClient();
    const token = await confirmElsewhere(victim, link);
    expectLinkInvalid(await confirm(stranger, token, { newPassword: PASSWORD }));

    for (const who of [victim, stranger, newClient()]) {
      const replay = await send(who, link);
      expect(replay.status).toBe(302);
      expect(replay.headers.get("location")).toBe("/login?reason=verified");
      expect(replay.setCookies.join("\n")).not.toContain("session_token");
    }
    expect(await sessionsOf(id)).toEqual([]);
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);
    expect((await signIn(newClient(), email, NEW_PASSWORD)).status).toBe(200);
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
    await purgeAuthRows(testDb(), id);
  });

  it("shares that were waiting for the address activate at the confirmation, as for any verification", async () => {
    const owner = await verifiedUser();
    const folder = await makeFolder(owner.user.id);
    const { email, link, id } = await strangerSignsUp();
    const share = await makePendingShare(folder.id, owner.user.id, email);
    await send(newClient(), link);
    expect((await shareById(share.id))!.activatedAt).toBeNull();
    await confirmElsewhere(newClient(), link);
    expect(await shareById(share.id)).toMatchObject({ granteeUserId: id });
    expect((await shareById(share.id))!.activatedAt).not.toBeNull();
    await purgeAuthRows(testDb(), id);
  });

  it("a tampered or expired link changes nothing and removes nothing", async () => {
    const { link, id } = await strangerSignsUp();
    const url = new URL(link, "http://localhost");
    const token = url.searchParams.get("token")!;
    const tampered = `${token.slice(0, -3)}${token.endsWith("AAA") ? "BBB" : "AAA"}`;
    url.searchParams.set("token", tampered);
    const answer = await send(newClient(), url.pathname + url.search);
    expect(answer.status).toBe(302);
    expect(answer.headers.get("location")).toContain("error=LINK_INVALID");
    // …and the POST with it is the one generic answer.
    expectLinkInvalid(await confirm(newClient(), tampered));
    expectLinkInvalid(await confirm(newClient(), "not-a-token"));
    expect(await userById(id)).toMatchObject({ emailVerified: false, name: "Planted Name" });
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);
    await purgeAuthRows(testDb(), id);
  });
});

describe("a verification link opened in the browser that signed up", () => {
  it("keeps the password and signs that browser in (the path every ordinary sign-up takes)", async () => {
    const client = newClient();
    const { email, link, id } = await strangerSignsUp(freshEmail(), client);
    const clicked = await send(client, link);
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get("location")).toBe("/login?reason=verified");
    expect(client.cookies.has(SESSION_COOKIE)).toBe(true);
    expect((await getSession(client))?.user).toMatchObject({ email, emailVerified: true });
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);
    expect((await userById(id))!.name).toBe("Planted Name");
    expect(await auditRows({ action: "auth.prehijack_cleanup", targetId: id })).toHaveLength(0);
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(200);
    await purgeAuthRows(testDb(), id);
  });

  it("the proof is sent to the verification link at all: `hf_pending` is scoped to `/`", async () => {
    const client = newClient();
    const { sent } = await signUp(client);
    const pending = sent.setCookies.find((cookie) => cookie.startsWith("hf_pending="))!;
    expect(pending).toMatch(/; Path=\/(;|$)/);
    expect(pending).toMatch(/; HttpOnly/);
    expect(pending).toMatch(/; SameSite=Lax/);
  });

  it("a proof for ANOTHER account is not a proof for this one", async () => {
    // The stranger signed up twice; the browser holds the proof of the second account only.
    const stranger = newClient();
    const first = await strangerSignsUp(freshEmail(), stranger);
    await strangerSignsUp(freshEmail(), stranger);
    const clicked = await send(stranger, first.link);
    // Not signed in, nothing changed: the page of ours, like any other browser.
    landing(clicked.headers.get("location"), first.link);
    expect(stranger.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(await userById(first.id)).toMatchObject({ emailVerified: false });
    expect(await sessionsOf(first.id)).toEqual([]);
  });

  it("the proof lasts at least as long as the link, and a resend from the browser that holds it renews it", async () => {
    expect(PENDING_COOKIE.maxAge).toBeGreaterThanOrEqual(VERIFY_LINK_EXPIRES_IN_S);
    const client = newClient();
    const { email, id } = await strangerSignsUp(freshEmail(), client);
    const first = client.cookies.get("hf_pending")!;
    const resend = (who: Client, address: string) =>
      send(who, "/api/auth/send-verification-email", {
        headers: CAPTCHA,
        json: { email: address, callbackURL: "/login?reason=verified" },
      });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const renewed = await resend(client, email);
    expect(renewed.status).toBe(200);
    const cookie = renewed.setCookies.find((value) => value.startsWith("hf_pending="))!;
    expect(cookie).toMatch(new RegExp(`; Max-Age=${PENDING_COOKIE.maxAge}(;|$)`));
    expect(client.cookies.get("hf_pending")).not.toBe(first);
    // It is still the proof for the same account: the resent link, in this browser, keeps the password.
    const link = linkIn(mailTo(email, "verification").at(-1)!);
    expect((await send(client, link)).headers.get("location")).toBe("/login?reason=verified");
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(200);
    // No cookie comes from a resend by a browser with no proof, or with a proof for another address.
    const other = newClient();
    const second = await strangerSignsUp(freshEmail(), other);
    expect((await resend(newClient(), second.email)).setCookies.join("\n")).not.toContain("hf_pending");
    // (`other` holds a valid proof — for ITS address — and no session: the request is answered
    // 200, so a renewal for an address the proof does not name would show.)
    const elsewhere = await resend(other, email);
    expect(elsewhere.status).toBe(200);
    expect(elsewhere.setCookies.join("\n")).not.toContain("hf_pending");
    // Control: for its own address the same browser's proof IS renewed.
    expect((await resend(other, second.email)).setCookies.join("\n")).toContain("hf_pending=");
    await purgeAuthRows(testDb(), id);
  });
});

describe("the admin role and the verification click", () => {
  const adminEnv = (address: string) => ({ ADMIN_EMAILS: address });

  it("cross-browser: an ADMIN_EMAILS address is no admin after the click, and one after a proper sign-in", async () => {
    const email = freshEmail();
    const stranger = newClient({ env: adminEnv(email) });
    const { link, id } = await strangerSignsUp(email, stranger);
    const victim = newClient({ env: adminEnv(email) });
    await confirmElsewhere(victim, link);
    expect((await userById(id))!.role).toBe("user");
    expect(await auditRows({ action: "auth.admin_granted", targetId: id })).toHaveLength(0);
    // The stranger, who knows the old password, gets nothing.
    expect((await signIn(stranger, email)).status).toBe(401);
    expect((await userById(id))!.role).toBe("user");
    expect((await signIn(victim, email, NEW_PASSWORD)).status).toBe(200);
    expect((await userById(id))!.role).toBe("admin");
    expect(await auditRows({ action: "auth.admin_granted", targetId: id })).toHaveLength(1);
    await purgeAuthRows(testDb(), id);
  });

  it("same browser: the click signs in but grants nothing; the next sign-in grants the role", async () => {
    const email = freshEmail();
    const client = newClient({ env: adminEnv(email) });
    const { link, id } = await strangerSignsUp(email, client);
    expect((await send(client, link)).status).toBe(302);
    expect(client.cookies.has(SESSION_COOKIE)).toBe(true);
    expect((await userById(id))!.role).toBe("user");
    await send(client, "/api/auth/sign-out", { json: {} });
    expect((await signIn(client, email)).status).toBe(200);
    expect((await userById(id))!.role).toBe("admin");
    await purgeAuthRows(testDb(), id);
  });
});

describe("the link that confirms a NEW address for an existing account", () => {
  /** A verified user who asked to change address, up to the mail sent to the NEW address. */
  async function changeRequested() {
    const owner = await verifiedUser();
    const target = freshEmail();
    const asked = await send(owner.client, "/api/auth/change-email", {
      json: { newEmail: target, callbackURL: "/account", password: PASSWORD },
    });
    expect(asked.status, asked.text).toBe(200);
    // Step 1: the confirmation, mailed to the CURRENT address.
    const confirm = linkIn(await waitForMail(owner.email, "changeEmailConfirmation"));
    expect((await pressConfirmChange(confirm)).status).toBe(200);
    // Step 2: the verification, mailed to the NEW address.
    const verify = linkIn(await waitForMail(target, "newAddressVerification"));
    return { owner, target, verify };
  }

  it("opened without that account's session: no session is created and the address does not change", async () => {
    const { owner, target, verify } = await changeRequested();
    const before = (await sessionsOf(owner.user.id)).length;
    const victim = newClient();
    const clicked = await send(victim, verify);
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get("location")).toBe("http://localhost/login?reason=change_email");
    expect(clicked.setCookies.join("\n")).not.toContain("session_token");
    expect(await getSession(victim)).toBeNull();
    expect((await sessionsOf(owner.user.id)).length).toBe(before);
    expect((await userById(owner.user.id))!.email).toBe(owner.email);
    expect(await userByEmail(target)).toBeNull();
  });

  it("opened in a browser signed in to a DIFFERENT account: refused the same way", async () => {
    const { owner, verify } = await changeRequested();
    const other = await verifiedUser();
    const clicked = await send(other.client, verify);
    expect(clicked.status).toBe(302);
    expect((await userById(owner.user.id))!.email).toBe(owner.email);
    expect((await getSession(other.client))?.user).toMatchObject({ email: other.email });
  });

  it("opened in the account's own signed-in browser: the address changes (control)", async () => {
    const { owner, target, verify } = await changeRequested();
    const clicked = await send(owner.client, verify);
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get("location")).toBe("/account");
    expect(await userById(owner.user.id)).toMatchObject({ email: target, emailVerified: true });
  });
});

describe("changing to an address: what the caller can and cannot learn (A7)", () => {
  /** Asks for a change and follows the confirmation mailed to the CURRENT address. */
  async function askAndConfirm(owner: Awaited<ReturnType<typeof verifiedUser>>, target: string) {
    const before = mailTo(owner.email, "changeEmailConfirmation").length;
    const asked = await send(owner.client, "/api/auth/change-email", {
      json: { newEmail: target, callbackURL: "/account", password: PASSWORD },
    });
    const mail = await waitForMail(owner.email, "changeEmailConfirmation", before + 1);
    // (the link itself is inert; the button on the page it lands on is the consent — N1)
    const confirmed = await pressConfirmChange(linkIn(mail));
    return { asked, mail, confirmed };
  }

  it("a TAKEN address answers and mails exactly as a free one does — and the address's owner hears nothing", async () => {
    const taken = await verifiedUser();
    const mailsToTaken = mailTo(taken.email).length;
    const prober = await verifiedUser();
    const forTaken = await askAndConfirm(prober, taken.email);
    const honest = await verifiedUser();
    const free = freshEmail();
    const forFree = await askAndConfirm(honest, free);

    // The answer, the mail to the caller's own inbox, and the answer to its link: alike.
    expect(forTaken.asked.status).toBe(forFree.asked.status);
    expect(forTaken.asked.body).toEqual(forFree.asked.body);
    expect(forTaken.mail.subject).toBe(forFree.mail.subject);
    // (The new address is shown as a label — services/email.ts `safeLabel` — not as typed.)
    expect(
      forTaken.mail.text!.replace(/https?:\/\/\S+/g, "<link>").replace(safeLabel(taken.email, 254), "<new>"),
    ).toBe(forFree.mail.text!.replace(/https?:\/\/\S+/g, "<link>").replace(safeLabel(free, 254), "<new>"));
    expect(forFree.mail.text).toContain(safeLabel(free, 254));
    expect(forTaken.confirmed.status).toBe(200);
    expect(forTaken.confirmed.body).toEqual(forFree.confirmed.body);
    // What differs is invisible to the caller: the free address gets the second mail, the taken
    // one's owner gets nothing at all, and nothing about either account changes.
    await waitForMail(free, "newAddressVerification");
    expect(mailTo(taken.email)).toHaveLength(mailsToTaken);
    expect((await userById(prober.user.id))!.email).toBe(prober.email);
    expect((await userById(taken.user.id))!.email).toBe(taken.email);
  });

  it("taken BETWEEN the request and the last click: the link says 'unavailable', nothing changes, no error page", async () => {
    const owner = await verifiedUser();
    const target = freshEmail();
    await askAndConfirm(owner, target);
    const verify = linkIn(await waitForMail(target, "newAddressVerification"));
    // Somebody else takes the address in the meantime.
    const other = await verifiedUser({ email: target });
    const clicked = await send(owner.client, verify);
    expect(clicked.status).toBe(302);
    expect(clicked.headers.get("location")).toBe("http://localhost/account?email=unavailable");
    expect((await userById(owner.user.id))!.email).toBe(owner.email);
    expect((await userById(other.user.id))!.email).toBe(target);
  });

  it("two accounts confirming the SAME new address at the same moment: one gets it, the other 'unavailable' — never a 500", async () => {
    const target = freshEmail();
    const one = await verifiedUser();
    const two = await verifiedUser();
    await askAndConfirm(one, target);
    const linkOne = linkIn(await waitForMail(target, "newAddressVerification", 1));
    await askAndConfirm(two, target);
    const linkTwo = linkIn(await waitForMail(target, "newAddressVerification", 2));
    expect(linkTwo).not.toBe(linkOne);
    // Hold each UPDATE that writes this address for a moment, so that both requests are past
    // their look-up before either row is written: the loser meets the unique index itself.
    const name = `hf_test_${crypto.randomUUID().replace(/-/g, "")}`;
    await testDb().execute(
      sql.raw(`
        CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.email = '${target}' AND OLD.email <> NEW.email THEN PERFORM pg_sleep(0.4); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER ${name} BEFORE UPDATE ON "user" FOR EACH ROW EXECUTE FUNCTION ${name}();`),
    );
    let answers: Awaited<ReturnType<typeof send>>[];
    try {
      answers = await Promise.all([send(one.client, linkOne), send(two.client, linkTwo)]);
    } finally {
      await testDb().execute(
        sql.raw(`DROP TRIGGER IF EXISTS ${name} ON "user"; DROP FUNCTION IF EXISTS ${name}();`),
      );
    }
    expect(answers.map((answer) => answer.status)).toEqual([302, 302]);
    const locations = answers.map((answer) => answer.headers.get("location")).sort();
    expect(locations).toEqual(["/account", "http://localhost/account?email=unavailable"]);
    const emails = [(await userById(one.user.id))!.email, (await userById(two.user.id))!.email];
    expect(emails.filter((email) => email === target)).toHaveLength(1);
    expect(emails.filter((email) => email === one.email || email === two.email)).toHaveLength(1);
  });
});

describe("races (real concurrent requests against Postgres)", () => {
  // Eight rounds, eight tests: each is a fresh race (sign-up, landing, then the two requests at
  // once), so each interleaving gets its own budget — one test of eight rounds took 4.2 s alone
  // at load 6.5 against the 5 s default, and timed out in most full runs.
  it.each(Array.from({ length: 8 }, (_, round) => round + 1))(
    "the owner's confirmation against the stranger moving the address: never a verified account with the stranger's password (round %i)",
    async () => {
      const { stranger, email, link, id } = await strangerSignsUp();
      const elsewhere = freshEmail();
      const victim = newClient();
      const token = landing((await send(victim, link)).headers.get("location"), link);
      const strangersPassword = (await accountsOf(id))[0]!.password;
      expect(strangersPassword).toBeTruthy();
      const [confirmed, moved] = await Promise.all([
        confirm(victim, token),
        send(stranger, "/api/account/pending-email", {
          headers: CAPTCHA,
          method: "PATCH",
          json: { email: elsewhere },
        }),
      ]);
      expect(moved.status).toBe(200);
      expect([200, 403], confirmed.text).toContain(confirmed.status);
      const row = (await userById(id))!;
      if (row.emailVerified) {
        // The confirmation won: the address is the owner's, proven, and the only password is theirs.
        expect(confirmed.status).toBe(200);
        expect(row.email).toBe(email);
        expect(await sessionsOf(id)).toEqual([]);
        // (Read from the row, not by signing in: eight rounds of two more password hashes each
        // is not what this test is timing.)
        const credentials = await accountsOf(id);
        expect(credentials.map((account) => account.providerId)).toEqual(["credential"]);
        expect(credentials[0]!.password).not.toBe(strangersPassword);
      } else {
        // The move won: the row is the stranger's own unverified account at another address,
        // and the owner's address is free again.
        expectLinkInvalid(confirmed);
        expect(row.email).toBe(elsewhere);
        expect(await userByEmail(email)).toBeNull();
      }
      expect(victim.cookies.has(SESSION_COOKIE)).toBe(false);
      await purgeAuthRows(testDb(), id);
    },
  );

  it("three confirmations at once (three devices of the owner): one takes effect, the others are 'no longer valid' — one password, no session, never a 500", async () => {
    const { email, link, id } = await strangerSignsUp();
    const token = new URL(link, "http://localhost").searchParams.get("token")!;
    const passwords = [
      "first device passphrase 11!",
      "second device passphrase 22!",
      "third device passphrase 33!",
    ];
    const answers = await Promise.all(
      passwords.map((newPassword) => confirm(newClient(), token, { newPassword })),
    );
    const won = answers.flatMap((answer, index) => (answer.status === 200 ? [index] : []));
    expect(won, answers.map((answer) => answer.status).join(",")).toHaveLength(1);
    for (const [index, answer] of answers.entries()) if (index !== won[0]) expectLinkInvalid(answer);
    expect(await sessionsOf(id)).toEqual([]);
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);
    expect(await testDb().select().from(verification).where(eq(verification.value, id))).toEqual([]);
    for (const [index, password] of passwords.entries()) {
      expect((await signIn(newClient(), email, password)).status, String(index)).toBe(
        index === won[0] ? 200 : 401,
      );
    }
    await purgeAuthRows(testDb(), id);
  });
});

describe("the sign-up that is not attacked is not disturbed", () => {
  it("an invite is spent once, and a second account with the same address cannot be made meanwhile", async () => {
    const code = await createInvite();
    const { email, link, id } = await strangerSignsUp();
    const again = await send(newClient(), "/api/auth/sign-up/email", {
      json: {
        email,
        password: NEW_PASSWORD,
        name: "Second",
        inviteCode: code,
        birthYear: 1990,
        birthMonth: 5,
        acceptTerms: true,
      },
      headers: CAPTCHA,
    });
    expect(again.status).toBe(200);
    expect((await userByEmail(email))!.id).toBe(id);
    await confirmElsewhere(newClient(), link);
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
    await purgeAuthRows(testDb(), id);
  });
});
