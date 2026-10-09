// What the auth layer writes to a log or hands to Sentry: nothing personal, nothing secret.
// Every category the logging rule names is fed in — inside objects, inside error fields, and
// inside free text — and none of it may come out.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildAuthOptions } from "../../../src/worker/auth/create-auth";
import { authLog, authLogLine } from "../../../src/worker/auth/logger";
import {
  describeValue,
  responseCode,
  safeError,
  safeFields,
  scrubText,
} from "../../../src/worker/auth/redact";
import { createScope } from "../../../src/worker/auth/scope";
import {
  auditRows,
  CAPTCHA,
  freshEmail,
  newClient,
  PASSWORD,
  send,
  signUp,
  testDb,
  verifiedUser,
} from "./helpers";

// One value per category. Each is distinctive, so finding any part of it in an output is a leak.
const SECRETS = {
  email: "victim.person@mail-example.org",
  name: "Zebediah Quillfeather",
  ipv4: "203.0.113.77",
  ipv6: "2001:db8:85a3::8a2e:370:7334",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15",
  sessionToken: "kT9xQ2mVb7LpR4sW8yZc3NdF6hJ1gA5u",
  sessionId: "Sx7Lm2Qp9Vr4Tz8Wb3Nc6Hd1Jf5Gk0Ya",
  verifyUrl:
    "https://holdfast.example/api/auth/verify-email?token=eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InZAZXguY29tIn0.c2lnbmF0dXJlLWJ5dGVz&callbackURL=%2Flogin",
  resetUrl: "https://holdfast.example/reset-password/Rz4Kq8Wm2Xv6Bn0Lp3Tj7Yc?callbackURL=%2Flogin",
  jwt: "eyJhbGciOiJIUzI1NiJ9.eyJlbWFpbCI6InZAZXguY29tIn0.c2lnbmF0dXJlLWJ5dGVz",
  cookie: "__Secure-hf.session_token=kT9xQ2mVb7LpR4sW8yZc3NdF6hJ1gA5u.Qm9ndXNTaWduYXR1cmVCeXRlczEyMw%3D%3D",
  password: "Tr0ub4dor&3-horse-staple",
  passwordHash:
    "9f86d081884c7d659a2feaa0c55ad015:a3f5c1e2b4d6978812ab34cd56ef7890a3f5c1e2b4d6978812ab34cd56ef7890",
  totpSecret: "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP",
  totpCode: "492817",
  backupCode: "a8Kd2-Pq7Xz",
  passkeyCredentialId: "AaFdkcD4SuPjF-jwUoRwH8-ZHuY5RihJIX2nTkN1PRc",
  passkeyPublicKey: "pQECAyYgASFYIH8Kp2mVb7LpR4sW8yZc3NdF6hJ1gA5uT9xQ2mVb7LpIlgg",
  oauthCode: "4/0AX4XfWhN8sQ2mVb7LpR4sW8yZc3NdF6hJ1gA5u",
  oauthToken: "ya29.a0AfH6SMBx7LpR4sW8yZc3NdF6hJ1gA5uT9xQ2mVb",
  inviteCode: "HF-7Q2M9VB4LPR8",
} as const;

/** Every secret, and for the long ones every distinctive piece a partial redaction could leave. */
function leaksIn(output: string): string[] {
  const needles: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(SECRETS)) needles[key] = [value];
  needles.email!.push("victim.person", "mail-example.org");
  needles.name!.push("Zebediah", "Quillfeather");
  needles.userAgent!.push("Macintosh", "AppleWebKit");
  // The link's secret is its token. The site and the path it is on are kept by the URL reducer
  // (scheme + host + path; userinfo, query and fragment dropped) and are not a leak.
  needles.verifyUrl!.push("eyJhbGciOiJIUzI1NiJ9", "callbackURL");
  needles.resetUrl!.push("Rz4Kq8Wm2Xv6Bn0Lp3Tj7Yc");
  needles.cookie!.push("Qm9ndXNTaWduYXR1cmVCeXRlczEyMw");
  needles.password!.push("Tr0ub4dor");
  needles.passwordHash!.push("9f86d081884c7d659a2feaa0c55ad015");
  needles.ipv6!.push("2001:db8");
  return Object.entries(needles)
    .filter(([, values]) => values.some((value) => output.includes(value)))
    .map(([key]) => key);
}

