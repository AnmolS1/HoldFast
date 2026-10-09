// The password-guess throttle on sign-in (src/worker/auth/signin-throttle.ts): per account AND
// per client, counted in Postgres, the same for an address that has no account — and built so
// that nobody but the owner's own client can make the owner wait.
import { env } from "cloudflare:workers";
import { like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATEMENT_BUDGET } from "../../../src/worker/auth/parity";
import * as passwordWork from "../../../src/worker/auth/password";
import {
  ACCOUNT_PRESSURE,
  FREE_ATTEMPTS,
  MAX_DELAY_S,
  THROTTLE_WINDOW_S,
  throttleKeys,
} from "../../../src/worker/auth/signin-throttle";
import { admitSignIn } from "../../../src/worker/db/queries/auth-lifecycle";
import { rateLimit } from "../../../src/worker/db/schema";
import { createKeys } from "../../../src/worker/services/keys";
import {
  enableTotp,
  freshEmail,
  freshIp,
  measured,
  newClient,
  PASSWORD,
  signIn,
  signUp,
  testDb,
  verifiedUser,
  CAPTCHA,
  type Client,
} from "./helpers";

vi.mock("../../../src/worker/auth/password", async (original) => {
  const real = await original<typeof import("../../../src/worker/auth/password")>();
  return { ...real, hashPassword: vi.fn(real.hashPassword), verifyPassword: vi.fn(real.verifyPassword) };
});
const hashes = () =>
  vi.mocked(passwordWork.hashPassword).mock.calls.length +
  vi.mocked(passwordWork.verifyPassword).mock.calls.length;
beforeEach(() => {
  vi.mocked(passwordWork.hashPassword).mockClear();
  vi.mocked(passwordWork.verifyPassword).mockClear();
});

const WRONG = "not the password at all 1!";
const RULE = {
  windowSeconds: THROTTLE_WINDOW_S,
  free: FREE_ATTEMPTS,
  maxDelaySeconds: MAX_DELAY_S,
  pressure: ACCOUNT_PRESSURE,
};
const keysOf = (email: string, ip: string) =>
  throttleKeys({ keys: createKeys(env.FILES_TOKEN_SECRET) }, email, ip);

// Neither of the two per-ADDRESS limits is what is tested here: the binding (20 auth requests a
// minute — these clients get one that always allows) and Better Auth's own rule on the path
// (5 a minute — its row is removed before each attempt).
const ALLOW = { limit: async () => ({ success: true }) };
const quiet = () => newClient({ env: { RL_AUTH: ALLOW, RL_API: ALLOW } });

async function forgetAddressRule(client: Client) {
  await testDb().execute(
    sql`DELETE FROM rate_limit WHERE key NOT LIKE 'signin:%' AND key LIKE ${`%${client.ip}%`}`,
  );
}
async function attempt(client: Client, email: string, password = WRONG) {
  await forgetAddressRule(client);
  const before = hashes();
  const sent = await signIn(client, email, password);
  return { sent, hashed: hashes() - before, retryAfter: sent.headers.get("retry-after") };
}
async function rowOf(email: string, client: Client) {
  const { pair } = await keysOf(email, client.ip);
  const [row] = await testDb().select().from(rateLimit).where(like(rateLimit.key, pair));
  return row ?? null;
}
/** This client's last counted attempt on the account was `seconds` ago (by the database's clock). */
async function ago(email: string, client: Client, seconds: number) {
  const { pair } = await keysOf(email, client.ip);
  await testDb().execute(sql`
    UPDATE rate_limit
    SET last_request = (extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${seconds * 1000}
    WHERE key = ${pair}`);
}

