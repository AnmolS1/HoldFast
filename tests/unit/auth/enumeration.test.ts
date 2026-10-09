// Account enumeration: what somebody who is NOT signed in can learn about an address.
//
// Every test here sends the same request twice — once about an address that has an account (in
// some state), once about one that has none — and compares what comes back: the status, the
// body's shape, the names of the headers and of the cookies, and how much password-hashing work
// the request did (counted with a spy on the two functions that do it; a wall-clock comparison
// would only measure the machine). What the request SPENDS is compared too: a sign-up that used
// its invite and its place in the day's count only when the address was new would tell the
// caller, on their next request, which it was.
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { user } from "../../../src/worker/db/schema";
import { scheduleDeletion, suspendUser, SYSTEM_ACTOR } from "../../../src/worker/services/account-state";
import * as passwordWork from "../../../src/worker/auth/password";
import {
  CAPTCHA,
  createInvite,
  freshEmail,
  inviteRow,
  mailTo,
  newClient,
  send,
  type Sent,
  serviceDeps,
  signIn,
  signUp,
  testDb,
  userByEmail,
  verifiedUser,
  waitForMail,
} from "./helpers";

// The two password functions, wrapped: they do the real work and are counted.
vi.mock("../../../src/worker/auth/password", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/password")>();
  return {
    ...real,
    hashPassword: vi.fn(real.hashPassword),
    verifyPassword: vi.fn(real.verifyPassword),
  };
});

const hashCalls = () => vi.mocked(passwordWork.hashPassword).mock.calls.length;
const verifyCalls = () => vi.mocked(passwordWork.verifyPassword).mock.calls.length;
/** Scrypt runs so far: one per hash, one per verify. */
const scryptRuns = () => hashCalls() + verifyCalls();

beforeEach(() => {
  vi.mocked(passwordWork.hashPassword).mockClear();
  vi.mocked(passwordWork.verifyPassword).mockClear();
});

/** Headers that differ between any two requests, whatever they are about. */
const PER_REQUEST = new Set(["x-request-id", "date", "content-length", "set-cookie", "cf-ray"]);

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

/** A user as answered, with the values that differ between any two sign-ups replaced by their kind. */
function valuesOf(answered: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(answered as Record<string, unknown>)) {
    if (key === "id") out[key] = /^[A-Za-z0-9]{32}$/.test(String(value)) ? "an id" : value;
    else if (key === "email") out[key] = "the address";
    else if (typeof value === "string" && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value)) out[key] = "a time";
    else out[key] = value;
  }
  return out;
}

/** Everything about an answer that a caller could compare, with the values that must differ taken out. */
function outline(sent: Sent) {
  const headers: Record<string, string> = {};
  sent.headers.forEach((value, name) => {
    if (!PER_REQUEST.has(name)) headers[name] = value;
  });
  return {
    status: sent.status,
    headers,
    // Name and attributes of each cookie; the value is a fresh signature every time.
    cookies: sent.setCookies.map((cookie) => cookie.replace(/^([^=]+)=[^;]*/, "$1=…")).sort(),
    shape: shapeOf(sent.body),
  };
}

const errorOf = (sent: Sent) => sent.body as { code?: string; message?: string } | null;

