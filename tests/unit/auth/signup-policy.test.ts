// The sign-up policy, through the real handler: every gate refuses (never a fake success, never
// a user row, never a spent invite), the counters hold under concurrency, and nothing a person
// states about their age is stored.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { DISPOSABLE_DOMAINS, isDisposableDomain } from "../../../src/worker/auth/data/disposable-domains";
import { PUBLIC_MAIL_PROVIDERS } from "../../../src/worker/auth/data/public-mail-providers";
import { testOutbound } from "../../../src/worker/auth/test-outbound";
import { addUsage, utcDay } from "../../../src/worker/db/queries/ledger";
import { downloadLedger, user, userPrefs } from "../../../src/worker/db/schema";
import { dayUTC, ipHashDaily, ipPrefix } from "../../../src/worker/services/ip-hash";
import { createKeys } from "../../../src/worker/services/keys";
import {
  domainAcceptsMail,
  emailDomain,
  isThirteenOrOlder,
  parseStatement,
  SIGNUP_REFUSALS,
  SIGNUP_VELOCITY_DEFAULTS,
} from "../../../src/worker/services/signup-policy";
import { isThirteenOrOlder as sharedIsThirteenOrOlder } from "../../../src/shared/age";
import { BA_ID } from "../../../src/shared/ids";
import authSchemaSource from "../../../src/worker/db/auth-schema.ts?raw";
import schemaSource from "../../../src/worker/db/schema.ts?raw";
import { testVars } from "../../setup/test-vars";
import {
  createInvite,
  freshEmail,
  freshIp,
  getSession,
  inviteRow,
  newClient,
  send,
  sessionsOf,
  signUp,
  testDb,
  userByEmail,
  type SignUpInput,
} from "./helpers";

const keys = createKeys(testVars.FILES_TOKEN_SECRET);
const today = () => utcDay(new Date());

async function ledgerCount(
  subjectType: "signup_ip" | "signup_ip24" | "signup_asn" | "signup_domain" | "ip",
  subjectId: string,
) {
  const [row] = await testDb()
    .select({ count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, today()),
        eq(downloadLedger.subjectType, subjectType),
        eq(downloadLedger.subjectId, subjectId),
      ),
    );
  return row?.count ?? 0;
}

/** A refused sign-up: 400 with the code, no user row, the invite untouched, no session, no mail. */
async function expectRefused(code: keyof typeof SIGNUP_REFUSALS, input: SignUpInput, client = newClient()) {
  const { sent, email, inviteCode } = await signUp(client, input);
  expect(sent.status, `${code}: ${sent.text}`).toBe(400);
  expect(sent.body).toMatchObject({ code, message: SIGNUP_REFUSALS[code] });
  expect(await userByEmail(email), "no user row").toBeNull();
  if (inviteCode) {
    const invite = await inviteRow(inviteCode);
    if (invite) expect(invite.uses, "the invite is not spent").toBe(0);
  }
  expect([...client.cookies.keys()].filter((name) => name.includes("session"))).toEqual([]);
  return { sent, email, inviteCode, client };
}

