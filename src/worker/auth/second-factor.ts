// "This SESSION passed a second factor" — `session.secondFactorAt`.
//
// Whether an account HAS two-factor says nothing about how the session in hand was made. Better
// Auth's two-factor plugin challenges only a password sign-in
// (better-auth/dist/plugins/two-factor/index.mjs: the after-hook matches `/sign-in/email`,
// `/sign-in/username`, `/sign-in/phone-number`); a session made by Google, by a passkey, by a
// trusted-device cookie or by a mailed link never meets it. So admin access is tied to the
// session (middleware/guards.ts `requireAdmin`, auth/admin-gate.ts): it needs `secondFactorAt`.
//
// WHEN IT IS SET — three places, nowhere else (the field is `input: false`: no request body
// reaches it, Better Auth's `/update-session` included):
//   1. a session CREATED by `/two-factor/verify-totp` or `/two-factor/verify-backup-code`: the
//      plugin creates one only after the code checked out — the second step of a password
//      sign-in, or the confirmation of an enrolment (totp/index.mjs, backup-codes/index.mjs);
//   2. a session created by `/passkey/verify-authentication` when the assertion carried the
//      USER VERIFIED flag. The passkey plugin hard-codes `requireUserVerification: false`
//      (@better-auth/passkey/dist/index.mjs), but hands the verified assertion to
//      `authentication.afterVerification`, where `authenticationInfo.userVerified` is read
//      (`passkeyOptions` below). A key that only proved presence is one factor: not set;
//   3. STEP-UP: a correct code sent to those same two endpoints by a session that already
//      exists (`afterSecondFactor`). This is how a session from Google, a trusted device or a
//      presence-only passkey becomes able to do admin things.
// Every other session is created with an explicit null, so a session that Better Auth makes by
// copying another (it re-creates the session when two-factor is switched on or off, and on a
// password change) never inherits it.
//
// WHAT BETTER AUTH DOES NOT DO for a code sent WITH a session, and this file adds:
//   - no attempt limit: `beginAttempt` and the account lock apply to the sign-in challenge only
//     (verify-two-factor.mjs: the session branch's `beginAttempt` is a no-op, and `isSignIn`
//     gates the lock). With a stolen session a code could be guessed at the rate limiter's
//     pace. Here every wrong code on a session counts on the account's own counter (the plugin's
//     `failedVerificationCount` / `lockedUntil` columns — one budget for sign-in and step-up),
//     and a locked account is refused before the code is looked at;
//   - no replay protection (A8): `createOTP(...).verify(code)` keeps no record, so a code seen
//     once works again for the rest of its ±1-step window. Here a code is CLAIMED before it is
//     verified — one row per (account, code), written under the account's two-factor row lock —
//     and a second use inside its lifetime is answered as a wrong code. A claim for a code that
//     turned out wrong is given back.

import { generateId } from "@better-auth/core/utils/id";
import { APIError, getSessionFromCtx } from "better-auth/api";
import {
  claimTotpCode,
  recordSecondFactorFailure,
  releaseTotpCode,
  resetSecondFactorFailures,
  secondFactorState,
  stampSecondFactor,
} from "../db/queries/auth-lifecycle";
import { hasAdminRole } from "../../shared/roles";
import { now } from "../services/clock";
import { record } from "./observe";
import type { AuthScope } from "./scope";

export const VERIFY_TOTP_PATH = "/two-factor/verify-totp";
export const VERIFY_BACKUP_CODE_PATH = "/two-factor/verify-backup-code";
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";
const CODE_PATHS = new Set([VERIFY_TOTP_PATH, VERIFY_BACKUP_CODE_PATH]);

/** Consecutive wrong codes an account may have before it is locked (the plugin's own default). */
export const SECOND_FACTOR_MAX_FAILURES = 10;
export const SECOND_FACTOR_LOCK_MS = 15 * 60 * 1000;
/** How long a used code stays claimed: longer than the ±1-step window it is valid in (90 s). */
export const TOTP_CLAIM_S = 120;

/** Better Auth's own codes and sentences (plugins/two-factor/error-code.mjs). */
const INVALID_CODE = { code: "INVALID_CODE", message: "Invalid code" } as const;
const LOCKED = {
  code: "ACCOUNT_TEMPORARILY_LOCKED",
  message:
    "Too many failed verification attempts. Your account is temporarily locked. Please try again later.",
} as const;

/** The name of the plugin's challenge cookie (plugins/two-factor/constant.mjs). */
const TWO_FACTOR_COOKIE = "two_factor";

/**
 * `secondFactorAt` for a session being created by the endpoint this request reached: the time,
 * or null. Called from `session.create.before` — and its answer is always written, null too.
 */
export function secondFactorOfNewSession(scope: AuthScope): Date | null {
  const path = scope.facts.endpointPath;
  if (path !== null && CODE_PATHS.has(path)) return now();
  if (path === PASSKEY_SIGN_IN_PATH && scope.facts.passkeyUserVerified) return now();
  return null;
}

/** The passkey plugin's options that let the assertion's user-verification flag be seen. */
export function passkeyAuthentication(scope: AuthScope) {
  return {
    afterVerification: async (args: {
      verification: { verified?: boolean; authenticationInfo?: { userVerified?: boolean } };
    }): Promise<void> => {
      scope.facts.passkeyUserVerified =
        args.verification.verified === true && args.verification.authenticationInfo?.userVerified === true;
    },
  };
}