describe("sign-up: an address that has an account, and one that has none", () => {
  it("answer alike — status, body shape, headers, cookies — and do the same password hashing", async () => {
    const existing = await verifiedUser();
    for (const settings of [{ signupMode: "invite" as const }, { signupMode: "open" as const }]) {
      vi.mocked(passwordWork.hashPassword).mockClear();
      const fresh = await signUp(newClient({ settings }), { name: "Same Name" });
      const freshRuns = scryptRuns();
      const again = await signUp(newClient({ settings }), { email: existing.email, name: "Same Name" });
      const againRuns = scryptRuns() - freshRuns;
      expect(fresh.sent.status).toBe(200);
      expect(outline(again.sent)).toEqual(outline(fresh.sent));
      // Field by field: a made-up user that differed from a real new one in any VALUE (a null
      // where a new account has its terms version, say) would be told apart by reading it.
      expect(valuesOf((again.sent.body as { user: object }).user)).toEqual(
        valuesOf((fresh.sent.body as { user: object }).user),
      );
      expect(freshRuns).toBe(1);
      expect(againRuns).toBe(1);
      // The values a caller sees are their own input either way.
      const body = again.sent.body as { token: unknown; user: { email: string; name: string; id: string } };
      expect(body.token).toBeNull();
      expect(body.user).toMatchObject({ email: existing.email, name: "Same Name", emailVerified: false });
      expect(body.user.id).not.toBe(existing.user.id);
    }
  });

  it("spend alike: the invite is used and the day's count is taken whether or not the address was new", async () => {
    const existing = await verifiedUser();
    // The invite: after either sign-up it is used up, so "is my code still good?" says nothing.
    const codeForNew = await createInvite();
    const codeForExisting = await createInvite();
    await signUp(newClient(), { inviteCode: codeForNew });
    const again = await signUp(newClient(), { email: existing.email, inviteCode: codeForExisting });
    expect(again.sent.status).toBe(200);
    expect((await inviteRow(codeForNew))!.uses).toBe(1);
    expect((await inviteRow(codeForExisting))!.uses).toBe(1);
    for (const code of [codeForNew, codeForExisting]) {
      const lookup = await send(newClient(), `/api/invites/${code}`);
      expect(lookup.body).toEqual({ valid: false });
      const reuse = await signUp(newClient(), { inviteCode: code });
      expect(reuse.sent.status).toBe(400);
      expect(errorOf(reuse.sent)?.code).toBe("INVITE_INVALID");
    }

    // The count: with one sign-up a day per address, the next one is refused after either.
    const settings = { signupMode: "open" as const, ceilings: { signupIpDay: 1 } };
    for (const email of [existing.email, freshEmail()]) {
      const client = newClient({ settings });
      expect((await signUp(client, { email, inviteCode: null })).sent.status).toBe(200);
      const next = await signUp(client, { inviteCode: null });
      expect(next.sent.status, email).toBe(400);
      expect(errorOf(next.sent)?.code).toBe("SIGNUP_LIMIT");
    }
  });

  it("nothing about the existing account changes, and its owner is told — with a notice, not a verification link", async () => {
    const existing = await verifiedUser();
    const before = await userByEmail(existing.email);
    const verificationsBefore = mailTo(existing.email, "verification").length;
    await signUp(newClient(), {
      email: existing.email,
      name: "Somebody Else",
      password: "another long password 77",
    });
    const notice = await waitForMail(existing.email, "signupAttempt");
    expect(notice.text).toContain("already has an account");
    expect(notice.text).not.toContain("Somebody Else");
    expect(notice.text).not.toMatch(/verify-email|token=/);
    expect(mailTo(existing.email, "verification").length).toBe(verificationsBefore);
    const after = await userByEmail(existing.email);
    expect(after).toEqual(before);
    // The old password still signs in; the one the stranger chose does not.
    expect((await signIn(newClient(), existing.email)).status).toBe(200);
    expect((await signIn(newClient(), existing.email, "another long password 77")).status).toBe(401);
  });

  it("a refusal is about what was submitted, and is the same for both addresses", async () => {
    const existing = await verifiedUser();
    const cases: Array<{ what: string; input: Parameters<typeof signUp>[1]; code: string }> = [
      { what: "no invite", input: { inviteCode: null }, code: "INVITE_INVALID" },
      { what: "an unknown invite", input: { inviteCode: "T-NOSUCHCODE0000000" }, code: "INVITE_INVALID" },
      {
        what: "under 13",
        input: { birthYear: new Date().getUTCFullYear() - 5 },
        code: "SIGNUP_NOT_AVAILABLE",
      },
      { what: "no assent", input: { acceptTerms: false }, code: "TERMS_NOT_ACCEPTED" },
      { what: "a breached password", input: { password: "password123456789" }, code: "PASSWORD_COMPROMISED" },
    ];
    for (const { what, input, code } of cases) {
      const forNew = await signUp(newClient(), { ...input });
      const forExisting = await signUp(newClient(), { ...input, email: existing.email });
      expect(forNew.sent.status, what).toBe(400);
      expect(errorOf(forNew.sent)?.code, what).toBe(code);
      expect(outline(forExisting.sent), what).toEqual(outline(forNew.sent));
      expect(forExisting.sent.body, what).toEqual(forNew.sent.body);
    }
  });
});

