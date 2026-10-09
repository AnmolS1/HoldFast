// "This SESSION passed a second factor" — `session.secondFactorAt`. Security-critical; small.
//
// Whether an account HAS two-factor says nothing about how the session in hand was made. Better
// Auth's two-factor plugin challenges only a password sign-in
// (better-auth/dist/plugins/two-factor/index.mjs: the after-hook matches `/sign-in/email`,
// `/sign-in/username`, `/sign-in/phone-number`); a session made by Google, by a passkey, by a
// trusted-device cookie or by a mailed link never meets it. So admin access is tied to the
// session (middleware/guards.ts `requireAdmin`, auth/admin-gate.ts): it needs a `secondFactorAt`
// no older than SECOND_FACTOR_MAX_AGE_MS.
//
// ── WHO WRITES THE FIELD ──────────────────────────────────────────────────────────────────────
// Two statements in the whole Worker write a non-null value, both reached only from this file:
//   `session.create.before` (hooks.ts) writes `secondFactorOfNewSession()` on EVERY new session —
//       null unless one of the grants below was recorded by this very request;
//   `stampSecondFactor` marks the one existing, non-impersonated session that stepped up.
// The field is `input: false`: Better Auth refuses a request body that carries it
// (dist/db/schema.mjs `parseInputData` → FIELD_NOT_ALLOWED). A session refresh updates
// `expiresAt` only; a session Better Auth makes by copying another gets the hook's null.
//
// THE GRANTS — each a proof given in THIS request, for the session's OWN user:
//   1. SIGN-IN: the second step of a password sign-in. No session exists yet; the code answers
//      the plugin's signed challenge cookie, and Better Auth creates the session only once its
//      own verifier accepted the code (totp/index.mjs, backup-codes/index.mjs `valid()`).
//   2. STEP-UP: a correct code sent to the same two endpoints BY a session — one that is not
//      impersonated, whose account is not restricted, and whose two-factor enrolment is complete.
//      This is how a session from Google, a trusted device or a passkey becomes able to act as
//      an admin.
//   3. ENROLMENT: the code that confirms a new enrolment marks the session only when that same
//      session proved the PASSWORD in the last ten minutes (`/two-factor/enable` — Better Auth
//      always requires the password there: utils/password.mjs `shouldRequirePassword` is true
//      unless `allowPasswordless` is set, which it is not). A session cannot hand itself a second
//      factor: enabling, switching off and re-issuing backup codes all need the password, and an
//      account with no password cannot enrol at all.
//   4. PASSKEY with user verification — and ONLY a passkey that was registered by a session
//      which had itself passed a second factor. The plugin never requires user verification
//      (@better-auth/passkey/dist/index.mjs: `requireUserVerification: false`) and lets ANY
//      fresh session register a passkey (`freshSessionMiddleware` only). Without the second
//      condition a stolen one-factor session could register its own key, sign in with it and
//      come back "two-factor". The assertion's flag is read in `authentication.afterVerification`
//      (`authenticationInfo.userVerified`, @simplewebauthn/server).
//
// ── WHAT A CODE HAS TO GET PAST, in this order (`beforeSecondFactor`) ─────────────────────────
//   a. the ATTEMPT BUDGET — per ACCOUNT, atomic. `admitSecondFactorAttempt` is one UPDATE that
//      counts the attempt and matches no row while the account is locked, so N simultaneous
//      guesses are admitted at most SECOND_FACTOR_MAX_ATTEMPTS times in a window, whatever
//      sessions and addresses they come from. The attempt that uses the last one locks the
//      account for SECOND_FACTOR_LOCK_S; a correct code clears the count. One budget for sign-in
//      and step-up, TOTP and backup codes. (Better Auth's own lock is check-then-count, applies
//      to the sign-in challenge only, and is switched off: create-auth.ts `accountLockout`.)
//      The lock is bounded (it lifts by itself), audited, and the owner is mailed.
//   b. for TOTP, OUR OWN verification against the stored secret (constant-time, the current
//      30-second step and the one either side), which says WHICH step the code belongs to — and
//      then REPLAY protection: `acceptTotpStep` records the step under the account's row lock
//      and refuses a step that is not newer than the last one accepted. Better Auth's verifier
//      runs afterwards as well; a code must pass both.
//   Backup codes are verified and consumed by Better Auth in one conditional update
//   (backup-codes/index.mjs: `where backupCodes = <the value read>`), so one works once.
//
// ── WHEN THE MARK IS TAKEN AWAY ───────────────────────────────────────────────────────────────
// By age (SECOND_FACTOR_MAX_AGE_MS), and at once on: a role change of the account, a password
// change or reset (Better Auth replaces or deletes the sessions), any two-factor change (on,
// off, new backup codes) for every OTHER session, and the end of an impersonation (the admin's
// own sessions: they prove the factor again before the next admin action).