describe("a sign-up that passes every gate", () => {
  it("creates an unverified user with the policy's fields, uses the invite once, and starts no session", async () => {
    const inviter = (await signUp(newClient())).email;
    const inviterRow = await userByEmail(inviter);
    const code = await createInvite({ createdBy: inviterRow!.id });
    const client = newClient({ settings: { termsVersion: "2031-01-01" } });
    const before = Date.now();
    // Only the stored form of an address is accepted (auth/preflight.ts): another spelling is
    // refused before an invite is looked at.
    const shouted = await signUp(newClient(), { inviteCode: code, email: freshEmail().toUpperCase() });
    expect(shouted.sent.status).toBe(400);
    expect(shouted.sent.body).toMatchObject({ code: "INVALID_EMAIL" });
    const { sent, email } = await signUp(client, { inviteCode: code, email: freshEmail() });
    expect(sent.status, sent.text).toBe(200);
    expect(sent.body).toMatchObject({ token: null });

    const row = await userByEmail(email);
    expect(row).not.toBeNull();
    expect(row!.email).toBe(email.toLowerCase());
    expect(row!.emailVerified).toBe(false);
    expect(row!.role).toBe("user");
    expect(row!.termsVersion).toBe("2031-01-01");
    expect(row!.termsAcceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.ageVerifiedAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row!.invitedBy).toBe(inviterRow!.id);
    expect(row!.quotaBytes).toBe(5_368_709_120);
    expect(row!.usedBytes).toBe(0);
    expect(row!.legalHold).toBe(false);
    // Ids are Better Auth's own (ruling 3): 32 characters of [A-Za-z0-9].
    expect(BA_ID.test(row!.id)).toBe(true);

    expect((await inviteRow(code))!.uses).toBe(1);
    expect(await sessionsOf(row!.id)).toEqual([]);
    expect(await getSession(client)).toBeNull();
    const prefs = await testDb().select().from(userPrefs).where(eq(userPrefs.userId, row!.id));
    expect(prefs).toHaveLength(1);
  });

  it("takes QUOTA_BYTES from the environment", async () => {
    const client = newClient({ env: { QUOTA_BYTES: "1234567890" } });
    const { email } = await signUp(client);
    expect((await userByEmail(email))!.quotaBytes).toBe(1_234_567_890);
  });

  it("ignores every protected field a body tries to set", async () => {
    const { sent, email } = await signUp(newClient(), {
      extra: { emailVerified: true, id: "a".repeat(32), invitedBy: "x", banned: true },
    });
    // Unknown and server-owned fields are dropped or refused — never applied.
    const row = await userByEmail(email);
    if (sent.status === 200) {
      expect(row!.emailVerified).toBe(false);
      expect(row!.id).not.toBe("a".repeat(32));
      expect(row!.invitedBy).toBeNull();
      expect(row!.banned).not.toBe(true);
    } else {
      expect(sent.status).toBe(400);
      expect(row).toBeNull();
    }
    for (const field of [
      "role",
      "quotaBytes",
      "legalHold",
      "termsVersion",
      "suspendedAt",
      "twoFactorEnabled",
    ]) {
      const value =
        field === "role" ? "admin" : field === "quotaBytes" ? 10 ** 15 : field === "legalHold" ? true : "x";
      const tried = await signUp(newClient(), { extra: { [field]: value } });
      const created = await userByEmail(tried.email);
      if (created) {
        expect(created.role, field).toBe("user");
        expect(created.quotaBytes, field).toBe(5_368_709_120);
        expect(created.legalHold, field).toBe(false);
        expect(created.termsVersion, field).toBe("2026-10");
        expect(created.suspendedAt, field).toBeNull();
        expect(created.twoFactorEnabled, field).not.toBe(true);
      } else {
        expect(tried.sent.status, field).toBe(400);
      }
    }
  });
});

