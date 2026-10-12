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
//      unless `allowPasswordless` is set, which it is not). An account with no password cannot
//      enrol at all. This is the FIRST enrolment only — see the next section.
//   4. PASSKEY with user verification — and ONLY a passkey that was registered by a session
//      which had itself passed a second factor. The plugin never requires user verification
//      (@better-auth/passkey/dist/index.mjs: `requireUserVerification: false`) and lets ANY
//      fresh session register a passkey (`freshSessionMiddleware` only). Without the second
//      condition a stolen one-factor session could register its own key, sign in with it and
//      come back "two-factor". The assertion's flag is read in `authentication.afterVerification`
//      (`authenticationInfo.userVerified`, @simplewebauthn/server).
//      The mark of a key is a fact about the moment it was registered, so it does not outlive
//      what would end a session's own mark: on a password change or reset, on any two-factor
//      change (off, new backup codes, a new enrolment) and on a role change of the account,
//      EVERY key of the account stops counting (`endStandingProofs`). The keys still sign in,
//      as one factor; a key registered afterwards by a session that has passed the factor
//      counts again. (Otherwise a key planted during a window in which somebody else held a
//      marked session would keep producing admin-grade sessions after the owner cleaned up.)
//
// ── THE PASSWORD IS THE FIRST FACTOR (`beforeTwoFactorManage`) ───────────────────────────────
// A password can be reset through the mailbox. So once an account has a CONFIRMED enrolment
// (`two_factor.verified`, read from the database), the password alone must not be able to read
// the factor, re-issue it, replace it or switch it off — or "controls the mailbox" would be
// "has the second factor" two requests later (reset the password, sign in with Google, ask for
// the TOTP secret). The four endpoints that do those things:
//   POST /two-factor/get-totp-uri            returns the TOTP secret
//   POST /two-factor/generate-backup-codes   returns ten new backup codes
//   POST /two-factor/disable                 removes the enrolment (after which `enable` is a
//                                            first enrolment again)
//   POST /two-factor/enable                  (Better Auth refuses it over a confirmed enrolment
//                                            anyway — TOTP_ALREADY_ENABLED; gated all the same)
// are refused `403 SECOND_FACTOR_REQUIRED` — before Better Auth looks at the password — unless
// THE SESSION ALREADY CARRIES THE MARK (`hasSecondFactor`). With the mark they still need the
// password as well (Better Auth's own check). Every refusal is audited.
// While there is no confirmed enrolment there is no second factor to protect: the first
// enrolment needs the password only, and the owner is told (mail `twoFactorEnabled`, class
// `account_security`, and the audit row `auth.2fa_enabled` — auth/audit.ts).
// A lost authenticator is a backup code (`/two-factor/verify-backup-code` steps the session up);
// both lost is an operator's action. Never the password.
// The plugin's other endpoints: `/two-factor/send-otp` and `/two-factor/verify-otp` cannot
// succeed (no `otpOptions.sendOTP` is configured: otp/index.mjs throws before anything is
// sent or compared), and `viewBackupCodes` is server-only (no route).
//
// ── WHAT A CODE HAS TO GET PAST, in this order (`beforeSecondFactor`) ─────────────────────────
//   a. the ATTEMPT BUDGET — counted before the code is looked at, in one statement
//      (`admitSecondFactorAttempt`), so N simultaneous guesses are admitted at most the cap. One
//      accounting for the sign-in challenge, the step-up and the enrolment, for TOTP and backup
//      codes. (Better Auth's own lock is check-then-count, applies to the sign-in challenge only,
//      and is switched off: create-auth.ts `accountLockout`.) There are two kinds of budget, and
//      NO LOCK ON THE ACCOUNT:
//        - a browser NOBODY HAS SEEN (no valid known-device proof for this account): ONE budget
//          for the whole account — SECOND_FACTOR_MAX_ATTEMPTS per SECOND_FACTOR_WINDOW_S,
//          whatever sessions and addresses the attempts come from. It has to be account-wide: a
//          six-digit code cannot be protected by a per-client limit (fresh clients are free, so
//          "N per client" is no bound at all).
//        - a KNOWN DEVICE — a browser from which a code of this account was accepted before. It
//          holds the signed `hf_device` cookie (auth/signed-cookie.ts: `__Host-`, HttpOnly, bound
//          to the account and to a device id whose row must still exist) and has a budget OF ITS
//          OWN: SECOND_FACTOR_DEVICE_ATTEMPTS per window, per device. Nothing anybody else does
//          is counted on it — so wrong codes from elsewhere, however many, never keep the owner
//          at a browser they have used before from answering with the right code.
//      A window is real: it begins with the first counted attempt and ends SECOND_FACTOR_WINDOW_S
//      later, and the count starts again — mistakes do not add up across days. A correct code
//      gives back its own attempt, nothing more.
//      WHAT A GUESSER GETS, per window: with K stolen known-device proofs and any number of
//      fresh clients, at most SECOND_FACTOR_MAX_ATTEMPTS + K × SECOND_FACTOR_DEVICE_ATTEMPTS
//      codes are looked at (`maxGuessesPerWindow`). A proof stops counting when its row is
//      deleted: on a password change or reset and on any two-factor change (off, new backup
//      codes, a new enrolment) — the browser that then passes the factor gets a new one.
//      The proof buys the budget and nothing else: it never skips the factor and never marks a
//      session (it is not Better Auth's "trust this device").
//      When a budget runs out the owner is mailed — at most once per window per account
//      (`claimOncePerWindow`) — and the event is audited (`auth.second_factor_exhausted`).
//      RESIDUAL — ACCEPTED, explicitly (orchestrator, 2026-10-11): the owner is protected only
//      at a browser that holds a proof. At a browser with NO known-device proof — after a
//      password or two-factor change (which end every proof), after cleared cookies, after 90
//      days — the owner shares the account-wide budget, and can be kept out for as long as
//      someone holding the password or ANY session of the account keeps spending it (five
//      requests a window). They get one mail per window; the remedy is to reset the password,
//      which ends the attacker's sessions; if the attacker holds the mailbox, nothing
//      in-product helps. And online guessing against the bound — five codes a window, three of
//      a million valid at a time, 96 windows a day — is about 0.14 % a day for someone who
//      keeps at it.
//   b. for TOTP, OUR OWN verification against the stored secret (constant-time, the current
//      30-second step and the one either side), which says WHICH step the code belongs to — and
//      then REPLAY protection: `acceptTotpStep` records the step under the account's row lock
//      and refuses a step that is not newer than the last one accepted. Better Auth's verifier
//      runs afterwards as well; a code must pass both.
//   Backup codes are verified and consumed by Better Auth in one conditional update
//   (backup-codes/index.mjs: `where backupCodes = <the value read>`), so one works once.
//
// ── WHEN THE MARK IS TAKEN AWAY ───────────────────────────────────────────────────────────────
// (The known-device proofs, the keys' marks and Better Auth's "remember this device" rows go on a
// password change or reset and on any two-factor change; the keys' marks on a role change too.)
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
  claimOncePerWindow,
  clearSecondFactor,
  deleteAuthMarker,
  deleteTrustedDevices,
  forgetKnownDevices,
  forgetPasskeyMarks,
  forgetTotpStep,
  hasAuthMarker,
  isKnownDevice,
  passkeyByCredential,
  putAuthMarker,
  putKnownDevice,
  returnSecondFactorAttempt,
  secondFactorState,
  stampSecondFactor,
} from "../db/queries/auth-lifecycle";
import { revokeSessions } from "../services/account-state";
import { now } from "../services/clock";
import { sendSecondFactorLocked } from "../services/email";
import { countFor, record, reportError } from "./observe";
import { afterAnswer, type AuthScope } from "./scope";
import { cookieAttributes, cookieName, DEVICE_COOKIE, mintDevice, readDevice } from "./signed-cookie";