/** The hostile arguments: each category inside an object, the way a careless caller would pass it. */
function hostileObjects(): unknown[] {
  return [
    {
      user: { id: "u1", email: SECRETS.email, name: SECRETS.name },
      email: SECRETS.email,
      name: SECRETS.name,
      ip: SECRETS.ipv4,
      ipAddress: SECRETS.ipv6,
      userAgent: SECRETS.userAgent,
    },
    {
      session: { id: SECRETS.sessionId, token: SECRETS.sessionToken, ipAddress: SECRETS.ipv4 },
      sessionId: SECRETS.sessionId,
      token: SECRETS.sessionToken,
      cookie: SECRETS.cookie,
      headers: { cookie: SECRETS.cookie, "user-agent": SECRETS.userAgent, "cf-connecting-ip": SECRETS.ipv4 },
    },
    { url: SECRETS.verifyUrl, resetUrl: SECRETS.resetUrl, link: SECRETS.resetUrl, jwt: SECRETS.jwt },
    {
      password: SECRETS.password,
      hash: SECRETS.passwordHash,
      secret: SECRETS.totpSecret,
      totp: SECRETS.totpCode,
      // `code` is on the allow-list as an ERROR code; a one-time code or an OAuth code under
      // that name must not ride through on it.
      code: SECRETS.totpCode,
      backupCodes: [SECRETS.backupCode],
    },
    {
      code: SECRETS.oauthCode,
      accessToken: SECRETS.oauthToken,
      idToken: SECRETS.jwt,
      refreshToken: SECRETS.oauthToken,
    },
    {
      credentialID: SECRETS.passkeyCredentialId,
      publicKey: SECRETS.passkeyPublicKey,
      inviteCode: SECRETS.inviteCode,
    },
    { body: { email: SECRETS.email, password: SECRETS.password }, response: { token: SECRETS.sessionToken } },
    // Allow-listed NAMES carrying the wrong kind of value.
    {
      event: SECRETS.email,
      userId: SECRETS.verifyUrl,
      requestId: `${SECRETS.name}`,
      code: SECRETS.backupCode,
    },
    { userId: SECRETS.inviteCode + " " + SECRETS.name },
    [SECRETS.email, SECRETS.sessionToken, { name: SECRETS.name }],
    new Map([[SECRETS.email, SECRETS.sessionToken]]),
  ];
}

/** Errors whose message embeds a reset URL and an address, and whose fields carry the rest. */
function hostileErrors(): Error[] {
  const pg = Object.assign(new Error('duplicate key value violates unique constraint "user_email_unique"'), {
    code: "23505",
    detail: `Key (email)=(${SECRETS.email}) already exists.`,
    parameters: [SECRETS.email, SECRETS.name, SECRETS.passwordHash],
    where: SECRETS.name,
  });
  const wrapped = new Error(
    `Failed query: insert into "user" … params: ${SECRETS.email},${SECRETS.sessionToken} while sending ${SECRETS.resetUrl} to ${SECRETS.email} from ${SECRETS.ipv4}`,
    { cause: pg },
  );
  const api = Object.assign(new Error(`could not verify ${SECRETS.verifyUrl} for ${SECRETS.email}`), {
    name: "APIError",
    status: "BAD_REQUEST",
    statusCode: 400,
    body: { code: "INVALID_TOKEN", message: `token ${SECRETS.jwt} for ${SECRETS.email}` },
    headers: { "set-cookie": SECRETS.cookie },
  });
  const oddName = Object.assign(
    new Error(`code ${SECRETS.totpCode}, backup ${SECRETS.backupCode}, ${SECRETS.ipv6}`),
    {
      name: SECRETS.email,
      code: SECRETS.oauthCode,
    },
  );
  return [wrapped, api, oddName];
}

