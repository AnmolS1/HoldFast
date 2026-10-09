// The invite gate has no exemption.
//
// `ADMIN_EMAILS` used to let its addresses sign up without an invite. That answered one request
// two ways — 200 for an admin address, 400 INVITE_INVALID for any other — so anybody could ask
// "is this address an admin?", and an account made that way could then be moved to any address
// through the pending-address route: an uninvited account for whoever asked. The exemption is
// gone: `ADMIN_EMAILS` decides only who is given the admin role at their first VERIFIED session.
//
// Three things are held here:
//  1. without a valid invite, a sign-up for an admin address and for any other address are
//     answered — and cost, and leave behind — exactly the same;
//  2. in invite mode NO path makes a user row without using an invite: email sign-up, Google
//     sign-up, the pending-address change, the change of a verified address;
//  3. a pending-address change applies to the NEW address what a sign-up with it would: it counts
//     on the day's velocity subjects and is refused at a limit — alike whoever the address is.
import { env } from "cloudflare:workers";
import { and, eq, inArray, sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as passwordWork from "../../../src/worker/auth/password";
import { createScope } from "../../../src/worker/auth/scope";
import { testGoogleCode, type TestGoogleProfile } from "../../../src/worker/auth/test-outbound";
import { downloadLedger, invites, user } from "../../../src/worker/db/schema";
import { purgeAuthRows } from "../../../src/worker/services/account-state";
import { dayUTC, ipHashDaily, ipPrefix } from "../../../src/worker/services/ip-hash";
import { createKeys } from "../../../src/worker/services/keys";
import { checkSessionStart, isAdminEmail } from "../../../src/worker/services/signup-policy";
import { testVars } from "../../setup/test-vars";
import {
  CAPTCHA,
  ADMIN_EMAIL,
  auditRows,
  createInvite,
  forgetMailCountOf,
  freshEmail,
  inviteRow,
  linkIn,
  mailTo,
  newClient,
  send,
  signIn,
  signUp,
  testDb,
  userByEmail,
  userById,
  verifiedUser,
  waitForMail,
  type Client,
  type Sent,
  type SignUpInput,
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
const scryptRuns = () =>
  vi.mocked(passwordWork.hashPassword).mock.calls.length +
  vi.mocked(passwordWork.verifyPassword).mock.calls.length;

const keys = createKeys(testVars.FILES_TOKEN_SECRET);
const today = () => dayUTC(new Date());

async function ledgerCount(subjectType: string, subjectId: string): Promise<number> {
  const [row] = await testDb()
    .select({ count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, today()),
        eq(downloadLedger.subjectType, subjectType as "signup_ip"),
        eq(downloadLedger.subjectId, subjectId),
      ),
    );
  return row?.count ?? 0;
}
const ipCount = async (ip: string) => ledgerCount("signup_ip", await ipHashDaily(keys, ip, today()));
const ip24Count = async (ip: string) =>
  ledgerCount("signup_ip24", await ipHashDaily(keys, ipPrefix(ip), today()));
const domainCount = (email: string) => ledgerCount("signup_domain", email.split("@")[1]!.toLowerCase());

/** Headers that differ between any two requests, whatever they are about. */
const PER_REQUEST = new Set(["x-request-id", "date", "content-length", "set-cookie", "cf-ray"]);

/** Everything about an answer a caller could compare. */
function outline(sent: Sent) {
  const headers: Record<string, string> = {};
  sent.headers.forEach((value, name) => {
    if (!PER_REQUEST.has(name)) headers[name] = value;
  });
  return {
    status: sent.status,
    headers,
    cookies: sent.setCookies.map((cookie) => cookie.replace(/^([^=]+)=[^;]*/, "$1=…")).sort(),
    // An error envelope carries the request's own id.
    body:
      sent.body !== null && typeof sent.body === "object" && "requestId" in sent.body
        ? { ...sent.body, requestId: "per request" }
        : sent.body,
  };
}

async function forgetAdmin(): Promise<void> {
  const existing = await userByEmail(ADMIN_EMAIL);
  if (existing) await purgeAuthRows(testDb(), existing.id);
  await forgetMailCountOf(ADMIN_EMAIL);
  // The admin address's domain is counted like any private domain (50 sign-ups a day), and the
  // local database keeps the day's counts across runs: start each group from zero. Only this
  // file signs up addresses at that domain.
  await testDb()
    .delete(downloadLedger)
    .where(
      and(
        eq(downloadLedger.subjectType, "signup_domain"),
        eq(downloadLedger.subjectId, ADMIN_EMAIL.split("@")[1]!),
      ),
    );
}

const change = (client: Client, email: unknown) =>
  send(client, "/api/account/pending-email", { headers: CAPTCHA, method: "PATCH", json: { email } });

// ── Google, as in google.test.ts ────────────────────────────────────────────────────────────
const profileFor = (email: string): TestGoogleProfile => ({
  sub: `g-${crypto.randomUUID()}`,
  email,
  name: "Gina Google",
});

async function intent(client: Client, inviteCode: string | null) {
  return send(client, "/api/auth-intent", {
    json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, ...(inviteCode ? { inviteCode } : {}) },
  });
}

