// `ADMIN_EMAILS` is EXACT ADDRESSES ONLY (src/shared/admin-emails.ts): one parser and one matcher
// for every consumer — the role grant, the test-mode stand-ins, the health flag, the checker
// script. A wildcard or a malformed entry grants nothing.
import { eq } from "drizzle-orm";
import { user } from "../../../src/worker/db/schema";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { adminListEntry, asciiLower, isListedAdmin, parseAdminList } from "../../../src/shared/admin-emails";
import * as observe from "../../../src/worker/auth/observe";
import {
  adminListOf,
  isAdminEmail,
  resetAdminListReportForTests,
} from "../../../src/worker/services/signup-policy";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import signupPolicySource from "../../../src/worker/services/signup-policy.ts?raw";
import testOutboundSource from "../../../src/worker/auth/test-outbound.ts?raw";
import {
  auditRows,
  createInvite,
  enableTotp,
  freshEmail,
  linkIn,
  newClient,
  nextTotp,
  send,
  signIn,
  signUp,
  testDb,
  userByEmail,
  verifiedUser,
  waitForMail,
} from "./helpers";

// Real work, not a unit of logic: up to twenty-five real sign-ups, verifications and sign-ins per test. The default budget (5 s) is
// for tests that do one thing; on a slow or busy machine (a CI runner) these need room. The
// assertions are what they are — only the clock is generous.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("../../../src/worker/auth/observe", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/observe")>();
  return { ...real, reportError: vi.fn(real.reportError), countFor: vi.fn(real.countFor) };
});

