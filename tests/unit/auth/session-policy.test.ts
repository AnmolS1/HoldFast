// What a session costs to get and what it looks like: verification first, Turnstile, the breach
// check, the rate limits, the cookie's flags, the origin checks, and what a session answer may
// carry. Also the standing facts about the options object (ids, no delete hooks) and that the
// runtime config and the schema-generation config describe the same tables.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BA_ID } from "../../../src/shared/ids";
import {
  auth as generationAuth,
  sessionAdditionalFields as generationSessionFields,
  userAdditionalFields as generationUserFields,
} from "../../../src/worker/auth/config";
import {
  buildAuthOptions,
  CAPTCHA_ENDPOINTS,
  PASSWORD_COMPROMISED_MESSAGE,
} from "../../../src/worker/auth/create-auth";
import { sessionAdditionalFields, userAdditionalFields } from "../../../src/worker/auth/fields";
import { authLog, authLogLine } from "../../../src/worker/auth/logger";
import { createScope } from "../../../src/worker/auth/scope";
import {
  BREACHED_TEST_PASSWORDS,
  installTestOutbound,
  routeTestOutbound,
  testGoogleCode,
  testOutbound,
  TURNSTILE_TEST_SECRET_FAIL,
  TURNSTILE_TEST_SECRET_PASS,
} from "../../../src/worker/auth/test-outbound";
import { user } from "../../../src/worker/db/schema";
import createAuthSource from "../../../src/worker/auth/create-auth.ts?raw";
import {
  CAPTCHA,
  createInvite,
  enableTotp,
  freshEmail,
  getSession,
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
  userByEmail,
  verifiedUser,
  waitForMail,
} from "./helpers";

describe("verification comes first", () => {
  it("a sign-up starts no session, and a correct password is refused until the address is verified", async () => {
    const client = newClient();
    const { sent, email } = await signUp(client);
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ token: null });
    expect(sent.setCookies.some((c) => c.includes("session"))).toBe(false);
    const row = await userByEmail(email);

    const early = await signIn(client, email);
    expect(early.status).toBe(403);
    expect(early.body).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await sessionsOf(row!.id)).toEqual([]);
    expect(await getSession(client)).toBeNull();

    // The link verifies and signs in; used again it does neither a second time.
    const link = linkIn(await waitForMail(email, "verification"));
    expect((await send(client, link)).status).toBe(302);
    expect((await userByEmail(email))!.emailVerified).toBe(true);
    expect(await sessionsOf(row!.id)).toHaveLength(1);
    const stranger = newClient();
    expect((await send(stranger, link)).status).toBe(302);
    expect(await getSession(stranger), "a verification link is not a sign-in link once used").toBeNull();
    expect(await sessionsOf(row!.id)).toHaveLength(1);
  });

  it("a verification link is built from APP_ORIGIN, whatever the request claims about its host", async () => {
    const client = newClient({
      headers: {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
        forwarded: "host=evil.example;proto=https",
        "x-original-host": "evil.example",
      },
    });
    const { email } = await signUp(client);
    const mail = await waitForMail(email, "verification");
    const links = (mail.text ?? "").match(/https?:\/\/[^\s]+/g) ?? [];
    expect(links.length).toBeGreaterThan(0);
    for (const link of links)
      expect(link.startsWith("http://localhost/api/auth/verify-email?token=")).toBe(true);
    expect(`${mail.html}${mail.text}`).not.toContain("evil.example");
  });

  it("a tampered or foreign verification token verifies nothing", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const link = linkIn(await waitForMail(email, "verification"));
    const url = new URL(link, "http://localhost");
    const token = url.searchParams.get("token")!;
    const [header, payload, signature] = token.split(".");
    const other = btoa(
      JSON.stringify({ email: "someone-else@holdfast-test.example", iat: 1, exp: 9999999999 }),
    ).replace(/=+$/, "");
    for (const forged of [`${header}.${other}.${signature}`, `${header}.${payload}.AAAA`, "not-a-token"]) {
      url.searchParams.set("token", forged);
      const answer = await send(newClient(), url.pathname + url.search);
      expect(answer.headers.get("location") ?? "").toMatch(/error=LINK_INVALID/);
    }
    expect((await userByEmail(email))!.emailVerified).toBe(false);
  });
});

