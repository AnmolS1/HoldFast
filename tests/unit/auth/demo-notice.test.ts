// The closed-test ("demo") notice at sign-up (DEMONOTICE, Anmol's choice 2026-10-22).
//
// While the `demoMode` setting is on, every way of becoming an account holder needs the tester's
// assent to the notice — a JSON `true` in `acceptDemo` — and the assent is written on the row like
// the terms assent: `demoNoticeVersion` (DEMO_NOTICE_VERSION) and `demoNoticeAcceptedAt`. The four
// ways: the email sign-up, the Google sign-up (its intent carries the assent), the look-alike
// answer for an address that already has an account (refused the same way, so it tells nothing),
// and the set-password confirmation of a link opened elsewhere (the statement becomes the
// prover's). With the setting off (no row: the default) sign-up is exactly as before: nothing is
// asked and nothing is written.
//
// The setting is given per client (helpers.ts `newClient({ settings })`), never written to the
// shared table.
import { describe, expect, it } from "vitest";
import { en } from "../../../src/client/lib/en";
import { testGoogleCode, type TestGoogleProfile } from "../../../src/worker/auth/test-outbound";
import { SUPPORT_EMAIL } from "../../../src/worker/services/email";
import { DEMO_NOTICE_VERSION, SIGNUP_REFUSALS } from "../../../src/worker/services/signup-policy";
import {
  CAPTCHA,
  createInvite,
  freshEmail,
  inviteRow,
  linkIn,
  newClient,
  send,
  signUp,
  userByEmail,
  userById,
  waitForMail,
  type Client,
} from "./helpers";

const DEMO = { settings: { demoMode: true } } as const;

/** A refused sign-up: 400 with the code, no user row, the invite untouched, no session cookie. */
async function expectDemoRefused(client: Client, acceptDemo: unknown, email = freshEmail()) {
  const extra = acceptDemo === undefined ? {} : { acceptDemo };
  const { sent, inviteCode } = await signUp(client, { email, extra });
  expect(sent.status, `${JSON.stringify(acceptDemo)}: ${sent.text}`).toBe(400);
  expect(sent.body).toMatchObject({
    code: "DEMO_NOT_ACCEPTED",
    message: SIGNUP_REFUSALS.DEMO_NOT_ACCEPTED,
  });
  expect((await inviteRow(inviteCode!))!.uses, "the invite is not spent").toBe(0);
  expect([...client.cookies.keys()].filter((name) => name.includes("session"))).toEqual([]);
  return { sent, email };
}

describe("the notice", () => {
  it("is the brief's sentence and names the support address the app's mail already uses", () => {
    expect(en["signup.demo.notice"]).toBe(
      `Holdfast is in a closed test. Don't store anything important — files may be deleted when the test ends. Report problems to ${SUPPORT_EMAIL}.`,
    );
  });
});

describe("email sign-up", () => {
  it("demo mode off (the default): nothing is asked and nothing is written — as before", async () => {
    const { sent, email } = await signUp(newClient());
    expect(sent.status, sent.text).toBe(200);
    const row = (await userByEmail(email))!;
    expect(row.demoNoticeVersion).toBeNull();
    expect(row.demoNoticeAcceptedAt).toBeNull();
    // An assent sent anyway is not recorded: there was no notice to accept.
    const extra = await signUp(newClient(), { extra: { acceptDemo: true } });
    expect(extra.sent.status, extra.sent.text).toBe(200);
    expect((await userByEmail(extra.email))!.demoNoticeVersion).toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["false", false],
    ['the string "true"', "true"],
    ["1", 1],
  ])("demo mode on: acceptDemo %s is refused (400 DEMO_NOT_ACCEPTED), no account", async (_label, value) => {
    const { email } = await expectDemoRefused(newClient(DEMO), value);
    expect(await userByEmail(email)).toBeNull();
  });

  it("demo mode on: with the assent the account carries the notice's version and when it was accepted", async () => {
    const before = Date.now();
    const { sent, email } = await signUp(newClient(DEMO), { extra: { acceptDemo: true } });
    expect(sent.status, sent.text).toBe(200);
    const row = (await userByEmail(email))!;
    expect(row.demoNoticeVersion).toBe(DEMO_NOTICE_VERSION);
    expect(DEMO_NOTICE_VERSION).toBe("demo-2026-10");
    expect(row.demoNoticeAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // Recorded beside the terms assent, not instead of it.
    expect(row.termsVersion).toBe("2026-10");
    // The answer does not carry it (the look-alike answer below must match a new one).
    expect(JSON.stringify(sent.body)).not.toMatch(/demoNotice/);
  });

  it("demo mode on, an address that already has an account: refused the same way without the assent, answered like a new one with it", async () => {
    const { email } = await signUp(newClient());
    const owner = (await userByEmail(email))!;
    await expectDemoRefused(newClient(DEMO), undefined, email);
    const fresh = await signUp(newClient(DEMO), { extra: { acceptDemo: true } });
    const taken = await signUp(newClient(DEMO), { email, extra: { acceptDemo: true } });
    expect(taken.sent.status, taken.sent.text).toBe(200);
    expect(fresh.sent.status).toBe(200);
    const keys = (body: unknown) => Object.keys((body as { user: object }).user).sort();
    expect(keys(taken.sent.body)).toEqual(keys(fresh.sent.body));
    // The owner's row is not touched.
    expect((await userById(owner.id))!.demoNoticeVersion).toBeNull();
  });
});

// ── Google ────────────────────────────────────────────────────────────────────────────────────

const profileFor = (email: string): TestGoogleProfile => ({
  sub: `g-${crypto.randomUUID()}`,
  email,
  name: "Gina Google",
});

async function intent(client: Client, body: Record<string, unknown> = {}) {
  const inviteCode = await createInvite();
  const sent = await send(client, "/api/auth-intent", {
    json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode, ...body },
  });
  return { sent, inviteCode };
}