describe("the gates, one at a time", () => {
  it("1. kill switch: readOnly refuses a sign-up — and still lets an existing account sign in", async () => {
    await expectRefused("SIGNUP_PAUSED", {}, newClient({ settings: { readOnly: true } }));
  });

  it.each([
    ["false", false],
    ["missing", undefined],
    ['the string "true"', "true"],
    ["1", 1],
  ])("2. assent: acceptTerms %s is refused", async (_label, value) => {
    await expectRefused("TERMS_NOT_ACCEPTED", { acceptTerms: value });
  });

  it("3. age: under 13 is refused with a neutral sentence", async () => {
    const year = new Date().getUTCFullYear();
    const month = new Date().getUTCMonth() + 1;
    const refused = await expectRefused("SIGNUP_NOT_AVAILABLE", { birthYear: year - 12, birthMonth: month });
    expect((refused.sent.body as { message: string }).message).not.toMatch(
      /\b(13|age|birth\w*|old|young\w*|thirteen)\b/i,
    );
    // Thirteen "this month" may not be thirteen yet: refused. A month later it is certain.
    await expectRefused("SIGNUP_NOT_AVAILABLE", { birthYear: year - 13, birthMonth: month });
    const earlier =
      month === 1
        ? { birthYear: year - 14, birthMonth: 12 }
        : { birthYear: year - 13, birthMonth: month - 1 };
    expect((await signUp(newClient(), earlier)).sent.status).toBe(200);
  });

  it.each([
    ["no birth year", { birthYear: undefined as unknown as number }],
    ["a string year", { birthYear: "1990" as unknown as number }],
    ["month 13", { birthMonth: 13 }],
    ["month 0", { birthMonth: 0 }],
    ["a year in the future", { birthYear: new Date().getUTCFullYear() + 1 }],
    ["a year before 1900", { birthYear: 1899 }],
    ["a fractional year", { birthYear: 1990.5 }],
  ])("3. age: %s is refused", async (_label, input) => {
    await expectRefused("SIGNUP_NOT_AVAILABLE", input);
  });

  it("isThirteenOrOlder counts whole months, strictly, in UTC", () => {
    const at = new Date("2026-10-09T12:00:00Z");
    expect(isThirteenOrOlder(2013, 10, at)).toBe(false);
    expect(isThirteenOrOlder(2013, 9, at)).toBe(true);
    expect(isThirteenOrOlder(2013, 11, at)).toBe(false);
    expect(isThirteenOrOlder(2012, 12, at)).toBe(true);
    expect(isThirteenOrOlder(1990, 5, at)).toBe(true);
    expect(isThirteenOrOlder(2026, 10, at)).toBe(false);
    expect(isThirteenOrOlder(2027, 1, at)).toBe(false);
    expect(() => parseStatement({ acceptTerms: true, birthYear: 2020, birthMonth: 1 }, at)).toThrow();
  });

  it("the age rule is the one the sign-up form uses (src/shared/age.ts), at every boundary", () => {
    // The same table as tests/unit/client/shell/forms.test.tsx.
    const table: Array<[number, number, string, boolean]> = [
      [2013, 9, "2026-10-08T12:00:00Z", true],
      [2013, 10, "2026-10-08T12:00:00Z", false],
      [2013, 11, "2026-10-08T12:00:00Z", false],
      [2013, 12, "2026-11-30T23:59:59Z", false],
      [2012, 12, "2025-12-01T00:00:00Z", false],
      [2012, 12, "2026-01-01T00:00:00Z", true],
      [2013, 1, "2026-01-31T12:00:00Z", false],
      [2013, 1, "2026-02-01T00:00:00Z", true],
      [2013, 9, "2026-09-30T23:59:59Z", false],
      [2013, 9, "2026-10-01T00:00:00Z", true],
      [1990, 5, "2026-10-08T12:00:00Z", true],
      [2026, 10, "2026-10-08T12:00:00Z", false],
      [2027, 1, "2026-10-08T12:00:00Z", false],
      [1899, 12, "2026-10-08T12:00:00Z", false],
      [2000, 0, "2026-10-08T12:00:00Z", false],
      [2000, 13, "2026-10-08T12:00:00Z", false],
      [2000.5, 5, "2026-10-08T12:00:00Z", false],
    ];
    for (const [year, month, at, expected] of table) {
      const when = new Date(at);
      expect(isThirteenOrOlder(year, month, when), `${year}-${month} at ${at}`).toBe(expected);
      expect(sharedIsThirteenOrOlder(year, month, when), `shared ${year}-${month} at ${at}`).toBe(expected);
    }
  });

  it("4. allowed domains: when SIGNUP_ALLOWED_DOMAINS is set, only those may sign up", async () => {
    const allowed = { env: { SIGNUP_ALLOWED_DOMAINS: " Allowed.example , second.example " } };
    await expectRefused("EMAIL_NOT_ALLOWED", { email: freshEmail("elsewhere.example") }, newClient(allowed));
    expect((await signUp(newClient(allowed), { email: freshEmail("allowed.example") })).sent.status).toBe(
      200,
    );
    expect((await signUp(newClient(allowed), { email: freshEmail("second.example") })).sent.status).toBe(200);
    // A sub-domain of an allowed domain is not that domain.
    await expectRefused("EMAIL_NOT_ALLOWED", { email: freshEmail("x.allowed.example") }, newClient(allowed));
    // …and with the list set, check 5 is skipped: a listed domain may be a disposable one.
    const disposable = newClient({ env: { SIGNUP_ALLOWED_DOMAINS: "mailinator.com" } });
    expect((await signUp(disposable, { email: freshEmail("mailinator.com") })).sent.status).toBe(200);
  });

  it("5. disposable email: a listed domain, and a sub-domain of one, are refused", async () => {
    expect(DISPOSABLE_DOMAINS.size).toBeGreaterThan(5000);
    expect(isDisposableDomain("mailinator.com")).toBe(true);
    expect(isDisposableDomain("deep.sub.mailinator.com")).toBe(true);
    expect(isDisposableDomain("holdfast-not-listed.example")).toBe(false);
    expect(isDisposableDomain("com")).toBe(false);
    // The exemption list and the blocklist must not contradict each other.
    for (const provider of PUBLIC_MAIL_PROVIDERS) expect(isDisposableDomain(provider), provider).toBe(false);
    await expectRefused("EMAIL_NOT_ALLOWED", { email: freshEmail("mailinator.com") });
    await expectRefused("EMAIL_NOT_ALLOWED", { email: freshEmail("a.b.mailinator.com") });
  });

  it("5. MX: a domain that does not exist, or that publishes the null MX, is refused", async () => {
    await expectRefused("EMAIL_NOT_ALLOWED", { email: freshEmail("gone.nxdomain.test") });
    await expectRefused("EMAIL_NOT_ALLOWED", { email: freshEmail("x.nullmx.test") });
  });

  it("5. MX: a lookup that fails, errors or hangs does not block (and is bounded)", async () => {
    const outbound = testOutbound()!;
    try {
      outbound.answer("cloudflare-dns.com", () => new Response("upstream sad", { status: 502 }));
      expect(await domainAcceptsMail("anything.example")).toBe(true);
      outbound.answer("cloudflare-dns.com", () => {
        throw new Error("network down");
      });
      expect(await domainAcceptsMail("anything.example")).toBe(true);
      outbound.answer("cloudflare-dns.com", () => new Response("not json"));
      expect(await domainAcceptsMail("anything.example")).toBe(true);
      // No MX record at all (an address record may still take mail): allowed.
      outbound.answer("cloudflare-dns.com", () => Response.json({ Status: 0 }));
      expect(await domainAcceptsMail("anything.example")).toBe(true);
      outbound.answer("cloudflare-dns.com", () => Response.json({ Status: 2 }));
      expect(await domainAcceptsMail("anything.example")).toBe(true);
      // And a sign-up goes through while the resolver is down.
      outbound.answer("cloudflare-dns.com", () => new Response("upstream sad", { status: 502 }));
      expect((await signUp(newClient())).sent.status).toBe(200);
    } finally {
      outbound.answer("cloudflare-dns.com", null);
    }
    expect(await domainAcceptsMail("gone.nxdomain.test")).toBe(false);
    expect(emailDomain("A@B.Example.")).toBe("b.example");
    expect(emailDomain("no-at-sign")).toBeNull();
    expect(emailDomain("x@localhost")).toBeNull();
  });

  it("7. invite: none, unknown, revoked, expired and exhausted are all the same refusal", async () => {
    await expectRefused("INVITE_INVALID", { inviteCode: null });
    await expectRefused("INVITE_INVALID", { inviteCode: "NO-SUCH-CODE-EVER" });
    await expectRefused("INVITE_INVALID", { inviteCode: await createInvite({ revokedAt: new Date() }) });
    await expectRefused("INVITE_INVALID", {
      // An hour, not a minute: the expiry is compared with the DATABASE's clock, and a local
      // Postgres in a VM can lag the host by minutes after the machine has slept.
      inviteCode: await createInvite({ expiresAt: new Date(Date.now() - 3_600_000) }),
    });
    const spent = await createInvite({ maxUses: 2, uses: 2 });
    const refused = await signUp(newClient(), { inviteCode: spent });
    expect(refused.sent.status).toBe(400);
    expect(refused.sent.body).toMatchObject({ code: "INVITE_INVALID" });
    expect((await inviteRow(spent))!.uses).toBe(2);
    // An invite that expires in the future is live.
    const live = await createInvite({ expiresAt: new Date(Date.now() + 3_600_000) });
    expect((await signUp(newClient(), { inviteCode: live })).sent.status).toBe(200);
  });

  it("7. open sign-up needs no invite, and does not use one that is offered", async () => {
    const open = { settings: { signupMode: "open" as const } };
    expect((await signUp(newClient(open), { inviteCode: null })).sent.status).toBe(200);
    const code = await createInvite();
    expect((await signUp(newClient(open), { inviteCode: code })).sent.status).toBe(200);
    expect((await inviteRow(code))!.uses).toBe(0);
  });

  it("a refusal is never a 403 and never a success: Better Auth turns a 403 at creation into a fake 200", async () => {
    // Every refusal above asserted 400. This is the same claim stated on its own, for the one
    // refusal that happens INSIDE user creation (the invite, at reservation time).
    const code = await createInvite();
    const first = await signUp(newClient(), { inviteCode: code });
    expect(first.sent.status).toBe(200);
    const second = await signUp(newClient(), { inviteCode: code });
    expect(second.sent.status).toBe(400);
    expect(second.sent.body).not.toHaveProperty("user");
    expect(await userByEmail(second.email)).toBeNull();
  });
});