describe("the session cookie", () => {
  it("is HttpOnly, SameSite=Lax, Path=/, 14 days — and not Secure on a plain-http origin", async () => {
    const { client, email } = await verifiedUser();
    await send(client, "/api/auth/sign-out", { json: {} });
    const sent = await signIn(client, email);
    expect(sent.status).toBe(200);
    const token = sent.setCookies.find((c) => c.startsWith("hf.session_token="))!;
    expect(token).toMatch(/; Max-Age=1209600;/);
    expect(token).toMatch(/; Path=\/(;|$)/);
    expect(token).toMatch(/; HttpOnly/);
    expect(token).toMatch(/; SameSite=Lax/);
    expect(token).not.toMatch(/; Secure/);
    expect(token).not.toMatch(/Domain=/i);
    // No cookie cache: no signed copy of the session or the user row is handed to the browser
    // (auth/create-auth.ts — with one, a revoked session lived on until the copy expired).
    expect(sent.setCookies.filter((c) => /session_data|account_data/.test(c.split("=")[0]!))).toEqual([]);
    expect((await send(client, "/api/auth/get-session")).setCookies).toEqual([]);
    // No cookie of ours or Better Auth's is readable by script.
    for (const cookie of sent.setCookies) expect(cookie, cookie.split("=")[0]).toMatch(/; HttpOnly/);
  });

  it("on an https origin every cookie is Secure and carries the __Host- prefix (no sibling origin can set it)", async () => {
    const https = { origin: "https://holdfast.example" };
    const client = newClient(https);
    const { email } = await signUp(client);
    const mail = await waitForMail(email, "verification");
    expect(linkIn(mail)).toMatch(/^\/api\/auth\/verify-email/);
    expect(mail.text).toContain("https://holdfast.example/api/auth/verify-email?token=");
    const verified = await send(client, linkIn(mail));
    expect(verified.status).toBe(302);
    const names = verified.setCookies.map((c) => c.split("=")[0]);
    expect(names).toContain("__Host-hf.session_token");
    expect(names.filter((name) => name.includes("session_data"))).toEqual([]);
    for (const cookie of verified.setCookies) {
      // `__Host-`: the browser accepts it only with Secure, Path=/ and NO Domain — so script on
      // a sibling subdomain cannot plant one for this host (a `__Secure-` cookie it can).
      expect(cookie.startsWith("__Host-"), cookie.split("=")[0]).toBe(true);
      expect(cookie).toMatch(/; Secure/);
      expect(cookie).toMatch(/; Path=\/(;|$)/);
      expect(cookie).not.toMatch(/Domain=/i);
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Lax/);
    }
    expect((await getSession(client))?.user.email).toBe(email);
    // The un-prefixed name is not honoured there: a plain-http cookie cannot stand in.
    const downgrade = newClient(https);
    downgrade.cookies.set("hf.session_token", client.cookies.get("__Host-hf.session_token")!);
    expect(await getSession(downgrade)).toBeNull();
    // Nor is a `__Secure-` one, which a sibling subdomain could have set with Domain=<parent>.
    const tossed = newClient(https);
    tossed.cookies.set("__Secure-hf.session_token", client.cookies.get("__Host-hf.session_token")!);
    expect(await getSession(tossed)).toBeNull();

    // Every other cookie the auth layer sets on that origin, flow by flow.
    const seen: string[] = [...verified.setCookies];
    const more = newClient(https);
    seen.push(...(await signUp(more)).sent.setCookies);
    seen.push(
      ...(
        await send(more, "/api/auth-intent", {
          json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: await createInvite() },
        })
      ).setCookies,
    );
    seen.push(
      ...(
        await send(more, "/api/auth/sign-in/social", {
          json: { provider: "google", callbackURL: "/", errorCallbackURL: "/login" },
        })
      ).setCookies,
    );
    seen.push(...(await send(client, "/api/auth/passkey/generate-register-options")).setCookies);
    seen.push(...(await send(more, "/api/auth/passkey/generate-authenticate-options")).setCookies);
    const totp = await enableTotp(client);
    await send(client, "/api/auth/sign-out", { json: {} });
    const challenge = await signIn(client, email);
    seen.push(...challenge.setCookies);
    seen.push(
      ...(
        await send(client, "/api/auth/two-factor/verify-totp", {
          json: { code: await nextTotp(totp.totpURI), trustDevice: true },
        })
      ).setCookies,
    );
    const namesSeen = new Set(seen.map((cookie) => cookie.split("=")[0]!));
    for (const expected of [
      "hf_pending",
      "hf_intent",
      "hf.session_token",
      "hf.two_factor",
      "hf.trust_device",
    ]) {
      expect([...namesSeen], expected).toContain(`__Host-${expected}`);
    }
    expect(namesSeen.size).toBeGreaterThanOrEqual(7);
    for (const cookie of seen) {
      expect(cookie.startsWith("__Host-"), cookie.split("=")[0]).toBe(true);
      expect(cookie, cookie.split("=")[0]).toMatch(/; Secure/);
      expect(cookie, cookie.split("=")[0]).toMatch(/; Path=\/(;|$)/);
      expect(cookie, cookie.split("=")[0]).not.toMatch(/Domain=/i);
      expect(cookie, cookie.split("=")[0]).toMatch(/; HttpOnly/);
    }
  });

  it("a session answer never carries the hold flag, the inviter or the suspension note — and no cookie carries a copy of the user", async () => {
    const { client, user: row } = await verifiedUser();
    await testDb()
      .update(user)
      .set({ legalHold: true, invitedBy: "someone", suspendedReason: "note" })
      .where(eq(user.id, row.id));
    await send(client, "/api/auth/sign-out", { json: {} });
    await testDb().update(user).set({ suspendedReason: null }).where(eq(user.id, row.id));
    const sent = await signIn(client, row.email);
    expect(sent.status, sent.text).toBe(200);
    const session = await getSession(client);
    const fresh = await send(client, "/api/auth/get-session?disableCookieCache=true");
    for (const body of [sent.body, session, fresh.body]) {
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/legalHold|legal_hold|invitedBy|suspendedReason/);
    }
    // And there is no cookie that carries a copy of the user row at all.
    expect([...client.cookies.keys()].filter((name) => name.includes("session_data"))).toEqual([]);
    // What the shell does need is there.
    expect(session!.user).toMatchObject({
      emailVerified: true,
      termsVersion: "2026-10",
      deleteScheduledAt: null,
    });
    expect(BA_ID.test(String(session!.session.id))).toBe(true);
    expect(BA_ID.test(String(session!.user.id))).toBe(true);
  });
});

