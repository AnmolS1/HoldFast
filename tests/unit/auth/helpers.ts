// Shared by the auth tests. Runs inside workerd.
//
// Requests go through the real app — `createApp` over exactly the `CoreDeps` the Worker entry
// builds: the whole pipeline, the routes, Better Auth, this checkout's local Postgres — with a
// hand-made ExecutionContext, so that `send` can wait for everything the request deferred (audit
// rows, mails) before it returns, and so that one request can see different vars (`env`).
// The Worker entry itself (host dispatch) is exercised by the e2e suite. Third parties are the
// test-mode stand-ins of src/worker/auth/test-outbound.ts — under the unit-test environment an
// outbound request to any other host throws, so no test here reaches the network.
//
// Postgres is shared by every test file and every run: rows are found by random markers (a
// fresh address, a fresh client address), never by table-wide counts.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { createApp } from "../../../src/worker/app";
import { createAuth, scopeOf } from "../../../src/worker/auth/create-auth";
import { installTestOutbound } from "../../../src/worker/auth/test-outbound";
import { createDb, type Db } from "../../../src/worker/db/client";
import { insertAudit } from "../../../src/worker/db/queries/audit";
import { getSettings, type Settings } from "../../../src/worker/db/queries/settings";
import { termsVersionOf } from "../../../src/worker/db/queries/users";
import {
  resolveSettings,
  type CoreDeps,
  type ServiceDeps,
} from "../../../src/worker/services/request-context";
import {
  account,
  auditLog,
  emailLedger,
  invites,
  nodes,
  type PauseReason,
  session,
  shareLinks,
  shares,
  user,
} from "../../../src/worker/db/schema";
import { recipientHash } from "../../../src/worker/services/email";
import * as outbox from "../../../src/worker/services/outbox";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";

// The stand-ins for third parties, before any test runs (createAuth installs them too, but a
// test may call a service before any request has built an auth instance).
installTestOutbound(env);

