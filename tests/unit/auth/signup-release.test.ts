// What a sign-up took — the invite's use and one count on each of the day's velocity subjects —
// is given back when the sign-up did not create its user, and only then
// (db/queries/auth-lifecycle.ts `releaseSignup`, auth/hooks.ts `releaseUnusedReservation`).
//
// The release used to decide "did this sign-up create its user?" by asking whether a user with
// the address exists. That cannot tell the sign-up's own row from one that was there before, and
// one path takes a reservation for an address whose row IS there before: a Google sign-up
// arriving at an UNVERIFIED account of that address (auth/hooks.ts `beforeProviderLink` — the
// pre-hijack cleanup takes invite and counts as for any new sign-up, then empties the row). When
// that cleanup does not happen — the account was verified in between, or the cleanup failed —
// the reservation must come back, and the row at the address must not keep it.
//
// Not here: an e-mail sign-up with an address that HAS an account spends its invite and count on
// purpose (the look-alike answer; tests/unit/auth/enumeration.test.ts "spend alike").
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { testGoogleCode } from "../../../src/worker/auth/test-outbound";
import { downloadLedger, type LedgerSubject } from "../../../src/worker/db/schema";
import { dayUTC, ipHashDaily, ipPrefix } from "../../../src/worker/services/ip-hash";
import { createKeys } from "../../../src/worker/services/keys";
import { testVars } from "../../setup/test-vars";
import {
  createInvite,
  freshEmail,
  getSession,
  inviteRow,
  newClient,
  send,
  signUp,
  testDb,
  userByEmail,
  userById,
  type Client,
} from "./helpers";

const keys = createKeys(testVars.FILES_TOKEN_SECRET);

async function ledgerCount(type: LedgerSubject, id: string): Promise<number> {
  const [row] = await testDb()
    .select({ count: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, dayUTC(new Date())),
        eq(downloadLedger.subjectType, type),
        eq(downloadLedger.subjectId, id),
      ),
    );
  return row?.count ?? 0;
}

/** Today's count on every velocity subject a sign-up by `client` for `email` takes (open mode: all four). */
async function velocityOf(client: Client, email: string) {
  const day = dayUTC(new Date());
  return {
    signup_ip: await ledgerCount("signup_ip", await ipHashDaily(keys, client.ip, day)),
    signup_ip24: await ledgerCount("signup_ip24", await ipHashDaily(keys, ipPrefix(client.ip), day)),
    signup_asn: await ledgerCount("signup_asn", String(client.cf!.asn)),
    signup_domain: await ledgerCount("signup_domain", email.split("@")[1]!),
  };
}

/** A client with an autonomous system of its own, so that every velocity subject is its own. */
const clientWithAsn = (settings: Client["settings"] = {}) =>
  newClient({ settings, cf: { asn: 4_200_000_000 + Math.floor(Math.random() * 90_000_000) } });

/** The intent step, then Google's callback with a verified address. */
async function googleSignUp(client: Client, email: string, inviteCode: string | null) {
  const intent = await send(client, "/api/auth-intent", {
    json: { birthYear: 1990, birthMonth: 5, acceptTerms: true, ...(inviteCode ? { inviteCode } : {}) },
  });
  expect(intent.status, intent.text).toBe(200);
  const begun = await send(client, "/api/auth/sign-in/social", {
    json: { provider: "google", callbackURL: "/", errorCallbackURL: "/signup" },
  });
  expect(begun.status, begun.text).toBe(200);
  const state = new URL((begun.body as { url: string }).url).searchParams.get("state")!;
  const profile = { sub: `g-${crypto.randomUUID()}`, email, name: "Vera Victim" };
  const callback = await send(
    client,
    `/api/auth/callback/google?code=${encodeURIComponent(testGoogleCode(profile))}&state=${encodeURIComponent(state)}`,
    { browser: false },
  );
  const location = new URL(callback.headers.get("location") ?? "/", "http://localhost");
  return { status: callback.status, error: location.searchParams.get("error") };
}

/** A stranger's unverified account at `email` (an e-mail sign-up nobody has confirmed). */
async function strangersAccount(email: string) {
  const { sent } = await signUp(newClient(), { email, name: "Mallory" });
  expect(sent.status, sent.text).toBe(200);
  const row = (await userByEmail(email))!;
  expect(row.emailVerified).toBe(false);
  return row;
}

/** Installs a row trigger `<timing> <event> ON <table>` that runs `body` when `when` holds; returns its remover. */
async function trigger(
  table: string,
  timing: string,
  when: string,
  body: string,
): Promise<() => Promise<void>> {
  const name = `hf_test_${crypto.randomUUID().replace(/-/g, "")}`;
  await testDb().execute(
    sql.raw(`
      CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF ${when} THEN
          ${body}
        END IF;
        RETURN COALESCE(NEW, OLD);
      END $$;
      CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${name}();`),
  );
  return async () => {
    await testDb().execute(
      sql.raw(`DROP TRIGGER IF EXISTS ${name} ON ${table}; DROP FUNCTION IF EXISTS ${name}();`),
    );
  };
}