describe("Turnstile", () => {
  it("every listed endpoint refuses a request with no token, before anything else happens", async () => {
    expect(CAPTCHA_ENDPOINTS).toEqual([
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/send-verification-email",
    ]);
    for (const path of CAPTCHA_ENDPOINTS) {
      const sent = await send(newClient(), `/api/auth${path}`, {
        json: { email: freshEmail(), password: PASSWORD },
      });
      expect(sent.status, path).toBe(400);
      expect(sent.body, path).toMatchObject({ code: "MISSING_RESPONSE" });
    }
  });

  it("accepts the dummy token under the published always-pass secret, and refuses under the always-fail secret", async () => {
    expect(env.TURNSTILE_SECRET).toBe("1x0000000000000000000000000000000AA");
    const before = testOutbound()!.calls.length;
    const ok = await signUp(newClient());
    expect(ok.sent.status).toBe(200);
    const verifyCalls = testOutbound()!
      .calls.slice(before)
      .filter((call) => call.host === "challenges.cloudflare.com");
    expect(verifyCalls).toEqual([
      { host: "challenges.cloudflare.com", path: "/turnstile/v0/siteverify", method: "POST" },
    ]);

    const failing = newClient({ env: { TURNSTILE_SECRET: TURNSTILE_TEST_SECRET_FAIL } });
    const refused = await signUp(failing);
    expect(refused.sent.status).toBe(403);
    expect(refused.sent.body).toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(await userByEmail(refused.email)).toBeNull();
  });
});