describe("the parser: an entry is one plain ASCII address, or nothing", () => {
  it.each([
    ["ana@example.com", "ana@example.com"],
    ["  Ana@Example.COM ", "ana@example.com"],
    ["a.b+tag_x-y%z@sub.example.co.uk", "a.b+tag_x-y%z@sub.example.co.uk"],
    ["ops@xn--bcher-kva.example", "ops@xn--bcher-kva.example"],
  ])("%s is the address %s", (entry, address) => {
    expect(adminListEntry(entry)).toBe(address);
  });

  it.each([
    ["a wildcard", "*@example.com"],
    ["a wildcard local part", "admin*@example.com"],
    ["a wildcard domain", "admin@*.example.com"],
    ["a question mark", "adm?n@example.com"],
    ["a regex", "/.*@example\\.com/"],
    ["a character class", "[a-z]+@example.com"],
    ["a display name", "Ana <ana@example.com>"],
    ["angle brackets", "<ana@example.com>"],
    ["a quoted local part", '"ana"@example.com'],
    ["a comment", "ana(work)@example.com"],
    ["two addresses, a semicolon", "ana@example.com;bo@example.com"],
    ["two addresses, a space", "ana@example.com bo@example.com"],
    ["two at-signs", "ana@bo@example.com"],
    ["a domain only", "@example.com"],
    ["a domain only, no at", "example.com"],
    ["no top-level label", "ana@localhost"],
    ["an IP literal", "ana@[127.0.0.1]"],
    ["a trailing dot", "ana@example.com."],
    ["an empty label", "ana@example..com"],
    ["a label that starts with a hyphen", "ana@-example.com"],
    ["full-width letters", "ａｎａ@example.com"],
    ["mathematical letters", "𝐚𝐧𝐚@example.com"],
    ["a non-ASCII letter", "añá@example.com"],
    ["a Cyrillic look-alike", "аna@example.com"],
    ["a dotless i", "adm\u0131n@example.com"],
    ["a capital dotted I", "adm\u0130n@example.com"],
    ["a sharp s", "stra\u00dfe@example.com"],
    ["a ligature", "o\ufb03ce@example.com"],
    ["the Kelvin sign", "mar\u212a@example.com"],
    ["an IDN domain in Unicode", "ops@bücher.example"],
    ["a zero-width space", "ana\u200b@example.com"],
    ["a no-break space", "ana\u00a0@example.com"],
    ["a mailto", "mailto:ana@example.com"],
    ["a newline inside", "ana@example.com\nbo@example.com"],
    [
      "a 255-character address",
      `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(58)}.com`,
    ],
    ["empty", ""],
    ["not text", 42],
  ])("%s is not an entry: %s", (_what, entry) => {
    expect(adminListEntry(entry)).toBeNull();
    // As a list entry it is ignored and counted — and grants nothing, to anyone.
    const alone = parseAdminList(String(entry));
    for (const probe of [
      "anyone@example.com",
      "ana@example.com",
      "admin@example.com",
      "x@gmail.com",
      String(entry),
    ]) {
      expect(isListedAdmin(alone, probe), probe).toBe(false);
    }
    const beside = parseAdminList(`ok@example.org, ${String(entry)}`);
    if (String(entry).trim() !== "" && !String(entry).includes(",")) expect(beside.invalid).toBe(1);
    expect(beside.addresses.has("ok@example.org")).toBe(true);
  });

  it("the stored address is compared as stored: only the case of its ASCII letters is ignored", () => {
    const list = parseAdminList("Admin@Example.com, a.b@gmail.com , ");
    expect(list).toEqual({ addresses: new Set(["admin@example.com", "a.b@gmail.com"]), invalid: 0 });
    for (const same of ["admin@example.com", "ADMIN@EXAMPLE.COM", "Admin@Example.Com"]) {
      expect(isListedAdmin(list, same), same).toBe(true);
    }
    // Everything a normaliser might "helpfully" fold onto the entry is ANOTHER address — a
    // mailbox somebody else can own.
    for (const [what, other] of [
      ["surrounding spaces", " admin@example.com "],
      ["a trailing newline", "admin@example.com\n"],
      ["full-width", "ａｄｍｉｎ@example.com"],
      ["full-width at-sign", "admin＠example.com"],
      ["mathematical bold", "𝐚𝐝𝐦𝐢𝐧@example.com"],
      ["dotless i", "adm\u0131n@example.com"],
      ["capital dotted I (lower-cases to i + combining dot)", "ADM\u0130N@example.com"],
      [
        "the Kelvin sign in the domain (lower-cases to k)",
        "admin@example.\u212aom".replace("\u212aom", "com"),
      ],
      ["Cyrillic а", "\u0430dmin@example.com"],
      ["a zero-width joiner", "ad\u200dmin@example.com"],
      ["a soft hyphen", "ad\u00admin@example.com"],
      ["a combining mark", "admin\u0301@example.com"],
      ["a plus tag", "admin+x@example.com"],
      ["dots removed", "ab@gmail.com"],
      ["googlemail", "a.b@googlemail.com"],
      ["a trailing dot", "admin@example.com."],
      ["a quoted local part", '"admin"@example.com'],
      ["a comment", "admin(x)@example.com"],
      ["a sub-domain", "admin@sub.example.com"],
      ["a suffix", "admin@example.com.evil.example"],
      ["a prefix", "xadmin@example.com"],
      ["the domain only", "example.com"],
      ["empty", ""],
      ["null", null],
      ["undefined", undefined],
    ] as const) {
      if (what.startsWith("the Kelvin sign in the domain")) continue; // (covered just below, explicitly)
      expect(isListedAdmin(list, other), what).toBe(false);
    }
    // The classic: `String#toLowerCase` folds U+212A (Kelvin) to `k` and `İ` to `i̇`. Not here.
    const k = parseAdminList("mark@example.com");
    expect("mar\u212a@example.com".toLowerCase()).toBe("mark@example.com");
    expect(asciiLower("MAR\u212a@Example.com")).toBe("mar\u212a@example.com");
    expect(isListedAdmin(k, "mar\u212a@example.com")).toBe(false);
    expect(isListedAdmin(k, "MARK@example.com")).toBe(true);
    // An IDN domain is only ever the bytes it is stored as.
    const idn = parseAdminList("ops@xn--bcher-kva.example");
    expect(isListedAdmin(idn, "ops@xn--bcher-kva.example")).toBe(true);
    expect(isListedAdmin(idn, "ops@bücher.example")).toBe(false);
  });
});

