// What an unauthenticated auth request has to get past before it may cost anything
// (src/worker/auth/preflight.ts): free refusals first — no database statement, no password hash —
// then the limiters, then the captcha, and only then the constant-shape work.
//
// "Costs nothing" is measured, not timed: the number of SQL statements the whole request sent
// (the session read included) and the number of scrypt runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STATEMENT_BUDGET } from "../../../src/worker/auth/parity";
import * as passwordWork from "../../../src/worker/auth/password";
import { HASH_PATHS, MAX_BODY_BYTES, PREFLIGHT } from "../../../src/worker/auth/preflight";
import {
  CAPTCHA,
  freshEmail,
  measured,
  newClient,
  PASSWORD,
  verifiedUser,
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
    for (const path of ["/sign-up/email", "/sign-in/email", "/reset-password", "/change-password"]) {
      expect(HASH_PATHS.has(path), path).toBe(true);
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

  it("the global guard: when all clients together are over the limit for hashing endpoints, a new one is refused — and only on those endpoints", async () => {
    const seen: string[] = [];
    const guard = {
      limit: async ({ key }: { key: string }) => {
        seen.push(key);
        return { success: key !== "global:auth-hash" };
      },
    };
    const done = await cost(() =>
      measured(newClient(), "/api/auth/sign-in/email", { ...signIn(freshEmail()), env: { RL_API: guard } }),
    );
    expect(done.sent.status).toBe(429);
    expect(done.sent.headers.get("retry-after")).toBe("60");
    expect(done.statementsTotal).toBe(0);
    expect(done.scrypt).toBe(0);
    expect(seen).toContain("global:auth-hash");
    // An endpoint that hashes nothing is not counted against it.
    seen.length = 0;
    const resend = await measured(newClient(), "/api/auth/send-verification-email", {
      ...json({ email: freshEmail() }),
      env: { RL_API: guard },
    });
    expect(resend.sent.status).toBe(200);
    expect(seen).not.toContain("global:auth-hash");
  });

  it("a captcha token that does not verify: no hash, and no padding", async () => {
    // Cloudflare's published always-FAIL secret.
    const failing = { TURNSTILE_SECRET: "2x0000000000000000000000000000000AA" };
    for (const [path, body] of [
      ["/api/auth/sign-in/email", { email: freshEmail(), password: PASSWORD }],
      ["/api/auth/sign-up/email", { ...SIGN_UP, email: freshEmail() }],
      ["/api/auth/request-password-reset", { email: freshEmail() }],
    ] as const) {
      const done = await cost(() => measured(newClient(), path, { ...json(body), env: failing }));
      expect(done.sent.status, `${path}: ${done.sent.text}`).toBeGreaterThanOrEqual(400);
      expect(done.sent.status, path).toBeLessThan(500);
      expect(done.scrypt, path).toBe(0);
      // Not brought up to the endpoint's budget: the padding is for requests that reached the work.
      expect(done.statementsTotal, path).toBeLessThan(STATEMENT_BUDGET[path.replace("/api/auth", "")]! / 2);
    }
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
        json({ newPassword: "a perfectly fine password 3!", token: "nobody-issued-this-token-00" }, {}),
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