async function googleRoundTrip(client: Client, profile: TestGoogleProfile) {
  const start = await send(client, "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
  });
  expect(start.status, start.text).toBe(200);
  const state = new URL((start.body as { url: string }).url).searchParams.get("state")!;
  return send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
}

beforeEach(() => {
  vi.mocked(passwordWork.hashPassword).mockClear();
  vi.mocked(passwordWork.verifyPassword).mockClear();
});

describe("without a valid invite: an ADMIN_EMAILS address and any other address", () => {
  beforeAll(forgetAdmin);

  const cases: Array<{ what: string; invite: () => Promise<string | null> }> = [
    { what: "no invite", invite: async () => null },
    { what: "an unknown code", invite: async () => "T-NOSUCHCODE0000000" },
    { what: "a revoked code", invite: () => createInvite({ revokedAt: new Date() }) },
    { what: "an expired code", invite: () => createInvite({ expiresAt: new Date(Date.now() - 3_600_000) }) },
    { what: "a used-up code", invite: () => createInvite({ maxUses: 2, uses: 2 }) },
  ];

  it.each(cases)("$what: the same answer, the same cost, and nothing left behind", async ({ invite }) => {
    type Observed = {
      answer: ReturnType<typeof outline>;
      scrypt: number;
      mails: number;
      userRow: boolean;
      ip: number;
      ip24: number;
      domain: number;
      inviteUses: number | null;
      sessionCookies: string[];
      pendingCookie: boolean;
    };
    const observe = async (email: string): Promise<Observed> => {
      const client = newClient();
      const inviteCode = await invite();
      const usesBefore = inviteCode ? ((await inviteRow(inviteCode))?.uses ?? null) : null;
      const mailsBefore = mailTo(email).length;
      const runsBefore = scryptRuns();
      // Another test may have signed this domain up today: what THIS request took is the delta.
      const domainBefore = await domainCount(email);
      const ipBefore = await ipCount(client.ip);
      const ip24Before = await ip24Count(client.ip);
      const { sent } = await signUp(client, { email, inviteCode });
      const usesAfter = inviteCode ? ((await inviteRow(inviteCode))?.uses ?? null) : null;
      expect(usesAfter, "the invite's count did not move").toBe(usesBefore);
      return {
        answer: outline(sent),
        scrypt: scryptRuns() - runsBefore,
        mails: mailTo(email).length - mailsBefore,
        userRow: (await userByEmail(email)) !== null,
        ip: (await ipCount(client.ip)) - ipBefore,
        ip24: (await ip24Count(client.ip)) - ip24Before,
        domain: (await domainCount(email)) - domainBefore,
        inviteUses: usesAfter,
        sessionCookies: [...client.cookies.keys()].filter((name) => name.includes("session")),
        pendingCookie: client.cookies.has("hf_pending"),
      };
    };

    const other = await observe(freshEmail());
    const admin = await observe(ADMIN_EMAIL);
    // Another spelling is not "the same address" to anything here: only the stored form is
    // accepted at all (auth/preflight.ts) — refused for free, like any malformed address.
    const adminSpelled = await observe(ADMIN_EMAIL.toUpperCase());
    expect(adminSpelled.answer.status).toBe(400);
    expect(adminSpelled.answer.body).toMatchObject({ code: "INVALID_EMAIL" });

    expect(other.answer.status).toBe(400);
    expect(other.answer.body).toMatchObject({ code: "INVITE_INVALID" });
    for (const [label, seen] of [["the admin address", admin]] as const) {
      expect(seen.answer, label).toEqual(other.answer);
      expect(seen, label).toEqual(other);
    }
    // And what "the same" is: refused before any hashing, no mail, no row, no count, no cookie.
    expect(other).toMatchObject({
      scrypt: 0,
      mails: 0,
      userRow: false,
      ip: 0,
      ip24: 0,
      domain: 0,
      sessionCookies: [],
      pendingCookie: false,
    });
  });

  it("the intent step and a Google sign-up without an invite are refused for an admin address like any other", async () => {
    const outcomes: Array<{ intentStatus: number; reason: unknown; location: string; row: boolean }> = [];
    for (const email of [freshEmail(), ADMIN_EMAIL]) {
      const client = newClient();
      const stated = await intent(client, null);
      const callback = await googleRoundTrip(client, profileFor(email));
      const location = new URL(callback.headers.get("location") ?? "/", "http://localhost");
      outcomes.push({
        intentStatus: stated.status,
        reason: (stated.body as { details?: { reason?: unknown } }).details?.reason,
        location: `${location.pathname}?error=${location.searchParams.get("error")}`,
        row: (await userByEmail(email)) !== null,
      });
    }
    expect(outcomes[0]).toEqual({
      intentStatus: 400,
      reason: "INVITE_INVALID",
      location: "/signup?error=SIGNUP_INTENT_REQUIRED",
      row: false,
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  });
});

describe("the admin bootstrap: an invite like anyone's, the role at the first verified session", () => {
  beforeAll(forgetAdmin);

  it("an ADMIN_EMAILS address signs up with an invite, is a plain user until it has verified AND signed in, then an admin — once", async () => {
    await forgetAdmin();
    const code = await createInvite({ note: "first admin" });
    const client = newClient();
    const { sent } = await signUp(client, { email: ADMIN_EMAIL, inviteCode: code });
    expect(sent.status, sent.text).toBe(200);
    expect((await inviteRow(code))!.uses).toBe(1);
    const unverified = await userByEmail(ADMIN_EMAIL);
    expect(unverified).toMatchObject({ emailVerified: false, role: "user" });
    // A correct password before verification starts no session and grants nothing.
    expect((await signIn(newClient(), ADMIN_EMAIL)).status).toBe(403);
    expect((await userById(unverified!.id))!.role).toBe("user");

    // The verification click signs the browser that signed up in — and grants nothing: a click
    // proves a mailbox, not a credential (auth/mailbox-proof.ts).
    expect((await send(client, linkIn(await waitForMail(ADMIN_EMAIL, "verification")))).status).toBe(302);
    const row = await userByEmail(ADMIN_EMAIL);
    expect(row).toMatchObject({ emailVerified: true, role: "user" });
    expect(await auditRows({ action: "auth.admin_granted", targetId: row!.id })).toHaveLength(0);

    // The role comes with the first SIGN-IN of the verified address — once.
    await send(client, "/api/auth/sign-out", { json: {} });
    expect((await signIn(client, ADMIN_EMAIL)).status).toBe(200);
    expect((await userByEmail(ADMIN_EMAIL))!.role).toBe("admin");
    expect(await auditRows({ action: "auth.admin_granted", targetId: row!.id })).toHaveLength(1);
    await send(client, "/api/auth/sign-out", { json: {} });
    expect((await signIn(client, ADMIN_EMAIL)).status).toBe(200);
    expect(await auditRows({ action: "auth.admin_granted", targetId: row!.id })).toHaveLength(1);
    await purgeAuthRows(testDb(), row!.id);
  });

  it("an unverified account moved ONTO an admin address is not an admin, and cannot become one without that mailbox", async () => {
    await forgetAdmin();
    const client = newClient();
    const { email } = await signUp(client);
    const row = await userByEmail(email);
    expect((await change(client, ADMIN_EMAIL)).status).toBe(200);
    const moved = await userById(row!.id);
    expect(moved).toMatchObject({ email: ADMIN_EMAIL, emailVerified: false, role: "user" });
    // The only link that verifies it was mailed to the admin address, not to this browser.
    expect((await signIn(newClient(), ADMIN_EMAIL)).status).toBe(403);
    expect((await userById(row!.id))!.role).toBe("user");
    expect(await auditRows({ action: "auth.admin_granted", targetId: row!.id })).toHaveLength(0);
    await purgeAuthRows(testDb(), row!.id);
    await forgetMailCountOf(ADMIN_EMAIL);
  });
});

describe("ADMIN_EMAILS grants the role, and only that", () => {
  beforeAll(forgetAdmin);

  it("the role is granted only to a VERIFIED admin address, and never through an impersonated session", async () => {
    const existing = await userByEmail(ADMIN_EMAIL);
    if (existing) await purgeAuthRows(testDb(), existing.id);
    const scope = createScope(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} });
    const roleOf = async (id: string) =>
      (await testDb().select({ role: user.role }).from(user).where(eq(user.id, id)))[0]!.role;
    const { sent } = await signUp(newClient(), { email: ADMIN_EMAIL });
    expect(sent.status).toBe(200);
    const row = await userByEmail(ADMIN_EMAIL);

    // Unverified: a session start (were one possible) grants nothing.
    await checkSessionStart(scope, row!.id, false);
    expect(await roleOf(row!.id)).toBe("user");
    // Verified, but the session being started is an admin impersonating this account: nothing.
    await testDb().update(user).set({ emailVerified: true }).where(eq(user.id, row!.id));
    await checkSessionStart(scope, row!.id, true);
    expect(await roleOf(row!.id)).toBe("user");
    // Verified, its own session: granted.
    await checkSessionStart(scope, row!.id, false);
    expect(await roleOf(row!.id)).toBe("admin");
    // Any other verified account: never.
    const other = await signUp(newClient());
    const otherRow = await userByEmail(other.email);
    await testDb().update(user).set({ emailVerified: true }).where(eq(user.id, otherRow!.id));
    await checkSessionStart(scope, otherRow!.id, false);
    expect(await roleOf(otherRow!.id)).toBe("user");
    await purgeAuthRows(testDb(), row!.id);
  });

  it("matches the whole address, case-insensitively, and nothing else", () => {
    const list = { ADMIN_EMAILS: ` ${ADMIN_EMAIL.toUpperCase()} , second@example.test,, ` };
    for (const address of [ADMIN_EMAIL, ADMIN_EMAIL.toUpperCase(), "second@example.test"]) {
      expect(isAdminEmail(list, address), address).toBe(true);
    }
    // The stored address is compared as stored: surrounding space is another string.
    expect(isAdminEmail(list, ` ${ADMIN_EMAIL} `)).toBe(false);
    for (const address of [
      `x${ADMIN_EMAIL}`,
      ADMIN_EMAIL.replace("@", "+tag@"),
      `${ADMIN_EMAIL}.evil.example`,
      ADMIN_EMAIL.split("@")[1]!,
      "",
    ]) {
      expect(isAdminEmail(list, address), address).toBe(false);
    }
    expect(isAdminEmail({ ADMIN_EMAILS: "" }, "")).toBe(false);
  });

  it("E2E_ADMIN_EMAILS replaces the list in TEST MODE only, and only with reserved test domains", () => {
    const real = "owner@real-company.com";
    const testMode = {
      ADMIN_EMAILS: real,
      EMAIL_TRANSPORT: "memory",
      SENTRY_ENVIRONMENT: "test",
      APP_ORIGIN: "http://localhost:5173",
    };
    const e2e = "admin@holdfast-e2e.example";
    // Test mode + the var: the e2e address is the admin, the real one is NOT (a test run never
    // makes an account for an operator's real address).
    expect(isAdminEmail({ ...testMode, E2E_ADMIN_EMAILS: `${e2e}, second@run.test` }, e2e)).toBe(true);
    expect(
      isAdminEmail({ ...testMode, E2E_ADMIN_EMAILS: `${e2e}, second@run.test` }, "second@run.test"),
    ).toBe(true);
    expect(isAdminEmail({ ...testMode, E2E_ADMIN_EMAILS: e2e }, real)).toBe(false);
    // Without the var (ordinary local development): ADMIN_EMAILS as ever.
    expect(isAdminEmail(testMode, real)).toBe(true);
    expect(isAdminEmail({ ...testMode, E2E_ADMIN_EMAILS: "" }, real)).toBe(true);
    // Not test mode — each of its three conditions alone: the var is ignored.
    for (const off of [
      { APP_ORIGIN: "https://holdfast.example" },
      { EMAIL_TRANSPORT: "resend" },
      { SENTRY_ENVIRONMENT: "production" },
    ]) {
      const env = { ...testMode, ...off, E2E_ADMIN_EMAILS: e2e };
      expect(isAdminEmail(env, e2e), JSON.stringify(off)).toBe(false);
      expect(isAdminEmail(env, real), JSON.stringify(off)).toBe(true);
    }
    // An address outside the reserved test domains (.example, .test) is never taken from it.
    const hostile = { ...testMode, E2E_ADMIN_EMAILS: `attacker@gmail.com, x@evil.example.com, ${e2e}` };
    expect(isAdminEmail(hostile, "attacker@gmail.com")).toBe(false);
    expect(isAdminEmail(hostile, "x@evil.example.com")).toBe(false);
    expect(isAdminEmail(hostile, e2e)).toBe(true);
    // No wildcard, in any mode — not even in the e2e var at a reserved domain: `*@domain` is not an
    // address, so it is ignored and grants nothing (tests/unit/auth/admin-emails.test.ts).
    const wild = { ...testMode, E2E_ADMIN_EMAILS: "*@admins.run.example, *@gmail.com" };
    expect(isAdminEmail(wild, "anyone@admins.run.example")).toBe(false);
    expect(isAdminEmail(wild, "*@admins.run.example")).toBe(false);
    expect(isAdminEmail({ ...testMode, ADMIN_EMAILS: "*@real-company.com" }, "ceo@real-company.com")).toBe(
      false,
    );
  });

  it("no test reads ADMIN_EMAILS out of .dev.vars (the e2e admin is a test-domain address from test vars)", async () => {
    const sources = {
      ...import.meta.glob("../../setup/**/*.ts", { query: "?raw", import: "default", eager: true }),
      ...import.meta.glob("../../e2e/**/*.ts", { query: "?raw", import: "default", eager: true }),
    };
    expect(Object.keys(sources).length).toBeGreaterThan(5);
    // Code only: a comment may say what is not done.
    const code = (text: string) =>
      text
        .split("\n")
        .filter((line) => !/^\s*(?:\/\/|\*|\/\*)/.test(line))
        .join("\n");
    const offenders = Object.entries(sources)
      .filter(([, text]) =>
        /ADMIN_EMAILS/.test(code(text).replace(/E2E_ADMIN_EMAILS?|HOLDFAST_E2E_ADMIN_EMAILS/g, "")),
      )
      // The Workers project's own explicit value (a test-domain address) is the one definition.
      .filter(([file]) => !file.endsWith("/setup/test-vars.ts"))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });
});