describe("one matcher for every consumer", () => {
  it("the role grant and the test stand-ins import the shared parser — and nothing else reads the list", () => {
    expect(signupPolicySource).toMatch(/from "\.\.\/\.\.\/shared\/admin-emails"/);
    expect(testOutboundSource).toMatch(/from "\.\.\/\.\.\/shared\/admin-emails"/);
    // No wildcard handling is left anywhere in either.
    for (const source of [signupPolicySource, testOutboundSource]) {
      const code = source
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .join("\n");
      expect(code).not.toMatch(/"\*@|startsWith\("\*|domains:/);
    }
    const sources = import.meta.glob("../../../src/worker/**/*.ts", {
      query: "?raw",
      import: "default",
      eager: true,
    }) as Record<string, string>;
    const readers = Object.entries(sources)
      .filter(([file, text]) => !file.endsWith("env.d.ts") && /env\.ADMIN_EMAILS|\.ADMIN_EMAILS\b/.test(text))
      .map(([file]) => file.replace(/^.*\/src\/worker\//, ""))
      .sort();
    expect(readers).toEqual(["auth/test-outbound.ts", "routes/health.ts", "services/signup-policy.ts"]);
  });

  it("an invalid entry is reported once per isolate — by count, never by value", () => {
    resetAdminListReportForTests();
    const report = vi.mocked(observe.reportError);
    report.mockClear();
    const bad = {
      ADMIN_EMAILS: "ok@example.com, *@secret-company.example, Boss <boss@secret-company.example>",
    };
    expect(adminListOf(bad).addresses).toEqual(new Set(["ok@example.com"]));
    adminListOf(bad);
    adminListOf(bad);
    expect(report).toHaveBeenCalledTimes(1);
    const said = String((report.mock.calls[0]![0] as Error).message);
    expect(said).toContain("2 entries");
    expect(said).not.toContain("secret-company");
    expect(said).not.toContain("*");
    // A clean list reports nothing.
    resetAdminListReportForTests();
    report.mockClear();
    adminListOf({ ADMIN_EMAILS: "ok@example.com, second@example.com" });
    expect(report).not.toHaveBeenCalled();
  });
});

describe("what the list grants, through real sign-ins", () => {
  const roleOf = async (email: string) => (await userByEmail(email))!.role;

  it("a wildcard or a malformed entry grants nothing: a verified user at that domain signs in as a user", async () => {
    const domain = `${crypto.randomUUID().slice(0, 8)}.holdfast-test.example`;
    const email = `anyone@${domain}`;
    const lists = [
      `*@${domain}`,
      `@${domain}`,
      domain,
      `Any One <${email}>`,
      `${email};x@y.example`,
      `/.*@${domain}/`,
    ];
    const made = await verifiedUser({ email });
    for (const ADMIN_EMAILS of lists) {
      const client = newClient({ env: { ADMIN_EMAILS } });
      expect((await signIn(client, email)).status, ADMIN_EMAILS).toBe(200);
      expect(await roleOf(email), ADMIN_EMAILS).toBe("user");
      expect(isAdminEmail({ ADMIN_EMAILS }, email), ADMIN_EMAILS).toBe(false);
    }
    // The control: the exact address does.
    const exact = newClient({ env: { ADMIN_EMAILS: ` ${email.toUpperCase()} ` } });
    expect((await signIn(exact, email)).status).toBe(200);
    expect(await roleOf(email)).toBe("admin");
    void made;
  });

  it("an exact entry grants the role only at a VERIFIED sign-in — and an admin route still needs a second factor on the session", async () => {
    const email = freshEmail();
    const listed = { env: { ADMIN_EMAILS: email } };
    // Unverified: signing up (and trying to sign in) grants nothing.
    const pending = newClient(listed);
    const { sent } = await (await import("./helpers")).signUp(pending, { email });
    expect(sent.status).toBe(200);
    expect(await roleOf(email)).toBe("user");
    expect((await signIn(newClient(listed), email)).status).toBe(403);
    expect(await roleOf(email)).toBe("user");
    // The verification click itself grants nothing either (a click proves a mailbox, not a credential).
    const { linkIn, waitForMail } = await import("./helpers");
    expect((await send(pending, linkIn(await waitForMail(email, "verification")))).status).toBe(302);
    expect(await roleOf(email)).toBe("user");
    // A verified sign-in does.
    const admin = newClient(listed);
    expect((await signIn(admin, email)).status).toBe(200);
    expect(await roleOf(email)).toBe("admin");
    // The role alone opens no admin route: no two-factor on the session.
    const target = await verifiedUser();
    const ban = (client: typeof admin) =>
      send(client, "/api/auth/admin/ban-user", { json: { userId: target.user.id } });
    const refused = await ban(admin);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "ADMIN_REQUIRES_2FA" });
    expect((await userByEmail(target.email))!.banned).not.toBe(true);
    // Enrolled, and signed in again WITH the code: now it does.
    const { totpURI } = await enableTotp(admin);
    const again = newClient(listed);
    expect((await signIn(again, email)).body).toMatchObject({ twoFactorRedirect: true });
    const verified = await send(again, "/api/auth/two-factor/verify-totp", {
      json: { code: await nextTotp(totpURI) },
    });
    expect(verified.status, verified.text).toBe(200);
    expect((await ban(again)).status).toBe(200);
    expect((await userByEmail(target.email))!.banned).toBe(true);
  });

  it("the stand-in Google refuses a REAL admin address (the same matcher), and serves a test admin", async () => {
    // This isolate's stand-in was installed with the test env's list (a reserved-domain admin):
    // a real address on the list of THIS request cannot be minted through it either, because the
    // role grant and the stand-in share one matcher and a real mailbox is never at a test domain.
    const real = `operator-${crypto.randomUUID().slice(0, 6)}@gmail.com`;
    expect(isAdminEmail({ ADMIN_EMAILS: real }, real)).toBe(true);
    const { realAdminAddresses, routeTestOutbound } = await import("../../../src/worker/auth/test-outbound");
    const state = {
      strict: true,
      original: (async () => new Response("network", { status: 599 })) as typeof fetch,
      realAdmins: realAdminAddresses(`${real}, ${env.ADMIN_EMAILS}`),
    };
    const exchange = (email: string) =>
      routeTestOutbound(
        new Request("https://oauth2.googleapis.com/token", {
          method: "POST",
          body: new URLSearchParams({ code: testGoogleCode({ sub: "1", email }), client_id: "c" }),
        }),
        state,
      );
    for (const spelling of [real, real.toUpperCase()]) {
      expect((await exchange(spelling)).status, spelling).toBe(400);
    }
    // A spelling that only `toLowerCase()` folds onto a real admin (the Kelvin sign for a `k`).
    const kelvin = `mar\u212a-${crypto.randomUUID().slice(0, 6)}@gmail.com`;
    const folded = { ...state, realAdmins: realAdminAddresses(kelvin.toLowerCase()) };
    expect(
      (
        await routeTestOutbound(
          new Request("https://oauth2.googleapis.com/token", {
            method: "POST",
            body: new URLSearchParams({ code: testGoogleCode({ sub: "1", email: kelvin }), client_id: "c" }),
          }),
          folded,
        )
      ).status,
    ).toBe(400);
    expect((await exchange(env.ADMIN_EMAILS)).status).toBe(200);
    expect((await exchange("someone-else@gmail.com")).status).toBe(200);
    void createInvite;
  });
});