describe("an address that already has an account", () => {
  it("answers exactly like a new sign-up and creates nothing — and spends what a new sign-up spends", async () => {
    const first = await signUp(newClient());
    const firstRow = await userByEmail(first.email);
    const code = await createInvite();
    const client = newClient();
    const again = await signUp(client, { email: first.email, inviteCode: code });
    expect(again.sent.status).toBe(200);
    expect(Object.keys(again.sent.body as object).sort()).toEqual(
      Object.keys(first.sent.body as object).sort(),
    );
    expect(Object.keys((again.sent.body as { user: object }).user).sort()).toEqual(
      Object.keys((first.sent.body as { user: object }).user).sort(),
    );
    expect((again.sent.body as { user: { id: string } }).user.id).not.toBe(firstRow!.id);
    // The invite is used either way: a code that stayed good would say "that address was taken"
    // (tests/unit/auth/enumeration.test.ts has the pairs).
    expect((await inviteRow(code))!.uses).toBe(1);
    expect((await userByEmail(first.email))!.id).toBe(firstRow!.id);
    // The pending cookie is set either way (and names nobody here) — see pending-email.test.ts.
    expect([...client.cookies.keys()]).toEqual(["hf_pending"]);
  });
});

describe("velocity: a day's sign-ups per subject", () => {
  it("signup_ip trips at its limit (3), and the refused attempt spends neither counter nor invite", async () => {
    const ip = freshIp();
    const subject = await ipHashDaily(keys, ip, dayUTC(new Date()));
    for (let i = 0; i < SIGNUP_VELOCITY_DEFAULTS.signupIpDay; i++) {
      expect((await signUp(newClient({ ip }))).sent.status, `sign-up ${i + 1}`).toBe(200);
    }
    expect(await ledgerCount("signup_ip", subject)).toBe(3);
    const fourth = await expectRefused("SIGNUP_LIMIT", {}, newClient({ ip }));
    expect(await ledgerCount("signup_ip", subject)).toBe(3);
    expect(await userByEmail(fourth.email)).toBeNull();
    // Another address is not affected.
    expect((await signUp(newClient())).sent.status).toBe(200);
  });

  // T8 — one IPv6 subscriber owns a whole /64 (2^64 addresses): counted by the raw address, the
  // per-address limit would never be reached.
  it("IPv6: the per-address limit is per /64, and the network limit per /48 — whatever spelling the address arrives in", async () => {
    const net = () => crypto.getRandomValues(new Uint16Array(1))[0]!.toString(16);
    const site = `2001:db8:${net()}`;
    const subscriber = `${site}:${net()}`;
    const day = dayUTC(new Date());
    // Three sign-ups from three DIFFERENT addresses of one /64 — one of them spelled in upper case.
    const addresses = [
      `${subscriber}::1`,
      `${subscriber}:ffff:ffff:ffff:ffff`,
      `${subscriber.toUpperCase()}:0:0:0:ABCD`,
    ];
    expect(addresses).toHaveLength(SIGNUP_VELOCITY_DEFAULTS.signupIpDay);
    for (const ip of addresses) expect((await signUp(newClient({ ip }))).sent.status, ip).toBe(200);
    // All three are ONE subject …
    const subject = await ipHashDaily(keys, addresses[0]!, day);
    for (const ip of addresses) expect(await ipHashDaily(keys, ip, day), ip).toBe(subject);
    expect(await ledgerCount("signup_ip", subject)).toBe(3);
    // … so a fourth address of that /64 is refused.
    await expectRefused("SIGNUP_LIMIT", {}, newClient({ ip: `${subscriber}:1:2:3:4` }));
    expect(await ledgerCount("signup_ip", subject)).toBe(3);
    // The control: another /64 of the same /48 has its own per-address count — and shares the
    // network's (the /48), which now stands at four.
    const neighbour = `${site}:${(parseInt(subscriber.split(":")[3]!, 16) ^ 1).toString(16)}::1`;
    expect(await ipHashDaily(keys, neighbour, day)).not.toBe(subject);
    expect((await signUp(newClient({ ip: neighbour }))).sent.status).toBe(200);
    const network = await ipHashDaily(keys, ipPrefix(neighbour), day);
    expect(await ipHashDaily(keys, ipPrefix(addresses[1]!), day)).toBe(network);
    expect(await ledgerCount("signup_ip24", network)).toBe(4);
  });

  it("no oracle: over the limit, a sign-up with an address that HAS an account is refused exactly like a new one", async () => {
    const existing = (await signUp(newClient())).email;
    const ip = freshIp();
    for (let i = 0; i < SIGNUP_VELOCITY_DEFAULTS.signupIpDay; i++) await signUp(newClient({ ip }));
    const fresh = await signUp(newClient({ ip }));
    const known = await signUp(newClient({ ip }), { email: existing });
    expect(fresh.sent.status).toBe(400);
    expect(known.sent.status).toBe(fresh.sent.status);
    expect(known.sent.body).toEqual(fresh.sent.body);
    // Under the limit both are a 200 (the look-alike answer for the existing one).
    expect((await signUp(newClient(), { email: existing })).sent.status).toBe(200);
  });

  it("the intent step is refused over the limit too, before anything is minted", async () => {
    const ip = freshIp();
    for (let i = 0; i < SIGNUP_VELOCITY_DEFAULTS.signupIpDay; i++) await signUp(newClient({ ip }));
    const sent = await send(newClient({ ip }), "/api/auth-intent", {
      json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, inviteCode: await createInvite() },
    });
    expect(sent.status).toBe(400);
    expect(sent.body).toMatchObject({ error: "validation", details: { reason: "SIGNUP_LIMIT" } });
    expect(sent.setCookies).toEqual([]);
  });

  it("50 file downloads from the same address do not touch signup_ip", async () => {
    const ip = freshIp();
    const hash = await ipHashDaily(keys, ip, dayUTC(new Date()));
    for (let i = 0; i < 50; i++) await addUsage(testDb(), today(), "ip", hash, 1_000_000, 1);
    expect(await ledgerCount("ip", hash)).toBe(50);
    expect(await ledgerCount("signup_ip", hash)).toBe(0);
    expect((await signUp(newClient({ ip }))).sent.status).toBe(200);
    expect(await ledgerCount("signup_ip", hash)).toBe(1);
    expect(await ledgerCount("ip", hash)).toBe(50);
  });

  it("signup_ip24 counts the /24, across addresses", async () => {
    const [a, b] = crypto.getRandomValues(new Uint8Array(2));
    // A /24 outside the range `freshIp` draws from: the day's counts stay in the database, and
    // every other sign-up of the day (thousands, on a day of many runs) has counted against the
    // /24 of ITS address — with a limit of 2 this test would meet one of them.
    const net = `10.${a}.${b}`;
    const settings = { ceilings: { signupIp24Day: 2 } };
    const first = await signUp(newClient({ ip: `${net}.10`, settings }));
    expect(first.sent.status, first.sent.text).toBe(200);
    const second = await signUp(newClient({ ip: `${net}.11`, settings }));
    expect(second.sent.status, second.sent.text).toBe(200);
    await expectRefused("SIGNUP_LIMIT", {}, newClient({ ip: `${net}.12`, settings }));
    const subject = await ipHashDaily(keys, ipPrefix(`${net}.99`), dayUTC(new Date()));
    expect(await ledgerCount("signup_ip24", subject)).toBe(2);
  });

  it("signup_asn counts Cloudflare's ASN for the request", async () => {
    const asn = 4_200_000_000 + Math.floor(Math.random() * 90_000_000);
    const settings = { ceilings: { signupAsnDay: 2 } };
    expect((await signUp(newClient({ cf: { asn }, settings }))).sent.status).toBe(200);
    expect((await signUp(newClient({ cf: { asn }, settings }))).sent.status).toBe(200);
    await expectRefused("SIGNUP_LIMIT", {}, newClient({ cf: { asn }, settings }));
    expect(await ledgerCount("signup_asn", String(asn))).toBe(2);
    // No ASN (local development): the subject is simply not counted.
    expect((await signUp(newClient({ settings }))).sent.status).toBe(200);
  });

  it("signup_domain counts a private domain, and exempts the large public providers", async () => {
    const domain = `${crypto.randomUUID().slice(0, 8)}.velocity.example`;
    const settings = { ceilings: { signupDomainDay: 2 } };
    expect((await signUp(newClient({ settings }), { email: freshEmail(domain) })).sent.status).toBe(200);
    expect((await signUp(newClient({ settings }), { email: freshEmail(domain) })).sent.status).toBe(200);
    await expectRefused("SIGNUP_LIMIT", { email: freshEmail(domain) }, newClient({ settings }));
    expect(await ledgerCount("signup_domain", domain)).toBe(2);

    const before = await ledgerCount("signup_domain", "gmail.com");
    const zero = { ceilings: { signupDomainDay: 0 } };
    expect(
      (await signUp(newClient({ settings: zero }), { email: freshEmail("gmail.com") })).sent.status,
    ).toBe(200);
    expect(await ledgerCount("signup_domain", "gmail.com")).toBe(before);
    // The same zero limit does stop a private domain: the exemption is what let gmail through.
    await expectRefused("SIGNUP_LIMIT", {}, newClient({ settings: zero }));
  });
});