describe("a Google sign-up at an address whose UNVERIFIED account exists: no cleanup → everything it took comes back", () => {
  it("the account was verified between the reservation and the cleanup: the invite's use and the day's count are back", async () => {
    const email = freshEmail();
    const row = await strangersAccount(email);
    const code = await createInvite();
    const victim = newClient();
    // Deterministic "in between": the moment this sign-up uses its invite (inside the
    // reservation's transaction), the account becomes verified — as if its owner had just
    // followed the mailed link. The cleanup then finds a proven account and touches nothing.
    const remove = await trigger(
      "invites",
      "AFTER UPDATE",
      `NEW.code = '${code}' AND NEW.uses > OLD.uses`,
      `UPDATE "user" SET email_verified = true WHERE id = '${row.id}';`,
    );
    let landed: Awaited<ReturnType<typeof googleSignUp>>;
    try {
      landed = await googleSignUp(victim, email, code);
    } finally {
      await remove();
    }
    // The proven account is linked as one (nothing of it was removed) …
    expect(landed.error).toBeNull();
    expect((await getSession(victim))?.user.id).toBe(row.id);
    expect((await userById(row.id))!.emailVerified).toBe(true);
    // … and the sign-up created no account, so it spent nothing.
    expect((await inviteRow(code))!.uses).toBe(0);
    expect(await ledgerCount("signup_ip", await ipHashDaily(keys, victim.ip, dayUTC(new Date())))).toBe(0);
  });

  it("the cleanup fails: every velocity subject's count is where it was (open mode: ip, /24, ASN, domain)", async () => {
    const email = freshEmail();
    const row = await strangersAccount(email);
    const settings = { signupMode: "open" as const };
    const victim = clientWithAsn(settings);
    const before = await velocityOf(victim, email);
    // The cleanup's transaction deletes the account's password row; make that fail.
    const remove = await trigger(
      "account",
      "BEFORE DELETE",
      `OLD.user_id = '${row.id}'`,
      `RAISE EXCEPTION 'the cleanup failed here';`,
    );
    let landed: Awaited<ReturnType<typeof googleSignUp>>;
    try {
      landed = await googleSignUp(victim, email, null);
    } finally {
      await remove();
    }
    expect(landed.error).not.toBeNull();
    expect(await getSession(victim)).toBeNull();
    // Nothing was done to the account (the cleanup is one transaction) …
    expect((await userById(row.id))!.emailVerified).toBe(false);
    // … and nothing was spent.
    expect(await velocityOf(victim, email)).toEqual(before);
  });
});

describe("a sign-up that DID create its user keeps what it took", () => {
  it("a new address, created: the invite stays used and the day's count stays taken", async () => {
    const victim = clientWithAsn({ signupMode: "open" });
    const email = freshEmail();
    const before = await velocityOf(victim, email);
    const { sent } = await signUp(victim, { email, inviteCode: null });
    expect(sent.status, sent.text).toBe(200);
    expect(await userByEmail(email)).not.toBeNull();
    const after = await velocityOf(victim, email);
    for (const [subject, count] of Object.entries(after)) {
      expect(count, subject).toBe(before[subject as keyof typeof before] + 1);
    }

    const invited = newClient();
    const created = await signUp(invited);
    expect(created.sent.status).toBe(200);
    expect((await inviteRow(created.inviteCode!))!.uses).toBe(1);
  });

  it("the request fails AFTER its user row was written (unknown failure): nothing is given back — the row is its own", async () => {
    const email = freshEmail();
    const client = newClient();
    const code = await createInvite();
    // Better Auth writes the user, then its password row; the second write fails.
    const remove = await trigger(
      "account",
      "BEFORE INSERT",
      `NEW.provider_id = 'credential' AND NEW.user_id IN (SELECT id FROM "user" WHERE email = '${email}')`,
      `RAISE EXCEPTION 'the password row could not be written';`,
    );
    let status: number;
    try {
      status = (await signUp(client, { email, inviteCode: code })).sent.status;
    } finally {
      await remove();
    }
    expect(status).not.toBe(200);
    // The row this sign-up wrote is there …
    expect(await userByEmail(email)).not.toBeNull();
    // … so what it took stays taken.
    expect((await inviteRow(code))!.uses).toBe(1);
    expect(await ledgerCount("signup_ip", await ipHashDaily(keys, client.ip, dayUTC(new Date())))).toBe(1);
  });
});
