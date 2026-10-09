// What an unauthenticated auth request has to get past BEFORE it may cost anything.
//
// The endpoints a stranger can call do expensive things by design — a password hash (scrypt,
// tens of milliseconds of CPU), a fixed number of database round trips (auth/parity.ts), a
// captcha verification, a breach look-up. None of that may be had for a request that could have
// been refused for free. The order, for every such request:
//
//   (a) FREE REFUSALS — no database, no hash, no network: this file. The method, a JSON
//       content type, a body of at most MAX_BODY_BYTES, a JSON object, and each field the
//       endpoint needs present, of its type and within its length (an address ≤ 254, a password
//       12–128 where one is being CHOSEN and ≤ 128 where one is being tried, a code in its
//       format), and the captcha header present where the endpoint needs one. The answer says
//       only which FIELDS of the caller's own request are wrong — never a value, never anything
//       about an account.
//   (b) THE LIMITERS — `RL_AUTH` (20 a minute per client address, middleware/rate-limit.ts —
//       it runs in the pipeline, in front of this route), the global guard below for the
//       endpoints that hash, then Better Auth's own per-address rules.
//   (c) THE CAPTCHA, verified (Better Auth's plugin, in its `onRequest` — before any endpoint
//       code, any hook of ours and any password work).
//   (d) only then the constant-shape section: the sign-up statement and breach check, one
//       hash, the endpoint's fixed number of statements. `hooks.before` marks the request as
//       having reached it; only such a request is padded (a refusal at (a)–(c) is not).
//
// THE GLOBAL GUARD. Per-address limits do not bound a flood from many addresses, and every
// request that reaches a hash costs CPU. The endpoints in HASH_PATHS share ONE counter per
// Cloudflare location — HASH_GUARD_LIMIT a minute (the `RL_API` namespace's limit, under a key
// of its own) — and are refused `429` beyond it. At ~0.1 s of CPU a hash that is at most about a
// minute of CPU per minute per location, whatever the number of clients; one request does at
// most ONE hash (a tenth of a second against a 120 s CPU limit).

import { enforceRateLimit } from "../services/ratelimit";

export const MAX_BODY_BYTES = 8 * 1024;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;

/** Requests a minute, per location, that may reach a password hash (all clients together). */
export const HASH_GUARD_LIMIT = 600;
const HASH_GUARD_KEY = "global:auth-hash";

/** The endpoints (relative to /api/auth) on which a password is hashed or verified. */
export const HASH_PATHS: ReadonlySet<string> = new Set([
  "/sign-up/email",
  "/sign-in/email",
  "/reset-password",
  "/change-password",
  "/verify-password",
  "/two-factor/enable",
  "/two-factor/disable",
  "/two-factor/generate-backup-codes",
  "/two-factor/get-totp-uri",
]);

type Rule = (value: unknown) => boolean;
const text =
  (min: number, max: number, shape?: RegExp): Rule =>
  (value) =>
    typeof value === "string" && value.length >= min && value.length <= max && (!shape || shape.test(value));
const optional =
  (rule: Rule): Rule =>
  (value) =>
    value === undefined || value === null || rule(value);

// A shape check only (the sign-up policy judges the domain): something@something, no spaces.
const email = text(3, EMAIL_MAX, /^[^\s@]+@[^\s@]+\.[^\s@]+$/);
const link = optional(text(1, 2048));

type Spec = {
  fields: Record<string, Rule>;
  /** The Turnstile header must be present (it is VERIFIED later, by the plugin). */
  captcha?: boolean;
};