describe("invite mode: no path makes a user row without using an invite", () => {
  /** An inviter of this test's own, so "their" invites and invitees can be counted exactly. */
  async function inviter() {
    const { user: row } = await verifiedUser();
    const invitees = async () =>
      (await testDb().select({ id: user.id }).from(user).where(eq(user.invitedBy, row.id))).map((r) => r.id);
    const uses = async () => {
      const [sum] = await testDb()
        .select({ uses: sql<number>`coalesce(sum(${invites.uses}), 0)::int` })
        .from(invites)
        .where(eq(invites.createdBy, row.id));
      return sum!.uses;
    };
    const invite = (overrides: Partial<typeof invites.$inferInsert> = {}) =>
      createInvite({ createdBy: row.id, ...overrides });
    /** The invariant: every account this inviter's codes admitted used one, and nothing else exists. */
    const expectBalanced = async (accounts: number) => {
      expect(await uses(), "invites used").toBe(accounts);
      expect(await invitees(), "accounts admitted").toHaveLength(accounts);
    };
    return { id: row.id, invite, invitees, uses, expectBalanced };
  }

  const rowsFor = async (emails: string[]) =>
    testDb()
      .select({ id: user.id, email: user.email, invitedBy: user.invitedBy })
      .from(user)
      .where(
        inArray(
          user.email,
          emails.map((email) => email.toLowerCase()),
        ),
      );

  beforeAll(forgetAdmin);

  it("email sign-up: with an invite one row and one use; without one, no row — for any address, an admin's included", async () => {
    const from = await inviter();
    const code = await from.invite();
    const invited = await signUp(newClient(), { inviteCode: code });
    expect(invited.sent.status).toBe(200);
    expect((await userByEmail(invited.email))!.invitedBy).toBe(from.id);
    await from.expectBalanced(1);

    const tried: string[] = [];
    const attempts: SignUpInput[] = [
      { inviteCode: null },
      { inviteCode: null, email: ADMIN_EMAIL },
      { inviteCode: code }, // used up
      { inviteCode: code, email: ADMIN_EMAIL },
      { inviteCode: await from.invite({ revokedAt: new Date() }) },
      { inviteCode: await from.invite({ expiresAt: new Date(Date.now() - 3_600_000) }), email: ADMIN_EMAIL },
    ];
    for (const input of attempts) {
      const { sent, email } = await signUp(newClient(), input);
      expect(sent.status, JSON.stringify(input)).toBe(400);
      tried.push(email);
    }
    expect(await rowsFor(tried)).toEqual([]);
    await from.expectBalanced(1);
  });

  it("Google sign-up: with the intent one row and one use; without an invite in the intent, or without the intent, no row", async () => {
    const from = await inviter();
    const code = await from.invite();
    const client = newClient();
    const email = freshEmail();
    expect((await intent(client, code)).status).toBe(200);
    expect(await from.uses(), "stating the intent uses nothing").toBe(0);
    expect((await googleRoundTrip(client, profileFor(email))).headers.get("location")).toBe("/");
    expect((await userByEmail(email))!.invitedBy).toBe(from.id);
    await from.expectBalanced(1);

    const tried: string[] = [];
    for (const address of [freshEmail(), ADMIN_EMAIL]) {
      // No intent at all.
      const bare = await googleRoundTrip(newClient(), profileFor(address));
      expect(bare.headers.get("location")).toMatch(/error=SIGNUP_INTENT_REQUIRED/);
      // An intent refused for want of an invite sets no cookie, so the callback has none either.
      const withoutInvite = newClient();
      expect((await intent(withoutInvite, null)).status).toBe(400);
      expect(withoutInvite.cookies.has("hf_intent")).toBe(false);
      const refused = await googleRoundTrip(withoutInvite, profileFor(address));
      expect(refused.headers.get("location")).toMatch(/error=SIGNUP_INTENT_REQUIRED/);
      // The used intent replayed for another address.
      const replay = await googleRoundTrip(client, profileFor(address));
      expect(replay.headers.get("location")).toMatch(/error=/);
      tried.push(address);
    }
    expect(await rowsFor(tried)).toEqual([]);
    await from.expectBalanced(1);
  });

  it("the pending-address change moves the ONE invited row — it never makes a second account, with or without the cookie's account existing", async () => {
    const from = await inviter();
    const client = newClient();
    const { email } = await signUp(client, { inviteCode: await from.invite() });
    const row = await userByEmail(email);
    const next = freshEmail();
    expect((await change(client, next)).status).toBe(200);
    expect(await rowsFor([email, next])).toEqual([{ id: row!.id, email: next, invitedBy: from.id }]);
    await from.expectBalanced(1);

    // A look-alike sign-up (the address already has an account) spends an invite like a real one,
    // and its cookie names nobody: a change with it creates nothing anywhere.
    const impostor = newClient();
    const spent = await from.invite();
    expect((await signUp(impostor, { email: next, inviteCode: spent })).sent.status).toBe(200);
    const elsewhere = freshEmail();
    expect((await change(impostor, elsewhere)).status).toBe(200);
    expect(await rowsFor([elsewhere])).toEqual([]);
    expect((await userById(row!.id))!.email).toBe(next);
    // Two invites used, one account: an invite can be spent for nothing, never the reverse.
    expect(await from.uses()).toBe(2);
    expect(await from.invitees()).toEqual([row!.id]);

    // Without any cookie: refused, nothing made.
    const cold = freshEmail();
    expect((await change(newClient(), cold)).status).toBe(403);
    expect(await rowsFor([cold])).toEqual([]);
  });

  it("changing a VERIFIED address makes no second account and uses no invite", async () => {
    const from = await inviter();
    const member = await verifiedUser({ inviteCode: await from.invite() });
    const next = freshEmail();
    const asked = await send(member.client, "/api/auth/change-email", {
      json: { newEmail: next, callbackURL: "/" },
    });
    expect(asked.status, asked.text).toBe(200);
    // Nothing exists at the new address until its owner confirms; the one account is the same row.
    expect(await rowsFor([next])).toEqual([]);
    expect(await rowsFor([member.email])).toEqual([
      { id: member.user.id, email: member.email, invitedBy: from.id },
    ]);
    await from.expectBalanced(1);
    // An address that belongs to an admin, or to anyone: the same request, still no row made.
    const toAdmin = await send(member.client, "/api/auth/change-email", {
      json: { newEmail: ADMIN_EMAIL, callbackURL: "/" },
    });
    expect(toAdmin.status).toBe(asked.status);
    expect(await userByEmail(ADMIN_EMAIL)).toBeNull();
    expect((await userById(member.user.id))!.role).toBe("user");
    await from.expectBalanced(1);
  });
});