describe("third parties under `vite dev` (test mode, not the unit-test environment)", () => {
  // The end-to-end run: `strict` is off there, so an unknown host goes to the network — but none
  // of the four third parties the auth layer calls may, with the test values an e2e run uses.
  const network: string[] = [];
  const state = {
    strict: false,
    original: (async (input: RequestInfo | URL) => {
      network.push(new Request(input as RequestInfo).url);
      return new Response("from the network", { status: 599 });
    }) as typeof fetch,
  };
  const verify = (secret: string) =>
    routeTestOutbound(
      new Request("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret, response: "XXXX.DUMMY.TOKEN.XXXX" }),
      }),
      state,
    );

  it("Turnstile's published test secrets are answered here: no request leaves for Cloudflare", async () => {
    network.length = 0;
    const pass = await verify(TURNSTILE_TEST_SECRET_PASS);
    expect(pass.status).toBe(200);
    expect(await pass.json()).toMatchObject({ success: true });
    expect(await (await verify(TURNSTILE_TEST_SECRET_FAIL)).json()).toMatchObject({ success: false });
    expect(network).toEqual([]);
  });

  it("the breach API, the MX lookup and a test Google code are answered here too", async () => {
    network.length = 0;
    const range = await routeTestOutbound(new Request("https://api.pwnedpasswords.com/range/ABCDE"), state);
    expect(range.status).toBe(200);
    const mx = await routeTestOutbound(
      new Request("https://cloudflare-dns.com/dns-query?name=example.test&type=MX"),
      state,
    );
    expect(await mx.json()).toMatchObject({ Status: 0 });
    const token = await routeTestOutbound(
      new Request("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({
          code: testGoogleCode({ sub: "1", email: "g@example.test" }),
          client_id: "c",
        }),
      }),
      state,
    );
    expect(await token.json()).toMatchObject({ token_type: "Bearer" });
    expect(network).toEqual([]);
  });

  it("control — anything that is not a test value still goes out: a real secret, a real code, another host", async () => {
    network.length = 0;
    expect((await verify("0x4AAAAAAA-a-developers-real-secret")).status).toBe(599);
    const real = await routeTestOutbound(
      new Request("https://oauth2.googleapis.com/token", {
        method: "POST",
        body: new URLSearchParams({ code: "4/0AbC-real-code" }),
      }),
      state,
    );
    expect(real.status).toBe(599);
    expect((await routeTestOutbound(new Request("https://api.resend.com/emails"), state)).status).toBe(599);
    expect(network).toEqual([
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      "https://oauth2.googleapis.com/token",
      "https://api.resend.com/emails",
    ]);
  });
});

