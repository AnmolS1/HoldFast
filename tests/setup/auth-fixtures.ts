// Signed-in users for the e2e suite, made the way a person makes one: a real sign-up through
// /api/auth/sign-up/email (invite, age, assent, the Turnstile test token), the verification link
// read from the memory outbox and followed. Later specs use these instead of rolling their own.
//
//   const user  = await signedInUser(page, { clientIp });        // verified; `page` is signed in
//   const admin = await signedInAdmin2fa(page, { clientIp });    // role admin + two-factor
//
// Pass a `Page` (its browser context ends up holding the session cookie) or an
// `APIRequestContext` (that context holds it). `clientIp` is REQUIRED — ask for the opt-in
// `clientIp` fixture in the test: the Worker limits auth writes to 20 a minute per client
// address and sign-ups to 3 a day, and `page.request` calls do not pass through the browser
// context's routes, so the address is sent on every call here.
//
// Local only: the invite and the direct checks use this checkout's own database
// (tests/setup/local-env.ts), and the mail comes from the Worker's in-memory outbox. A spec
// against a deploy uses scripts/create-session.ts instead.
import { createHmac, randomBytes } from "node:crypto";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import pg from "pg";
import { latestMailTo, linksIn } from "../e2e/fixtures/outbox";
import { appOrigin, e2ePort, localDbName, localDbUrl } from "./local-env";
import { E2E_ADMIN_DOMAIN } from "./test-vars";

/** What the stand-in Turnstile widget yields, and what Cloudflare's test secret accepts. */
export const TURNSTILE_TEST_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";
/** Long enough, and not in the test breach corpus. */
export const FIXTURE_PASSWORD = "correct horse battery staple 9!";

export type FixtureOptions = {
  /** From the `clientIp` fixture. Required: see the header. */
  clientIp: string;
  email?: string;
  password?: string;
  name?: string;
};

export type SignedInUser = {
  id: string;
  email: string;
  password: string;
  name: string;
};

export type SignedInAdmin = SignedInUser & {
  /** The otpauth:// URI of the admin's authenticator. */
  totpURI: string;
  backupCodes: string[];
};

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** A fresh address at a domain of its own (no shared per-domain sign-up counter). */
export const freshEmail = () => `e2e-${hex(6)}@${hex(4)}.holdfast-e2e.example`;

const requestOf = (target: APIRequestContext | Page): APIRequestContext =>
  "request" in target ? target.request : target;

function headersFor(clientIp: string, extra: Record<string, string> = {}) {
  // The Origin a browser on the app would send: Better Auth refuses a cookie-bearing write
  // without it, and our own routes refuse any write without it.
  return { origin: appOrigin(e2ePort()), "cf-connecting-ip": clientIp, ...extra };
}

async function expectOk(response: APIResponse, what: string): Promise<void> {
  if (response.ok() || (response.status() >= 300 && response.status() < 400)) return;
  // The status and Better Auth's error code only: a body can carry an address.
  let code = "";
  try {
    code = String(((await response.json()) as { code?: unknown; error?: unknown }).code ?? "");
  } catch {
    code = "";
  }
  throw new Error(`auth fixture: ${what} answered ${response.status()}${code ? ` (${code})` : ""}`);
}

/** One query against this checkout's local database. */
export async function localDb<T>(run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: localDbUrl(localDbName()) });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** A one-use invite, inserted straight into the run's database. */
export async function createInvite(maxUses = 1): Promise<string> {
  const code = `E2E-${hex(8).toUpperCase()}`;
  await localDb((db) =>
    db.query("INSERT INTO invites (code, max_uses, note) VALUES ($1, $2, 'e2e fixture')", [code, maxUses]),
  );
  return code;
}

async function userIdOf(email: string): Promise<string | null> {
  const found = await localDb((db) =>
    db.query<{ id: string }>('SELECT id FROM "user" WHERE email = $1', [email.toLowerCase()]),
  );
  return found.rows[0]?.id ?? null;
}

