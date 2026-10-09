// ONE ANSWER, ONE AMOUNT OF WORK (src/worker/auth/parity.ts) — for every endpoint somebody who is
// not signed in can call about an address, a code or a token.
//
// Each case sends the same request about things in different states — an address with an
// account and one without, a token that exists and one that does not — and compares, instead of
// a wall clock (which measures the machine): the status, the body's shape, the header names,
// the cookie names, the number of SQL statements sent BEFORE the answer, and the number of
// password hashes. Mail and audit rows are counted too: they may differ in number (nobody is
// mailed about an address nobody has) but never happen before the answer — that is what the
// statement count before the answer shows.
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { BREACHED_TEST_PASSWORDS } from "../../../src/worker/auth/test-outbound";
import { LINK_ERROR_BUDGET, STATEMENT_BUDGET } from "../../../src/worker/auth/parity";
import * as passwordWork from "../../../src/worker/auth/password";
import { account } from "../../../src/worker/db/schema";
import { testVars } from "../../setup/test-vars";
import {
  CAPTCHA,
  createInvite,
  freshEmail,
  linkIn,
  measured,
  newClient,
  PASSWORD,
  signUp,
  testDb,
  verifiedUser,
  waitForMail,
  type Measured,
  type SendOptions,
} from "./helpers";

vi.mock("../../../src/worker/auth/password", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/password")>();
  return { ...real, hashPassword: vi.fn(real.hashPassword), verifyPassword: vi.fn(real.verifyPassword) };
});
const scryptRuns = () =>
  vi.mocked(passwordWork.hashPassword).mock.calls.length +
  vi.mocked(passwordWork.verifyPassword).mock.calls.length;
beforeEach(() => {
  vi.mocked(passwordWork.hashPassword).mockClear();
  vi.mocked(passwordWork.verifyPassword).mockClear();
});

const PER_REQUEST = new Set(["x-request-id", "date", "content-length", "cf-ray"]);

function shapeOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shapeOf);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, shapeOf(item)]),
    );
  }
  return value === null ? "null" : typeof value;
}

type Outline = {
  status: number;
  shape: unknown;
  code: unknown;
  headers: string[];
  cookies: string[];
  location: string | null;
  statements: number;
  scrypt: number;
};

/** One request, and everything about it that a caller could measure or compare. */
async function outline(run: () => Promise<Measured>): Promise<Outline & { mails: number }> {
  const before = scryptRuns();
  const done = await run();
  const headers: string[] = [];
  done.sent.headers.forEach((_value, name) => {
    if (!PER_REQUEST.has(name)) headers.push(name);
  });
  const location = done.sent.headers.get("location");
  return {
    status: done.sent.status,
    shape: shapeOf(done.sent.body),
    code: (done.sent.body as { code?: unknown; error?: unknown } | null)?.code ?? null,
    headers: headers.sort(),
    cookies: done.sent.setCookies.map((cookie) => cookie.replace(/^([^=]+)=[^;]*/, "$1=…")).sort(),
    // A link's answer is where it sends the browser; a token in it is replaced by its kind.
    location: location ? location.replace(/#token=.*/, "#token=…") : null,
    statements: done.statements,
    scrypt: scryptRuns() - before,
    mails: done.mails,
  };
}

/** The outline without the count of mails (which follows the answer, and may differ). */
function withoutMails(found: Outline & { mails: number }): Outline {
  const copy: Partial<Outline & { mails: number }> = { ...found };
  delete copy.mails;
  return copy as Outline;
}

/** Every variant's outline equals the first's — reported by name. */
async function expectAlike(variants: Array<[string, () => Promise<Measured>]>) {
  const outlines: Array<[string, Outline & { mails: number }]> = [];
  for (const [name, run] of variants) outlines.push([name, await outline(run)]);
  const reference = withoutMails(outlines[0]![1]);
  for (const [name, found] of outlines) expect(withoutMails(found), name).toEqual(reference);
  return outlines;
}

const post = (json: unknown, headers: Record<string, string> = CAPTCHA): SendOptions => ({ json, headers });
const signUpBody = async (email: string, extra: Record<string, unknown> = {}) =>
  post({
    email,
    password: PASSWORD,
    name: "Same Name",
    inviteCode: await createInvite(),
    birthYear: 1990,
    birthMonth: 5,
    acceptTerms: true,
    callbackURL: "/login?reason=verified",
    ...extra,
  });

/** A verification token for `email`, signed with the test secret (HS256, as Better Auth signs its own). */
function verificationToken(email: string, expiresInS: number, extra: Record<string, unknown> = {}): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const at = Math.floor(Date.now() / 1000);
  const body = `${part({ alg: "HS256" })}.${part({ email, iat: at - 10, exp: at + expiresInS, ...extra })}`;
  return `${body}.${createHmac("sha256", testVars.BETTER_AUTH_SECRET).update(body).digest("base64url")}`;
}
const verifyLink = (token: string) =>
  `/api/auth/verify-email?token=${encodeURIComponent(token)}&callbackURL=${encodeURIComponent("/login?reason=verified")}`;