async function googleRoundTrip(client: Client, profile: TestGoogleProfile) {
  const start = await send(client, "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
  });
  expect(start.status, start.text).toBe(200);
  const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
  const callback = await send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
  return callback.headers.get("location") ?? "";
}

describe("Google sign-up", () => {
  it("demo mode on: the intent without the assent is refused (400, reason DEMO_NOT_ACCEPTED) and sets no cookie", async () => {
    for (const acceptDemo of [undefined, false, "true"]) {
      const { sent, inviteCode } = await intent(
        newClient(DEMO),
        acceptDemo === undefined ? {} : { acceptDemo },
      );
      expect(sent.status, sent.text).toBe(400);
      expect(sent.body).toMatchObject({ error: "validation", details: { reason: "DEMO_NOT_ACCEPTED" } });
      expect(sent.setCookies).toEqual([]);
      expect((await inviteRow(inviteCode))!.uses).toBe(0);
    }
  });

  it("demo mode on: with the assent the Google account carries the notice's version", async () => {
    const client = newClient(DEMO);
    const email = freshEmail();
    const { sent } = await intent(client, { acceptDemo: true });
    expect(sent.status, sent.text).toBe(200);
    expect(await googleRoundTrip(client, profileFor(email))).toBe("/");
    const row = (await userByEmail(email))!;
    expect(row.demoNoticeVersion).toBe(DEMO_NOTICE_VERSION);
    expect(row.demoNoticeAcceptedAt).toBeInstanceOf(Date);
  });

  it("an intent made while demo mode was off does not carry an assent: switched on before the callback, the sign-up is refused", async () => {
    const before = newClient();
    const email = freshEmail();
    const { sent, inviteCode } = await intent(before);
    expect(sent.status, sent.text).toBe(200);
    // The same browser (its cookies), the setting now on.
    const after = newClient({
      ...DEMO,
      ip: before.ip,
      cookies: before.cookies,
      cookiePaths: before.cookiePaths,
    });
    const location = await googleRoundTrip(after, profileFor(email));
    const url = new URL(location, "http://localhost");
    expect(url.pathname).toBe("/signup");
    expect(url.searchParams.get("error")).toBe("DEMO_NOT_ACCEPTED");
    expect(await userByEmail(email)).toBeNull();
    expect((await inviteRow(inviteCode))!.uses).toBe(0);
  });

  it("demo mode off: a Google sign-up is as before — nothing written", async () => {
    const client = newClient();
    const email = freshEmail();
    expect((await intent(client)).sent.status).toBe(200);
    expect(await googleRoundTrip(client, profileFor(email))).toBe("/");
    expect((await userByEmail(email))!.demoNoticeVersion).toBeNull();
  });
});

// ── the set-password confirmation (a verification link opened in another browser) ─────────────

describe("confirm-email", () => {
  const STATEMENT = { acceptTerms: true, birthYear: 1990, birthMonth: 5 };

  async function linkOpenedElsewhere(signupClient: Client) {
    const email = freshEmail();
    const { sent } = await signUp(signupClient, { email, extra: { acceptDemo: true } });
    expect(sent.status, sent.text).toBe(200);
    const link = linkIn(await waitForMail(email, "verification"));
    const token = new URL(link, "http://localhost").searchParams.get("token")!;
    return { email, token, id: (await userByEmail(email))!.id };
  }

  const confirm = (client: Client, token: string, extra: Record<string, unknown> = {}) =>
    send(client, "/api/account/confirm-email", {
      headers: CAPTCHA,
      json: { token, newPassword: "a different long passphrase 7!", ...STATEMENT, ...extra },
    });

  it("demo mode on: refused without the prover's own assent (400, reason DEMO_NOT_ACCEPTED), the row untouched; with it, the prover's assent is on the row", async () => {
    const { token, id } = await linkOpenedElsewhere(newClient(DEMO));
    const planted = (await userById(id))!;
    expect(planted.demoNoticeVersion).toBe(DEMO_NOTICE_VERSION);
    const prover = newClient(DEMO);
    for (const acceptDemo of [undefined, false, "true"]) {
      const refused = await confirm(prover, token, acceptDemo === undefined ? {} : { acceptDemo });
      expect(refused.status, refused.text).toBe(400);
      expect(refused.body).toMatchObject({ error: "validation", details: { reason: "DEMO_NOT_ACCEPTED" } });
    }
    expect(await userById(id)).toEqual(planted);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const done = await confirm(prover, token, { acceptDemo: true });
    expect(done.status, done.text).toBe(200);
    const row = (await userById(id))!;
    expect(row.emailVerified).toBe(true);
    expect(row.demoNoticeVersion).toBe(DEMO_NOTICE_VERSION);
    expect(row.demoNoticeAcceptedAt!.getTime()).toBeGreaterThan(planted.demoNoticeAcceptedAt!.getTime());
  });

  it("demo mode off: the creator's demo assent does not stay on the row — the statement is the prover's, and they were asked nothing", async () => {
    const { token, id } = await linkOpenedElsewhere(newClient(DEMO));
    const done = await confirm(newClient(), token);
    expect(done.status, done.text).toBe(200);
    const row = (await userById(id))!;
    expect(row.demoNoticeVersion).toBeNull();
    expect(row.demoNoticeAcceptedAt).toBeNull();
  });
});