/** RFC 6238: SHA-1, 6 digits, 30 s — what Better Auth's two-factor plugin is configured with. */
export function totpCode(uriOrSecret: string, at: number = Date.now()): string {
  const secret = uriOrSecret.startsWith("otpauth://")
    ? (new URL(uriOrSecret).searchParams.get("secret") ?? "")
    : uriOrSecret;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of secret.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value !== -1) bits += value.toString(2).padStart(5, "0");
  }
  const key = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < key.length; i++) key[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

// A TOTP time-step is accepted ONCE per account, and never an older one after a newer (the
// Worker records the last step: src/worker/auth/second-factor.ts). A code is valid for its own
// 30-second step and the one before and after, so codes for one authenticator are taken in
// ascending order: the previous step, the current one, the next.
const lastStep = new Map<string, number>();

/** A currently valid code for the authenticator, newer than any this worker process has handed out for it. */
export async function nextTotpCode(uriOrSecret: string): Promise<string> {
  for (;;) {
    const current = Math.floor(Date.now() / 30_000);
    const step = Math.max(current - 1, (lastStep.get(uriOrSecret) ?? -1) + 1);
    if (step <= current + 1) {
      lastStep.set(uriOrSecret, step);
      return totpCode(uriOrSecret, step * 30_000);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Sign up with an invite and follow the verification link. Every address needs an invite. */
async function signUpAndVerify(
  request: APIRequestContext,
  options: FixtureOptions & { inviteCode: string },
): Promise<SignedInUser> {
  const email = (options.email ?? freshEmail()).toLowerCase();
  const password = options.password ?? FIXTURE_PASSWORD;
  const name = options.name ?? "E2E Person";
  const signUp = await request.post("/api/auth/sign-up/email", {
    headers: headersFor(options.clientIp, { "x-captcha-response": TURNSTILE_TEST_TOKEN }),
    data: {
      email,
      password,
      name,
      inviteCode: options.inviteCode,
      birthYear: 1990,
      birthMonth: 5,
      acceptTerms: true,
      callbackURL: "/login?reason=verified",
    },
  });
  await expectOk(signUp, "sign-up");
  const mail = await latestMailTo(email, { subject: "Confirm your email address" });
  const link = linksIn(mail).find((url) => url.includes("/api/auth/verify-email"));
  if (!link) throw new Error("auth fixture: the verification mail has no link");
  const verified = await request.get(link, { headers: headersFor(options.clientIp), maxRedirects: 0 });
  await expectOk(verified, "the verification link");
  const id = await userIdOf(email);
  if (!id)
    throw new Error(
      "auth fixture: the sign-up answered 200 but created no user (does the address already exist?)",
    );
  return { id, email, password, name };
}

/** A verified, signed-in user. The target (page or request context) holds its session afterwards. */
export async function signedInUser(
  target: APIRequestContext | Page,
  options: FixtureOptions,
): Promise<SignedInUser> {
  return signUpAndVerify(requestOf(target), { ...options, inviteCode: await createInvite() });
}

// ── the admin ───────────────────────────────────────────────────────────────────────────────
// Every call makes an admin of ITS OWN: a fresh address at the run's admin domain (the e2e
// server is told `*@<that domain>` through E2E_ADMIN_EMAILS — tests/setup/test-vars.ts — and
// honours it in test mode only), its own password and its own authenticator secret. No account
// and no one-time code is shared between tests, so nothing here depends on a code being
// accepted twice. Never this checkout's real ADMIN_EMAILS: no test reads that var.

/** A fresh address at the run's admin domain. */
export const freshAdminEmail = () => `e2e-${hex(6)}@${E2E_ADMIN_DOMAIN}`;

/**
 * An admin signed in the way an admin must be: role `admin`, two-factor enrolled, and a session
 * that PASSED the second factor — what `requireAdmin` and the admin-plugin gate ask for.
 *
 * The bootstrap as an operator does it: an invite made out of band (scripts/create-invite.ts), a
 * sign-up with an admin address, the verification link, TOTP enrolment — and then a real
 * sign-in, password and code: the role is granted by a sign-in, never by the verification click.
 */
export async function signedInAdmin2fa(
  target: APIRequestContext | Page,
  options: FixtureOptions,
): Promise<SignedInAdmin> {
  const request = requestOf(target);
  const email = options.email ?? freshAdminEmail();
  const user = await signUpAndVerify(request, {
    ...options,
    email,
    inviteCode: await createInvite(),
    name: options.name ?? "E2E Admin",
  });
  const enabled = await request.post("/api/auth/two-factor/enable", {
    headers: headersFor(options.clientIp),
    data: { password: user.password },
  });
  await expectOk(enabled, "two-factor/enable");
  const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
  const enrolled = await request.post("/api/auth/two-factor/verify-totp", {
    headers: headersFor(options.clientIp),
    data: { code: await nextTotpCode(totpURI) },
  });
  await expectOk(enrolled, "two-factor/verify-totp (enrolment)");
  await expectOk(
    await request.post("/api/auth/sign-out", { headers: headersFor(options.clientIp), data: {} }),
    "sign-out",
  );
  const password = await request.post("/api/auth/sign-in/email", {
    headers: headersFor(options.clientIp, { "x-captcha-response": TURNSTILE_TEST_TOKEN }),
    data: { email, password: user.password },
  });
  await expectOk(password, "the admin's password sign-in");
  const code = await request.post("/api/auth/two-factor/verify-totp", {
    headers: headersFor(options.clientIp),
    data: { code: await nextTotpCode(totpURI) },
  });
  await expectOk(code, "the admin's TOTP code");
  return { ...user, totpURI, backupCodes };
}
