// The password-guess throttle on sign-in (src/worker/auth/signin-throttle.ts): per account AND
// per client, counted in Postgres, the same for an address that has no account — and built so
// that nobody but the owner's own client can make the owner wait.
import { env } from "cloudflare:workers";
import { like, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATEMENT_BUDGET } from "../../../src/worker/auth/parity";
import * as passwordWork from "../../../src/worker/auth/password";
import { APIError } from "better-auth/api";
import { createScope } from "../../../src/worker/auth/scope";
import {
  ACCOUNT_PRESSURE,
  afterSignIn,
  FREE_ATTEMPTS,
  MAX_DELAY_S,
  provingVerify,
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
  send,
  signIn,
  signUp,
  testDb,
  verifiedUser,
  CAPTCHA,
  type Client,
} from "./helpers";

// Real work, not a unit of logic: dozens of real sign-ins (one scrypt run each) per test. The default budget (5 s) is
// for tests that do one thing; on a slow or busy machine (a CI runner) these need room. The
// assertions are what they are — only the clock is generous.
vi.setConfig({ testTimeout: 30_000 });

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

describe("fail-closed: the count is given back only on proof of the right password", () => {
  const countOf = async (email: string, client: Client) => (await rowOf(email, client))?.count ?? 0;

  it("requests that end in a 400 — refused before the throttle, or by the handler after it — never reset the count", async () => {
    const owner = await verifiedUser();
    const guesser = quiet();
    for (let n = 0; n < 3; n++) expect((await attempt(guesser, owner.email)).sent.status).toBe(401);
    expect(await countOf(owner.email, guesser)).toBe(3);
    const before = await rowOf(owner.email, guesser);

    // Refused at stage (a): the row is not touched at all.
    const malformed: Array<[string, Record<string, unknown>]> = [
      ["a password that is a number", { email: owner.email, password: 123456789012 }],
      ["a password that is an array", { email: owner.email, password: [PASSWORD] }],
      ["no password", { email: owner.email }],
      ["an empty password", { email: owner.email, password: "" }],
      ["a password of 129 characters", { email: owner.email, password: "p".repeat(129) }],
      ["rememberMe that is not a boolean", { email: owner.email, password: WRONG, rememberMe: "yes" }],
      ["a callbackURL that is an object", { email: owner.email, password: WRONG, callbackURL: {} }],
      ["the address with a space in front", { email: ` ${owner.email}`, password: WRONG }],
      ["the address with a trailing newline", { email: `${owner.email}\n`, password: WRONG }],
      ["the address in a list", { email: [owner.email], password: WRONG }],
    ];
    for (const [what, body] of malformed) {
      await forgetAddressRule(guesser);
      const sent = await send(guesser, "/api/auth/sign-in/email", { json: body, headers: CAPTCHA });
      expect(sent.status, what).toBe(400);
      expect(await rowOf(owner.email, guesser), what).toEqual(before);
    }

    // Refused by the handler AFTER the attempt was admitted — an answer that is neither a 401 nor
    // a success (here: the password check itself answering 400, then failing outright, then a
    // 403 nobody has listed). Each stays counted; none gives anything back.
    for (const [what, failure, status] of [
      [
        "a 400 from inside the handler",
        new APIError("BAD_REQUEST", { code: "SOMETHING_ELSE", message: "x" }),
        400,
      ],
      ["a 403 from inside the handler", new APIError("FORBIDDEN", { code: "UNLISTED", message: "x" }), 403],
      ["a 404 from inside the handler", new APIError("NOT_FOUND", { code: "UNLISTED", message: "x" }), 404],
      ["a thrown error", new Error("boom"), 500],
    ] as const) {
      const counted = await countOf(owner.email, guesser);
      await ago(owner.email, guesser, MAX_DELAY_S);
      vi.mocked(passwordWork.verifyPassword).mockRejectedValueOnce(failure);
      const sent = (await attempt(guesser, owner.email)).sent;
      expect(sent.status, what).toBe(status);
      expect(await countOf(owner.email, guesser), what).toBe(counted + 1);
    }
    expect(await countOf(owner.email, guesser)).toBe(7);
    // … so the next guess waits, as after seven wrong passwords.
    const next = await attempt(guesser, owner.email);
    expect(next.sent.status).toBe(429);
    expect(next.hashed).toBe(0);
  });

  it("the two-factor step answers only a RIGHT password — a wrong one on such an account stays counted", async () => {
    const owner = await verifiedUser();
    await enableTotp(owner.client);
    const client = quiet();
    for (let n = 1; n <= 3; n++) {
      const wrong = await attempt(client, owner.email);
      expect(wrong.sent.status).toBe(401);
      expect(wrong.sent.body).not.toMatchObject({ twoFactorRedirect: true });
      expect(await countOf(owner.email, client)).toBe(n);
    }
    const right = await attempt(client, owner.email, PASSWORD);
    expect(right.sent.body).toMatchObject({ twoFactorRedirect: true });
    expect(await rowOf(owner.email, client)).toBeNull();
  });

  it("a success clears exactly one row: this client's, on this account", async () => {
    const a = await verifiedUser();
    const b = await verifiedUser();
    const client = quiet();
    const other = quiet();
    await attempt(client, a.email);
    await attempt(client, b.email);
    await attempt(other, a.email);
    expect((await attempt(client, a.email, PASSWORD)).sent.status).toBe(200);
    expect(await rowOf(a.email, client)).toBeNull();
    expect(await countOf(b.email, client)).toBe(1);
    expect(await countOf(a.email, other)).toBe(1);
  });

  it("asked directly: without the proof nothing is given back, whatever the endpoint returned", async () => {
    const email = freshEmail();
    const ip = freshIp();
    const keys = await keysOf(email, ip);
    expect((await admitSignIn(testDb(), keys, RULE)).ok).toBe(true);
    const scope = createScope(env, testDb(), { waitUntil() {}, passThroughOnException() {} });
    scope.facts.signInAttempt = keys.pair;
    await afterSignIn(scope);
    const [kept] = await testDb().select().from(rateLimit).where(like(rateLimit.key, keys.pair));
    expect(kept?.count).toBe(1);
    // A right password proved OUTSIDE an admitted sign-in attempt (another endpoint's check) is no proof.
    const verify = provingVerify(scope, async () => true);
    expect(await verify({ hash: "h", password: "p" })).toBe(true);
    expect(scope.facts.signInProved).toBe(false);
    // The control: inside an attempt, a verified password is the proof, and the row goes.
    scope.facts.signInAttempt = keys.pair;
    expect(await provingVerify(scope, async () => false)({ hash: "h", password: "p" })).toBe(false);
    expect(scope.facts.signInProved).toBe(false);
    expect(await verify({ hash: "h", password: "p" })).toBe(true);
    expect(scope.facts.signInProved).toBe(true);
    await afterSignIn(scope);
    expect(await testDb().select().from(rateLimit).where(like(rateLimit.key, keys.pair))).toEqual([]);
  });
});