import { generateId } from "@better-auth/core/utils/id";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { hasAdminRole } from "../../shared/roles";
import {
  acceptTotpStep,
  admitSecondFactorAttempt,
  clearSecondFactor,
  deleteAuthMarker,
  hasAuthMarker,
  passkeyByCredential,
  putAuthMarker,
  resetSecondFactorAttempts,
  secondFactorState,
  stampSecondFactor,
} from "../db/queries/auth-lifecycle";
import { revokeSessions } from "../services/account-state";
import { now } from "../services/clock";
import { sendSecondFactorLocked } from "../services/email";
import { record } from "./observe";
import type { AuthScope } from "./scope";

export const VERIFY_TOTP_PATH = "/two-factor/verify-totp";
export const VERIFY_BACKUP_CODE_PATH = "/two-factor/verify-backup-code";
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";
const CODE_PATHS = new Set([VERIFY_TOTP_PATH, VERIFY_BACKUP_CODE_PATH]);

/** Attempts at an account's second factor before it is locked; a correct code starts the count again. */
export const SECOND_FACTOR_MAX_ATTEMPTS = 5;
/** How long a locked account refuses codes. Bounded: it lifts by itself. */
export const SECOND_FACTOR_LOCK_S = 15 * 60;
/** How old a session's second factor may be for an admin action. */
export const SECOND_FACTOR_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** How long after proving the password an enrolment's confirmation still marks the session. */
export const ENROL_PROOF_S = 10 * 60;

const TOTP_PERIOD_S = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

/** Better Auth's own codes and sentences (plugins/two-factor/error-code.mjs). */
const INVALID_CODE = { code: "INVALID_CODE", message: "Invalid code" } as const;
const LOCKED = {
  code: "ACCOUNT_TEMPORARILY_LOCKED",
  message:
    "Too many failed verification attempts. Your account is temporarily locked. Please try again later.",
} as const;
const NOT_AVAILABLE = {
  code: "SECOND_FACTOR_NOT_AVAILABLE",
  message: "This is not available for this session.",
};

/** The name of the plugin's challenge cookie (plugins/two-factor/constant.mjs). */
const TWO_FACTOR_COOKIE = "two_factor";

const enrolProof = (sessionId: string) => `2fa-enrol:${sessionId}`;
const passkeyProof = (passkeyId: string) => `passkey-2f:${passkeyId}`;

/** Does this session carry a second factor that is still fresh enough for an admin action? */
export function hasSecondFactor(
  session: { secondFactorAt?: unknown; impersonatedBy?: unknown } | null | undefined,
  at: number = Date.now(),
): boolean {
  if (!session || session.impersonatedBy) return false;
  const value = session.secondFactorAt;
  if (value === null || value === undefined) return false;
  const passed = value instanceof Date ? value : new Date(value as string | number);
  const time = passed.getTime();
  // In the future is not "fresh": it is wrong.
  return !Number.isNaN(time) && time <= at + 60_000 && at - time <= SECOND_FACTOR_MAX_AGE_MS;
}

/**
 * `secondFactorAt` for a session being created by this request: the time when a grant was
 * recorded by this request (see the header), otherwise null. Called from `session.create.before`
 * for EVERY new session, and its answer is always written.
 */
export function secondFactorOfNewSession(
  scope: AuthScope,
  session: { userId: string; impersonatedBy?: unknown },
): Date | null {
  if (session.impersonatedBy) return null;
  const path = scope.facts.endpointPath;
  const code = scope.facts.secondFactor;
  if (path !== null && CODE_PATHS.has(path) && code?.grantsNewSession && code.userId === session.userId) {
    return now();
  }
  if (path === PASSKEY_SIGN_IN_PATH && scope.facts.passkeySecondFactorFor === session.userId) return now();
  return null;
}

// ── TOTP, verified here (RFC 6238 over HMAC-SHA-1, as the plugin's own verifier) ─────────────