describe("the breach check", () => {
  it("refuses a breached password at sign-up, sending only a 5-character hash prefix", async () => {
    const before = testOutbound()!.calls.length;
    const { sent, email } = await signUp(newClient(), { password: BREACHED_TEST_PASSWORDS[0] });
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ code: "PASSWORD_COMPROMISED", message: PASSWORD_COMPROMISED_MESSAGE });
    expect(await userByEmail(email)).toBeNull();
    const calls = testOutbound()!
      .calls.slice(before)
      .filter((call) => call.host === "api.pwnedpasswords.com");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toMatch(/^\/range\/[0-9A-F]{5}$/);
  });

  it("refuses a breached password at change and at reset; a password not in the corpus passes", async () => {
    const { client, email } = await verifiedUser();
    const changed = await send(client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword: BREACHED_TEST_PASSWORDS[1] },
    });
    expect(changed.status).toBe(400);
    expect(changed.body).toMatchObject({ code: "PASSWORD_COMPROMISED" });

    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const reset = await waitForMail(email, "passwordReset");
    const follow = await send(newClient(), linkIn(reset));
    const token = new URL(follow.headers.get("location")!, "http://localhost").searchParams.get("token")!;
    const refused = await send(newClient(), "/api/auth/reset-password", {
      json: { newPassword: BREACHED_TEST_PASSWORDS[0], token },
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: "PASSWORD_COMPROMISED" });
    // The old password still works: nothing was changed by the refused attempts.
    await send(client, "/api/auth/sign-out", { json: {} });
    expect((await signIn(newClient(), email)).status).toBe(200);
    // And the refusal came BEFORE the token was looked at: the link is not spent — the same
    // token then takes a password that is not in the corpus.
    const accepted = await send(newClient(), "/api/auth/reset-password", {
      json: { newPassword: "a password nobody breached 61!", token },
    });
    expect(accepted.status, accepted.text).toBe(200);
    expect((await signIn(newClient(), email, "a password nobody breached 61!")).status).toBe(200);
  });

  it("an unreachable breach service fails the sign-up closed (no account without the check)", async () => {
    const outbound = testOutbound()!;
    outbound.answer("api.pwnedpasswords.com", () => new Response("down", { status: 503 }));
    try {
      const { sent, email } = await signUp(newClient());
      // Refused, and said so — 503 with a code of its own, not an unexplained 500 (auth/breach-check.ts).
      expect(sent.status).toBe(503);
      expect(sent.body).toMatchObject({ code: "BREACH_CHECK_UNAVAILABLE" });
      expect(await userByEmail(email)).toBeNull();
    } finally {
      outbound.answer("api.pwnedpasswords.com", null);
    }
  });

  it("passwords shorter than 12 or longer than 128 characters are refused", async () => {
    for (const password of ["short-one-1", "x".repeat(129)]) {
      const { sent, email } = await signUp(newClient(), { password });
      expect(sent.status, String(password.length)).toBe(400);
      expect(await userByEmail(email)).toBeNull();
    }
  });
});