describe("sign-in with a wrong password", () => {
  it("is one answer whatever the address is: unknown, unverified, verified, suspended, banned, deletion pending or past", async () => {
    const verified = await verifiedUser();
    const unverified = await signUp(newClient());
    const suspended = await verifiedUser();
    const s = serviceDeps();
    await suspendUser(s.deps, suspended.user.id, "test", SYSTEM_ACTOR);
    await s.settle();
    const banned = await verifiedUser();
    await testDb().update(user).set({ banned: true, banReason: "test" }).where(eq(user.id, banned.user.id));
    const leaving = await verifiedUser();
    const d = serviceDeps();
    await scheduleDeletion(d.deps, leaving.user.id);
    await d.settle();
    const gone = await verifiedUser();
    await testDb()
      .update(user)
      .set({ deleteScheduledAt: new Date(Date.now() - 60_000) })
      .where(eq(user.id, gone.user.id));

    const addresses = {
      unknown: freshEmail(),
      unverified: unverified.email,
      verified: verified.email,
      suspended: suspended.email,
      banned: banned.email,
      "deletion pending": leaving.email,
      "deletion passed": gone.email,
    };
    const outlines: Record<string, unknown> = {};
    for (const [state, email] of Object.entries(addresses)) {
      const before = scryptRuns();
      const sent = await signIn(newClient(), email, "definitely not the password 1");
      expect(sent.status, state).toBe(401);
      expect(sent.body, state).toEqual({
        code: "INVALID_EMAIL_OR_PASSWORD",
        message: "Invalid email or password",
      });
      expect(sent.setCookies, state).toEqual([]);
      // One scrypt run each: a verify against the stored hash, or a hash of the submitted
      // password when there is nothing to verify against.
      expect(scryptRuns() - before, state).toBe(1);
      outlines[state] = outline(sent);
    }
    for (const state of Object.keys(addresses)) expect(outlines[state], state).toEqual(outlines.unknown);
  });

  it("the account's state is told only to somebody who knows the password", async () => {
    const unverified = await signUp(newClient());
    expect((await signIn(newClient(), unverified.email)).status).toBe(403);
    const suspended = await verifiedUser();
    const s = serviceDeps();
    await suspendUser(s.deps, suspended.user.id, "test", SYSTEM_ACTOR);
    await s.settle();
    const told = await signIn(newClient(), suspended.email);
    expect(told.status).toBe(403);
    expect(errorOf(told)?.code).toBe("ACCOUNT_SUSPENDED");
    // An account past its deletion date is gone: even the right password gets the generic answer.
    const gone = await verifiedUser();
    await testDb()
      .update(user)
      .set({ deleteScheduledAt: new Date(Date.now() - 60_000) })
      .where(eq(user.id, gone.user.id));
    const refused = await signIn(newClient(), gone.email);
    expect(refused.status).toBe(401);
    expect(refused.body).toEqual({ code: "INVALID_EMAIL_OR_PASSWORD", message: "Invalid email or password" });
  });
});

describe("asking for mail", () => {
  it("a password reset request answers alike for an address with an account and one without", async () => {
    const existing = await verifiedUser();
    const unknown = freshEmail();
    const ask = (email: string) =>
      send(newClient(), "/api/auth/request-password-reset", {
        json: { email, redirectTo: "/reset-password" },
        headers: CAPTCHA,
      });
    const forExisting = await ask(existing.email);
    const forUnknown = await ask(unknown);
    expect(forExisting.status).toBe(200);
    expect(outline(forUnknown)).toEqual(outline(forExisting));
    expect(forUnknown.body).toEqual(forExisting.body);
    await waitForMail(existing.email, "passwordReset");
    expect(mailTo(unknown)).toEqual([]);
  });

  it("a verification resend answers alike for an unverified, a verified and an unknown address", async () => {
    const unverified = await signUp(newClient());
    const verified = await verifiedUser();
    const unknown = freshEmail();
    const ask = (email: string) =>
      send(newClient(), "/api/auth/send-verification-email", {
        json: { email, callbackURL: "/login?reason=verified" },
        headers: CAPTCHA,
      });
    const answers = [await ask(unverified.email), await ask(verified.email), await ask(unknown)];
    expect(answers[0]!.status).toBe(200);
    for (const answer of answers) {
      expect(outline(answer)).toEqual(outline(answers[0]!));
      expect(answer.body).toEqual(answers[0]!.body);
    }
    await waitForMail(unverified.email, "verification", 2);
    expect(mailTo(unknown)).toEqual([]);
  });
});

describe("the invite lookup", () => {
  it("is about the code alone: one answer for unknown, used up and revoked, and nothing about who was invited", async () => {
    const live = await createInvite();
    const used = await createInvite();
    await signUp(newClient(), { inviteCode: used });
    const revoked = await createInvite({ revokedAt: new Date() });
    expect((await send(newClient(), `/api/invites/${live}`)).body).toEqual({ valid: true });
    const answers = [
      await send(newClient(), `/api/invites/${used}`),
      await send(newClient(), `/api/invites/${revoked}`),
      await send(newClient(), "/api/invites/T-NOSUCHCODE0000000"),
    ];
    for (const answer of answers) {
      expect(answer.body).toEqual({ valid: false });
      expect(outline(answer)).toEqual(outline(answers[0]!));
    }
  });
});