export const VERIFY_TOTP_PATH = "/two-factor/verify-totp";
export const VERIFY_BACKUP_CODE_PATH = "/two-factor/verify-backup-code";
export const PASSKEY_SIGN_IN_PATH = "/passkey/verify-authentication";
const CODE_PATHS = new Set([VERIFY_TOTP_PATH, VERIFY_BACKUP_CODE_PATH]);

/** Codes looked at per window from browsers that hold no known-device proof — for the whole ACCOUNT. */
export const SECOND_FACTOR_MAX_ATTEMPTS = 5;
/** Codes looked at per window from ONE known device, on its own budget. */
export const SECOND_FACTOR_DEVICE_ATTEMPTS = 5;
/** The window of both budgets: it begins with the first counted attempt. */
export const SECOND_FACTOR_WINDOW_S = 15 * 60;
/** The most codes looked at in one window for an account of which `stolenProofs` known-device proofs are in other hands. */
export const maxGuessesPerWindow = (stolenProofs: number) =>
  SECOND_FACTOR_MAX_ATTEMPTS + stolenProofs * SECOND_FACTOR_DEVICE_ATTEMPTS;
/** How old a session's second factor may be for an admin action. */
export const SECOND_FACTOR_MAX_AGE_MS = 12 * 60 * 60 * 1000;
/** How long after proving the password an enrolment's confirmation still marks the session. */
export const ENROL_PROOF_S = 10 * 60;