describe("rate limits", () => {
  it("the 6th sign-in in a minute from one address is refused by Better Auth's limiter", async () => {
    const { email } = await verifiedUser();
    const attacker = newClient();
    for (let i = 1; i <= 5; i++) {
      const tried = await signIn(attacker, email, "wrong password, attempt " + i);
      expect(tried.status, `attempt ${i}`).toBe(401);
    }
    const sixth = await signIn(attacker, email, PASSWORD);
    expect(sixth.status).toBe(429);
    expect(sixth.body).toMatchObject({ message: "Too many requests. Please try again later." });
    expect(Number(sixth.headers.get("x-retry-after"))).toBeGreaterThan(0);
    expect(await getSession(attacker)).toBeNull();
    // Another address is not limited.
    expect((await signIn(newClient(), email)).status).toBe(200);
  });

  it("RL_AUTH: from one address the 21st auth write in a minute is 429 with our envelope — and 60 session reads still pass", async () => {
    const ip = newClient().ip;
    const a = newClient({ ip });
    const b = newClient({ ip });
    // Sign-out is limited by Better Auth at its default 30 a minute, so RL_AUTH (20) trips first.
    // The limiter counts in fixed one-minute windows. Twenty writes pass in any window, so the
    // first refusal is the 21st write — or, when the minute rolls over part-way (a loaded
    // machine), the 21st of the new window: never earlier than the 21st, never later than the 41st.
    let refused: Awaited<ReturnType<typeof send>> | null = null;
    let refusedAt = 0;
    for (let i = 1; i <= 41 && refused === null; i++) {
      const sent = await send(i % 2 ? a : b, "/api/auth/sign-out", { json: {} });
      if (sent.status === 429) {
        refused = sent;
        refusedAt = i;
      } else {
        expect(sent.status, `write ${i}`).toBe(200);
      }
    }
    expect(refusedAt, "the first refused write").toBeGreaterThanOrEqual(21);
    if (refused === null) throw new Error("41 writes in at most two windows were all let through");
    expect(refused.body).toMatchObject({ error: "rate_limited" });
    expect(refused.headers.get("retry-after")).toBe("60");
    // The ruling's own words: the 21st SIGN-IN attempt from that address is a 429 too.
    const signInAttempt = await signIn(b, freshEmail());
    expect(signInAttempt.status).toBe(429);
    expect(signInAttempt.body).toMatchObject({ error: "rate_limited" });
    // …while the shell's session read, from two clients behind that one address, is not counted.
    // (60, not 30: Better Auth's own default limit of 30 a minute per address must not apply
    // to this endpoint either.)
    for (let i = 1; i <= 60; i++) {
      const read = await send(i % 2 ? a : b, "/api/auth/get-session");
      expect(read.status, `read ${i}`).toBe(200);
    }
  });

  it("a verification resend is limited to 3 an hour per address", async () => {
    const client = newClient();
    const { email } = await signUp(client);
    const resend = () =>
      send(client, "/api/auth/send-verification-email", { json: { email }, headers: CAPTCHA });
    for (let i = 1; i <= 3; i++) expect((await resend()).status, `resend ${i}`).toBe(200);
    expect((await resend()).status).toBe(429);
    // One at sign-up and three resends reached the outbox (the per-recipient cap is 5 an hour).
    expect(mailTo(email, "verification")).toHaveLength(4);
    expect(mailTo(email, "verification").at(-1)!.text).toContain("new link");
  });

  it("a resend for an address with no account, or an already verified one, answers the same and sends nothing", async () => {
    const unknown = freshEmail();
    const sent = await send(newClient(), "/api/auth/send-verification-email", {
      json: { email: unknown },
      headers: CAPTCHA,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toEqual({ status: true });
    expect(mailTo(unknown)).toEqual([]);
    const { email } = await verifiedUser();
    const count = mailTo(email).length;
    const again = await send(newClient(), "/api/auth/send-verification-email", {
      json: { email },
      headers: CAPTCHA,
    });
    expect(again.body).toEqual({ status: true });
    expect(mailTo(email)).toHaveLength(count);
  });
});

describe("origins", () => {
  it("a cookie-bearing write from another origin, or with no origin at all, is refused", async () => {
    const { client } = await verifiedUser();
    const evil = await send(client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword: "another long password 77!" },
      browser: false,
      headers: { origin: "https://evil.example" },
    });
    expect(evil.status).toBe(403);
    expect(evil.body).toMatchObject({ code: "INVALID_ORIGIN" });
    const none = await send(client, "/api/auth/change-password", {
      json: { currentPassword: PASSWORD, newPassword: "another long password 77!" },
      browser: false,
    });
    expect(none.status).toBe(403);
    expect(none.body).toMatchObject({ code: "MISSING_OR_NULL_ORIGIN" });
    // A look-alike origin is not the origin.
    for (const origin of [
      "http://localhost.evil.example",
      "http://localhost:81",
      "https://localhost",
      "null",
    ]) {
      const sent = await send(client, "/api/auth/sign-out", {
        json: {},
        browser: false,
        headers: { origin },
      });
      expect(sent.status, origin).toBe(403);
    }
    expect((await getSession(client))?.user).toBeTruthy();
  });

  it("a cross-site sign-in or sign-up (login CSRF) is refused even without a cookie", async () => {
    const { email } = await verifiedUser();
    const forced = await send(newClient(), "/api/auth/sign-in/email", {
      json: { email, password: PASSWORD },
      browser: false,
      headers: {
        ...CAPTCHA,
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "cors",
      },
    });
    expect(forced.status).toBe(403);
    expect(forced.setCookies.some((c) => c.includes("session_token"))).toBe(false);
    const navigation = await send(newClient(), "/api/auth/sign-in/email", {
      json: { email, password: PASSWORD },
      browser: false,
      headers: {
        ...CAPTCHA,
        "sec-fetch-site": "cross-site",
        "sec-fetch-mode": "navigate",
        "sec-fetch-dest": "document",
      },
    });
    expect(navigation.status).toBe(403);
  });

  it("a callbackURL or redirectTo on another origin is refused", async () => {
    const { email } = await verifiedUser();
    const signInElsewhere = await send(newClient(), "/api/auth/sign-in/email", {
      json: { email, password: PASSWORD, callbackURL: "https://evil.example/landing" },
      headers: CAPTCHA,
    });
    expect(signInElsewhere.status).toBe(403);
    expect(signInElsewhere.body).toMatchObject({ code: "INVALID_CALLBACK_URL" });
    const reset = await send(newClient(), "/api/auth/request-password-reset", {
      json: { email, redirectTo: "https://evil.example/reset" },
      headers: CAPTCHA,
    });
    expect(reset.status).toBe(403);
    expect(mailTo(email, "passwordReset")).toEqual([]);
    const social = await send(newClient(), "/api/auth/sign-in/social", {
      json: { provider: "google", callbackURL: "//evil.example", errorCallbackURL: "/login" },
    });
    expect(social.status).toBe(403);
  });
});

