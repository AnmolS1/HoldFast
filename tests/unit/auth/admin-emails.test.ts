// `ADMIN_EMAILS` is EXACT ADDRESSES ONLY (src/shared/admin-emails.ts): one parser and one matcher
// for every consumer — the role grant, the test-mode stand-ins, the health flag, the checker
// script. A wildcard or a malformed entry grants nothing.
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { canonicalAdminAddress, isListedAdmin, parseAdminList } from "../../../src/shared/admin-emails";
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
  createInvite,
  enableTotp,
  freshEmail,
  newClient,
  nextTotp,
  send,
  signIn,
  userByEmail,
  verifiedUser,
} from "./helpers";

vi.mock("../../../src/worker/auth/observe", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/observe")>();
  return { ...real, reportError: vi.fn(real.reportError), countFor: vi.fn(real.countFor) };
});

describe("the parser: one plain address per entry, or nothing", () => {
  it.each([
    ["ana@example.com", "ana@example.com"],
    ["  Ana@Example.COM ", "ana@example.com"],
    ["a.b+tag_x-y@sub.example.co.uk", "a.b+tag_x-y@sub.example.co.uk"],
    ["ＡＮＡ@example.com", "ana@example.com"],
  ])("%s is the address %s", (entry, canonical) => {
    expect(canonicalAdminAddress(entry)).toBe(canonical);
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
    ["two addresses, a semicolon", "ana@example.com;bo@example.com"],
    ["two addresses, a space", "ana@example.com bo@example.com"],
    ["a domain only", "@example.com"],
    ["a domain only, no at", "example.com"],
    ["no domain dot", "ana@localhost"],
    ["an IP literal", "ana@[127.0.0.1]"],
    ["a trailing dot", "ana@example.com."],
    ["a leading dot", ".ana@example.com"],
    ["a double dot", "a..b@example.com"],
    ["a non-ASCII letter", "añá@example.com"],
    ["a Cyrillic look-alike", "аna@example.com"],
    ["a non-ASCII domain", "ana@exámple.com"],
    ["a mailto", "mailto:ana@example.com"],
    ["a newline inside", "ana@example.com\nbo@example.com"],
    ["a percent trick", "ana%example.com@evil.example"],
    ["empty", ""],
    ["not text", 42],
  ])("%s is not an address: %s", (_what, entry) => {
    expect(canonicalAdminAddress(entry)).toBeNull();
    // As a list entry it is ignored and counted — and grants nothing, to anyone.
    const list = parseAdminList(`ok@example.com, ${String(entry)}`);
    if (String(entry).trim() !== "") expect(list.invalid).toBeGreaterThanOrEqual(1);
    expect(
      [...list.addresses].filter((address) => address !== "ok@example.com" && address !== "bo@example.com"),
    ).toEqual([]);
    for (const probe of ["anyone@example.com", "ana@example.com", "x@gmail.com", String(entry)]) {
      expect(isListedAdmin(parseAdminList(String(entry)), probe), probe).toBe(false);
    }
  });

  it("matching is exact on the canonical form: case folds, nothing else does", () => {
    const list = parseAdminList("Ana@Example.com, a.b@gmail.com , ");
    expect(list).toEqual({ addresses: new Set(["ana@example.com", "a.b@gmail.com"]), invalid: 0 });
    for (const same of ["ana@example.com", "ANA@EXAMPLE.COM", " ana@example.com ", "ＡＮＡ@example.com"]) {
      expect(isListedAdmin(list, same), same).toBe(true);
    }
    for (const other of [
      "ana+x@example.com", // no plus folding
      "ab@gmail.com", // no dot folding
      "a.b+x@gmail.com",
      "a.b@googlemail.com",
      "ana@sub.example.com",
      "ana@example.com.evil.example",
      "xana@example.com",
      "аna@example.com", // Cyrillic а
      "ana@exаmple.com",
      "example.com",
      "",
      null,
      undefined,
    ]) {
      expect(isListedAdmin(list, other), String(other)).toBe(false);
    }
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
    for (const spelling of [real, real.toUpperCase(), ` ${real} `]) {
      expect((await exchange(spelling)).status, spelling).toBe(400);
    }
    expect((await exchange(env.ADMIN_EMAILS)).status).toBe(200);
    expect((await exchange("someone-else@gmail.com")).status).toBe(200);
    void createInvite;
  });
});