type CodeContext = Parameters<typeof getSessionFromCtx>[0] & {
  path?: string;
  request?: Request;
  body?: unknown;
  getSignedCookie(name: string, secret: string): Promise<string | null | undefined | false>;
  context: {
    secret: string;
    returned?: unknown;
    createAuthCookie(name: string): { name: string };
    internalAdapter: {
      findVerificationValue(identifier: string): Promise<{ value: string } | null | undefined>;
    };
  };
};

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Who is answering the challenge: the session's user, or the user the challenge cookie names. */
async function challenged(ctx: CodeContext): Promise<{ userId: string; sessionId: string | null } | null> {
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  if (session) return { userId: session.user.id, sessionId: session.session.id };
  try {
    const cookie = ctx.context.createAuthCookie(TWO_FACTOR_COOKIE);
    const identifier = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
    if (!identifier) return null;
    const row = await ctx.context.internalAdapter.findVerificationValue(identifier);
    return row ? { userId: row.value, sessionId: null } : null;
  } catch {
    return null;
  }
}

/**
 * `hooks.before` for the two code endpoints (HTTP requests only). Refuses a locked account's
 * step-up and a code that was already used; otherwise leaves the verdict to Better Auth and
 * notes, for `afterSecondFactor`, what this request is. Returns the body the endpoint must see
 * instead of the request's, or undefined.
 */
export async function beforeSecondFactor(
  scope: AuthScope,
  ctx: CodeContext,
): Promise<Record<string, unknown> | undefined> {
  if (!ctx.request || typeof ctx.path !== "string" || !CODE_PATHS.has(ctx.path)) return undefined;
  const who = await challenged(ctx);
  // Neither a session nor a challenge: Better Auth answers (INVALID_TWO_FACTOR_COOKIE).
  if (!who) return undefined;
  const state = await secondFactorState(scope.db, who.userId);
  if (!state) return undefined;
  const body = (ctx.body ?? {}) as Record<string, unknown>;

  // A step-up: a code for a session that exists, on an enrolment that is complete. (A code for
  // an enrolment still being confirmed is the user proving the secret they were just shown.)
  const stepUp = who.sessionId !== null && state.verified;
  if (stepUp && state.lockedUntil && state.lockedUntil.getTime() > Date.now()) {
    throw new APIError("TOO_MANY_REQUESTS", { ...LOCKED });
  }
  let claim: string | null = null;
  if (ctx.path === VERIFY_TOTP_PATH && typeof body.code === "string" && body.code !== "") {
    claim = `totp-used:${await sha256Hex(`${who.userId}:${body.code}`)}`;
    const mine = await claimTotpCode(scope.db, who.userId, {
      id: generateId(),
      identifier: claim,
      expiresAt: new Date(Date.now() + TOTP_CLAIM_S * 1000),
    });
    if (!mine) {
      // Used already, by this account, inside its lifetime. Counted like any wrong code on a
      // session; the sign-in challenge keeps Better Auth's own accounting.
      if (stepUp) {
        await recordSecondFactorFailure(
          scope.db,
          who.userId,
          SECOND_FACTOR_MAX_FAILURES,
          SECOND_FACTOR_LOCK_MS,
        );
      }
      throw new APIError("UNAUTHORIZED", { ...INVALID_CODE });
    }
  }
  scope.facts.secondFactor = { userId: who.userId, sessionId: who.sessionId, stepUp, claim };

  // "Remember this device" is not offered to an admin: an admin's session passes the second
  // factor every time it is made.
  if (body.trustDevice && hasAdminRole(state.role)) return { ...body, trustDevice: false };
  return undefined;
}

/** `hooks.after` for the two code endpoints: the claim, the account's counter, and the stamp. */
export async function afterSecondFactor(scope: AuthScope, ctx: CodeContext): Promise<void> {
  const attempt = scope.facts.secondFactor;
  if (!attempt || typeof ctx.path !== "string" || !CODE_PATHS.has(ctx.path)) return;
  scope.facts.secondFactor = null;
  const failed = ctx.context.returned instanceof Error;
  if (failed) {
    // A wrong code was not "used": give the claim back (it may be the right code a step later).
    if (attempt.claim) await releaseTotpCode(scope.db, attempt.claim);
    if (attempt.stepUp) {
      await recordSecondFactorFailure(
        scope.db,
        attempt.userId,
        SECOND_FACTOR_MAX_FAILURES,
        SECOND_FACTOR_LOCK_MS,
      );
    }
    return;
  }
  if (!attempt.stepUp || attempt.sessionId === null) return;
  await resetSecondFactorFailures(scope.db, attempt.userId);
  if (await stampSecondFactor(scope.db, attempt.sessionId, attempt.userId, now())) {
    record(
      scope.deps,
      "auth.second_factor_step_up",
      { type: "user", id: attempt.userId },
      { method: ctx.path === VERIFY_TOTP_PATH ? "totp" : "backup_code" },
      { actorUserId: attempt.userId, actorType: "user" },
    );
  }
}

/** Does this session carry a second factor? (A date, however it was read.) */
export function hasSecondFactor(session: { secondFactorAt?: unknown } | null | undefined): boolean {
  const value = session?.secondFactorAt;
  if (value === null || value === undefined) return false;
  const at = value instanceof Date ? value : new Date(value as string | number);
  return !Number.isNaN(at.getTime());
}
