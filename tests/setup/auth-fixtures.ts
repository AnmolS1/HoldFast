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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { APIRequestContext, APIResponse, Page } from "@playwright/test";
import pg from "pg";
import { latestMailTo, linksIn } from "../e2e/fixtures/outbox";
import { readVars } from "./e2e-preflight";
import { appOrigin, e2ePort, localDbName, localDbUrl } from "./local-env";

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

/** Sign up and follow the verification link. `inviteCode: null` sends none (an ADMIN_EMAILS address). */
async function signUpAndVerify(
  request: APIRequestContext,
  options: FixtureOptions & { inviteCode: string | null },
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
      ...(options.inviteCode ? { inviteCode: options.inviteCode } : {}),
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
// ADMIN_EMAILS names one address, and every test of a run (two browser projects, several
// workers) may ask for the admin at once. So: the first caller creates it and enrols TOTP, the
// rest sign in to it — serialised by a Postgres advisory lock, with the authenticator secret
// kept in a file in the OS temp directory (it belongs to a throw-away local account).

type AdminState = { userId: string; totpURI: string; backupCodes: string[]; password: string };

const stateFile = () => join(tmpdir(), `holdfast-e2e-admin-${localDbName()}.json`);

function readState(): AdminState | null {
  try {
    return existsSync(stateFile()) ? (JSON.parse(readFileSync(stateFile(), "utf8")) as AdminState) : null;
  } catch {
    return null;
  }
}

/** The first address of this checkout's ADMIN_EMAILS (.dev.vars). Read here, never logged. */
function adminEmail(): string {
  const vars = readVars(resolve(process.cwd(), ".dev.vars"), ["ADMIN_EMAILS"]);
  const first = (vars.ADMIN_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .find(Boolean);
  if (!first)
    throw new Error(
      "auth fixture: ADMIN_EMAILS is empty in this checkout's .dev.vars — signedInAdmin2fa needs one address",
    );
  return first;
}

async function withAdminLock<T>(run: () => Promise<T>): Promise<T> {
  return localDb(async (db) => {
    await db.query("SELECT pg_advisory_lock(hashtext('holdfast:e2e:admin'))");
    try {
      return await run();
    } finally {
      await db.query("SELECT pg_advisory_unlock(hashtext('holdfast:e2e:admin'))");
    }
  });
}

async function createAdmin(
  request: APIRequestContext,
  options: FixtureOptions,
  email: string,
): Promise<SignedInAdmin> {
  // An ADMIN_EMAILS address needs no invite; its first session (the verification link) grants the role.
  const user = await signUpAndVerify(request, { ...options, email, inviteCode: null, name: "E2E Admin" });
  const enabled = await request.post("/api/auth/two-factor/enable", {
    headers: headersFor(options.clientIp),
    data: { password: user.password },
  });
  await expectOk(enabled, "two-factor/enable");
  const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
  const verified = await request.post("/api/auth/two-factor/verify-totp", {
    headers: headersFor(options.clientIp),
    data: { code: totpCode(totpURI) },
  });
  await expectOk(verified, "two-factor/verify-totp");
  const state: AdminState = { userId: user.id, totpURI, backupCodes, password: user.password };
  writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 });
  return { ...user, totpURI, backupCodes };
}

async function signInAdmin(
  request: APIRequestContext,
  options: FixtureOptions,
  email: string,
  state: AdminState,
): Promise<SignedInAdmin> {
  const password = await request.post("/api/auth/sign-in/email", {
    headers: headersFor(options.clientIp, { "x-captcha-response": TURNSTILE_TEST_TOKEN }),
    data: { email, password: state.password },
  });
  await expectOk(password, "the admin's password sign-in");
  const code = await request.post("/api/auth/two-factor/verify-totp", {
    headers: headersFor(options.clientIp),
    data: { code: totpCode(state.totpURI) },
  });
  await expectOk(code, "the admin's TOTP code");
  return {
    id: state.userId,
    email,
    password: state.password,
    name: "E2E Admin",
    totpURI: state.totpURI,
    backupCodes: state.backupCodes,
  };
}

/**
 * The run's admin, signed in with two-factor: role `admin` AND `twoFactorEnabled`, on a session
 * that is not an impersonated one — what `requireAdmin` and the admin-plugin gate ask for.
 */
export async function signedInAdmin2fa(
  target: APIRequestContext | Page,
  options: FixtureOptions,
): Promise<SignedInAdmin> {
  const request = requestOf(target);
  const email = adminEmail();
  return withAdminLock(async () => {
    const existing = await userIdOf(email);
    const state = readState();
    if (existing && state && state.userId === existing) return signInAdmin(request, options, email, state);
    if (existing) {
      // An admin left by an earlier run whose authenticator we no longer have: start again.
      await localDb((db) => db.query('DELETE FROM "user" WHERE id = $1', [existing]));
    }
    return createAdmin(request, options, email);
  });
}
