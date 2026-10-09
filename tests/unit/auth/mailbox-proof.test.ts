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
//   the click comes from anywhere else               → the address is marked verified, every
//                                                     credential the creator could have planted
//                                                     is deleted, NO session is created, and the
//                                                     person is sent to "set your password" with
//                                                     a single-use token.
// The admin role is never granted by the click itself — only by a sign-in after it.
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
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
  newClient,
  PASSWORD,
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

/** The set-password token of a redirect to `/set-password#token=…`. */
function setPasswordToken(location: string | null): string {
  expect(location).toMatch(/^http:\/\/localhost\/set-password#token=[A-Za-z0-9]{24}$/);
  return location!.split("#token=")[1]!;
}

describe("a verification link opened in a browser that did not sign up", () => {
  it("verifies the address, removes the stranger's password, creates no session, and hands over a set-password step", async () => {
    const { stranger, email, link, id } = await strangerSignsUp();
    expect((await accountsOf(id)).map((row) => row.providerId)).toEqual(["credential"]);

    const victim = newClient();
    const clicked = await send(victim, link);
    expect(clicked.status).toBe(302);
    const token = setPasswordToken(clicked.headers.get("location"));
    // Verified, with nothing left that its creator chose, and nobody signed in.
    expect(await userById(id)).toMatchObject({
      emailVerified: true,
      name: email.split("@")[0],
      role: "user",
    });
    expect(await accountsOf(id)).toEqual([]);
    expect(await sessionsOf(id)).toEqual([]);
    expect(victim.cookies.has(SESSION_COOKIE)).toBe(false);
    expect(clicked.setCookies.join("\n")).not.toContain("session_token");
    expect(await getSession(victim)).toBeNull();
    expect(await auditRows({ action: "auth.prehijack_cleanup", targetId: id })).toHaveLength(1);

    // The stranger's password is dead — answered like any wrong password.
    const strangerSignIn = await signIn(stranger, email);
    expect(strangerSignIn.status).toBe(401);
    expect(strangerSignIn.body).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    // …and so is the stranger's hold on the pending address.
    const moved = await send(stranger, "/api/account/pending-email", {
      method: "PATCH",
      json: { email: freshEmail() },
    });
    expect(moved.status).toBe(200);
    expect((await userById(id))!.email).toBe(email);

    // The owner sets a password with the token, and signs in with it.
    const set = await send(victim, "/api/auth/reset-password", {
      json: { newPassword: NEW_PASSWORD, token },
    });
    expect(set.status, set.text).toBe(200);
    expect((await signIn(victim, email, NEW_PASSWORD)).status).toBe(200);
    expect((await getSession(victim))?.user).toMatchObject({ email, emailVerified: true });
    // The token worked once.
    const again = await send(newClient(), "/api/auth/reset-password", {
      json: { newPassword: "yet another long passphrase 3!", token },
    });
    expect(again.status).toBe(400);
    expect((await signIn(newClient(), email, PASSWORD)).status).toBe(401);
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
    const clicked = await send(victim, link);
    expect(clicked.status).toBe(302);
    setPasswordToken(clicked.headers.get("location"));
    expect(await accountsOf(id)).toEqual([]);
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

    const clicked = await send(newClient(), link);
    const token = setPasswordToken(clicked.headers.get("location"));
    expect(await testDb().select().from(passkey).where(eq(passkey.userId, id))).toEqual([]);
    expect(await testDb().select().from(twoFactor).where(eq(twoFactor.userId, id))).toEqual([]);
    const tokens = await testDb().select().from(verification).where(eq(verification.value, id));
    // Only the set-password token just issued.
    expect(tokens.map((row) => row.identifier)).toEqual([`reset-password:${token}`]);
    expect((await userById(id))!.twoFactorEnabled).toBe(false);
    await purgeAuthRows(testDb(), id);
  });

  it("the link again — from anyone — does nothing more: no session, no second token, the owner's password stands", async () => {
    const { stranger, email, link, id } = await strangerSignsUp();
    const victim = newClient();
    const token = setPasswordToken((await send(victim, link)).headers.get("location"));
    await send(victim, "/api/auth/reset-password", { json: { newPassword: NEW_PASSWORD, token } });

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

  it("shares that were waiting for the address activate at the click, as for any verification", async () => {
    const owner = await verifiedUser();
    const folder = await makeFolder(owner.user.id);
    const { email, link, id } = await strangerSignsUp();
    const share = await makePendingShare(folder.id, owner.user.id, email);
    await send(newClient(), link);
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
    expect(answer.headers.get("location")).toContain("error=INVALID_TOKEN");
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
    setPasswordToken(clicked.headers.get("location"));
    expect(await accountsOf(first.id)).toEqual([]);
    expect(await sessionsOf(first.id)).toEqual([]);
  });
});

describe("the admin role and the verification click", () => {
  const adminEnv = (address: string) => ({ ADMIN_EMAILS: address });

  it("cross-browser: an ADMIN_EMAILS address is no admin after the click, and one after a proper sign-in", async () => {
    const email = freshEmail();
    const stranger = newClient({ env: adminEnv(email) });
    const { link, id } = await strangerSignsUp(email, stranger);
    const victim = newClient({ env: adminEnv(email) });
    const token = setPasswordToken((await send(victim, link)).headers.get("location"));
    expect((await userById(id))!.role).toBe("user");
    expect(await auditRows({ action: "auth.admin_granted", targetId: id })).toHaveLength(0);
    // The stranger, who knows the old password, gets nothing.
    expect((await signIn(stranger, email)).status).toBe(401);
    expect((await userById(id))!.role).toBe("user");

    await send(victim, "/api/auth/reset-password", { json: { newPassword: NEW_PASSWORD, token } });
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
      json: { newEmail: target, callbackURL: "/account" },
    });
    expect(asked.status, asked.text).toBe(200);
    // Step 1: the confirmation, mailed to the CURRENT address.
    const confirm = linkIn(await waitForMail(owner.email, "changeEmailConfirmation"));
    expect((await send(owner.client, confirm)).status).toBe(302);
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
      json: { newEmail: target, callbackURL: "/account" },
    });
    const mail = await waitForMail(owner.email, "changeEmailConfirmation", before + 1);
    const confirmed = await send(owner.client, linkIn(mail));
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
    expect(forTaken.mail.text!.replace(/https?:\/\/\S+/g, "<link>").replace(taken.email, "<new>")).toBe(
      forFree.mail.text!.replace(/https?:\/\/\S+/g, "<link>").replace(free, "<new>"),
    );
    expect(forTaken.confirmed.status).toBe(302);
    expect(forTaken.confirmed.headers.get("location")).toBe(forFree.confirmed.headers.get("location"));
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
  it("the owner's click against the stranger moving the address: never a verified account with the stranger's password", async () => {
    for (let round = 0; round < 8; round++) {
      const { stranger, email, link, id } = await strangerSignsUp();
      const elsewhere = freshEmail();
      const victim = newClient();
      const [clicked, moved] = await Promise.all([
        send(victim, link),
        send(stranger, "/api/account/pending-email", { method: "PATCH", json: { email: elsewhere } }),
      ]);
      expect(moved.status).toBe(200);
      expect(clicked.status).toBe(302);
      const row = (await userById(id))!;
      const credentials = (await accountsOf(id)).filter((account) => account.providerId === "credential");
      if (row.emailVerified) {
        // The click won: the address is the owner's, proven, and nothing of the stranger is left.
        expect(row.email).toBe(email);
        expect(credentials).toEqual([]);
        expect(await sessionsOf(id)).toEqual([]);
      } else {
        // The move won: the row is the stranger's own unverified account at another address,
        // and the owner's address is free again.
        expect(row.email).toBe(elsewhere);
        expect(await userByEmail(email)).toBeNull();
      }
      expect(victim.cookies.has(SESSION_COOKIE)).toBe(false);
      await purgeAuthRows(testDb(), id);
    }
  });

  it("two clicks at once (two devices of the owner): one set-password token, no session, no error", async () => {
    const { link, id } = await strangerSignsUp();
    const answers = await Promise.all([
      send(newClient(), link),
      send(newClient(), link),
      send(newClient(), link),
    ]);
    for (const answer of answers) expect(answer.status).toBe(302);
    const handedOver = answers.filter((answer) =>
      (answer.headers.get("location") ?? "").includes("/set-password#"),
    );
    expect(handedOver).toHaveLength(1);
    expect(await sessionsOf(id)).toEqual([]);
    expect(await accountsOf(id)).toEqual([]);
    const tokens = await testDb().select().from(verification).where(eq(verification.value, id));
    expect(tokens).toHaveLength(1);
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
    await send(newClient(), link);
    expect(await accountsOf(id)).toEqual([]);
    await purgeAuthRows(testDb(), id);
  });
});
