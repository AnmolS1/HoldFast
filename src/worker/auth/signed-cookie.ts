// Two small signed cookies of our own, beside Better Auth's:
//
//   hf_intent    set by POST /api/auth-intent before a Google sign-up: the person has stated
//                their age and accepted the terms (and named an invite). Read once by the
//                sign-up policy when the OAuth callback creates the account. 10 minutes,
//                SINGLE-USE — its nonce is a row in `verification` that the sign-up deletes
//                (db/queries/auth-lifecycle.ts), so a copied cookie admits one account, not two.
//                It carries no birth date: only the fact that the age check passed.
//   hf_pending   set when POST /api/auth/sign-up/email answers: this browser just signed up with
//                that address. It is what lets the "check your email" screen change a mistyped
//                address (PATCH /api/account/pending-email) — an unverified account has no
//                session — and what lets the verification link keep the password and sign this
//                browser in (auth/mailbox-proof.ts): opened anywhere else, the link proves the
//                mailbox only. 1 hour, and it works only while the account is unverified.
//
// Both are `HttpOnly; SameSite=Lax; Path=/`, and on an https origin `Secure` with the `__Host-`
// name prefix (`COOKIE_HOST_PREFIX` below — the same prefix Better Auth's cookies get), and are
// a base64url JSON payload
// plus an HMAC-SHA256 under a purpose key of their own (services/keys.ts) — signed, not
// encrypted: nothing in them is secret from the browser that holds them. A cookie whose
// signature, version or expiry does not check out is simply absent.

import type { Keys, KeyPurpose } from "../services/keys";

type CookieSpec = {
  base: string;
  path: string;
  maxAge: number;
  purpose: Exclude<KeyPurpose, "link-token-enc">;
};

export const INTENT_COOKIE: CookieSpec = {
  base: "hf_intent",
  // `/`: a `__Host-` cookie may have no other path.
  path: "/",
  maxAge: 600,
  purpose: "intent-cookie",
};
export const PENDING_COOKIE: CookieSpec = {
  base: "hf_pending",
  // Read in two places: PATCH /api/account/pending-email, and the verification link
  // (GET /api/auth/verify-email — auth/mailbox-proof.ts), where it is what tells the browser
  // that signed up from any other browser that opens the mailed link.
  path: "/",
  maxAge: 3600,
  purpose: "account-action",
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

const isSecure = (env: Pick<Env, "APP_ORIGIN">) => env.APP_ORIGIN.startsWith("https://");

/**
 * The name prefix of EVERY cookie the auth layer sets on an https origin — these two and Better
 * Auth's (create-auth.ts `cookiePrefix`).
 *
 * `__Host-`, not `__Secure-`. The app lives on a subdomain of a domain it shares with other
 * sites (and with its own dev deploy). A `__Secure-` cookie can be set for the whole parent
 * domain by ANY of them (`Domain=<parent>`): script on a sibling could plant a session cookie of
 * the attacker's own account in a victim's browser, who then uploads into it. A browser accepts
 * a `__Host-` cookie only with `Secure`, `Path=/` and NO `Domain` — only this exact host can set
 * it.
 */
export const COOKIE_HOST_PREFIX = "__Host-";

/** The session cookie's name on this origin. */
export function sessionCookieName(env: Pick<Env, "APP_ORIGIN">): string {
  return `${isSecure(env) ? COOKIE_HOST_PREFIX : ""}hf.session_token`;
}

export function cookieName(env: Pick<Env, "APP_ORIGIN">, spec: CookieSpec): string {
  return `${isSecure(env) ? COOKIE_HOST_PREFIX : ""}${spec.base}`;
}

/** The attributes as Better Auth's `ctx.setCookie` takes them. */
export function cookieAttributes(env: Pick<Env, "APP_ORIGIN">, spec: CookieSpec, maxAge = spec.maxAge) {
  return { maxAge, path: spec.path, httpOnly: true, sameSite: "lax" as const, secure: isSecure(env) };
}

/** A whole `Set-Cookie` value. `value: null` expires the cookie. */
export function setCookieHeader(
  env: Pick<Env, "APP_ORIGIN">,
  spec: CookieSpec,
  value: string | null,
): string {
  const parts = [
    `${cookieName(env, spec)}=${value ?? ""}`,
    `Max-Age=${value === null ? 0 : spec.maxAge}`,
    `Path=${spec.path}`,
    "HttpOnly",
    "SameSite=Lax",
  ];
  if (isSecure(env)) parts.push("Secure");
  return parts.join("; ");
}

/** The raw value of one cookie in a `Cookie` header, or null. The LAST one wins nothing: a name sent twice is refused. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  const found: string[] = [];
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) found.push(part.slice(eq + 1).trim());
  }
  return found.length === 1 ? found[0]! : null;
}

/** The version of the signed payload. 2: the payload names its own cookie (`p`). */
const PAYLOAD_VERSION = 2;

/**
 * `payload` (must carry `e`, the expiry in epoch seconds) as a signed cookie value. What is
 * signed always says WHICH cookie it is (`p`) and its version (`v`), beside what the caller
 * binds it to (the account, the nonce, the expiry): a value signed as one cookie is not another,
 * even where two cookies are signed under one purpose key.
 */
export async function sign(keys: Keys, spec: CookieSpec, payload: Record<string, unknown>): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify({ ...payload, v: PAYLOAD_VERSION, p: spec.base })));
  const mac = await crypto.subtle.sign("HMAC", await keys.get(spec.purpose), encoder.encode(body));
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The payload of a value this Worker signed and that has not expired; otherwise null. */
export async function verify(
  keys: Keys,
  spec: CookieSpec,
  value: string | null,
  at: Date,
): Promise<Record<string, unknown> | null> {
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot < 1 || dot !== value.lastIndexOf(".")) return null;
  const body = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const mac = fromBase64Url(signature);
  const raw = fromBase64Url(body);
  if (!mac || !raw || mac.length !== 32) return null;
  // One spelling per signature: base64 has spare bits in its last character, and a value that
  // differs only there would decode to the same bytes.
  if (toBase64Url(mac) !== signature) return null;
  // `verify` compares in constant time.
  const valid = await crypto.subtle.verify("HMAC", await keys.get(spec.purpose), mac, encoder.encode(body));
  if (!valid) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(decoder.decode(raw));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (record.v !== PAYLOAD_VERSION || record.p !== spec.base) return null;
  if (typeof record.e !== "number" || record.e * 1000 <= at.getTime()) return null;
  return record;
}

