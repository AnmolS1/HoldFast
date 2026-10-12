// N1 — changing the address of a verified account is a takeover if it can be done with a stolen
// session and a link nobody clicked. Two rules:
//   (a) POST /change-email needs the caller to prove they are the owner AGAIN: the password
//       (through the per-account throttle) when the account has one; otherwise a session that
//       carries the second-factor mark, or a fresh sign-in;
//   (b) the confirmation link mailed to the CURRENT address is inert on a GET (a mail scanner
//       fetches every link): it lands on a page of ours, and a same-origin POST from its button
//       is what sends the second mail.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { FREE_ATTEMPTS, throttleKeys } from "../../../src/worker/auth/signin-throttle";
import { rateLimit, session } from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import emailSource from "../../../src/worker/services/email.ts?raw";
import {
  accountsOf,
  CAPTCHA,
  createInvite,
  freshEmail,
  linkIn,
  mailTo,
  newClient,
  PASSWORD,
  send,
  signIn,
  testDb,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
} from "./helpers";

// Cloudflare's published Turnstile test secret that refuses every token (not a real secret).
const ALWAYS_FAILS = "2x0000000000000000000000000000000AA";
const ALLOW = { limit: async () => ({ success: true }) };
const CONFIRM = "/api/account/confirm-email-change";
const ask = (client: Client, newEmail: string, extra: Record<string, unknown> = {}) =>
  send(client, "/api/auth/change-email", { json: { newEmail, callbackURL: "/account", ...extra } });

describe("POST /change-email needs the owner again (N1a)", () => {
  it("a stolen session without the password is refused — nothing is mailed; with the password it is the owner", async () => {
    const owner = await verifiedUser();
    const target = freshEmail();
    const thief = newClient();
    thief.cookies = new Map(owner.client.cookies);
    for (const extra of [{}, { password: "a guess at the password 1!" }]) {
      const refused = await ask(thief, target, extra);
      expect(refused.status, `${JSON.stringify(extra)}: ${refused.text}`).toBe(400);
      expect(refused.body).toMatchObject({ code: "INVALID_PASSWORD" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mailTo(owner.email, "changeEmailConfirmation")).toEqual([]);
    const asked = await ask(owner.client, target, { password: PASSWORD });
    expect(asked.status, asked.text).toBe(200);
    await waitForMail(owner.email, "changeEmailConfirmation");
  });

  it("the password offered with a change is a guess like any other: counted on the account's sign-in throttle row, given back when right", async () => {
    const owner = await verifiedUser();
    const thief = newClient({ env: { RL_AUTH: ALLOW, RL_API: ALLOW } });
    thief.cookies = new Map(owner.client.cookies);
    const row = async () => {
      const { pair } = await throttleKeys(
        { keys: createKeys(env.FILES_TOKEN_SECRET) },
        owner.email,
        thief.ip,
      );
      return (await testDb().select().from(rateLimit).where(eq(rateLimit.key, pair)))[0]?.count ?? 0;
    };
    for (let n = 1; n <= FREE_ATTEMPTS; n++) {
      await testDb().execute(
        sql`DELETE FROM rate_limit WHERE key NOT LIKE 'signin:%' AND key LIKE ${`%${thief.ip}%`}`,
      );
      expect((await ask(thief, freshEmail(), { password: `wrong guess number ${n} !!` })).status).toBe(400);
      expect(await row()).toBe(n);
    }
    await testDb().execute(
      sql`DELETE FROM rate_limit WHERE key NOT LIKE 'signin:%' AND key LIKE ${`%${thief.ip}%`}`,
    );
    const throttled = await ask(thief, freshEmail(), { password: PASSWORD });
    expect(throttled.status).toBe(429);
    expect(throttled.body).toMatchObject({ code: "SIGN_IN_THROTTLED" });
    // The owner, at their own address, is not delayed — and a right password leaves no row.
    expect((await ask(owner.client, freshEmail(), { password: PASSWORD })).status).toBe(200);
  });

  it("an account with no password (made with Google): a fresh sign-in may ask, an old session may not", async () => {
    const email = freshEmail();
    const client = newClient();
    await send(client, "/api/auth-intent", {
      json: { inviteCode: await createInvite(), birthYear: 1990, birthMonth: 5, acceptTerms: true },
    });
    const start = await send(client, "/api/auth/sign-in/social", {
      json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
    });
    const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
    const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email, name: "G" });
    await send(
      client,
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { browser: false },
    );
    const row = (await userByEmail(email))!;
    expect((await ask(client, freshEmail())).status).toBe(200);
    // The same session, two days old: no password to ask for, no second factor, not fresh.
    await testDb()
      .update(session)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(session.userId, row.id));
    const stale = await ask(client, freshEmail());
    expect(stale.status, stale.text).toBe(403);
    expect(stale.body).toMatchObject({ code: "SESSION_NOT_FRESH" });
  });
});