describe("one client on one account", () => {
  it("five wrong passwords are not delayed; then the wait doubles from 1 s to at most 60 s — refused without a hash, and not counted", async () => {
    const owner = await verifiedUser();
    const guesser = quiet();
    for (let n = 1; n <= FREE_ATTEMPTS; n++) {
      const tried = await attempt(guesser, owner.email);
      expect(tried.sent.status, `guess ${n}`).toBe(401);
      expect(tried.hashed, `guess ${n}`).toBe(1);
    }
    expect((await rowOf(owner.email, guesser))?.count).toBe(FREE_ATTEMPTS);

    const waits: number[] = [];
    for (const expected of [1, 2, 4, 8, 16, 32, 60, 60]) {
      const refused = await attempt(guesser, owner.email);
      expect(refused.sent.status, `wait ${expected}`).toBe(429);
      expect(refused.sent.body).toEqual({
        code: "SIGN_IN_THROTTLED",
        message: "Too many attempts. Wait a moment and try again.",
      });
      expect(refused.hashed, "a refused attempt costs no hash").toBe(0);
      const wait = Number(refused.retryAfter);
      expect(wait).toBeGreaterThanOrEqual(1);
      expect(wait).toBeLessThanOrEqual(expected);
      expect(wait).toBeLessThanOrEqual(MAX_DELAY_S);
      waits.push(expected);
      // A refused attempt is not counted and moves nothing: the row is as it was.
      const before = await rowOf(owner.email, guesser);
      expect((await attempt(guesser, owner.email)).sent.status).toBe(429);
      expect(await rowOf(owner.email, guesser)).toEqual(before);
      // Not quite long enough: still refused. Long enough: the next guess is heard.
      if (expected > 2) {
        await ago(owner.email, guesser, expected - 2);
        expect((await attempt(guesser, owner.email)).sent.status).toBe(429);
      }
      await ago(owner.email, guesser, expected);
      const heard = await attempt(guesser, owner.email);
      expect(heard.sent.status, `after ${expected} s`).toBe(401);
      expect(heard.hashed).toBe(1);
    }
    expect(waits).toHaveLength(8);
  });

  it("the right password is never a failure: it removes the client's row — also with two-factor on, and for an unverified account", async () => {
    const owner = await verifiedUser();
    const client = quiet();
    for (let n = 0; n < 3; n++) expect((await attempt(client, owner.email)).sent.status).toBe(401);
    expect((await rowOf(owner.email, client))?.count).toBe(3);
    expect((await attempt(client, owner.email, PASSWORD)).sent.status).toBe(200);
    expect(await rowOf(owner.email, client)).toBeNull();

    // Two-factor on: the password step answers "now the code" — the password was right.
    const second = await verifiedUser();
    await enableTotp(second.client);
    const elsewhere = quiet();
    expect((await attempt(elsewhere, second.email)).sent.status).toBe(401);
    const step = await attempt(elsewhere, second.email, PASSWORD);
    expect(step.sent.body).toMatchObject({ twoFactorRedirect: true });
    expect(await rowOf(second.email, elsewhere)).toBeNull();

    // Unverified: 403 "verify first" comes after the password was checked.
    const pending = quiet();
    const { email } = await signUp(pending);
    const browser = quiet();
    expect((await attempt(browser, email)).sent.status).toBe(401);
    expect((await attempt(browser, email, PASSWORD)).sent.status).toBe(403);
    expect(await rowOf(email, browser)).toBeNull();
  });

  it("after fifteen minutes without an attempt the count starts again", async () => {
    const owner = await verifiedUser();
    const client = quiet();
    for (let n = 0; n < FREE_ATTEMPTS; n++) await attempt(client, owner.email);
    expect((await attempt(client, owner.email)).sent.status).toBe(429);
    await ago(owner.email, client, THROTTLE_WINDOW_S);
    expect((await attempt(client, owner.email)).sent.status).toBe(401);
    expect((await rowOf(owner.email, client))?.count).toBe(1);
  });
});

describe("it says nothing about whether the account exists", () => {
  it("an address with no account is counted, delayed and answered exactly like one with an account — same statements, one hash each", async () => {
    const owner = await verifiedUser();
    const nobody = freshEmail();
    const trace = async (email: string) => {
      const client = quiet();
      const seen: unknown[] = [];
      for (let n = 0; n < FREE_ATTEMPTS + 2; n++) {
        await forgetAddressRule(client);
        const before = hashes();
        const done = await measured(client, "/api/auth/sign-in/email", {
          json: { email, password: WRONG },
          headers: CAPTCHA,
        });
        seen.push({
          status: done.sent.status,
          body: done.sent.body,
          retryAfter: done.sent.headers.get("retry-after"),
          cookies: done.sent.setCookies.length,
          statements: done.statements,
          hashed: hashes() - before,
        });
      }
      return { seen, row: await rowOf(email, client) };
    };
    const known = await trace(owner.email);
    const unknown = await trace(nobody);
    expect(unknown.seen).toEqual(known.seen);
    expect(unknown.row?.count).toBe(known.row?.count);
    expect(known.row?.count).toBe(FREE_ATTEMPTS);
    // The shape of the run: five heard (one hash each), then refused (none).
    expect(
      (known.seen as Array<{ status: number; hashed: number }>).map((s) => [s.status, s.hashed]),
    ).toEqual([...Array.from({ length: FREE_ATTEMPTS }, () => [401, 1]), [429, 0], [429, 0]]);
    // A refused attempt is not brought up to the endpoint's budget (it reached no work to hide).
    const refusedCost = (known.seen as Array<{ status: number; statements: number }>)
      .filter((entry) => entry.status === 429)
      .map((entry) => entry.statements);
    for (const statements of refusedCost) {
      expect(statements).toBeLessThan(STATEMENT_BUDGET["/sign-in/email"]! - 2);
    }
    // What is stored names neither the address nor the client.
    const rows = await testDb().select().from(rateLimit).where(like(rateLimit.key, "signin:%"));
    for (const row of rows) expect(row.key).toMatch(/^signin:[0-9a-f]{32}:[0-9a-f]{32}$/);
  });
});