const FREE_TEXT = [
  `Sign-up attempt for existing email: ${SECRETS.email}`,
  `sent ${SECRETS.verifyUrl}`,
  `reset link ${SECRETS.resetUrl} requested from ${SECRETS.ipv4} / ${SECRETS.ipv6}`,
  `cookie ${SECRETS.cookie}`,
  `session ${SECRETS.sessionId} token ${SECRETS.sessionToken}`,
  `totp secret ${SECRETS.totpSecret} code ${SECRETS.totpCode} backup ${SECRETS.backupCode}`,
  `passkey ${SECRETS.passkeyCredentialId} key ${SECRETS.passkeyPublicKey}`,
  `oauth code=${SECRETS.oauthCode} token ${SECRETS.oauthToken} id_token ${SECRETS.jwt}`,
  `hash ${SECRETS.passwordHash}`,
  `/api/auth/verify-email?token=${SECRETS.jwt}&callbackURL=%2F`,
  `/invite/${SECRETS.inviteCode}`,
];

describe("the redaction function", () => {
  it("structured values: only event, userId, requestId and an error code survive — and only in their own shape", () => {
    expect(
      safeFields({
        event: "auth.signin_failed",
        userId: SECRETS.sessionId,
        requestId: "req_01HZX",
        code: "USER_NOT_FOUND",
        email: SECRETS.email,
        anything: "else",
      }),
    ).toEqual({
      event: "auth.signin_failed",
      userId: SECRETS.sessionId,
      requestId: "req_01HZX",
      code: "USER_NOT_FOUND",
    });
    expect(safeFields({ code: "23505" })).toEqual({ code: "23505" });
    expect(safeFields({ code: 429 })).toEqual({ code: "429" });
    expect(safeFields({ body: { code: "INVALID_TOKEN" } })).toEqual({ code: "INVALID_TOKEN" });
    // The wrong shape under an allowed name is dropped, not scanned.
    expect(safeFields({ code: SECRETS.totpCode })).toEqual({});
    expect(safeFields({ code: SECRETS.oauthCode, userId: SECRETS.email, event: "two words" })).toEqual({});
    for (const value of hostileObjects()) expect(leaksIn(describeValue(value))).toEqual([]);
    expect(describeValue({ email: SECRETS.email })).toBe("{…}");
  });

  it("free text: addresses, URLs, tokens, codes and IP addresses are replaced; an error code and plain words are kept", () => {
    for (const text of FREE_TEXT) expect(leaksIn(scrubText(text)), text).toEqual([]);
    expect(scrubText(FREE_TEXT[0]!)).toBe("Sign-up attempt for existing email: [email]");
    expect(scrubText("Invalid password")).toBe("Invalid password");
    expect(scrubText("INVALID_EMAIL_OR_PASSWORD (SQLSTATE 23505) in user_email_unique")).toBe(
      "INVALID_EMAIL_OR_PASSWORD (SQLSTATE 23505) in user_email_unique",
    );
    expect(scrubText("x".repeat(5000)).length).toBeLessThanOrEqual(501);
    // Any URL — relative or absolute — loses its WHOLE query and fragment: short values have no
    // shape a scan could find. Its scheme, host and path are kept.
    expect(scrubText("GET /api/auth/callback/google?state=qZ7&x=ab&name=Zeb#frag failed")).toBe(
      "GET /api/auth/callback/google failed",
    );
    expect(scrubText("redirect to /login?error=x&error_description=Zeb+Q+is+not+allowed.")).toBe(
      "redirect to /login",
    );
    expect(scrubText("see https://User:pw@Holdfast.Example/api/auth/verify-email?token=abc#x.")).toBe(
      "see https://holdfast.example/api/auth/verify-email",
    );
    expect(scrubText("is it /invite/J4K? yes")).toBe("is it /invite/[redacted]? yes");
    // A failed query's parameter list is the row: cut off whole, name and all.
    expect(
      scrubText(
        `Failed query: insert into "user" (name) values ($1)\nparams: ${SECRETS.name},${SECRETS.password}`,
      ),
    ).toBe('Failed query: insert into "user" (name) values ($1)\nparams: [dropped]');
  });

  it("an error: its class, its code and its scanned message — none of its fields", () => {
    for (const error of hostileErrors()) {
      expect(leaksIn(describeValue(error))).toEqual([]);
      const safe = safeError(error);
      expect(leaksIn(`${safe.name} ${safe.message} ${safe.stack} ${JSON.stringify({ ...safe })}`)).toEqual(
        [],
      );
      expect(Object.keys(safe).filter((key) => key !== "code")).toEqual([]);
    }
    const [wrapped, api] = hostileErrors();
    expect(describeValue(wrapped)).toContain("[code=23505]");
    expect(describeValue(wrapped)).toContain("user_email_unique");
    expect(describeValue(wrapped)).not.toContain("Key (email)");
    expect(describeValue(api)).toMatch(
      /^APIError \[code=INVALID_TOKEN\]: could not verify https:\/\/holdfast\.example\/api\/auth\/verify-email for \[email\]$/,
    );
    expect((safeError(api) as Error & { code?: string }).code).toBe("INVALID_TOKEN");
    // The stack keeps its frames (where it happened) and loses its message line.
    expect(safeError(wrapped).stack).toMatch(/\n\s+at /);
  });
});