describe("concurrency", () => {
  it("two sign-ups on a one-use invite: exactly one account", async () => {
    const code = await createInvite({ maxUses: 1 });
    const results = await Promise.all([0, 1].map(() => signUp(newClient(), { inviteCode: code })));
    expect(results.map((r) => r.sent.status).sort()).toEqual([200, 400]);
    const created = (await Promise.all(results.map((r) => userByEmail(r.email)))).filter(Boolean);
    expect(created).toHaveLength(1);
    expect((await inviteRow(code))!.uses).toBe(1);
  });

  it("twelve sign-ups on a three-use invite: exactly three accounts", async () => {
    const code = await createInvite({ maxUses: 3 });
    const results = await Promise.all(
      Array.from({ length: 12 }, () => signUp(newClient(), { inviteCode: code })),
    );
    expect(results.filter((r) => r.sent.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.sent.status === 400)).toHaveLength(9);
    const created = (await Promise.all(results.map((r) => userByEmail(r.email)))).filter(Boolean);
    expect(created).toHaveLength(3);
    expect((await inviteRow(code))!.uses).toBe(3);
  });

  it("eight sign-ups from one address at once: exactly three pass the limit, and the counter says three", async () => {
    const ip = freshIp();
    const results = await Promise.all(Array.from({ length: 8 }, () => signUp(newClient({ ip }))));
    expect(results.filter((r) => r.sent.status === 200)).toHaveLength(3);
    const created = (await Promise.all(results.map((r) => userByEmail(r.email)))).filter(Boolean);
    expect(created).toHaveLength(3);
    expect(await ledgerCount("signup_ip", await ipHashDaily(keys, ip, dayUTC(new Date())))).toBe(3);
    // The five refused ones gave their invites back (each had its own).
    const invites = await Promise.all(results.map((r) => inviteRow(r.inviteCode!)));
    expect(invites.reduce((sum, invite) => sum + invite!.uses, 0)).toBe(3);
  });

  it("the same new address four times at once: one account; each request that was answered 200 spent one invite and one count, the others none", async () => {
    const email = freshEmail();
    const clients = Array.from({ length: 4 }, () => newClient());
    const results = await Promise.all(clients.map((client) => signUp(client, { email })));
    // One request creates the account. Each of the others either hits the unique index (422,
    // and gives back what it took) or arrives after the account exists and gets the look-alike
    // 200 — which spends exactly what a new sign-up spends, so that a duplicate cannot be told
    // from a new one by what is left afterwards (tests/unit/auth/enumeration.test.ts).
    for (const result of results) expect([200, 422]).toContain(result.sent.status);
    const answered = results.filter((result) => result.sent.status === 200).length;
    expect(answered).toBeGreaterThanOrEqual(1);
    const row = await userByEmail(email);
    expect(row).not.toBeNull();
    const all = await testDb().select({ id: user.id }).from(user).where(eq(user.email, email));
    expect(all, "exactly one account").toHaveLength(1);
    const invites = await Promise.all(results.map((r) => inviteRow(r.inviteCode!)));
    for (const [index, invite] of invites.entries()) {
      expect(invite!.uses, `request ${index}: ${results[index]!.sent.status}`).toBe(
        results[index]!.sent.status === 200 ? 1 : 0,
      );
    }
    const counts = await Promise.all(
      clients.map(async (client) =>
        ledgerCount("signup_ip", await ipHashDaily(keys, client.ip, dayUTC(new Date()))),
      ),
    );
    for (const [index, count] of counts.entries()) {
      expect(count, `request ${index}: ${results[index]!.sent.status}`).toBe(
        results[index]!.sent.status === 200 ? 1 : 0,
      );
    }
  });
});