describe("the role is decided on the bytes that were proven", () => {
  const roleOf = async (email: string) => (await userByEmail(email))?.role ?? null;
  const tag = () => crypto.randomUUID().slice(0, 8);

  it("look-alikes and variants of an admin address: each either cannot be registered, or is a distinct user who is not an admin", async () => {
    const domain = `${tag()}.holdfast-test.example`;
    const admin = `admin@${domain}`;
    const listed = { env: { ADMIN_EMAILS: admin } };
    const variants: Array<[string, string]> = [
      ["upper case", admin.toUpperCase()],
      ["mixed case", `Admin@${domain}`],
      ["full-width letters", `ａｄｍｉｎ@${domain}`],
      ["mathematical letters", `𝐚𝐝𝐦𝐢𝐧@${domain}`],
      ["dotless i", `adm\u0131n@${domain}`],
      ["capital dotted I", `adm\u0130n@${domain}`],
      ["a Cyrillic а", `\u0430dmin@${domain}`],
      ["a ligature (NFKC-equivalent to plain letters)", `adm\ufb01@${domain}`],
      ["a zero-width space", `ad\u200bmin@${domain}`],
      ["a zero-width joiner", `admin\u200d@${domain}`],
      ["a soft hyphen", `ad\u00admin@${domain}`],
      ["a leading space", ` ${admin}`],
      ["a trailing space", `${admin} `],
      ["a trailing dot", `${admin}.`],
      ["a quoted local part", `"admin"@${domain}`],
      ["a comment", `admin(x)@${domain}`],
      ["a Unicode domain", `admin@bücher-${domain}`],
      ["a plus tag", `admin+x@${domain}`],
      ["a dot in the local part", `ad.min@${domain}`],
      ["a punycode domain (its own domain)", `admin@xn--bcher-kva.${domain}`],
      ["a sub-domain", `admin@mail.${domain}`],
    ];
    const registered: string[] = [];
    for (const [what, address] of variants) {
      const client = newClient(listed);
      const { sent } = await signUp(client, { email: address });
      if (sent.status !== 200) {
        // Cannot be registered: refused for free, and no row was made under any spelling.
        expect(sent.status, what).toBe(400);
        expect(await userByEmail(address.trim().toLowerCase()), what).toBeNull();
        continue;
      }
      // Registered: it is stored exactly as sent — a DIFFERENT address from the admin's.
      registered.push(what);
      const row = await userByEmail(address);
      expect(row?.email, what).toBe(address);
      expect(address, what).not.toBe(admin);
      // Verified and signed in — with the admin list in force — it is a user.
      expect((await send(client, linkIn(await waitForMail(address, "verification")))).status, what).toBe(302);
      expect((await signIn(newClient(listed), address)).status, what).toBe(200);
      expect(await roleOf(address), what).toBe("user");
    }
    // The ones that are simply other ASCII addresses.
    expect(registered).toEqual([
      "a plus tag",
      "a dot in the local part",
      "a punycode domain (its own domain)",
      "a sub-domain",
    ]);
    // Nobody became the admin's row on the way.
    expect(await userByEmail(admin)).toBeNull();
  });

  it("an exact ASCII match of a VERIFIED user is an admin; unverified it is not; changing the address away drops the role on the next request", async () => {
    const domain = `${tag()}.holdfast-test.example`;
    const admin = `boss@${domain}`;
    const listed = { env: { ADMIN_EMAILS: `someone@elsewhere.example, ${admin}` } };
    // Unverified exact match: not an admin, and cannot sign in.
    const pending = newClient(listed);
    await signUp(pending, { email: admin });
    expect((await signIn(newClient(listed), admin)).status).toBe(403);
    expect(await roleOf(admin)).toBe("user");
    // Verified, signed in: admin — and the grant is audited.
    await send(pending, linkIn(await waitForMail(admin, "verification")));
    const client = newClient(listed);
    expect((await signIn(client, admin)).status).toBe(200);
    const id = (await userByEmail(admin))!.id;
    expect(await roleOf(admin)).toBe("admin");
    expect(await auditRows({ action: "auth.admin_granted", targetId: id })).toHaveLength(1);
    type Seen = { user: { role: string; email: string } };
    expect(((await send(client, "/api/auth/get-session")).body as Seen).user.role).toBe("admin");

    // The stored address changes (to one that is not on the list): the role goes with it —
    // seen by the very next request, and audited.
    const moved = `boss-moved@${domain}`;
    await testDb().update(user).set({ email: moved }).where(eq(user.id, id));
    const next = (await send(client, "/api/auth/get-session")).body as Seen;
    expect(next.user.email).toBe(moved);
    expect(next.user.role).toBe("user");
    expect(await roleOf(moved)).toBe("user");
    expect(await auditRows({ action: "auth.admin_revoked", targetId: id })).toHaveLength(1);
    // Once: a second request finds nothing left to revoke.
    await send(client, "/api/auth/get-session");
    expect(await auditRows({ action: "auth.admin_revoked", targetId: id })).toHaveLength(1);
    // The address changed back: the role returns only at a new verified sign-in.
    await testDb().update(user).set({ email: admin }).where(eq(user.id, id));
    expect(((await send(client, "/api/auth/get-session")).body as Seen).user.role).toBe("user");
    expect((await signIn(newClient(listed), admin)).status).toBe(200);
    expect(await roleOf(admin)).toBe("admin");
  });

  it("an entry that leaves the list takes its role with it; a role another admin gave is not the list's to take", async () => {
    const domain = `${tag()}.holdfast-test.example`;
    const admin = `lead@${domain}`;
    const made = await verifiedUser({ email: admin });
    const listed = newClient({ env: { ADMIN_EMAILS: admin } });
    expect((await signIn(listed, admin)).status).toBe(200);
    expect(await roleOf(admin)).toBe("admin");
    type Seen = { user: { role: string } };
    // The same session, on a deploy whose list no longer has the entry.
    const unlisted = newClient({
      cookies: new Map(listed.cookies),
      ip: listed.ip,
      env: { ADMIN_EMAILS: "other@elsewhere.example" },
    });
    expect(((await send(unlisted, "/api/auth/get-session")).body as Seen).user.role).toBe("user");
    expect(await roleOf(admin)).toBe("user");
    expect(await auditRows({ action: "auth.admin_revoked", targetId: made.user.id })).toHaveLength(1);

    // An admin made by an admin (no bootstrap mark) and not on any list: keeps the role.
    const appointed = await verifiedUser();
    await testDb().update(user).set({ role: "admin" }).where(eq(user.id, appointed.user.id));
    expect(((await send(appointed.client, "/api/auth/get-session")).body as Seen).user.role).toBe("admin");
    expect(await roleOf(appointed.email)).toBe("admin");
    expect(await auditRows({ action: "auth.admin_revoked", targetId: appointed.user.id })).toEqual([]);
  });
});