// ── the sign-up intent ──────────────────────────────────────────────────────────────────────

export type Intent = { nonce: string; inviteCode: string | null };

/** The value of a fresh intent cookie and its single-use nonce (the caller records the nonce). */
export async function mintIntent(
  keys: Keys,
  inviteCode: string | null,
  at: Date,
): Promise<{ value: string; nonce: string; expiresAt: Date }> {
  const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const expiresAt = new Date(at.getTime() + INTENT_COOKIE.maxAge * 1000);
  const value = await sign(keys, INTENT_COOKIE, {
    e: Math.floor(expiresAt.getTime() / 1000),
    n: nonce,
    i: inviteCode,
  });
  return { value, nonce, expiresAt };
}

export async function readIntent(
  env: Pick<Env, "APP_ORIGIN">,
  keys: Keys,
  cookieHeader: string | null | undefined,
  at: Date,
): Promise<Intent | null> {
  const payload = await verify(
    keys,
    INTENT_COOKIE,
    readCookie(cookieHeader, cookieName(env, INTENT_COOKIE)),
    at,
  );
  if (!payload || typeof payload.n !== "string" || payload.n.length < 16) return null;
  if (payload.i !== null && typeof payload.i !== "string") return null;
  return { nonce: payload.n, inviteCode: payload.i };
}

// ── the pending sign-up ─────────────────────────────────────────────────────────────────────

/** How many times one sign-up may change its pending address. */
export const PENDING_MAX_CHANGES = 5;

/**
 * `userId` is the account the sign-up created — or, for the look-alike answer to a sign-up with
 * an address that already has an account, an id that names nobody. The two are the same shape,
 * so the cookie (which the browser can read) does not say which it was.
 */
export type Pending = { email: string; userId: string; changes: number };

export async function mintPending(
  keys: Keys,
  who: { email: string; userId: string },
  changes: number,
  at: Date,
): Promise<string> {
  return sign(keys, PENDING_COOKIE, {
    e: Math.floor(at.getTime() / 1000) + PENDING_COOKIE.maxAge,
    m: who.email,
    u: who.userId,
    c: changes,
  });
}

export async function readPending(
  env: Pick<Env, "APP_ORIGIN">,
  keys: Keys,
  cookieHeader: string | null | undefined,
  at: Date,
): Promise<Pending | null> {
  const payload = await verify(
    keys,
    PENDING_COOKIE,
    readCookie(cookieHeader, cookieName(env, PENDING_COOKIE)),
    at,
  );
  if (!payload || typeof payload.m !== "string" || typeof payload.u !== "string") return null;
  if (typeof payload.c !== "number" || !Number.isInteger(payload.c) || payload.c < 0) return null;
  return { email: payload.m, userId: payload.u, changes: payload.c };
}