async function hotp(key: CryptoKey, counter: number): Promise<string> {
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

function sameCode(input: string, expected: string): boolean {
  let difference = input.length ^ expected.length;
  for (let index = 0; index < expected.length; index++) {
    difference |= (input.charCodeAt(index) || 0) ^ expected.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * The time-step `code` is the TOTP of, among the current step and its neighbours — or null.
 * Every candidate is computed and compared, whichever matches.
 */
export async function totpStepOf(
  secret: string,
  code: string,
  at: number = Date.now(),
): Promise<number | null> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const current = Math.floor(at / 1000 / TOTP_PERIOD_S);
  let matched: number | null = null;
  for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
    const candidate = await hotp(key, current + offset);
    // The newest matching step, should two neighbours ever share a code.
    if (sameCode(code, candidate)) matched = current + offset;
  }
  return matched;
}

// ── the passkey plugin ───────────────────────────────────────────────────────────────────────

/** The passkey plugin's `authentication` options: where the assertion's user-verification flag is seen. */
export function passkeyAuthentication(scope: AuthScope) {
  return {
    afterVerification: async (args: {
      verification: { verified?: boolean; authenticationInfo?: { userVerified?: boolean } };
      clientData?: { id?: unknown };
    }): Promise<void> => {
      scope.facts.passkeySecondFactorFor = null;
      if (args.verification.verified !== true) return;
      if (args.verification.authenticationInfo?.userVerified !== true) return;
      const credentialId = args.clientData?.id;
      if (typeof credentialId !== "string" || credentialId === "") return;
      const key = await passkeyByCredential(scope.db, credentialId);
      if (!key) return;
      // Only a key that a second-factor session registered (`afterPasskeyRegistered`).
      if (await hasAuthMarker(scope.db, passkeyProof(key.id), key.userId)) {
        scope.facts.passkeySecondFactorFor = key.userId;
      }
    },
  };
}

type SessionContext = {
  context: {
    session?: {
      session: { id: string; secondFactorAt?: unknown; impersonatedBy?: unknown };
      user: { id: string };
    } | null;
    returned?: unknown;
  };
  body?: unknown;
};

const succeeded = (ctx: { context: { returned?: unknown } }) => !(ctx.context.returned instanceof Error);

/** After `/passkey/verify-registration`: remember that a second-factor session registered this key. */
export async function afterPasskeyRegistered(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  const session = ctx.context.session;
  const created = ctx.context.returned as { id?: unknown; userId?: unknown } | null | undefined;
  if (!session || typeof created?.id !== "string" || created.userId !== session.user.id) return;
  if (!hasSecondFactor(session.session)) return;
  await putAuthMarker(scope.db, {
    id: generateId(),
    identifier: passkeyProof(created.id),
    userId: session.user.id,
    // A fact about the key, for as long as the key exists (deleted with it, and with the account).
    expiresAt: new Date(Date.now() + 50 * 365 * 24 * 60 * 60 * 1000),
  });
}

/** After `/passkey/delete-passkey`: the fact about the key goes with the key. */
export async function afterPasskeyDeleted(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  const id = (ctx.body as { id?: unknown } | undefined)?.id;
  if (typeof id === "string" && id !== "") await deleteAuthMarker(scope.db, passkeyProof(id));
}

// ── two-factor changes ───────────────────────────────────────────────────────────────────────

/** After `/two-factor/enable` (Better Auth has checked the password): this session may confirm the enrolment. */
export async function afterTwoFactorEnable(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  const session = ctx.context.session;
  const body = (ctx.body ?? {}) as { password?: unknown };
  // Belt and braces: the endpoint cannot succeed without the password, and this says so again.
  if (!session || session.session.impersonatedBy || typeof body.password !== "string" || body.password === "")
    return;
  await putAuthMarker(scope.db, {
    id: generateId(),
    identifier: enrolProof(session.session.id),
    userId: session.user.id,
    expiresAt: new Date(Date.now() + ENROL_PROOF_S * 1000),
  });
}

/** After `/two-factor/disable` and `/two-factor/generate-backup-codes`: every session proves the factor again. */
export async function afterTwoFactorChange(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  const userId = ctx.context.session?.user.id;
  if (userId) await clearSecondFactor(scope.db, userId);
}

/**
 * After `/admin/set-role`: a change of privilege ends every session of the account whose role
 * changed — it signs in again, as what it now is (and proves its second factor again).
 */
export async function afterRoleChange(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
  if (typeof userId === "string" && userId !== "") await revokeSessions(scope.deps, userId);
}

/** After `/admin/stop-impersonating`: the admin who was impersonating proves the factor again. */
export async function afterImpersonationStopped(scope: AuthScope, ctx: SessionContext): Promise<void> {
  const adminId = scope.facts.impersonatorId;
  scope.facts.impersonatorId = null;
  if (!succeeded(ctx) || !adminId) return;
  await clearSecondFactor(scope.db, adminId);
}

// ── the two code endpoints ───────────────────────────────────────────────────────────────────

type CodeContext = Parameters<typeof getSessionFromCtx>[0] & {
  path?: string;
  request?: Request;
  body?: unknown;
  getSignedCookie(name: string, secret: string): Promise<string | null | undefined | false>;
  context: {
    secret: string;
    secretConfig: Parameters<typeof symmetricDecrypt>[0]["key"];
    returned?: unknown;
    createAuthCookie(name: string): { name: string };
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null | undefined>;
    };
  };
};