describe("nobody else can lock the owner out", () => {
  it("an account under attack from many addresses: the owner signs in at once from their own; after a mistake of their own they wait at most 60 s — whatever the others do", async () => {
    const owner = await verifiedUser();
    // Thirty other clients, one wrong guess each: the account is under pressure.
    const attackers = Array.from({ length: ACCOUNT_PRESSURE + 10 }, () => quiet());
    for (const attacker of attackers) expect((await attempt(attacker, owner.email)).sent.status).toBe(401);

    // Each of them has had its one undelayed guess: the next one waits the full minute.
    const again = await attempt(attackers[0]!, owner.email);
    expect(again.sent.status).toBe(429);
    // (counted from its own guess, a moment ago)
    expect(Number(again.retryAfter)).toBeGreaterThan(MAX_DELAY_S - 20);
    expect(Number(again.retryAfter)).toBeLessThanOrEqual(MAX_DELAY_S);
    expect(again.hashed).toBe(0);

    // The owner, at an address that has not been wrong: in, at once — captcha and password.
    const ownersBrowser = quiet();
    const first = await attempt(ownersBrowser, owner.email, PASSWORD);
    expect(first.sent.status, first.sent.text).toBe(200);

    // The owner mistypes once, at another address of their own …
    const phone = quiet();
    expect((await attempt(phone, owner.email)).sent.status).toBe(401);
    // … so now waits — at most MAX_DELAY_S, counted from that mistake.
    const held = await attempt(phone, owner.email, PASSWORD);
    expect(held.sent.status).toBe(429);
    expect(Number(held.retryAfter)).toBeLessThanOrEqual(MAX_DELAY_S);
    // The attack goes on meanwhile — more addresses, more guesses, and the old ones hammering.
    for (let n = 0; n < 15; n++) await attempt(quiet(), owner.email);
    for (const attacker of attackers.slice(0, 10)) await attempt(attacker, owner.email);
    // None of it moved the owner's wait: sixty seconds after their own mistake they are in.
    await ago(owner.email, phone, MAX_DELAY_S - 10);
    expect((await attempt(phone, owner.email, PASSWORD)).sent.status).toBe(429);
    await ago(owner.email, phone, MAX_DELAY_S);
    const inAgain = await attempt(phone, owner.email, PASSWORD);
    expect(inAgain.sent.status, inAgain.sent.text).toBe(200);
  });

  it("two addresses on one account are counted apart: one client's five free guesses do not use up the other's", async () => {
    const owner = await verifiedUser();
    const noisy = quiet();
    for (let n = 0; n < FREE_ATTEMPTS; n++) await attempt(noisy, owner.email);
    expect((await attempt(noisy, owner.email)).sent.status).toBe(429);
    const other = quiet();
    for (let n = 1; n <= FREE_ATTEMPTS; n++) {
      expect((await attempt(other, owner.email)).sent.status, `the other client's guess ${n}`).toBe(401);
    }
    // …and the noisy client on ANOTHER account starts fresh too.
    const someoneElse = await verifiedUser();
    expect((await attempt(noisy, someoneElse.email)).sent.status).toBe(401);
  });
});

describe("the count is atomic (real concurrent statements against Postgres)", () => {
  it("sixty simultaneous attempts from one client on one account: exactly the five free ones are admitted", async () => {
    const keys = await keysOf(freshEmail(), freshIp());
    const results = await Promise.all(Array.from({ length: 60 }, () => admitSignIn(testDb(), keys, RULE)));
    const admitted = results.filter((result) => result.ok);
    expect(admitted).toHaveLength(FREE_ATTEMPTS);
    expect(admitted.map((result) => (result.ok ? result.count : 0)).sort()).toEqual([1, 2, 3, 4, 5]);
    for (const result of results) {
      if (!result.ok) expect(result.retryAfterSeconds).toBe(1);
    }
    // After the wait: exactly ONE of sixty more.
    await testDb().execute(
      sql`UPDATE rate_limit SET last_request = last_request - 1000 WHERE key = ${keys.pair}`,
    );
    const next = await Promise.all(Array.from({ length: 60 }, () => admitSignIn(testDb(), keys, RULE)));
    expect(next.filter((result) => result.ok)).toHaveLength(1);
  });

  it("under pressure: sixty simultaneous attempts from a client that has already failed admit none before its minute is up, and one after", async () => {
    const email = freshEmail();
    for (let n = 0; n < ACCOUNT_PRESSURE; n++) {
      expect((await admitSignIn(testDb(), await keysOf(email, freshIp()), RULE)).ok).toBe(true);
    }
    const keys = await keysOf(email, freshIp());
    // A client new to the account: its first attempt is admitted, even now.
    const first = await Promise.all(Array.from({ length: 60 }, () => admitSignIn(testDb(), keys, RULE)));
    expect(first.filter((result) => result.ok)).toHaveLength(1);
    for (const result of first) if (!result.ok) expect(result.retryAfterSeconds).toBe(MAX_DELAY_S);
    await testDb().execute(
      sql`UPDATE rate_limit SET last_request = last_request - ${MAX_DELAY_S * 1000} WHERE key = ${keys.pair}`,
    );
    const second = await Promise.all(Array.from({ length: 60 }, () => admitSignIn(testDb(), keys, RULE)));
    expect(second.filter((result) => result.ok)).toHaveLength(1);
  });
});