const TOTP_PERIOD_S = 30;
const TOTP_DIGITS = 6;
const TOTP_WINDOW = 1;

/** Better Auth's own codes and sentences (plugins/two-factor/error-code.mjs). */
const INVALID_CODE = { code: "INVALID_CODE", message: "Invalid code" } as const;
export const SECOND_FACTOR_THROTTLED = {
  code: "SECOND_FACTOR_THROTTLED",
  // In the words our own routes use too (src/shared/errors.ts), as the admin gate does.
  error: "second_factor_throttled",
  message: "Too many wrong codes. Wait a while, or use a browser you have signed in from before.",
} as const;
const NOT_AVAILABLE = {
  code: "SECOND_FACTOR_NOT_AVAILABLE",
  message: "This is not available for this session.",
};

/** The name of the plugin's challenge cookie (plugins/two-factor/constant.mjs). */
const TWO_FACTOR_COOKIE = "two_factor";

const enrolProof = (sessionId: string) => `2fa-enrol:${sessionId}`;
// The budgets' rows in `rate_limit` (a user id is URL-safe characters: no separator in it).
const unknownBudget = (userId: string) => `2fa:${userId}:new`;
const deviceBudget = (userId: string, deviceId: string) => `2fa:${userId}:dev:${deviceId}`;
const exhaustedNotice = (userId: string) => `2fa:${userId}:mail`;
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

/**
 * What an account's browsers and keys have STANDING — a known-device proof (its own code
 * budget), a passkey's "counts as a second factor", Better Auth's "remember this device" (which
 * SKIPS the challenge for thirty days) — ends here: on a password change or reset and on any
 * two-factor change. (A role change ends the passkey marks only: `afterRoleChange`.)
 */
export async function endStandingProofs(db: AuthScope["db"], userId: string): Promise<void> {
  await forgetKnownDevices(db, userId);
  await forgetPasskeyMarks(db, userId);
  await deleteTrustedDevices(db, userId);
}

/**
 * `cleanup`, tried twice; never throws. False when it failed both times — reported and counted,
 * and remembered on the scope (`facts.cleanupFailed`), which makes the route answer 5xx AFTER it
 * has written the audit row and started the notice (routes/auth.ts). Why not simply throw:
 * Better Auth has written the password (or the role) by the time a cleanup runs, outside any
 * transaction of ours, and an exception here would also take away what must happen whatever
 * the cleanup does — the sessions ended, the owner told, the change on record.
 */
export async function cleanUpOrFlag(
  scope: AuthScope,
  what: string,
  cleanup: () => Promise<void>,
): Promise<boolean> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await cleanup();
      return true;
    } catch (error) {
      reportError(error, { kind: "auth_cleanup", what, attempt: String(attempt) });
    }
  }
  countFor(scope.env, "error", { kind: "auth_cleanup", reason: what });
  scope.facts.cleanupFailed = true;
  return false;
}

/** The passkey endpoints that change or remove a key (it is named by `id` in the body). */
export const PASSKEY_MANAGE_PATHS: ReadonlySet<string> = new Set([
  "/passkey/delete-passkey",
  "/passkey/update-passkey",
]);

/**
 * Does this key of `userId` count as a second factor (grant 4 in the header)? Such a key is not
 * managed by a session alone — the plugin asks for nothing but a session and ownership
 * (@better-auth/passkey/dist/index.mjs: `sessionMiddleware` + `requireResourceOwnership`), so
 * a one-factor session could take the owner's second factor away. hooks.ts asks for the owner
 * again first (auth/mailbox-proof.ts `ownerAgain`: the session's mark, or the password through
 * the per-account throttle). A key that does not count keeps the plugin's rule.
 */