describe("Better Auth's logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("every line it writes has been through the redaction: hostile messages, objects and errors leave nothing behind", () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        written.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "));
      });
    }
    const messages: unknown[] = [...FREE_TEXT, ...hostileErrors(), ...hostileObjects()];
    for (const level of ["debug", "info", "success", "warn", "error"] as const) {
      for (const message of messages) {
        authLog(level, message as string, ...hostileObjects(), ...hostileErrors(), ...FREE_TEXT);
      }
    }
    expect(written.length).toBe(5 * messages.length);
    const all = written.join("\n");
    expect(leaksIn(all)).toEqual([]);
    for (const line of written) {
      expect(line.startsWith("[auth] ")).toBe(true);
      expect(line.length).toBeLessThanOrEqual(2_100);
    }
    // What a line is FOR still comes through: the error's code and constraint.
    expect(all).toContain("code=23505");
    expect(all).toContain("user_email_unique");
  });

  it("a thrown Better Auth error is logged as its code and its redacted message only", () => {
    const [, api] = hostileErrors();
    expect(authLogLine(api, [])).toBe(
      "APIError [code=INVALID_TOKEN]: could not verify https://holdfast.example/api/auth/verify-email for [email]",
    );
    expect(authLogLine("BAD_REQUEST", [api])).toBe(
      "BAD_REQUEST APIError [code=INVALID_TOKEN]: could not verify https://holdfast.example/api/auth/verify-email for [email]",
    );
  });

  it("is the logger the instance is built with, at level warn (Better Auth's info lines carry addresses)", () => {
    const options = buildAuthOptions(
      createScope(env, testDb(), { waitUntil: () => {}, passThroughOnException: () => {} }),
    );
    expect(options.logger).toMatchObject({ level: "warn", log: authLog, disabled: false });
  });
});