/** Every unauthenticated POST under /api/auth, and what its body must be. */
export const PREFLIGHT: Readonly<Record<string, Spec>> = Object.freeze({
  "/sign-up/email": {
    captcha: true,
    fields: {
      email,
      // A password being chosen: the policy's own bounds.
      password: text(PASSWORD_MIN, PASSWORD_MAX),
      name: text(1, 80),
      inviteCode: optional(text(1, 64)),
      // The age statement and the assent are judged by the sign-up policy (stage d), which
      // answers them in its own neutral words.
      callbackURL: link,
    },
  },
  "/sign-in/email": {
    captcha: true,
    // A password being TRIED: any length a password could have had.
    fields: { email, password: text(1, PASSWORD_MAX), callbackURL: link },
  },
  "/request-password-reset": { captcha: true, fields: { email, redirectTo: link } },
  "/send-verification-email": { captcha: true, fields: { email, callbackURL: link } },
  "/reset-password": {
    fields: { newPassword: text(PASSWORD_MIN, PASSWORD_MAX), token: text(1, 128, /^[A-Za-z0-9_-]+$/) },
  },
  "/two-factor/verify-totp": { fields: { code: text(6, 6, /^\d{6}$/) } },
  "/two-factor/verify-backup-code": { fields: { code: text(1, 32, /^[A-Za-z0-9-]+$/) } },
});

export const CAPTCHA_HEADER = "x-captcha-response";

export type Refusal = { status: 400 | 413 | 415; body: Record<string, unknown> };

const refuse = (
  status: Refusal["status"],
  code: string,
  message: string,
  fields: string[] = [],
): Refusal => ({
  status,
  body: { error: "validation", code, message, ...(fields.length > 0 ? { details: { fields } } : {}) },
});

/** At most `MAX_BODY_BYTES` of the body, parsed — or why not. Reads a copy. */
async function readBody(request: Request): Promise<{ json: unknown } | Refusal> {
  const type = (request.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return refuse(415, "VALIDATION", "Send the request as JSON.");
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    return refuse(413, "VALIDATION", "The request is too large.");
  }
  const reader = request.clone().body?.getReader();
  if (!reader) return refuse(400, "VALIDATION", "The request has no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return refuse(413, "VALIDATION", "The request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { json: JSON.parse(new TextDecoder().decode(bytes)) as unknown };
  } catch {
    return refuse(400, "VALIDATION", "The request is not valid JSON.");
  }
}

/**
 * Stage (a) for one request: null when it may go on (with its parsed body, for the route), or
 * the refusal. Touches nothing but the request.
 */
export async function preflight(
  relativePath: string,
  request: Request,
): Promise<{ refusal: Refusal } | { refusal: null; body: unknown }> {
  const spec = PREFLIGHT[relativePath];
  if (!spec || request.method !== "POST") return { refusal: null, body: null };
  // The cheapest first: a header that is not there.
  if (spec.captcha) {
    const token = request.headers.get(CAPTCHA_HEADER);
    if (!token || token.length > 4096) {
      return {
        refusal: { status: 400, body: { code: "MISSING_RESPONSE", message: "Missing CAPTCHA response" } },
      };
    }
  }
  const read = await readBody(request);
  if ("status" in read) return { refusal: read };
  const body = read.json;
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { refusal: refuse(400, "VALIDATION", "The request must be a JSON object.") };
  }
  const record = body as Record<string, unknown>;
  const wrong = Object.entries(spec.fields)
    .filter(([name, rule]) => !rule(Object.hasOwn(record, name) ? record[name] : undefined))
    .map(([name]) => name);
  if (wrong.length > 0) {
    // Better Auth's own code where it has one for the field, so the forms keep their sentences.
    const password = wrong.find((name) => name === "password" || name === "newPassword");
    const value = password ? record[password] : undefined;
    const code =
      typeof value === "string" && value.length > PASSWORD_MAX
        ? "PASSWORD_TOO_LONG"
        : typeof value === "string" && wrong.length === 1 && relativePath !== "/sign-in/email"
          ? "PASSWORD_TOO_SHORT"
          : wrong.length === 1 && wrong[0] === "email"
            ? "INVALID_EMAIL"
            : "VALIDATION";
    return { refusal: refuse(400, code, "Check the request: some fields are missing or not valid.", wrong) };
  }
  return { refusal: null, body };
}

/** Stage (b), the global part: one counter per location for every request that may reach a hash. */
export async function hashGuard(
  env: Parameters<typeof enforceRateLimit>[0],
  relativePath: string,
): Promise<void> {
  if (HASH_PATHS.has(relativePath)) await enforceRateLimit(env, "RL_API", HASH_GUARD_KEY);
}