describe("the throttle's key and Better Auth's look-up normalise an address the same way", () => {
  // Better Auth looks the account up by `email.toLowerCase()` (api/routes/sign-in.mjs:319,
  // db/internal-adapter.mjs:572) after `z.email()` (:317). The key is made from exactly that —
  // and stage (a) refuses whatever `z.email()` would. So for every spelling: it is refused before
  // the throttle (no row), OR it is the owner's account under the owner's key, OR it is another
  // address — another key AND no way into the owner's account.
  it.each([
    // Only the form an address is STORED in is accepted (auth/preflight.ts): the forms lower-case
    // what a person types; the server folds nothing.
    ["upper case", (e: string) => e.toUpperCase(), "refused"],
    ["mixed case", (e: string) => e.replace(/^./, (c) => c.toUpperCase()), "refused"],
    ["as stored", (e: string) => e, "same"],
    ["a leading space", (e: string) => ` ${e}`, "refused"],
    ["a trailing space", (e: string) => `${e} `, "refused"],
    ["a trailing tab", (e: string) => `${e}\t`, "refused"],
    ["a space inside", (e: string) => e.replace("@", " @"), "refused"],
    ["a no-break space in front", (e: string) => `\u00a0${e}`, "refused"],
    ["a zero-width space inside", (e: string) => e.replace("@", "\u200b@"), "refused"],
    ["the Kelvin sign for a k (lower-cases to k)", (e: string) => `\u212a${e}`, "refused"],
    ["a full-width letter", (e: string) => e.replace(/^./, "\uff55"), "refused"],
    ["a dotless-i look-alike", (e: string) => e.replace("@", "\u0131@"), "refused"],
    ["a trailing dot on the domain", (e: string) => `${e}.`, "refused"],
    ["a quoted local part", (e: string) => `"${e.split("@")[0]}"@${e.split("@")[1]}`, "refused"],
    ["plus-addressing", (e: string) => e.replace("@", "+x@"), "other"],
    ["a dot in the local part", (e: string) => e.replace(/^(.)/, "$1."), "other"],
    ["another sub-domain", (e: string) => e.replace("@", "@mail."), "other"],
  ] as const)("%s", async (_what, spell, expected) => {
    const owner = await verifiedUser();
    const client = quiet();
    const variant = spell(owner.email);
    const ownersKey = (await keysOf(owner.email, client.ip)).pair;
    const variantsKey = (await keysOf(variant, client.ip)).pair;
    const wrong = (await attempt(client, variant)).sent;
    const right = (await attempt(quiet(), variant, PASSWORD)).sent;
    if (expected === "refused") {
      expect(wrong.status).toBe(400);
      expect(right.status).toBe(400);
      expect(await testDb().select().from(rateLimit).where(like(rateLimit.key, variantsKey))).toEqual([]);
      expect(await rowOf(owner.email, client)).toBeNull();
    } else if (expected === "same") {
      // One account, one key: the wrong guess is on the owner's row, and the right password opens it.
      expect(variantsKey).toBe(ownersKey);
      expect(wrong.status).toBe(401);
      expect((await rowOf(owner.email, client))?.count).toBe(1);
      expect(right.status).toBe(200);
    } else {
      // Another address: its own key — and the owner's password does not open anything through it.
      expect(variantsKey).not.toBe(ownersKey);
      expect(wrong.status).toBe(401);
      expect(right.status).toBe(401);
      expect(await rowOf(owner.email, client)).toBeNull();
      expect(
        (await testDb().select().from(rateLimit).where(like(rateLimit.key, variantsKey)))[0]?.count,
      ).toBe(1);
    }
  });
});