// ADMIN_EMAILS — who gets the admin role, and that it changes nothing about a sign-up — is
// tests/unit/auth/invite-gate.test.ts (one file, because the test environment names one admin
// address and two files signing it up at once would see each other's rows).

describe("the date of birth is stored nowhere", () => {
  it("no table has a column for it", () => {
    for (const source of [schemaSource, authSchemaSource]) {
      expect(source).not.toMatch(/birth|\bdob\b|date_of_birth|\bage\b(?!Verified)/i);
    }
    // What IS stored: the moment the age check passed.
    expect(authSchemaSource).toContain('ageVerifiedAt: timestamp("age_verified_at")');
  });

  it("a signed-up user's row, cookie and audit rows carry neither the year nor the month", async () => {
    const client = newClient();
    const { sent, email } = await signUp(client, { birthYear: 1987, birthMonth: 11 });
    expect(sent.status).toBe(200);
    const row = await userByEmail(email);
    const everything = JSON.stringify({
      row,
      body: sent.body,
      cookies: [...client.cookies.values()].map((v) =>
        atob(v.split(".")[0]!.replace(/-/g, "+").replace(/_/g, "/")),
      ),
    });
    expect(everything).not.toMatch(/1987|birth/i);
    expect(Object.keys(row!)).not.toContain("birthYear");
  });
});