type Challenged = { userId: string; sessionId: string | null; impersonated: boolean };

/** Who is answering: the session's own user, or the user the signed challenge cookie names. */
async function challenged(ctx: CodeContext): Promise<Challenged | null> {
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  if (session) {
    const impersonatedBy = (session.session as { impersonatedBy?: unknown }).impersonatedBy;
    return { userId: session.user.id, sessionId: session.session.id, impersonated: Boolean(impersonatedBy) };
  }
  try {
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!identifier) return null;
    const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
    return row ? { userId: row.value, sessionId: null, impersonated: false } : null;
  } catch {
    return null;
  }
}

const methodOf = (path: string) => (path === VERIFY_TOTP_PATH ? "totp" : "backup_code");

/**
 * `hooks.before` for the two code endpoints (HTTP requests only). Throws the refusal, or returns
 * — after counting the attempt — to let Better Auth's own verifier run. Returns the body the
 * endpoint must see instead of the request's, or undefined.
 */
export async function beforeSecondFactor(
  scope: AuthScope,
  ctx: CodeContext,
): Promise<Record<string, unknown> | undefined> {
  scope.facts.secondFactor = null;
  if (!ctx.request || typeof ctx.path !== "string" || !CODE_PATHS.has(ctx.path)) return undefined;
  const who = await challenged(ctx);
  // Neither a session nor a challenge: Better Auth answers (INVALID_TWO_FACTOR_COOKIE).
  if (!who) return undefined;
  // An impersonated session is the target's, looked through by an admin: it proves nothing.
  if (who.impersonated) throw new APIError("FORBIDDEN", { ...NOT_AVAILABLE });
  const state = await secondFactorState(scope.db, who.userId);
  // No enrolment: Better Auth answers (TOTP_NOT_ENABLED / BACKUP_CODES_NOT_ENABLED) — to the
  // account's own session or to somebody who already has its password; nobody else gets here.
  if (!state) return undefined;
  if (state.restricted) throw new APIError("FORBIDDEN", { ...NOT_AVAILABLE });

  const mode = who.sessionId === null ? "sign_in" : state.verified ? "step_up" : "enrolment";
  const method = methodOf(ctx.path);
  // A backup code is for an enrolment that is complete.
  if (mode === "enrolment" && method !== "totp") throw new APIError("FORBIDDEN", { ...NOT_AVAILABLE });

  // a. The budget — counted now, before the code is looked at.
  const admitted = await admitSecondFactorAttempt(
    scope.db,
    who.userId,
    SECOND_FACTOR_MAX_ATTEMPTS,
    SECOND_FACTOR_LOCK_S,
  );
  if (!admitted) {
    record(
      scope.deps,
      "auth.second_factor_refused",
      { type: "user", id: who.userId },
      { method, mode, reason: "locked" },
    );
    throw new APIError("TOO_MANY_REQUESTS", { ...LOCKED });
  }
  const attempt = {
    userId: who.userId,
    sessionId: who.sessionId,
    mode,
    method,
    lockedNow: admitted.lockedNow,
    grantsNewSession: false,
    proved: false,
    backupCodesBefore: method === "backup_code" ? state.backupCodes : null,
    email: state.email,
    name: state.name,
  } as const;
  scope.facts.secondFactor = { ...attempt };

  const body = (ctx.body ?? {}) as Record<string, unknown>;
  // b. TOTP: verified here first, so that the step is known — and a step is accepted once.
  if (method === "totp") {
    const code = typeof body.code === "string" ? body.code : "";
    let step: number | null = null;
    try {
      const secret = await symmetricDecrypt({ key: ctx.context.secretConfig, data: state.secret });
      step = /^\d{6}$/.test(code) ? await totpStepOf(secret, code) : null;
    } catch {
      step = null;
    }
    const fresh = step !== null && (await acceptTotpStep(scope.db, who.userId, { id: generateId(), step }));
    if (!fresh) {
      await afterSecondFactorFailure(scope, step === null ? "wrong_code" : "replayed_code");
      throw new APIError("UNAUTHORIZED", { ...INVALID_CODE });
    }
  }

  // What a session created by the endpoint may carry (see the header).
  let grantsNewSession = mode === "sign_in";
  if (mode === "enrolment" && who.sessionId !== null) {
    grantsNewSession = await hasAuthMarker(scope.db, enrolProof(who.sessionId), who.userId);
  }
  // A TOTP code that got here was verified above, against the account's own secret, and its step
  // was accepted for the first time: that is the proof. A backup code is proved afterwards.
  scope.facts.secondFactor = { ...attempt, grantsNewSession, proved: method === "totp" };

  // "Remember this device" is not offered to an admin.
  if (body.trustDevice && hasAdminRole(state.role)) return { ...body, trustDevice: false };
  return undefined;
}