export const ORIGIN = TEST_APP_ORIGIN;
export const CAPTCHA = { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" };
/** Long, and not one of the stand-in breach API's breached passwords. */
export const PASSWORD = "correct horse battery staple 9!";

const rand = (bytes = 6) =>
  [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A fresh address at a domain of its own (the stand-in DNS gives every domain an MX record), so
 * that no test shares a per-domain sign-up counter with another.
 */
export const freshEmail = (domain = `${rand(6)}.holdfast-test.example`) => `u${rand(8)}@${domain}`;
/** A fresh documentation-range client address: its own rate-limit and velocity buckets. */
export const freshIp = () => {
  const [a, b, c] = crypto.getRandomValues(new Uint8Array(3));
  return `100.${64 + (a! % 64)}.${b}.${1 + (c! % 250)}`;
};

// ── one database handle per test file ───────────────────────────────────────────────────────
let handle: ReturnType<typeof createDb> | null = null;
export function testDb(): Db {
  handle ??= createDb(env);
  return handle.db;
}

// ── a browser, roughly: cookies and a client address ────────────────────────────────────────
export type Client = {
  ip: string;
  cookies: Map<string, string>;
  /** Extra headers on every request (`user-agent`, …). */
  headers: Record<string, string>;
  /** Vars this client's requests see instead of the test environment's. */
  env: Record<string, unknown>;
  /** The origin its requests are sent to (and claim as `Origin`). */
  origin: string;
  /** Settings this client's requests see, over BASE_SETTINGS. */
  settings: Settings;
  /** Cloudflare's request facts (`asn`, `country`). */
  cf: Record<string, unknown> | null;
};

/** Exactly what src/worker/index.ts injects. */
export const realCore: CoreDeps = { createDb, createAuth, getSettings, termsVersionOf, insertAudit };

/**
 * The settings every auth test sees unless it says otherwise. The `settings` TABLE is shared by
 * every test file running beside this one (some of them switch `readOnly` on for a moment), so
 * the keys the auth layer reads are pinned here instead of read from it — and a test that needs
 * another value passes `settings` to its client rather than writing the table.
 */
export const BASE_SETTINGS: Settings = {
  signupMode: "invite",
  termsVersion: "2026-10",
  readOnly: false,
  uploadsEnabled: true,
  linksEnabled: true,
  ceilings: {},
};

const apps = new Map<string, ReturnType<typeof createApp>>();

/** The real app, with the settings table overlaid by `overrides` (for the pipeline AND the auth hooks). */
function appFor(overrides: Settings): ReturnType<typeof createApp> {
  const pinned = { ...BASE_SETTINGS, ...overrides };
  const key = JSON.stringify(pinned);
  let app = apps.get(key);
  if (!app) {
    const overlaid: CoreDeps["getSettings"] = async (db, opts) => ({
      ...(await getSettings(db, opts)),
      ...pinned,
    });
    app = createApp({
      ...realCore,
      getSettings: overlaid,
      createAuth: (authEnv, db, ctx) => {
        const auth = createAuth(authEnv, db, ctx);
        const scope = scopeOf(auth);
        if (scope) scope.settings = async () => resolveSettings(authEnv, await overlaid(db, { fresh: true }));
        return auth;
      },
    });
    apps.set(key, app);
  }
  return app;
}

export function newClient(overrides: Partial<Client> = {}): Client {
  return {
    ip: freshIp(),
    cookies: new Map(),
    headers: {},
    env: {},
    origin: ORIGIN,
    settings: {},
    cf: null,
    ...overrides,
  };
}

export type Sent = {
  status: number;
  headers: Headers;
  setCookies: string[];
  body: unknown;
  text: string;
};

export type SendOptions = {
  method?: string;
  json?: unknown;
  headers?: Record<string, string>;
  /** `false`: no Origin / fetch-metadata headers (a non-browser client). */
  browser?: boolean;
  /** Vars for this one request, over the client's. */
  env?: Record<string, unknown>;
};

/** One request from `client` through the Worker; cookies in the answer are kept. */
export async function send(client: Client, path: string, options: SendOptions = {}): Promise<Sent> {
  const method = options.method ?? (options.json === undefined ? "GET" : "POST");
  const headers = new Headers({ "cf-connecting-ip": client.ip, ...client.headers });
  if (options.browser !== false) {
    headers.set("origin", client.origin);
    headers.set("sec-fetch-site", "same-origin");
  }
  if (client.cookies.size > 0) {
    headers.set("cookie", [...client.cookies].map(([name, value]) => `${name}=${value}`).join("; "));
  }
  let body: string | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);

  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (promise: Promise<unknown>) => void pending.push(promise),
    passThroughOnException() {},
    props: {},
  } as unknown as ExecutionContext;
  const requestEnv = { ...env, APP_ORIGIN: client.origin, ...client.env, ...options.env } as unknown as Env;
  const init: RequestInit = { method, headers, body };
  if (client.cf) (init as { cf?: unknown }).cf = client.cf;
  const response = await appFor(client.settings).fetch(
    new Request(`${client.origin}${path}`, init),
    requestEnv,
    ctx,
  );
  // Everything the request deferred — audit rows, mails, the pool's close — has happened when
  // this returns.
  while (pending.length) await Promise.allSettled(pending.splice(0));
  const setCookies = response.headers.getSetCookie();
  for (const cookie of setCookies) {
    const [pair = ""] = cookie.split(";");
    const eqAt = pair.indexOf("=");
    const name = pair.slice(0, eqAt).trim();
    const value = pair.slice(eqAt + 1).trim();
    if (value === "" || /;\s*max-age=0\b/i.test(cookie)) client.cookies.delete(name);
    else client.cookies.set(name, value);
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, setCookies, body: parsed, text };
}