describe("the options object", () => {
  const scope = () => createScope(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} });

  it("uses Better Auth's own ids: no generateId anywhere, and no uuid import in create-auth.ts", () => {
    const options = buildAuthOptions(scope());
    expect(options.advanced.database).toEqual({ joins: true });
    expect("generateId" in options.advanced.database).toBe(false);
    expect("generateId" in options.advanced).toBe(false);
    const code = createAuthSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/generateId|uuidv7/);
  });

  it("has no delete hook that could be mistaken for a veto: no databaseHooks.user.delete, no afterDelete", () => {
    const options = buildAuthOptions(scope());
    expect(Object.keys(options.databaseHooks.user).sort()).toEqual(["create", "update"]);
    // `account` is the provider-linking policy (create) and "no provider token is stored" (create,
    // update); what must never exist is a DELETE hook.
    expect(Object.keys(options.databaseHooks).sort()).toEqual(["account", "session", "user"]);
    expect(Object.keys(options.databaseHooks.account).sort()).toEqual(["create", "update"]);
    expect(Object.keys(options.user.deleteUser).sort()).toEqual([
      "beforeDelete",
      "enabled",
      "sendDeleteAccountVerification",
    ]);
    expect(options.user.deleteUser.enabled).toBe(true);
  });

  it("pins the origin, the cookie prefix, the session lifetimes and the per-endpoint rate limits", () => {
    const options = buildAuthOptions(scope());
    expect(options).toMatchObject({
      baseURL: env.APP_ORIGIN,
      basePath: "/api/auth",
      trustedOrigins: [env.APP_ORIGIN],
      telemetry: { enabled: false },
      advanced: {
        useSecureCookies: false,
        cookiePrefix: "hf",
        ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      },
      session: { expiresIn: 1_209_600, updateAge: 86_400, cookieCache: { enabled: false } },
      emailAndPassword: {
        requireEmailVerification: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        revokeSessionsOnPasswordReset: true,
      },
      emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: true, expiresIn: 3600 },
      rateLimit: {
        enabled: true,
        storage: "database",
        window: 60,
        max: 30,
        customRules: {
          "/get-session": false,
          "/sign-in/email": { window: 60, max: 5 },
          "/sign-up/email": { window: 3600, max: 5 },
          "/request-password-reset": { window: 3600, max: 3 },
          "/send-verification-email": { window: 3600, max: 3 },
          "/two-factor/verify-totp": { window: 60, max: 5 },
          "/two-factor/verify-backup-code": { window: 60, max: 5 },
        },
      },
    });
    const secure = buildAuthOptions(
      createScope({ ...env, APP_ORIGIN: "https://holdfast.example" }, testDb(), {
        waitUntil: () => {},
        passThroughOnException: () => {},
      }),
    );
    // `__Host-` cookies: the prefix and the Secure attribute are given explicitly (Better Auth's
    // own switch can only produce `__Secure-`).
    expect(secure.advanced).toMatchObject({
      useSecureCookies: false,
      cookiePrefix: "__Host-hf",
      defaultCookieAttributes: { secure: true },
    });
  });

  it("the stand-ins for third parties exist only in test mode", () => {
    // Already installed in this isolate (test mode). The gate itself: every way of not being in
    // test mode leaves `fetch` alone.
    expect(
      installTestOutbound({
        EMAIL_TRANSPORT: "resend",
        SENTRY_ENVIRONMENT: "dev",
        APP_ORIGIN: "http://localhost:5173",
      }),
    ).toBe(false);
    expect(
      installTestOutbound({
        EMAIL_TRANSPORT: "memory",
        SENTRY_ENVIRONMENT: "production",
        APP_ORIGIN: "http://localhost:5173",
      }),
    ).toBe(false);
    expect(
      installTestOutbound({
        EMAIL_TRANSPORT: "memory",
        SENTRY_ENVIRONMENT: "dev",
        APP_ORIGIN: "https://holdfast-dev.ponderance.dev",
      }),
    ).toBe(false);
    expect(installTestOutbound({ EMAIL_TRANSPORT: "memory", SENTRY_ENVIRONMENT: "dev" })).toBe(false);
    expect(installTestOutbound({})).toBe(false);
    expect(
      installTestOutbound({
        EMAIL_TRANSPORT: "memory",
        SENTRY_ENVIRONMENT: "test",
        APP_ORIGIN: "http://localhost",
      }),
    ).toBe(true);
  });

  it("under the unit-test environment an outbound request to any other host throws", async () => {
    await expect(fetch("https://example.com/")).rejects.toThrow(
      /unexpected outbound request to example\.com/,
    );
    await expect(fetch("https://api.resend.com/emails", { method: "POST", body: "{}" })).rejects.toThrow(
      /unexpected outbound/,
    );
  });
});