export async function isSecondFactorKey(
  scope: AuthScope,
  passkeyId: unknown,
  userId: string,
): Promise<boolean> {
  return typeof passkeyId === "string" && passkeyId !== ""
    ? hasAuthMarker(scope.db, passkeyProof(passkeyId), userId)
    : false;
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
  if (!userId) return;
  // Every session proves the factor again; no browser is a "known device", no key a second
  // factor and no device "remembered" under a factor that has changed. Better Auth has already
  // made the change (and, for `disable`, the caller's new session): tried twice and flagged,
  // never thrown — the route audits, mails, keeps the cookie, then says 5xx (`cleanUpOrFlag`).
  await cleanUpOrFlag(scope, "two_factor_change", async () => {
    await clearSecondFactor(scope.db, userId);
    await endStandingProofs(scope.db, userId);
  });
}

/**
 * After `/two-factor/disable`: as any two-factor change — and the record of the last TOTP step
 * goes with the secret it was a step of (a new enrolment's first code must not be refused as a
 * "replay" of the old authenticator's).
 */
export async function afterTwoFactorDisable(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  await afterTwoFactorChange(scope, ctx);
  const userId = ctx.context.session?.user.id;
  if (userId) await forgetTotpStep(scope.db, userId);
}

/**
 * After `/admin/set-role`: a change of privilege ends every session of the account whose role
 * changed — it signs in again, as what it now is (and proves its second factor again).
 */
export async function afterRoleChange(scope: AuthScope, ctx: SessionContext): Promise<void> {
  if (!succeeded(ctx)) return;
  const userId = (ctx.body as { userId?: unknown } | undefined)?.userId;
  if (typeof userId !== "string" || userId === "") return;
  // The sessions FIRST — that is what must not be skipped; then the keys' marks (they prove
  // themselves again under the new role: grant 4 in the header), tried twice and flagged.
  await revokeSessions(scope.deps, userId);
  await cleanUpOrFlag(scope, "role_change", async () => void (await forgetPasskeyMarks(scope.db, userId)));
}

/** After `/admin/stop-impersonating`: the admin who was impersonating proves the factor again. */
export async function afterImpersonationStopped(scope: AuthScope, ctx: SessionContext): Promise<void> {
  const adminId = scope.facts.impersonatorId;
  scope.facts.impersonatorId = null;
  if (!succeeded(ctx) || !adminId) return;
  await clearSecondFactor(scope.db, adminId);
}

// ── the endpoints that read or change the factor ─────────────────────────────────────────────

/** The endpoints a password alone must not reach once an enrolment is confirmed (see the header). */
export const TWO_FACTOR_MANAGE_PATHS: ReadonlySet<string> = new Set([
  "/two-factor/get-totp-uri",
  "/two-factor/generate-backup-codes",
  "/two-factor/disable",
  "/two-factor/enable",
]);

export const SECOND_FACTOR_REQUIRED_CODE = "SECOND_FACTOR_REQUIRED";

/**
 * `hooks.before` for TWO_FACTOR_MANAGE_PATHS: with a confirmed enrolment, only a session that
 * has itself passed the second factor goes on to Better Auth's password check. Throws the 403.
 */
export async function beforeTwoFactorManage(scope: AuthScope, ctx: CodeContext): Promise<void> {
  if (!ctx.request || typeof ctx.path !== "string" || !TWO_FACTOR_MANAGE_PATHS.has(ctx.path)) return;
  // Straight from the database, like the admin gate: the mark is the row's, not a cached copy's.
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  // No session: Better Auth answers 401.
  if (!session) return;
  const state = await secondFactorState(scope.db, session.user.id);
  // Nothing confirmed: there is no second factor yet — the first enrolment (password only).
  if (!state || !state.verified) return;
  if (hasSecondFactor(session.session as { secondFactorAt?: unknown; impersonatedBy?: unknown })) return;
  record(
    scope.deps,
    "auth.second_factor_refused",
    { type: "user", id: session.user.id },
    { path: ctx.path, reason: "needs_second_factor" },
    { actorUserId: session.user.id, actorType: "user" },
  );
  throw new APIError("FORBIDDEN", {
    message: "Confirm your two-factor code to continue.",
    code: SECOND_FACTOR_REQUIRED_CODE,
    // In the words our own routes use (`error`) and Better Auth's (`code`), as the admin gate.
    error: "second_factor_required",
  });
}

/** After `/two-factor/get-totp-uri` and `/two-factor/generate-backup-codes`: the audit row. */
export async function afterTwoFactorRead(
  scope: AuthScope,
  ctx: SessionContext & { path?: string },
): Promise<void> {
  if (!succeeded(ctx)) return;
  const userId = ctx.context.session?.user.id;
  if (!userId) return;
  record(
    scope.deps,
    ctx.path === "/two-factor/get-totp-uri" ? "auth.totp_secret_viewed" : "auth.backup_codes_regenerated",
    { type: "user", id: userId },
    null,
    { actorUserId: userId, actorType: "user" },
  );
}