describe("an address that has an account, and one that has none: the same answer for the same work", () => {
  it("sign-up", async () => {
    const verified = await verifiedUser();
    const unverified = await signUp(newClient());
    const outlines = await expectAlike([
      [
        "a new address",
        async () => measured(newClient(), "/api/auth/sign-up/email", await signUpBody(freshEmail())),
      ],
      [
        "a verified account",
        async () => measured(newClient(), "/api/auth/sign-up/email", await signUpBody(verified.email)),
      ],
      [
        "an unverified account",
        async () => measured(newClient(), "/api/auth/sign-up/email", await signUpBody(unverified.email)),
      ],
    ]);
    expect(outlines[0]![1]).toMatchObject({
      status: 200,
      scrypt: 1,
      statements: STATEMENT_BUDGET["/sign-up/email"],
    });
    // One mail either way (the verification link, or the notice to the address's owner) — and it
    // was not sent before the answer: the statements before the answer are the same number.
    expect(outlines.map(([, found]) => found.mails)).toEqual([1, 1, 1]);
  });

  it("sign-in with a wrong password", async () => {
    const verified = await verifiedUser();
    const unverified = await signUp(newClient());
    const googleOnly = await verifiedUser();
    await testDb().delete(account).where(eq(account.userId, googleOnly.user.id));
    const attempt = (email: string) => () =>
      measured(newClient(), "/api/auth/sign-in/email", post({ email, password: "not the password 123!" }));
    const outlines = await expectAlike([
      ["an unknown address", attempt(freshEmail())],
      ["a verified account", attempt(verified.email)],
      ["an unverified account", attempt(unverified.email)],
      ["an account with no password", attempt(googleOnly.email)],
    ]);
    expect(outlines[0]![1]).toMatchObject({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD", scrypt: 1 });
  });

  it("asking for a password reset", async () => {
    const verified = await verifiedUser();
    const unverified = await signUp(newClient());
    const ask = (email: string) => () =>
      measured(
        newClient(),
        "/api/auth/request-password-reset",
        post({ email, redirectTo: "/reset-password" }),
      );
    const outlines = await expectAlike([
      ["an unknown address", ask(freshEmail())],
      ["a verified account", ask(verified.email)],
      ["an unverified account", ask(unverified.email)],
    ]);
    expect(outlines[0]![1]).toMatchObject({
      status: 200,
      scrypt: 0,
      statements: STATEMENT_BUDGET["/request-password-reset"],
    });
    // Somebody is mailed only where there is somebody — after the answer.
    expect(outlines.map(([, found]) => found.mails)).toEqual([0, 1, 1]);
  });

  it("asking for the verification mail again", async () => {
    const verified = await verifiedUser();
    const unverified = await signUp(newClient());
    const ask = (email: string) => () =>
      measured(
        newClient(),
        "/api/auth/send-verification-email",
        post({ email, callbackURL: "/login?reason=verified" }),
      );
    const outlines = await expectAlike([
      ["an unknown address", ask(freshEmail())],
      ["an unverified account", ask(unverified.email)],
      ["a verified account", ask(verified.email)],
    ]);
    expect(outlines[0]![1]).toMatchObject({
      status: 200,
      statements: STATEMENT_BUDGET["/send-verification-email"],
    });
    expect(outlines.map(([, found]) => found.mails)).toEqual([0, 1, 0]);
  });

  it("changing a pending sign-up's address: an account that moves, a look-alike sign-up, and a taken address", async () => {
    const taken = await verifiedUser();
    const settings = { ceilings: { signupIpDay: 50 } };
    const real = newClient({ settings });
    await signUp(real);
    const another = newClient({ settings });
    await signUp(another);
    const lookAlike = newClient({ settings });
    await signUp(lookAlike, { email: taken.email });
    const change = (client: typeof real, email: string) => () =>
      measured(client, "/api/account/pending-email", { method: "PATCH", json: { email } });
    const outlines = await expectAlike([
      ["the account moves", change(real, freshEmail())],
      ["a look-alike sign-up (nothing to move)", change(lookAlike, freshEmail())],
      ["to an address somebody has", change(another, taken.email)],
    ]);
    expect(outlines[0]![1]).toMatchObject({
      status: 200,
      statements: STATEMENT_BUDGET["/account/pending-email"],
    });
    expect(outlines.map(([, found]) => found.mails)).toEqual([1, 0, 0]);
  });
});

describe("a link or a token that does not work: one answer, whatever is wrong with it", () => {
  it("the verification link — garbage, tampered, expired, for an address nobody has, for somebody else's change", async () => {
    const stranger = await verifiedUser();
    const { email } = await signUp(newClient());
    const good = new URL(
      linkIn(await waitForMail(email, "verification")),
      "http://localhost",
    ).searchParams.get("token")!;
    const open =
      (token: string, client = newClient()) =>
      () =>
        measured(client, verifyLink(token));
    const outlines = await expectAlike([
      ["garbage", open("garbage")],
      ["not a token at all", open("a.b.c")],
      ["tampered", open(`${good.slice(0, -4)}${good.endsWith("AAAA") ? "BBBB" : "AAAA"}`)],
      ["expired", open(verificationToken(email, -3600))],
      ["an address nobody has", open(verificationToken(freshEmail(), 3600))],
      [
        "an address change of another account, opened by somebody signed in as someone else",
        open(
          verificationToken(freshEmail(), 3600, {
            updateTo: freshEmail(),
            requestType: "change-email-confirmation",
          }),
          stranger.client,
        ),
      ],
    ]);
    expect(outlines[0]![1]).toMatchObject({
      status: 302,
      location: "/login?reason=verified&error=LINK_INVALID",
      cookies: [],
      statements: LINK_ERROR_BUDGET,
      scrypt: 0,
    });
  });

  it("choosing a password with a token — unknown, already used, another kind of token: one refusal, the round trips of a good one, and NO hash", async () => {
    const owner = await verifiedUser();
    await measured(
      newClient(),
      "/api/auth/request-password-reset",
      post({ email: owner.email, redirectTo: "/reset-password" }),
    );
    const used = /reset-password\/([^?/]+)/.exec(
      linkIn(await waitForMail(owner.email, "passwordReset")),
    )![1]!;
    const choose =
      (token: string, newPassword = "a perfectly fine password 3!") =>
      () =>
        measured(newClient(), "/api/auth/reset-password", { json: { newPassword, token } });
    // The first use works (and is the measure of the round trips a VALID token costs).
    const worked = await outline(choose(used));
    expect(worked).toMatchObject({ status: 200, scrypt: 1 });
    expect(worked.statements).toBeGreaterThanOrEqual(STATEMENT_BUDGET["/reset-password"]!);
    const outlines = await expectAlike([
      ["a token nobody issued", choose("nobody-issued-this-token-00")],
      ["a token already used", choose(used)],
      ["a one-character token", choose("x")],
      [
        "a session token, offered as a reset token",
        choose(decodeURIComponent(owner.client.cookies.get("hf.session_token") ?? "x").split(".")[0]!),
      ],
    ]);
    // The same round trips as the valid one — and no hash: there is no captcha in front of
    // this endpoint, and a stranger with a made-up token must not be able to buy a tenth of a
    // second of CPU per request (auth/preflight.ts). A token is not an address: that one of
    // 62^24 exists is not a thing to hide.
    expect(outlines[0]![1]).toMatchObject({
      status: 400,
      code: "INVALID_TOKEN",
      scrypt: 0,
      statements: worked.statements,
    });
  });
});

describe("what depends only on the input is refused first — at the same stage whoever it is about", () => {
  it("sign-up, sign-in, reset request and resend: a malformed request is the same refusal for a known and an unknown address", async () => {
    const known = await verifiedUser();
    type Case = { what: string; path: string; body: (email: string) => Promise<SendOptions> | SendOptions };
    const cases: Case[] = [
      {
        what: "sign-up: terms not accepted",
        path: "/api/auth/sign-up/email",
        body: (email) => signUpBody(email, { acceptTerms: false }),
      },
      {
        what: "sign-up: under 13",
        path: "/api/auth/sign-up/email",
        body: (email) => signUpBody(email, { birthYear: new Date().getUTCFullYear() - 5 }),
      },
      {
        what: "sign-up: no invite",
        path: "/api/auth/sign-up/email",
        body: (email) => signUpBody(email, { inviteCode: "NOPE-NOPE-NOPE-NOPE" }),
      },
      {
        what: "sign-up: a short password",
        path: "/api/auth/sign-up/email",
        body: (email) => signUpBody(email, { password: "short-1" }),
      },
      {
        what: "sign-up: a breached password",
        path: "/api/auth/sign-up/email",
        body: (email) => signUpBody(email, { password: BREACHED_TEST_PASSWORDS[1] }),
      },
      {
        what: "sign-up: no captcha",
        path: "/api/auth/sign-up/email",
        body: async (email) => ({ ...(await signUpBody(email)), headers: {} }),
      },
      {
        what: "sign-in: no captcha",
        path: "/api/auth/sign-in/email",
        body: (email) => post({ email, password: PASSWORD }, {}),
      },
      { what: "sign-in: no password", path: "/api/auth/sign-in/email", body: (email) => post({ email }) },
      {
        what: "reset request: no captcha",
        path: "/api/auth/request-password-reset",
        body: (email) => post({ email, redirectTo: "/reset-password" }, {}),
      },
      {
        what: "reset request: a foreign redirect",
        path: "/api/auth/request-password-reset",
        body: (email) => post({ email, redirectTo: "https://evil.example/x" }),
      },
      {
        what: "resend: no captcha",
        path: "/api/auth/send-verification-email",
        body: (email) => post({ email }, {}),
      },
    ];
    for (const { what, path, body } of cases) {
      const forKnown = await outline(async () => measured(newClient(), path, await body(known.email)));
      const forUnknown = await outline(async () => measured(newClient(), path, await body(freshEmail())));
      const a = withoutMails(forKnown);
      const b = withoutMails(forUnknown);
      expect(a, what).toEqual(b);
      expect(a.status, what).toBeGreaterThanOrEqual(400);
      // Refused before any password work.
      expect(a.scrypt, what).toBe(0);
    }
  });

  it("choosing a password: a short or a breached one is refused the same with a VALID token and with none — and does not spend the token", async () => {
    const owner = await verifiedUser();
    await measured(
      newClient(),
      "/api/auth/request-password-reset",
      post({ email: owner.email, redirectTo: "/reset-password" }),
    );
    const valid = /reset-password\/([^?/]+)/.exec(
      linkIn(await waitForMail(owner.email, "passwordReset")),
    )![1]!;
    const choose = (token: string, newPassword: string) => () =>
      measured(newClient(), "/api/auth/reset-password", { json: { newPassword, token } });
    for (const [what, password, code] of [
      ["short", "short-1", "PASSWORD_TOO_SHORT"],
      ["breached", BREACHED_TEST_PASSWORDS[0], "PASSWORD_COMPROMISED"],
    ] as const) {
      const outlines = await expectAlike([
        [`${what}, a valid token`, choose(valid, password)],
        [`${what}, no such token`, choose("nobody-issued-this-token-00", password)],
      ]);
      expect(outlines[0]![1], what).toMatchObject({ status: 400, code, scrypt: 0 });
    }
    // The valid token is still good.
    expect((await outline(choose(valid, "a perfectly fine password 3!"))).status).toBe(200);
  });
});