/** Waits for the Worker's deferred work (audit rows, mails) to land: polls `check` until it is true. */
export async function eventually<T>(
  check: () => Promise<T | null | undefined | false>,
  ms = 4000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("eventually: the condition did not become true in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// ── rows ────────────────────────────────────────────────────────────────────────────────────
export async function createInvite(overrides: Partial<typeof invites.$inferInsert> = {}): Promise<string> {
  const code = overrides.code ?? `T-${rand(10).toUpperCase()}`;
  await testDb()
    .insert(invites)
    .values({ maxUses: 1, ...overrides, code });
  return code;
}

export async function inviteRow(code: string) {
  const [row] = await testDb().select().from(invites).where(eq(invites.code, code));
  return row ?? null;
}

export async function userByEmail(email: string) {
  const [row] = await testDb().select().from(user).where(eq(user.email, email.toLowerCase()));
  return row ?? null;
}

export async function userById(id: string) {
  const [row] = await testDb().select().from(user).where(eq(user.id, id));
  return row ?? null;
}

export async function sessionsOf(userId: string) {
  return testDb().select().from(session).where(eq(session.userId, userId));
}

export async function accountsOf(userId: string) {
  return testDb().select().from(account).where(eq(account.userId, userId));
}

export async function auditRows(where: {
  action: string;
  targetId?: string | null;
  actorUserId?: string | null;
}) {
  const rows = await testDb().select().from(auditLog).where(eq(auditLog.action, where.action));
  return rows.filter(
    (row) =>
      (where.targetId === undefined || row.targetId === where.targetId) &&
      (where.actorUserId === undefined || row.actorUserId === where.actorUserId),
  );
}

// ── mail ────────────────────────────────────────────────────────────────────────────────────
export type Mail = outbox.OutboxMessage & { template?: string; class?: string };

export function mailTo(address: string, template?: string): Mail[] {
  return (outbox.list({ to: address }) as Mail[]).filter(
    (m) => String(m.to).toLowerCase() === address.toLowerCase() && (!template || m.template === template),
  );
}

export async function waitForMail(address: string, template: string, count = 1): Promise<Mail> {
  return eventually(async () => {
    const found = mailTo(address, template);
    return found.length >= count ? found.at(-1)! : null;
  });
}

/**
 * Forgets the mail already counted against an address. For the ONE address every run shares
 * (ADMIN_EMAIL): its per-recipient cap (5 an hour) is otherwise used up by earlier runs, and the
 * sixth run in an hour would wait for a verification mail that was — correctly — never sent.
 */
export async function forgetMailCountOf(address: string): Promise<void> {
  await testDb()
    .delete(emailLedger)
    .where(eq(emailLedger.recipientHash, await recipientHash(env as unknown as Env, address)));
}

/** The first link in a message, as a path (its origin is asserted where a test is about origins). */
export function linkIn(mail: Mail): string {
  const match = /https?:\/\/[^\s"'<>)]+/.exec(mail.text ?? "");
  if (!match) throw new Error("no link in the message");
  const url = new URL(match[0]);
  return url.pathname + url.search;
}

// ── flows ───────────────────────────────────────────────────────────────────────────────────
export type SignUpInput = {
  email?: string;
  password?: string;
  name?: string;
  inviteCode?: string | null;
  birthYear?: number;
  birthMonth?: number;
  acceptTerms?: unknown;
  extra?: Record<string, unknown>;
};

/** POST /api/auth/sign-up/email with everything valid unless overridden. A fresh invite is made unless one is given. */
export async function signUp(client: Client, input: SignUpInput = {}) {
  const email = input.email ?? freshEmail();
  const inviteCode = input.inviteCode === undefined ? await createInvite() : input.inviteCode;
  const sent = await send(client, "/api/auth/sign-up/email", {
    json: {
      email,
      password: input.password ?? PASSWORD,
      name: input.name ?? "Test Person",
      ...(inviteCode === null ? {} : { inviteCode }),
      birthYear: "birthYear" in input ? input.birthYear : 1990,
      birthMonth: "birthMonth" in input ? input.birthMonth : 5,
      acceptTerms: "acceptTerms" in input ? input.acceptTerms : true,
      callbackURL: "/login?reason=verified",
      ...input.extra,
    },
    headers: CAPTCHA,
  });
  return { sent, email, inviteCode };
}

/** Sign up, follow the verification link: a verified user and a client holding its session. */
export async function verifiedUser(input: SignUpInput = {}, client: Client = newClient()) {
  const { sent, email } = await signUp(client, input);
  if (sent.status !== 200) throw new Error(`sign-up failed: ${sent.status} ${sent.text}`);
  const mail = await waitForMail(email, "verification");
  const verified = await send(client, linkIn(mail));
  if (verified.status !== 302) throw new Error(`verification failed: ${verified.status} ${verified.text}`);
  const row = await userByEmail(email);
  if (!row) throw new Error("the verified user has no row");
  return { client, email, user: row, password: input.password ?? PASSWORD };
}

export async function signIn(client: Client, email: string, password: string = PASSWORD) {
  return send(client, "/api/auth/sign-in/email", { json: { email, password }, headers: CAPTCHA });
}

export async function getSession(client: Client) {
  const sent = await send(client, "/api/auth/get-session");
  return sent.body as { user: Record<string, unknown>; session: Record<string, unknown> } | null;
}

// ── TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ──────────────────────────────────────────────────
function base32Decode(text: string): Uint8Array {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of text.replace(/=+$/, "").toUpperCase()) {
    const value = alphabet.indexOf(char);
    if (value === -1) continue;
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes = new Uint8Array(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

/** The current code for an `otpauth://` URI (or a bare base32 secret). */
export async function totp(uriOrSecret: string, at: number = Date.now()): Promise<string> {
  const secret = uriOrSecret.startsWith("otpauth://")
    ? (new URL(uriOrSecret).searchParams.get("secret") ?? "")
    : uriOrSecret;
  const counter = Math.floor(at / 1000 / 30);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    base32Decode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Enrols TOTP for the signed-in client. Returns the URI and the backup codes. */
export async function enableTotp(client: Client, password: string = PASSWORD) {
  const enabled = await send(client, "/api/auth/two-factor/enable", { json: { password } });
  if (enabled.status !== 200) throw new Error(`two-factor/enable failed: ${enabled.status} ${enabled.text}`);
  const { totpURI, backupCodes } = enabled.body as { totpURI: string; backupCodes: string[] };
  const verified = await send(client, "/api/auth/two-factor/verify-totp", {
    json: { code: await totp(totpURI) },
  });
  if (verified.status !== 200)
    throw new Error(`two-factor/verify-totp failed: ${verified.status} ${verified.text}`);
  return { totpURI, backupCodes };
}

/** The address the test environment's ADMIN_EMAILS names. */
export const ADMIN_EMAIL = "admin@example.test";

// ── files, links and shares (just enough for the account-state side effects) ────────────────
export async function makeFolder(ownerId: string, name = `folder-${rand(4)}`) {
  const [row] = await testDb()
    .insert(nodes)
    .values({
      ownerId,
      createdBy: ownerId,
      parentId: null,
      kind: "folder",
      name,
      nameKey: name.toLowerCase(),
      ext: "",
      scanStatus: "clean",
    })
    .returning();
  return row!;
}

export async function makeLink(nodeId: string, createdBy: string, pauseReasons: PauseReason[] = []) {
  const [row] = await testDb()
    .insert(shareLinks)
    .values({
      nodeId,
      createdBy,
      tokenHash: rand(32),
      tokenEnc: Buffer.from(crypto.getRandomValues(new Uint8Array(48))),
      tokenIv: Buffer.from(crypto.getRandomValues(new Uint8Array(12))),
      pausedAt: pauseReasons.length > 0 ? new Date() : null,
      pauseReasons,
    })
    .returning();
  return row!;
}

export async function linkById(id: string) {
  const [row] = await testDb().select().from(shareLinks).where(eq(shareLinks.id, id));
  return row!;
}

/** A share to an address that has no account yet. */
export async function makePendingShare(nodeId: string, grantedBy: string, email: string) {
  const [row] = await testDb()
    .insert(shares)
    .values({
      nodeId,
      grantedBy,
      granteeEmail: email,
      granteeUserId: null,
      activatedAt: null,
      role: "viewer",
    })
    .returning();
  return row!;
}

export async function shareById(id: string) {
  const [row] = await testDb().select().from(shares).where(eq(shares.id, id));
  return row ?? null;
}

// ── services called directly ────────────────────────────────────────────────────────────────
/** A `ServiceDeps` over the test database, and a way to wait for what was deferred on it. */
export function serviceDeps(overrides: Record<string, unknown> = {}) {
  const deferred: Promise<unknown>[] = [];
  const deps: ServiceDeps = {
    db: testDb(),
    env: { ...env, ...overrides } as unknown as Env,
    defer: (promise) => void deferred.push(promise),
  };
  return {
    deps,
    deferred,
    async settle() {
      while (deferred.length) await Promise.allSettled(deferred.splice(0));
    },
  };
}

/** Makes a signed-in user what `requireAdmin` and the admin gate ask for: the role and two-factor. */
export async function promoteToAdmin(userId: string, twoFactor = true) {
  await testDb().update(user).set({ role: "admin", twoFactorEnabled: twoFactor }).where(eq(user.id, userId));
}