describe("through the real handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a sign-up, a duplicate sign-up, wrong passwords and a reset request write no address, name, password or token to the console", async () => {
    const written: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => {
        written.push(parts.map((part) => (typeof part === "string" ? part : String(part))).join(" "));
      });
    }
    const email = freshEmail();
    const name = "Zebediah Quillfeather";
    const account = await verifiedUser({ email, name });
    await signUp(newClient(), { email, name });
    const stranger = freshEmail();
    for (const address of [email, stranger]) {
      const wrong = await send(newClient(), "/api/auth/sign-in/email", {
        json: { email: address, password: "not the password 123" },
        headers: CAPTCHA,
      });
      expect(wrong.status).toBe(401);
      await send(newClient(), "/api/auth/request-password-reset", {
        json: { email: address, redirectTo: "/reset-password" },
        headers: CAPTCHA,
      });
    }
    const all = written.join("\n");
    // Better Auth did log (its "User not found" / "Invalid password" warnings): the spy saw lines.
    expect(written.some((line) => line.startsWith("[auth] "))).toBe(true);
    for (const secret of [
      email,
      stranger,
      name,
      "Zebediah",
      PASSWORD,
      "not the password 123",
      account.user.id,
    ]) {
      expect(all.includes(secret), secret).toBe(false);
    }
    expect(all).not.toMatch(/reset-password\/[A-Za-z0-9]/);
    expect(all).not.toMatch(/token=[A-Za-z0-9]/);
  });
});

describe("audit metadata and metric tags", () => {
  it("a code read out of a response is kept only when it reads as a code", () => {
    expect(responseCode("INVALID_EMAIL_OR_PASSWORD")).toBe("INVALID_EMAIL_OR_PASSWORD");
    expect(responseCode("unable_to_create_user")).toBe("unable_to_create_user");
    expect(responseCode(null)).toBeNull();
    expect(responseCode("")).toBeNull();
    for (const echoed of [
      SECRETS.email,
      SECRETS.sessionToken,
      SECRETS.oauthCode,
      SECRETS.verifyUrl,
      "two words",
    ]) {
      expect(responseCode(echoed), echoed).toBe("other");
    }
  });

  it("the path of a refused admin-plugin request is scanned before it is recorded", async () => {
    const marker = `m${crypto.randomUUID().slice(0, 8)}`;
    const refused = await send(
      newClient(),
      `/api/auth/admin/${marker}/${SECRETS.email}/${SECRETS.sessionToken}?token=${SECRETS.jwt}`,
      { json: {} },
    );
    expect(refused.status).toBe(403);
    const rows = (await auditRows({ action: "auth.admin_endpoint_denied" })).filter((row) =>
      JSON.stringify(row.meta).includes(marker),
    );
    expect(rows).toHaveLength(1);
    const meta = rows[0]!.meta as { path: string; method: string };
    expect(leaksIn(JSON.stringify(meta))).toEqual([]);
    expect(meta.path).toContain(`/admin/${marker}/[email]/[token]`);
    expect(meta.method).toBe("POST");
  });

  it("no audit row of a sign-up, a failed sign-in or a reset carries the address, the name or a link", async () => {
    const email = freshEmail();
    const account = await verifiedUser({ email, name: "Zebediah Quillfeather" });
    await send(newClient(), "/api/auth/sign-in/email", {
      json: { email, password: "not the password 123" },
      headers: CAPTCHA,
    });
    await send(newClient(), "/api/auth/request-password-reset", {
      json: { email, redirectTo: "/reset-password" },
      headers: CAPTCHA,
    });
    const failed = await auditRows({ action: "auth.failed", targetId: account.user.id });
    const signedIn = await auditRows({ action: "auth.sign_in", targetId: account.user.id });
    expect(failed).toHaveLength(1);
    expect(signedIn).toHaveLength(1);
    expect(failed[0]!.meta).toEqual({
      path: "/sign-in/email",
      status: 401,
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
    const all = JSON.stringify([...failed, ...signedIn].map((row) => row.meta));
    for (const secret of [email, "Zebediah", "Quillfeather", "token=", "http"]) {
      expect(all.includes(secret), secret).toBe(false);
    }
  });
});