describe("what Better Auth logs", () => {
  it("is redacted before it reaches the Worker's log: no address, no token, no field of a database error", () => {
    const pgError = Object.assign(
      new Error('duplicate key value violates unique constraint "user_email_unique"'),
      {
        detail: "Key (email)=(victim@example.com) already exists.",
        code: "23505",
      },
    );
    const wrapped = new Error("Failed query: insert into user … params: victim@example.com", {
      cause: pgError,
    });
    const line = authLogLine("Sign-up attempt for existing email: victim@example.com", [
      wrapped,
      {
        endpoint: "http://localhost/api/auth/verify-email?token=eyJhbGciOi.abc.def&callbackURL=%2F",
        who: "other@example.org",
      },
      "http://localhost/api/auth/reset-password/sEcReTtOkEn123?callbackURL=x",
    ]);
    expect(line).not.toMatch(/victim@example\.com|other@example\.org|eyJhbGciOi|sEcReTtOkEn123/);
    expect(line).toContain("[email]");
    expect(line).toContain("user_email_unique");
    expect(line).not.toContain("Key (email)");
    expect(authLogLine("x".repeat(5000), []).length).toBeLessThanOrEqual(2001);
    // And it is what the instance is configured with.
    const options = buildAuthOptions(
      createScope(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} }),
    );
    expect(options.logger).toMatchObject({ level: "warn", log: authLog });
  });
});

describe("the runtime config and the schema-generation config agree", () => {
  const COLUMN_ATTRIBUTES = ["type", "bigint", "required", "defaultValue", "input"] as const;
  const columns = (fields: Record<string, Record<string, unknown>>) =>
    Object.fromEntries(
      Object.entries(fields).map(([name, field]) => [
        name,
        Object.fromEntries(COLUMN_ATTRIBUTES.map((a) => [a, field[a]])),
      ]),
    );

  it("same additional fields, attribute for attribute (everything that decides a column)", () => {
    expect(columns(userAdditionalFields)).toEqual(columns(generationUserFields));
    expect(columns(sessionAdditionalFields)).toEqual(columns(generationSessionFields));
    expect(Object.keys(userAdditionalFields)).toEqual(Object.keys(generationUserFields));
  });

  it("same plugins, in the same order, and the same table-deciding options", () => {
    const runtime = buildAuthOptions(
      createScope(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} }),
    );
    const generation = generationAuth.options;
    expect(runtime.plugins.map((p) => p.id)).toEqual((generation.plugins ?? []).map((p) => p.id));
    expect(runtime.rateLimit.storage).toBe(generation.rateLimit?.storage);
    expect(Object.keys(runtime.socialProviders)).toEqual(Object.keys(generation.socialProviders ?? {}));
    expect(runtime.emailAndPassword.enabled).toBe(generation.emailAndPassword?.enabled);
  });
});