describe("a pending-address change is held to what a sign-up with the new address would be", () => {
  it("counts on every velocity subject of the new address, the domain included", async () => {
    const client = newClient();
    await signUp(client);
    expect(await ipCount(client.ip)).toBe(1);
    const next = freshEmail();
    expect(await domainCount(next)).toBe(0);
    // (The /24 is counted as a DIFFERENCE: 16 384 test /24s are shared by every client any test
    // file has made today, so another client may sit in this one — the address itself is unique.)
    const in24 = await ip24Count(client.ip);
    expect(in24).toBeGreaterThanOrEqual(1);
    expect((await change(client, next)).status).toBe(200);
    expect(await ipCount(client.ip)).toBe(2);
    expect(await ip24Count(client.ip)).toBe(in24 + 1);
    expect(await domainCount(next)).toBe(1);
    // The same address again is not a change: nothing is taken.
    expect((await change(client, next)).status).toBe(200);
    expect(await ipCount(client.ip)).toBe(2);
    // A large public provider's domain is not counted, as at sign-up.
    const atGmail = freshEmail("gmail.com");
    expect((await change(client, atGmail)).status).toBe(200);
    expect(await domainCount(atGmail)).toBe(0);
    expect(await ipCount(client.ip)).toBe(3);
  });

  it("is refused at the day's limit — 429, nothing moved, nobody mailed", async () => {
    // The default: three sign-ups a day from one address. The sign-up is one, two changes more.
    const client = newClient();
    const { email } = await signUp(client);
    const row = await userByEmail(email);
    const second = freshEmail();
    const third = freshEmail();
    expect((await change(client, second)).status).toBe(200);
    expect((await change(client, third)).status).toBe(200);
    const fourth = freshEmail();
    const refused = await change(client, fourth);
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: "rate_limited", details: { reason: "SIGNUP_LIMIT" } });
    expect((await userById(row!.id))!.email).toBe(third);
    expect(mailTo(fourth)).toEqual([]);
    expect(await ipCount(client.ip), "a refused change takes nothing").toBe(3);
    expect(await domainCount(fourth)).toBe(0);
    // And a NEW sign-up from that address is refused too: the budget is one budget.
    const again = await signUp(newClient({ ip: client.ip }));
    expect(again.sent.status).toBe(400);
    expect(again.sent.body).toMatchObject({ code: "SIGNUP_LIMIT" });
  });

  it("the new address's DOMAIN is held to its own limit", async () => {
    const domain = `${crypto.randomUUID().slice(0, 8)}.holdfast-test.example`;
    const settings = { ceilings: { signupDomainDay: 1 } };
    expect((await signUp(newClient({ settings }), { email: freshEmail(domain) })).sent.status).toBe(200);
    const client = newClient({ settings });
    const { email } = await signUp(client);
    const refused = await change(client, freshEmail(domain));
    expect(refused.status).toBe(429);
    expect((await userByEmail(email))!.email).toBe(email);
    expect(await domainCount(`x@${domain}`)).toBe(1);
    // Control: another domain passes under the same ceiling.
    expect((await change(client, freshEmail())).status).toBe(200);
  });

  it("no oracle: a change costs and answers the same whether it moved an account, named nobody, or hit someone's address", async () => {
    const owner = await verifiedUser();
    type Seen = { answer: ReturnType<typeof outline>; taken: number; mailsToTarget: number };
    const run = async (client: Client, target: string): Promise<Seen> => {
      const before = await ipCount(client.ip);
      const mailsBefore = mailTo(target).length;
      const sent = await change(client, target);
      return {
        answer: outline(sent),
        taken: (await ipCount(client.ip)) - before,
        mailsToTarget: mailTo(target).length - mailsBefore,
      };
    };
    // (a) an ordinary sign-up moving its own account to a free address;
    const honest = newClient();
    await signUp(honest);
    const moved = await run(honest, freshEmail());
    // (b) a look-alike sign-up (its cookie names nobody) "moving" to a free address;
    const impostor = newClient();
    await signUp(impostor, { email: owner.email });
    const nobody = await run(impostor, freshEmail());
    // (c) an ordinary sign-up asking for an address that belongs to someone.
    const prober = newClient();
    const probing = await signUp(prober);
    const taken = await run(prober, owner.email);

    expect(moved.answer.status).toBe(200);
    expect(nobody.answer).toEqual(moved.answer);
    expect(taken.answer).toEqual(moved.answer);
    expect([moved.taken, nobody.taken, taken.taken]).toEqual([1, 1, 1]);
    // Only (a) mails the new address; the owner of (c) hears nothing from this route.
    expect([moved.mailsToTarget, nobody.mailsToTarget, taken.mailsToTarget]).toEqual([1, 0, 0]);
    expect((await userById(owner.user.id))!.email).toBe(owner.email);
    expect((await userByEmail(probing.email))!.email).toBe(probing.email);

    // At the limit all three are refused alike, before any account is looked at.
    const settings = { ceilings: { signupIpDay: 1 } };
    const refusals: Sent[] = [];
    for (const [signupEmail, target] of [
      [undefined, freshEmail()],
      [owner.email, freshEmail()],
      [undefined, owner.email],
    ] as const) {
      const client = newClient({ settings });
      expect((await signUp(client, { email: signupEmail })).sent.status).toBe(200);
      refusals.push(await change(client, target));
    }
    expect(refusals[0]!.status).toBe(429);
    expect(outline(refusals[1]!)).toEqual(outline(refusals[0]!));
    expect(outline(refusals[2]!)).toEqual(outline(refusals[0]!));
  });

  it("the cookie is one sign-up's, for one hour, and worth nothing once the account is verified", async () => {
    // Bound to the user id: another sign-up's cookie cannot move this account (its `u` is its own).
    const mine = newClient();
    const { email } = await signUp(mine);
    const row = await userByEmail(email);
    const theirs = newClient();
    await signUp(theirs);
    const payloadOf = (client: Client) =>
      JSON.parse(
        atob(client.cookies.get("hf_pending")!.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
      ) as {
        u: string;
        m: string;
        e: number;
      };
    expect(payloadOf(mine).u).toBe(row!.id);
    expect(payloadOf(theirs).u).not.toBe(row!.id);
    expect(payloadOf(mine).e - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
    expect(payloadOf(mine).e - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(3600);
    expect((await change(theirs, freshEmail())).status).toBe(200);
    expect((await userById(row!.id))!.email).toBe(email);

    // Verified: the same cookie still answers 200 (no oracle) and moves nothing.
    expect((await send(mine, linkIn(await waitForMail(email, "verification")))).status).toBe(302);
    const after = freshEmail();
    expect((await change(mine, after)).status).toBe(200);
    expect(await userById(row!.id)).toMatchObject({ email, emailVerified: true });
    expect(await userByEmail(after)).toBeNull();
    expect(mailTo(after)).toEqual([]);
  });
});