// ── the two code endpoints ───────────────────────────────────────────────────────────────────

type CodeContext = Parameters<typeof getSessionFromCtx>[0] & {
  path?: string;
  request?: Request;
  body?: unknown;
  headers?: Headers;
  getSignedCookie(name: string, secret: string): Promise<string | null | undefined | false>;
  setCookie(name: string, value: string, options: ReturnType<typeof cookieAttributes>): unknown;
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

  // a. The budget — counted now, before the code is looked at. A known device's own, or the
  // account's one budget for every browser nobody has seen (see the header).
  const cookies = ctx.headers?.get("cookie") ?? ctx.request.headers.get("cookie");
  const device = await readDevice(scope.env, scope.keys, cookies, now());
  const known =
    device !== null &&
    device.userId === who.userId &&
    (await isKnownDevice(scope.db, device.deviceId, who.userId));
  const budget = known
    ? { key: deviceBudget(who.userId, device.deviceId), known: true }
    : { key: unknownBudget(who.userId), known: false };
  const cap = known ? SECOND_FACTOR_DEVICE_ATTEMPTS : SECOND_FACTOR_MAX_ATTEMPTS;
  const admitted = await admitSecondFactorAttempt(scope.db, budget.key, cap, SECOND_FACTOR_WINDOW_S);
  if (!admitted.ok) {
    record(
      scope.deps,
      "auth.second_factor_refused",
      { type: "user", id: who.userId },
      { method, mode, reason: "throttled", budget: known ? "device" : "account" },
    );
    throw new APIError(
      "TOO_MANY_REQUESTS",
      { ...SECOND_FACTOR_THROTTLED },
      { "Retry-After": String(admitted.retryAfterSeconds) },
    );
  }
  const attempt = {
    userId: who.userId,
    sessionId: who.sessionId,
    mode,
    method,
    budget,
    exhaustedNow: admitted.count >= cap,
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

/** A refused or wrong code: audited without the code; a budget this attempt used up is announced. */
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
  if (!attempt.exhaustedNow) return;
  record(
    scope.deps,
    "auth.second_factor_exhausted",
    { type: "user", id: attempt.userId },
    {
      budget: attempt.budget.known ? "device" : "account",
      attempts: attempt.budget.known ? SECOND_FACTOR_DEVICE_ATTEMPTS : SECOND_FACTOR_MAX_ATTEMPTS,
      seconds: SECOND_FACTOR_WINDOW_S,
    },
  );
  // The owner is told — once per window, however many budgets run out in it.
  if (!(await claimOncePerWindow(scope.db, exhaustedNotice(attempt.userId), SECOND_FACTOR_WINDOW_S))) return;
  // After the answer, like every mail an auth request causes (auth/scope.ts `afterAnswer`).
  scope.deps.defer(
    afterAnswer(scope, () =>
      sendSecondFactorLocked(scope.deps, {
        to: attempt.email,
        name: attempt.name,
        minutes: Math.round(SECOND_FACTOR_WINDOW_S / 60),
      }),
    ).catch(() => {}),
  );
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
  // A correct code: its own attempt is given back to the budget it was counted on.
  await returnSecondFactorAttempt(scope.db, attempt.budget.key, SECOND_FACTOR_WINDOW_S);
  if (attempt.mode === "enrolment") {
    // A new enrolment is a two-factor change: no browser is a known device of the old factor,
    // and no key registered under it counts.
    await cleanUpOrFlag(scope, "enrolment", () => endStandingProofs(scope.db, attempt.userId));
  }
  // This browser has now passed the account's second factor: it is a known device. (Kept when
  // it already was one. Only ever here — on proof — and never for an impersonated session: one
  // does not get this far.)
  if (attempt.mode === "enrolment" || !attempt.budget.known) {
    const deviceId = generateId(32);
    const at = now();
    await putKnownDevice(scope.db, {
      id: generateId(),
      deviceId,
      userId: attempt.userId,
      expiresAt: new Date(at.getTime() + DEVICE_COOKIE.maxAge * 1000),
    });
    ctx.setCookie(
      cookieName(scope.env, DEVICE_COOKIE),
      await mintDevice(scope.keys, { userId: attempt.userId, deviceId }, at),
      cookieAttributes(scope.env, DEVICE_COOKIE),
    );
  }
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