describe("the confirmation link mailed to the current address is inert on a GET (N1b)", () => {
  it("a stolen session + a mail scanner's fetch: no second mail, no row changed; the button's POST is what sends it", async () => {
    const owner = await verifiedUser();
    const target = freshEmail();
    expect((await ask(owner.client, target, { password: PASSWORD })).status).toBe(200);
    const link = linkIn(await waitForMail(owner.email, "changeEmailConfirmation"));
    const before = await userById(owner.user.id);
    // The gateway: cookieless GET, HEAD, GET — and the same with the account's own session.
    for (const [who, options] of [
      [newClient(), { browser: false }],
      [newClient(), { browser: false, method: "HEAD" }],
      [owner.client, {}],
    ] as const) {
      const fetched = await send(who, link, options);
      expect(fetched.status).toBeLessThan(500);
      if (options.method !== "HEAD") {
        expect(fetched.headers.get("location")).toMatch(/^http:\/\/localhost\/confirm-email-change#token=/);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(mailTo(target, "newAddressVerification")).toEqual([]);
    expect(await userById(owner.user.id)).toEqual(before);

    // The person presses the button on our page.
    const token = new URL(link, "http://localhost").searchParams.get("token")!;
    const noCaptcha = await send(newClient(), CONFIRM, { json: { token } });
    expect(noCaptcha.status).toBe(400);
    const crossSite = await send(newClient(), CONFIRM, {
      browser: false,
      headers: { ...CAPTCHA, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
      json: { token },
    });
    expect(crossSite.status).toBe(403);
    // A challenge Turnstile does not accept (Cloudflare's published always-fail test secret).
    const failedChallenge = await send(newClient({ env: { TURNSTILE_SECRET: ALWAYS_FAILS } }), CONFIRM, {
      headers: CAPTCHA,
      json: { token },
    });
    expect(failedChallenge.status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mailTo(target, "newAddressVerification")).toEqual([]);
    const pressed = await send(newClient(), CONFIRM, { headers: CAPTCHA, json: { token } });
    expect(pressed.status, pressed.text).toBe(200);
    expect(pressed.body).toEqual({ ok: true });
    const verify = linkIn(await waitForMail(target, "newAddressVerification"));
    // …and the second link still needs the account's own session.
    expect((await send(newClient(), verify)).headers.get("location")).toContain("/login?reason=change_email");
    expect((await userById(owner.user.id))!.email).toBe(owner.email);
    expect((await send(owner.client, verify)).status).toBe(302);
    expect((await userById(owner.user.id))!.email).toBe(target);
  });

  it("a token that is not a confirmation, or not ours: one answer, nothing sent", async () => {
    const owner = await verifiedUser();
    const signUpLink = linkIn((await waitForMail(owner.email, "verification"))!);
    const signUpToken = new URL(signUpLink, "http://localhost").searchParams.get("token")!;
    for (const token of [signUpToken, "not-a-token", `${signUpToken.slice(0, -3)}AAA`]) {
      const sent = await send(newClient(), CONFIRM, { headers: CAPTCHA, json: { token } });
      expect(sent.status, token.slice(0, 12)).toBe(403);
      expect(sent.body).toMatchObject({ error: "invalid_token" });
    }
  });
});

// EVERY link the product mails. A mail gateway fetches links with a cookieless GET before a
// person sees the mail, so each one must be either inert on a GET, or do its work only for the
// browser that holds a proof (the sign-up browser's `hf_pending`, the account's own session).
// The table is checked against the template source: a template that gains a link, or a new
// template with one, fails here until somebody decides which kind it is.
describe("every mailed link is inert on a GET, or bound to a proof the scanner does not have", () => {
  type Kind =
    | "inert: lands on a page of ours, a same-origin POST acts"
    | "proof: acts only for the sign-up browser (hf_pending), else inert"
    | "session: acts only with the account's own session"
    | "page: a link to a screen of the app or the estate site (a GET reads)";
  const LINKS: Record<string, Kind> = {
    verification: "proof: acts only for the sign-up browser (hf_pending), else inert",
    changeEmailConfirmation: "inert: lands on a page of ours, a same-origin POST acts",
    newAddressVerification: "session: acts only with the account's own session",
    passwordReset: "inert: lands on a page of ours, a same-origin POST acts",
    deleteAccountVerification: "session: acts only with the account's own session",
    signupAttempt: "page: a link to a screen of the app or the estate site (a GET reads)",
    deletionScheduled: "page: a link to a screen of the app or the estate site (a GET reads)",
    deletionCancelled: "page: a link to a screen of the app or the estate site (a GET reads)",
    shareInvitation: "page: a link to a screen of the app or the estate site (a GET reads)",
    adminDigest: "page: a link to a screen of the app or the estate site (a GET reads)",
    adminAlert: "page: a link to a screen of the app or the estate site (a GET reads)",
    operatorCritical: "page: a link to a screen of the app or the estate site (a GET reads)",
    operatorDigest: "page: a link to a screen of the app or the estate site (a GET reads)",
    contentRemovedCopyright: "page: a link to a screen of the app or the estate site (a GET reads)",
    securityDigest: "page: a link to a screen of the app or the estate site (a GET reads)",
  };

  it("the table names exactly the templates that carry a link", () => {
    const table = emailSource.slice(
      emailSource.indexOf("export const templates"),
      emailSource.indexOf("export const KINDS"),
    );
    const withLink = new Set<string>();
    let current = "";
    for (const line of table.split("\n")) {
      const start = /^ {2}([A-Za-z]+): \(/.exec(line);
      if (start) current = start[1]!;
      if (/\blink: \{/.test(line) && current) withLink.add(current);
    }
    expect(withLink.size).toBeGreaterThan(10);
    expect([...withLink].sort()).toEqual(Object.keys(LINKS).sort());
  });

  it("the reset link: a scanner's GET spends nothing — the old password still works and the token still takes a new one", async () => {
    const owner = await verifiedUser();
    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email: owner.email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const link = linkIn(await waitForMail(owner.email, "passwordReset"));
    const before = await userById(owner.user.id);
    for (const method of ["GET", "HEAD", "GET"]) await send(newClient(), link, { method, browser: false });
    expect(await userById(owner.user.id)).toEqual(before);
    expect((await signIn(newClient(), owner.email)).status).toBe(200);
    const follow = await send(newClient(), link);
    const token = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
    const set = await send(newClient(), "/api/auth/reset-password", {
      headers: CAPTCHA,
      json: { newPassword: "chosen after the scanner 81!", token },
    });
    expect(set.status, set.text).toBe(200);
  });

  it("the delete-account link: a scanner's GET (no session) schedules nothing", async () => {
    const owner = await verifiedUser();
    const asked = await send(owner.client, "/api/auth/delete-user", {
      json: { password: PASSWORD, callbackURL: "/" },
    });
    expect(asked.status, asked.text).toBe(200);
    const link = linkIn(await waitForMail(owner.email, "deleteAccountVerification"));
    for (const method of ["GET", "HEAD", "GET"]) {
      const fetched = await send(newClient(), link, { method, browser: false });
      expect(fetched.status).toBeLessThan(500);
    }
    expect((await userById(owner.user.id))!.deleteScheduledAt).toBeNull();
    // Another account's session is not this account's either.
    const other = await verifiedUser();
    await send(other.client, link);
    expect((await userById(owner.user.id))!.deleteScheduledAt).toBeNull();
    expect((await userById(other.user.id))!.deleteScheduledAt).toBeNull();
  });
});

// P1 — `/unlink-account` must not be a way round the gate: with the password row gone, the
// change-of-address gate would no longer ask for a password.
describe("unlinking a sign-in method (P1)", () => {
  /** A verified account with a password AND Google linked; its session. */
  async function withGoogle() {
    const owner = await verifiedUser();
    const start = await send(owner.client, "/api/auth/link-social", {
      json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
    });
    const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
    const code = testGoogleCode({ sub: `g-${crypto.randomUUID()}`, email: owner.email, name: "G" });
    await send(
      owner.client,
      `/api/auth/callback/google?code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`,
      { browser: false },
    );
    const rows = await accountsOf(owner.user.id);
    expect(rows.map((row) => row.providerId).sort()).toEqual(["credential", "google"]);
    return {
      owner,
      credential: rows.find((row) => row.providerId === "credential")!.id,
      google: rows.find((row) => row.providerId === "google")!.id,
    };
  }
  const unlink = (client: Client, accountId: string, extra: Record<string, unknown> = {}) =>
    send(client, "/api/auth/unlink-account", { json: { accountId, ...extra } });
  const providers = async (userId: string) => (await accountsOf(userId)).map((row) => row.providerId).sort();

  it("a stolen session cannot remove the password row — with or without the password — so the change-of-address gate still asks for it", async () => {
    const { owner, credential } = await withGoogle();
    const thief = newClient();
    thief.cookies = new Map(owner.client.cookies);
    for (const extra of [{}, { password: PASSWORD }]) {
      const refused = await unlink(thief, credential, extra);
      expect(refused.status, refused.text).toBe(403);
      expect(refused.body).toMatchObject({ code: "UNLINK_NOT_AVAILABLE" });
    }
    expect(await providers(owner.user.id)).toEqual(["credential", "google"]);
    const asked = await ask(thief, freshEmail());
    expect(asked.status).toBe(400);
    expect(asked.body).toMatchObject({ code: "INVALID_PASSWORD" });
  });

  it("unlinking Google needs the owner again (the password), like a change of address — and works with it", async () => {
    const { owner, google } = await withGoogle();
    const thief = newClient();
    thief.cookies = new Map(owner.client.cookies);
    for (const extra of [{}, { password: "a guess at the password 1!" }]) {
      const refused = await unlink(thief, google, extra);
      expect(refused.status, refused.text).toBe(400);
      expect(refused.body).toMatchObject({ code: "INVALID_PASSWORD" });
    }
    expect(await providers(owner.user.id)).toEqual(["credential", "google"]);
    const done = await unlink(owner.client, google, { password: PASSWORD });
    expect(done.status, done.text).toBe(200);
    expect(await providers(owner.user.id)).toEqual(["credential"]);
  });
});
