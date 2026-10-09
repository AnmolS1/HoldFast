// What an unauthenticated auth request has to get past before it may cost anything
// (src/worker/auth/preflight.ts): free refusals first — no database statement, no password hash —
// then the limiters, then the captcha, and only then the constant-shape work.
//
// "Costs nothing" is measured, not timed: the number of SQL statements the whole request sent
// (the session read included) and the number of scrypt runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATEMENT_BUDGET } from "../../../src/worker/auth/parity";
import * as passwordWork from "../../../src/worker/auth/password";
import { MAX_BODY_BYTES, PREFLIGHT } from "../../../src/worker/auth/preflight";
import { testOutbound } from "../../../src/worker/auth/test-outbound";
import {
  CAPTCHA,
  freshEmail,
  measured,
  newClient,
  PASSWORD,
  send,
  signUp,
  verifiedUser,
  type Client,
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

const SENTINEL = "zzSENTINELzz";
const json = (body: unknown, headers: Record<string, string> = CAPTCHA): SendOptions => ({
  json: body,
  headers,
});
/** A request with a body that is not what `send` would build from an object. */
const raw = (body: string, headers: Record<string, string>): SendOptions => ({
  rawBody: body,
  headers: { ...CAPTCHA, ...headers },
});

async function cost(run: () => Promise<Measured>) {
  const before = scryptRuns();
  const done = await run();
  return { ...done, scrypt: scryptRuns() - before };
}

/** Refused for free: nothing sent to the database, nothing hashed, nothing of the input echoed. */
function expectFree(what: string, done: Measured & { scrypt: number }, statuses = [400]) {
  expect(statuses, `${what}: ${done.sent.status} ${done.sent.text}`).toContain(done.sent.status);
  expect(done.statementsTotal, `${what}: statements`).toBe(0);
  expect(done.scrypt, `${what}: hashes`).toBe(0);
  expect(done.mails, `${what}: mails`).toBe(0);
  expect(done.sent.text, `${what}: echo`).not.toContain(SENTINEL);
  const body = (done.sent.body ?? {}) as Record<string, unknown>;
  // Only: what kind of error, a fixed sentence, and the NAMES of the fields at fault.
  expect(Object.keys(body).filter((key) => !["error", "code", "message", "details"].includes(key))).toEqual(
    [],
  );
  if (body.details !== undefined) {
    expect(Object.keys(body.details as object)).toEqual(["fields"]);
    for (const field of (body.details as { fields: unknown[] }).fields)
      expect(field).toMatch(/^[A-Za-z]{1,24}$/);
  }
}

const SIGN_UP = {
  email: "new@person.example",
  password: PASSWORD,
  name: "N",
  inviteCode: "ABCDE-ABCDE-ABCDE-ABCDE",
  birthYear: 1990,
  birthMonth: 5,
  acceptTerms: true,
};

describe("stage (a): free refusals — no database, no hash, nothing echoed", () => {
  it.each([
    ["sign-up: no captcha header", "/api/auth/sign-up/email", json(SIGN_UP, {})],
    [
      "sign-up: an address that is not one",
      "/api/auth/sign-up/email",
      json({ ...SIGN_UP, email: `${SENTINEL} not an address` }),
    ],
    [
      "sign-up: an address of 255 characters",
      "/api/auth/sign-up/email",
      json({ ...SIGN_UP, email: `${SENTINEL}${"a".repeat(240)}@x.example` }),
    ],
    [
      "sign-up: a short password",
      "/api/auth/sign-up/email",
      json({ ...SIGN_UP, password: SENTINEL.slice(0, 11) }),
    ],
    [
      "sign-up: a password of 129 characters",
      "/api/auth/sign-up/email",
      json({ ...SIGN_UP, password: `${SENTINEL}${"p".repeat(120)}` }),
    ],
    [
      "sign-up: a password that is a number",
      "/api/auth/sign-up/email",
      json({ ...SIGN_UP, password: 123456789012 }),
    ],
    ["sign-up: no name", "/api/auth/sign-up/email", json({ ...SIGN_UP, name: "" })],
    [
      "sign-up: an invite code of 200 characters",
      "/api/auth/sign-up/email",
      json({ ...SIGN_UP, inviteCode: SENTINEL.repeat(20) }),
    ],
    [
      "sign-in: no captcha header",
      "/api/auth/sign-in/email",
      json({ email: "a@b.example", password: PASSWORD }, {}),
    ],
    ["sign-in: no password", "/api/auth/sign-in/email", json({ email: "a@b.example" })],
    [
      "sign-in: a password of 5,000 characters",
      "/api/auth/sign-in/email",
      json({ email: "a@b.example", password: "p".repeat(5000) }),
    ],
    [
      "sign-in: an array for an address",
      "/api/auth/sign-in/email",
      json({ email: [SENTINEL], password: PASSWORD }),
    ],
    ["sign-in: not an object", "/api/auth/sign-in/email", json([SENTINEL])],
    ["sign-in: null", "/api/auth/sign-in/email", json(null)],
    [
      "reset request: no address",
      "/api/auth/request-password-reset",
      json({ redirectTo: "/reset-password" }),
    ],
    [
      "reset request: no captcha header",
      "/api/auth/request-password-reset",
      json({ email: "a@b.example" }, {}),
    ],
    [
      "resend: an address with a space",
      "/api/auth/send-verification-email",
      json({ email: `${SENTINEL} a@b.example` }),
    ],
    [
      "reset: a token with a slash",
      "/api/auth/reset-password",
      json({ newPassword: PASSWORD, token: `${SENTINEL}/../x` }, {}),
    ],
    [
      "reset: a token of 200 characters",
      "/api/auth/reset-password",
      json({ newPassword: PASSWORD, token: "t".repeat(200) }, {}),
    ],
    ["reset: no token", "/api/auth/reset-password", json({ newPassword: PASSWORD }, {})],
    ["reset: a short password", "/api/auth/reset-password", json({ newPassword: "short", token: "abc" }, {})],
    [
      "a two-factor code that is not six digits",
      "/api/auth/two-factor/verify-totp",
      json({ code: `${SENTINEL}` }, {}),
    ],
    ["a two-factor code sent as a number", "/api/auth/two-factor/verify-totp", json({ code: 123456 }, {})],
    [
      "a backup code with other characters",
      "/api/auth/two-factor/verify-backup-code",
      json({ code: "<script>" }, {}),
    ],
  ])("%s", async (what, path, options) => {
    expectFree(what, await cost(() => measured(newClient(), path, options)));
  });

  it("a body that is too large, not JSON, or not declared as JSON", async () => {
    const big = JSON.stringify({ email: "a@b.example", password: PASSWORD, filler: SENTINEL.repeat(1000) });
    expect(big.length).toBeGreaterThan(MAX_BODY_BYTES);
    const path = "/api/auth/sign-in/email";
    expectFree(
      "too large",
      await cost(() => measured(newClient(), path, raw(big, { "content-type": "application/json" }))),
      [413],
    );
    expectFree(
      "too large, with a lying content-length",
      await cost(() =>
        measured(newClient(), path, raw(big, { "content-type": "application/json", "content-length": "10" })),
      ),
      [400, 413],
    );
    expectFree(
      "not JSON",
      await cost(() =>
        measured(newClient(), path, raw(`{"email": ${SENTINEL}`, { "content-type": "application/json" })),
      ),
    );
    expectFree(
      "a form body",
      await cost(() =>
        measured(
          newClient(),
          path,
          raw(`email=a%40b.example&password=${SENTINEL}`, {
            "content-type": "application/x-www-form-urlencoded",
          }),
        ),
      ),
      [415],
    );
    expectFree("no content type", await cost(() => measured(newClient(), path, raw("{}", {}))), [415]);
  });

  it("the answer names fields, and Better Auth's own code where a form has a sentence for it", async () => {
    const refusal = async (path: string, body: unknown) =>
      (await measured(newClient(), path, json(body))).sent.body as {
        code: string;
        details?: { fields: string[] };
      };
    expect(await refusal("/api/auth/sign-up/email", { ...SIGN_UP, password: "short" })).toMatchObject({
      code: "PASSWORD_TOO_SHORT",
      details: { fields: ["password"] },
    });
    expect(await refusal("/api/auth/sign-up/email", { ...SIGN_UP, password: "p".repeat(129) })).toMatchObject(
      {
        code: "PASSWORD_TOO_LONG",
      },
    );
    expect(await refusal("/api/auth/sign-in/email", { email: "nope", password: PASSWORD })).toMatchObject({
      code: "INVALID_EMAIL",
      details: { fields: ["email"] },
    });
    expect(await refusal("/api/auth/sign-up/email", { password: PASSWORD })).toMatchObject({
      code: "VALIDATION",
      details: { fields: ["email", "name"] },
    });
  });

  it("every unauthenticated POST that hashes or looks something up has a preflight", () => {
    for (const path of [
      "/sign-up/email",
      "/sign-in/email",
      "/request-password-reset",
      "/send-verification-email",
      "/reset-password",
    ]) {
      expect(PREFLIGHT[path], path).toBeDefined();
      expect(STATEMENT_BUDGET[path], path).toBeGreaterThan(0);
    }
  });
});

describe("the session read costs nothing for a request that holds no session", () => {
  it("no cookie, a junk cookie, a cookie with a forged signature: zero statements", async () => {
    const real = await verifiedUser();
    const value = real.client.cookies.get("hf.session_token")!;
    const cookies: Array<[string, string | null]> = [
      ["no cookie", null],
      ["junk", "hf.session_token=junk"],
      ["a token-shaped value, unsigned", `hf.session_token=${"A".repeat(32)}`],
      ["a real token with another signature", `hf.session_token=${value.split(".")[0]}.${"A".repeat(43)}%3D`],
      ["an unrelated cookie", `theme=${SENTINEL}`],
    ];
    for (const [what, cookie] of cookies) {
      for (const path of ["/api/account/deletion-status", "/api/auth/get-session"]) {
        const done = await measured(newClient(), path, cookie ? { headers: { cookie } } : {});
        expect(done.statementsTotal, `${what} ${path}`).toBe(0);
        expect([200, 401], `${what} ${path}`).toContain(done.sent.status);
      }
    }
    // Control: the real cookie is looked up.
    const signedIn = await measured(real.client, "/api/account/deletion-status");
    expect(signedIn.sent.status).toBe(200);
    expect(signedIn.statementsTotal).toBeGreaterThan(0);
  });
});

describe("stages (b) and (c): the limiters and the captcha come before the work", () => {
  const signIn = (email: string) => json({ email, password: "not the password 123!" });

  it("a client over its auth limit: refused before the database or a hash is touched", async () => {
    const denied = { limit: async () => ({ success: false }) };
    const done = await cost(() =>
      measured(newClient(), "/api/auth/sign-in/email", { ...signIn(freshEmail()), env: { RL_AUTH: denied } }),
    );
    expect(done.sent.status).toBe(429);
    expect(done.statementsTotal).toBe(0);
    expect(done.scrypt).toBe(0);
  });

  // There is NO counter shared between clients (one was here, and was withdrawn: whoever filled
  // it locked everybody out of sign-in). Every limiter key is one client's own.
  it("one client that has used up its budget changes nothing for another client", async () => {
    const keys: string[] = [];
    const noisy = newClient();
    // The binding, standing in: the noisy client's own key is over its limit, nobody else's is.
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: !key.endsWith(noisy.ip) };
      },
    };
    const limited = { RL_AUTH: limiter, RL_API: limiter };
    const owner = await verifiedUser();
    const refused = await measured(noisy, "/api/auth/sign-in/email", {
      ...json({ email: owner.email, password: PASSWORD }),
      env: limited,
    });
    expect(refused.sent.status).toBe(429);
    // The same endpoint, the same account, the same moment — from another address: served.
    const other = newClient();
    const served = await measured(other, "/api/auth/sign-in/email", {
      ...json({ email: owner.email, password: PASSWORD }),
      env: limited,
    });
    expect(served.sent.status, served.sent.text).toBe(200);
    // Every key that was asked for names exactly one client (an address or a user): none is shared.
    expect(keys.length).toBeGreaterThanOrEqual(3);
    for (const key of keys) expect(key).toMatch(/^(ip:\d+\.\d+\.\d+\.\d+|u:[A-Za-z0-9]{32})$/);
    expect(new Set(keys.filter((key) => key.startsWith("ip:")))).toEqual(
      new Set([`ip:${noisy.ip}`, `ip:${other.ip}`]),
    );
  });

  it("a GET, a HEAD or an OPTIONS never spends an auth budget — the binding's or Better Auth's own", async () => {
    const owner = await verifiedUser();
    const client = newClient();
    const auth: string[] = [];
    const counting = { limit: async ({ key }: { key: string }) => (auth.push(key), { success: true }) };
    // Better Auth allows an address 5 sign-in requests a minute, keyed by address and PATH
    // whatever the method (api/rate-limiter/index.mjs:247). Thirty reads of that path first:
    for (let n = 0; n < 10; n++) {
      for (const method of ["GET", "HEAD", "OPTIONS"]) {
        const read = await measured(client, "/api/auth/sign-in/email", {
          method,
          env: { RL_AUTH: counting },
        });
        expect(read.sent.status, method).toBe(404);
        expect(read.statementsTotal, method).toBe(0);
      }
    }
    expect(auth).toEqual([]);
    // … and all five attempts are still there.
    for (let n = 1; n <= 5; n++) {
      const tried = await send(
        client,
        "/api/auth/sign-in/email",
        json({ email: owner.email, password: PASSWORD }),
      );
      expect(tried.status, `attempt ${n}`).toBe(200);
    }
  });

  it("the captcha is verified exactly once per request — by the plugin on the handler's endpoints, by the route on ours", async () => {
    const outbound = testOutbound()!;
    const verifications = () =>
      outbound.calls.filter((call) => call.host === "challenges.cloudflare.com").length;
    const signedUp = newClient();
    await signUp(signedUp);
    const cases: Array<[string, Client, SendOptions]> = [
      ["/api/auth/sign-in/email", newClient(), json({ email: freshEmail(), password: PASSWORD })],
      ["/api/auth/sign-up/email", newClient(), json({ ...SIGN_UP, email: freshEmail() })],
      ["/api/auth/request-password-reset", newClient(), json({ email: freshEmail() })],
      ["/api/auth/send-verification-email", newClient(), json({ email: freshEmail() })],
      [
        "/api/auth/reset-password",
        newClient(),
        json({ newPassword: PASSWORD, token: "nobody-issued-this-token-00" }),
      ],
      ["/api/account/pending-email", signedUp, { ...json({ email: freshEmail() }), method: "PATCH" }],
    ];
    for (const [path, client, options] of cases) {
      const before = verifications();
      const sent = await send(client, path, options);
      expect(sent.status, `${path}: ${sent.text}`).not.toBe(403);
      expect(verifications() - before, path).toBe(1);
    }
    // The control: an endpoint that needs no token asks Turnstile nothing.
    const before = verifications();
    await send(newClient(), "/api/auth/get-session");
    expect(verifications()).toBe(before);
  });

  it("a captcha token that does not verify: no hash, nothing about any account, and no padding", async () => {
    // Cloudflare's published always-FAIL secret.
    const failing = { TURNSTILE_SECRET: "2x0000000000000000000000000000000AA" };
    const real = await verifiedUser();
    const pendingClient = newClient();
    await signUp(pendingClient);
    const outbound = testOutbound()!;
    const cases: Array<[string, Client, SendOptions]> = [
      ["/api/auth/sign-in/email", newClient(), json({ email: real.email, password: PASSWORD })],
      ["/api/auth/sign-up/email", newClient(), json({ ...SIGN_UP, email: real.email })],
      ["/api/auth/request-password-reset", newClient(), json({ email: real.email })],
      ["/api/auth/send-verification-email", newClient(), json({ email: real.email })],
      [
        "/api/auth/reset-password",
        newClient(),
        json({ newPassword: PASSWORD, token: "nobody-issued-this-token-00" }),
      ],
    ];
    for (const [path, client, options] of cases) {
      const lookups = outbound.calls.length;
      const done = await cost(() => measured(client, path, { ...options, env: failing }));
      expect(done.sent.status, `${path}: ${done.sent.text}`).toBe(403);
      expect(done.scrypt, path).toBe(0);
      expect(done.mails, path).toBe(0);
      // Only Better Auth's own per-address limiter has been to the database (its row is keyed by
      // the caller's address and the path: nothing in it depends on an account) — at most the
      // read and the write of that one row. Not the endpoint's budget: no padding either.
      expect(done.statementsTotal, path).toBeLessThanOrEqual(3);
      // … and the only outbound request was the verification itself (no breach or MX lookup).
      expect(
        outbound.calls.slice(lookups).map((call) => call.host),
        path,
      ).toEqual(["challenges.cloudflare.com"]);
    }
    // Our own route: refused before ANY statement (its limiter is the binding, not a table).
    const ours = await cost(() =>
      measured(pendingClient, "/api/account/pending-email", {
        ...json({ email: freshEmail() }),
        method: "PATCH",
        env: failing,
      }),
    );
    expect(ours.sent.status, ours.sent.text).toBe(403);
    expect(ours.statementsTotal).toBe(0);
    expect(ours.scrypt).toBe(0);
    // … and with no token at all: refused without asking Turnstile either.
    const asked = outbound.calls.length;
    const none = await cost(() =>
      measured(pendingClient, "/api/account/pending-email", {
        ...json({ email: freshEmail() }, {}),
        method: "PATCH",
      }),
    );
    expect(none.sent.status).toBe(400);
    expect(none.statementsTotal).toBe(0);
    expect(outbound.calls.length).toBe(asked);
  });
});

describe("stage (d): a well-formed request about nobody costs the endpoint's constant, and no more", () => {
  it("statements before the answer equal the budget; one hash where an address is the question, none for a token", async () => {
    const cases: Array<[string, SendOptions, number]> = [
      ["/sign-in/email", json({ email: freshEmail(), password: "not the password 123!" }), 1],
      ["/request-password-reset", json({ email: freshEmail(), redirectTo: "/reset-password" }), 0],
      ["/send-verification-email", json({ email: freshEmail() }), 0],
      [
        "/reset-password",
        json({ newPassword: "a perfectly fine password 3!", token: "nobody-issued-this-token-00" }),
        0,
      ],
    ];
    for (const [path, options, hashes] of cases) {
      const done = await cost(() => measured(newClient(), `/api/auth${path}`, options));
      expect(done.scrypt, path).toBe(hashes);
      // The budget, plus at most the route's own audit bookkeeping after it.
      expect(done.statements, path).toBeGreaterThanOrEqual(STATEMENT_BUDGET[path]!);
      expect(done.statements, path).toBeLessThanOrEqual(STATEMENT_BUDGET[path]! + 4);
    }
  });
});