/** A refused or wrong code: audited without the code; the lock, when this attempt set it, is announced. */
async function afterSecondFactorFailure(scope: AuthScope, reason: string): Promise<void> {
  const attempt = scope.facts.secondFactor;
  scope.facts.secondFactor = null;
  if (!attempt) return;
  record(
    scope.deps,
    "auth.second_factor_failed",
    { type: "user", id: attempt.userId },
    { method: attempt.method, mode: attempt.mode, reason },
    { actorUserId: attempt.userId, actorType: "user" },
  );
  if (attempt.lockedNow) {
    record(
      scope.deps,
      "auth.second_factor_locked",
      { type: "user", id: attempt.userId },
      { attempts: SECOND_FACTOR_MAX_ATTEMPTS, seconds: SECOND_FACTOR_LOCK_S },
    );
    scope.deps.defer(
      sendSecondFactorLocked(scope.deps, {
        to: attempt.email,
        name: attempt.name,
        minutes: Math.round(SECOND_FACTOR_LOCK_S / 60),
      }).catch(() => {}),
    );
  }
}

/** `hooks.after` for the two code endpoints: the count, the mark, the audit rows. */
export async function afterSecondFactor(scope: AuthScope, ctx: CodeContext): Promise<void> {
  const attempt = scope.facts.secondFactor;
  if (!attempt || typeof ctx.path !== "string" || !CODE_PATHS.has(ctx.path)) return;
  if (ctx.context.returned instanceof Error) {
    await afterSecondFactorFailure(scope, "wrong_code");
    return;
  }
  // FAIL-CLOSED: the count starts again only on positive proof that THIS request presented a valid
  // factor of THIS account — never because the endpoint "did not fail". TOTP: our own check, in
  // `beforeSecondFactor`. A backup code: the plugin has USED one — the stored codes are no longer
  // what they were (plugins/two-factor/backup-codes/index.mjs:220–227 rewrites them on a valid
  // code, and only then).
  let proved = attempt.proved;
  if (!proved && attempt.method === "backup_code" && attempt.backupCodesBefore !== null) {
    const after = await secondFactorState(scope.db, attempt.userId);
    proved = after !== null && after.backupCodes !== attempt.backupCodesBefore;
  }
  if (!proved) {
    // An answer nobody proved: the attempt stays counted, is audited, and is not honoured.
    await afterSecondFactorFailure(scope, "unproven");
    throw new APIError("UNAUTHORIZED", { ...INVALID_CODE });
  }
  scope.facts.secondFactor = null;
  // A correct code: the count starts again (and a lock this very attempt set is lifted).
  await resetSecondFactorAttempts(scope.db, attempt.userId);
  if (attempt.mode === "step_up" && attempt.sessionId !== null) {
    if (await stampSecondFactor(scope.db, attempt.sessionId, attempt.userId, now())) {
      record(
        scope.deps,
        "auth.second_factor_step_up",
        { type: "user", id: attempt.userId },
        { method: attempt.method },
        { actorUserId: attempt.userId, actorType: "user" },
      );
    }
    return;
  }
  if (attempt.mode === "enrolment" && attempt.sessionId !== null) {
    // Two-factor has just been switched on: the proof is spent, and every other session of the
    // account proves the new factor before it acts as an admin.
    await deleteAuthMarker(scope.db, enrolProof(attempt.sessionId));
    const replacement = scope.facts.newSessions.findLast((made) => made.userId === attempt.userId);
    await clearSecondFactor(scope.db, attempt.userId, replacement?.id);
  }
}
