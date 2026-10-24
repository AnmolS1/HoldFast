// Better Auth's hooks, bound to one request's scope: the database hooks that apply the sign-up
// and sign-in policy and the account-state side effects, and the `before` / `after` endpoint
// hooks. `createAuth` wires them in.
//
// Things the installed Better Auth (1.7.7) does that shape this file:
//
//  - A 403 thrown while a user is being created is turned into a FAKE SUCCESS by the sign-up
//    endpoint (api/routes/sign-up.mjs: `if (e.statusCode === 403 && shouldReturnGenericDuplicate
//    Response) return buildGenericDuplicateResponse()` — with verification required, a 403 from
//    `createUser` is answered as "200, here is your user"). So a sign-up refusal is NEVER a 403:
//    every one is `400 BAD_REQUEST` with a code.
//  - The Drizzle adapter runs with `transaction: false` (its default): "after" database hooks run
//    once the endpoint's work is done, and an exception from one fails a request whose rows are
//    already written. So every after-hook here catches, reports and carries on.
//  - `update.before` receives the fields being written and `update.after` the resulting row —
//    never both. A ban is "this update wrote `banned`", which only `before` can see, so `before`
//    leaves a marker that `after` consumes.
//  - `hooks.before` / `hooks.after` run for `auth.api.*` calls made inside the Worker too — the
//    session read of every /api/* request included — so both return at once for paths they do
//    not handle.
//  - Plugins' after-hooks run AFTER `hooks.after` (the two-factor plugin deletes the session a
//    password sign-in just made). Whether a sign-in really completed is therefore decided from
//    the final response, by the route (auth/audit.ts), not here.

import { hasAdminRole } from "../../shared/roles";
import { generateId } from "@better-auth/core/utils/id";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { UAParser } from "ua-parser-js";
import {
  clearUnprovenAccount,
  ensureUserPrefs,
  getAccount,
  getAccountByEmail,
  linkedProvider,
  releaseSignup,
  revokeBootstrapAdmin,
  sweepAfterLink,
} from "../db/queries/auth-lifecycle";
import { activatePendingShares } from "../db/queries/shares";
import { applyBanChange, revokeAllAccess, SYSTEM_ACTOR, type Actor } from "../services/account-state";
import { now } from "../services/clock";
import {
  chargeUnsent,
  sendChangeEmailConfirmation,
  sendSignInMethodAdded,
  sendSignupAttempt,
} from "../services/email";
import {
  ACCOUNT_SUSPENDED_MESSAGE,
  checkSessionStart,
  isAdminEmail,
  parseStatement,
  precheckSignup,
  SessionRefusal,
  SignupRefusal,
  takeSignup,
  type SignupGrant,
} from "../services/signup-policy";
import { adminGate } from "./admin-gate";
import { BREACH_PATHS, refuseBreachedPassword } from "./breach-check";
import {
  afterSignIn,
  beforeSessionPassword,
  beforeSignIn,
  SESSION_PASSWORD_PATHS,
  SIGN_IN_PATH,
} from "./signin-throttle";
import {
  afterChangeEmail,
  beforeChangeEmail,
  beforeUnlinkAccount,
  beforeVerifyEmail,
  ownerAgain,
  REAUTH_PATHS,
} from "./mailbox-proof";
import {
  afterImpersonationStopped,
  afterPasskeyDeleted,
  afterPasskeyRegistered,
  afterRoleChange,
  afterSecondFactor,
  afterTwoFactorChange,
  afterTwoFactorDisable,
  afterTwoFactorEnable,
  afterTwoFactorRead,
  beforeSecondFactor,
  beforeTwoFactorManage,
  cleanUpOrFlag,
  endPasswordStanding,
  hasSecondFactor,
  isSecondFactorKey,
  PASSKEY_MANAGE_PATHS,
  secondFactorOfNewSession,
  TWO_FACTOR_MANAGE_PATHS,
  VERIFY_BACKUP_CODE_PATH,
  VERIFY_TOTP_PATH,
} from "./second-factor";
import { countFor, record, reportError } from "./observe";
import { afterAnswer, type AuthScope, type ClientFacts } from "./scope";
import {
  cookieAttributes,
  cookieName,
  INTENT_COOKIE,
  mintPending,
  PENDING_COOKIE,
  readIntent,
  readPending,
} from "./signed-cookie";

/** Better Auth's own answer to a wrong password (api/routes/sign-in.mjs), reproduced exactly. */
export const INVALID_CREDENTIALS = {
  message: "Invalid email or password",
  code: "INVALID_EMAIL_OR_PASSWORD",
} as const;

/** The endpoints through which an OAuth profile can create an account. */
const OAUTH_SIGNUP_PATHS = new Set(["/callback/:id", "/sign-in/social"]);

/** What auth/second-factor.ts does after each of these endpoints. */
const SECOND_FACTOR_AFTER = new Map([
  ["/two-factor/enable", afterTwoFactorEnable],
  ["/two-factor/disable", afterTwoFactorDisable],
  [
    "/two-factor/generate-backup-codes",
    async (scope: AuthScope, ctx: Parameters<typeof afterTwoFactorChange>[1]) => {
      await afterTwoFactorChange(scope, ctx);
      await afterTwoFactorRead(scope, ctx);
    },
  ],
  ["/two-factor/get-totp-uri", afterTwoFactorRead],
  ["/passkey/verify-registration", afterPasskeyRegistered],
  ["/passkey/delete-passkey", afterPasskeyDeleted],
  ["/admin/set-role", afterRoleChange],
  ["/admin/stop-impersonating", afterImpersonationStopped],
]);

/** What is never kept of a provider's tokens (see the `account` hooks). */
const PROVIDER_TOKEN_FIELDS = ["idToken", "accessToken", "refreshToken"] as const;
const NO_PROVIDER_TOKENS = { idToken: null, accessToken: null, refreshToken: null };

/** The endpoints whose session is created by following a mailed link, not by a credential. */
const LINK_SESSION_PATHS = new Set(["/verify-email"]);

/** The part of Better Auth's endpoint context the database hooks read. Null outside a request. */
type HookContext = {
  path?: string;
  body?: unknown;
  headers?: Headers;
  request?: Request;
  context?: unknown;
} | null;

/** A policy refusal as the error Better Auth answers with. Never a 403 — see the header. */
function refused(error: unknown): never {
  if (error instanceof SignupRefusal)
    throw new APIError("BAD_REQUEST", { message: error.message, code: error.code });
  if (error instanceof SessionRefusal) {
    if (error.kind === "suspended") {
      throw new APIError("FORBIDDEN", { message: ACCOUNT_SUSPENDED_MESSAGE, code: "ACCOUNT_SUSPENDED" });
    }
    throw new APIError("UNAUTHORIZED", { ...INVALID_CREDENTIALS });
  }
  throw error;
}

/** An after-hook must not fail the request whose work is already done. */
async function quietly(env: Env, kind: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    reportError(error, { kind: `auth_hook_${kind}` });
    countFor(env, "error", { kind: "auth_hook", reason: kind });
  }
}

/** The client as the route saw it, or — for a direct call to the handler — as the request says. */
export function clientOf(scope: AuthScope, ctx: HookContext): ClientFacts {
  if (scope.client) return scope.client;
  const headers = ctx?.request?.headers ?? ctx?.headers;
  const cf = (ctx?.request as { cf?: { asn?: unknown; country?: unknown } } | undefined)?.cf;
  return {
    ip: headers?.get("cf-connecting-ip") ?? "127.0.0.1",
    asn: typeof cf?.asn === "number" ? cf.asn : null,
    country: typeof cf?.country === "string" ? cf.country : null,
    userAgent: headers?.get("user-agent") ?? null,
  };
}

/** "Chrome on macOS" — a coarse label, never the raw User-Agent. */
export function uaFamily(userAgent: string | null): string | null {
  if (!userAgent) return null;
  const parsed = UAParser(userAgent.slice(0, 512));
  const label = [parsed.browser.name, parsed.os.name].filter(Boolean).join(" on ");
  return label ? label.slice(0, 64) : null;
}

/** Better Auth's code for "the user row could not be inserted" (api/routes/sign-up.mjs). */
const FAILED_TO_CREATE_USER = "FAILED_TO_CREATE_USER";

/**
 * Gives back what a sign-up took when its account was not created. Never throws.
 * `insertFailed`: Better Auth said the user row could not be written — then a row with that
 * address is another sign-up's, and this one's reservation is given back whatever exists. So is
 * a reservation that creates no row at all (`email` null: a Google sign-up at an account that
 * was there before — the row at the address is never its own).
 * Otherwise (the request failed somewhere unknown) it is given back only if no such user exists.
 */
export async function releaseUnusedReservation(scope: AuthScope, insertFailed = false): Promise<void> {
  const held = scope.reservation;
  if (!held) return;
  scope.reservation = null;
  await quietly(scope.env, "release", async () => {
    await releaseSignup(scope.db, held.taken, insertFailed ? null : held.email);
  });
}

function actorOf(ctx: HookContext): Actor {
  const session = (
    ctx?.context as
      | { session?: { user?: { id?: string }; session?: { impersonatedBy?: string | null } } | null }
      | undefined
  )?.session;
  const id = session?.session?.impersonatedBy ?? session?.user?.id;
  return id ? { userId: id, type: "admin" } : SYSTEM_ACTOR;
}

/** The unauthenticated endpoints that mail an address ONLY when it has an account in the right state. */
const UNSENT_KIND: Record<string, "passwordReset" | "verification"> = {
  "/request-password-reset": "passwordReset",
  "/send-verification-email": "verification",
};

/** The endpoints whose mail goes to the address in the body's `email`. */
const OWN_MAIL_PATHS = new Set(["/send-verification-email", "/request-password-reset"]);

/**
 * Is the address this request asks mail for the CALLER'S OWN (services/email.ts "WHOSE BUDGET")?
 * "Own" means the recipient address is ALREADY BOUND to the requester, server-side — never an
 * address the request merely names:
 *   - a resend from the browser that signed up: the MAC-verified `hf_pending` proof names the
 *     address AND its user id is an existing, still-unverified account whose STORED address is
 *     exactly that address. The cookie's presence is not enough — the look-alike answer to a
 *     sign-up with a TAKEN address sets one too (naming nobody);
 *   - the session's account is VERIFIED and its stored address is that address (a reset).
 * A sign-up is NOT one: its recipient is whatever the body says (the mail it causes is counted
 * as mail anybody can cause; the resend from that browser, with the proof, is the own one).
 * The proof decides which BUDGET a mail is counted on, nothing a caller can see: the answer, the
 * work before it (padded — auth/parity.ts) and the caller's own per-client charge are the same.
 * Returns the address and the account it is bound to (the own budget is keyed on both —
 * services/email.ts `ownLedgerKey`), or null: a stranger's request.
 */
async function ownAddressOf(
  scope: AuthScope,
  ctx: Parameters<typeof getSessionFromCtx>[0] & { path?: string; body?: unknown; request?: Request },
): Promise<{ email: string; accountId: string } | null> {
  const asked = (ctx.body as { email?: unknown } | null | undefined)?.email;
  if (typeof asked !== "string" || !ctx.request) return null;
  const email = asked.toLowerCase();
  const cookies = ctx.headers?.get("cookie") ?? ctx.request.headers.get("cookie");
  // No cookie at all: nothing to read, and nothing to look up.
  if (!cookies) return null;
  if (ctx.path === "/send-verification-email") {
    const pending = await readPending(scope.env, scope.keys, cookies, now());
    if (pending && pending.email === email) {
      const signedUp = await getAccount(scope.db, pending.userId);
      if (signedUp && !signedUp.emailVerified && signedUp.email.toLowerCase() === email) {
        return { email, accountId: signedUp.id };
      }
    }
  }
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  return session && session.user.emailVerified === true && session.user.email.toLowerCase() === email
    ? { email, accountId: session.user.id }
    : null;
}

export function buildHooks(scope: AuthScope) {
  const env = scope.env;

  /** The policy for linking a provider identity to an account that already exists (see below). */
  const beforeProviderLink = async (
    account: { userId: string; providerId: string },
    ctx: HookContext,
  ): Promise<void> => {
    // The first account row of a user this request has just created (a new OAuth sign-up) is
    // not a link.
    try {
      const owner = await getAccount(scope.db, account.userId);
      if (!owner) return;
      if (scope.facts.signingUpEmail === owner.email.toLowerCase()) return;
      if (owner.emailVerified) {
        scope.facts.linking = { userId: owner.id, providerId: account.providerId, cleaned: false };
        return;
      }
      const cookies = ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie");
      const intent = await readIntent(env, scope.keys, cookies, now());
      if (!intent) throw new SignupRefusal("SIGNUP_INTENT_REQUIRED");
      const statement = {
        inviteCode: intent.inviteCode,
        birthYear: 0,
        birthMonth: 0,
        acceptTerms: true as const,
        acceptDemo: intent.acceptDemo,
      };
      // Invite, velocity and the intent's single use: taken as for any new sign-up.
      const grant = await takeSignup(scope, owner.email, statement, clientOf(scope, ctx), intent.nonce);
      // This sign-up creates no user: the row at the address is the one that was there before.
      // Until the cleanup below has made it this sign-up's, an unspent reservation always comes
      // back — here if the account turns out proven, or from the handler if the cleanup throws.
      if (scope.reservation) scope.reservation.email = null;
      const removed = await clearUnprovenAccount(scope.db, owner.id, {
        ...grant,
        // The name the row's creator typed is theirs, not the owner's.
        name: owner.email.split("@")[0] ?? "",
      });
      // Verified in the meantime (the owner followed a mailed link a moment ago): a proven
      // account after all — link it as one, and give back what was just taken.
      if (removed === null) {
        await releaseUnusedReservation(scope);
        scope.facts.linking = { userId: owner.id, providerId: account.providerId, cleaned: false };
        return;
      }
      scope.reservation = null;
      scope.facts.linking = { userId: owner.id, providerId: account.providerId, cleaned: true };
      record(
        scope.deps,
        "auth.prehijack_cleanup",
        { type: "user", id: owner.id },
        { ...removed },
        {
          actorUserId: owner.id,
          actorType: "user",
        },
      );
    } catch (error) {
      return refused(error);
    }
  };

  const afterProviderLink = async (account: { userId: string; providerId: string }) => {
    const linking = scope.facts.linking;
    if (!linking || linking.userId !== account.userId || linking.providerId !== account.providerId) return;
    await quietly(env, "account_linked", async () => {
      const owner = await getAccount(scope.db, account.userId);
      if (!owner) return;
      record(
        scope.deps,
        "auth.provider_linked",
        { type: "user", id: owner.id },
        {
          provider: account.providerId === "google" ? "google" : "other",
          cleaned: linking.cleaned,
        },
        { actorUserId: owner.id, actorType: "user" },
      );
      // A proven owner is told that a new way in exists. (After a cleanup the address has
      // only just been proven, by this very sign-in: there is no earlier owner to tell.)
      if (!linking.cleaned) {
        scope.deps.defer(
          afterAnswer(scope, () =>
            sendSignInMethodAdded(scope.deps, { to: owner.email, name: owner.name, method: "google" }),
          ),
        );
      }
    });
  };

  const databaseHooks = {
    user: {
      create: {
        // The whole sign-up policy. What it returns is written on the new row.
        before: async (user: { email: string; emailVerified?: boolean }, ctx: HookContext) => {
          try {
            const path = ctx?.path;
            const email = user.email.toLowerCase();
            const client = clientOf(scope, ctx);
            // For the `account.create` hook below: the account row that follows belongs to a NEW
            // user. (Set here, not in `after`: after-hooks run when the endpoint's work is done.)
            scope.facts.signingUpEmail = email;
            if (path === "/sign-up/email") {
              const grant = await takeSignup(scope, email, parseStatement(ctx?.body), client, null);
              return { data: grant };
            }
            if (path && OAUTH_SIGNUP_PATHS.has(path)) {
              // Invite, age and assent were given to POST /api/auth-intent; its cookie is the proof.
              const cookies = ctx?.headers?.get("cookie") ?? ctx?.request?.headers.get("cookie");
              const intent = await readIntent(env, scope.keys, cookies, now());
              if (!intent) throw new SignupRefusal("SIGNUP_INTENT_REQUIRED");
              // An address the provider has not verified is nobody's yet.
              if (user.emailVerified !== true) throw new SignupRefusal("PROVIDER_EMAIL_UNVERIFIED");
              const statement = {
                inviteCode: intent.inviteCode,
                birthYear: 0,
                birthMonth: 0,
                acceptTerms: true as const,
                acceptDemo: intent.acceptDemo,
              };
              const grant = await takeSignup(scope, email, statement, client, intent.nonce);
              return { data: grant };
            }
            // No other endpoint creates accounts (the admin plugin's create-user is refused earlier).
            throw new SignupRefusal("SIGNUP_NOT_AVAILABLE");
          } catch (error) {
            return refused(error);
          }
        },
        after: async (user: { id: string; email: string; emailVerified?: boolean }) => {
          // The account exists: what its sign-up took is now spent.
          scope.reservation = null;
          scope.facts.createdUserId = user.id;
          await quietly(env, "user_created", async () => {
            await ensureUserPrefs(scope.db, user.id);
            // An address verified by the provider is a verified account address from the start.
            if (user.emailVerified) await activatePendingShares(scope.db, user.id, user.email);
          });
        },
      },
      update: {
        before: async (data: Record<string, unknown>) => {
          const marker: AuthScope["userUpdates"][number] = {};
          if ("banned" in data) marker.banned = data.banned === true;
          if ("email" in data || "emailVerified" in data) marker.address = true;
          if ("email" in data) marker.emailChanged = true;
          if (Object.keys(marker).length > 0) scope.userUpdates.push(marker);
        },
        after: async (
          user: { id?: string; email?: string; emailVerified?: boolean; banned?: boolean | null } | null,
          ctx: HookContext,
        ) => {
          if (!user || typeof user !== "object" || typeof user.id !== "string") return;
          const userId = user.id;
          // The admin plugin's own write of the account the gate wrote ahead of it: it landed.
          if (scope.facts.adminPreWrite?.userId === userId) scope.facts.adminPreWrite = null;
          const banned = user.banned === true;
          const banIndex = scope.userUpdates.findIndex((m) => m.banned !== undefined && m.banned === banned);
          if (banIndex !== -1) {
            scope.userUpdates.splice(banIndex, 1);
            await quietly(env, "ban", () => applyBanChange(scope.deps, userId, banned, actorOf(ctx)));
          }
          const addressIndex = scope.userUpdates.findIndex((m) => m.address);
          if (addressIndex !== -1) {
            const [marker] = scope.userUpdates.splice(addressIndex, 1);
            if (marker?.emailChanged) scope.facts.emailChangedUserId = userId;
            // The address has just become (or stayed) a verified account address: shares that
            // were waiting for it activate now.
            if (user.emailVerified && user.email) {
              const email = user.email;
              await quietly(env, "shares", async () => {
                await activatePendingShares(scope.db, userId, email);
              });
            }
          }
        },
      },
    },
    // LINKING A PROVIDER IDENTITY TO AN ACCOUNT THAT ALREADY EXISTS.
    //
    // Better Auth links a Google sign-in to the local account with the same address. It does so
    // only when Google says the address is verified (it is not a "trusted provider" here) and the
    // addresses are equal (`allowDifferentEmails` is off). What it cannot know is whether the
    // LOCAL account's address was ever proven. An unverified local account may be somebody
    // else's: anyone can sign up with a victim's address and a password of their own, and wait.
    // Linking the victim's Google identity to that row as it is would verify the address and
    // leave the stranger's password opening the account ("pre-hijacking").
    //
    //   the local account is VERIFIED    link; its credentials stay; the owner is told.
    //   the local account is UNVERIFIED  the Google user is the first to PROVE the address, and
    //                                    is treated as the new sign-up they are: the intent
    //                                    cookie (invite, age, terms) is required and taken, and
    //                                    the row is emptied of everything its creator could
    //                                    have planted — password, sessions, passkeys, two-factor
    //                                    — before the link. Without the intent: refused, and
    //                                    nothing is linked or removed.
    //
    // Atomicity, as it is. Better Auth inserts the provider's account row with its own statement,
    // outside any transaction of ours (auth/create-auth.ts), so "check, empty, link" cannot be one
    // transaction. The order is made safe instead — delete, link, delete again:
    //   1. `clearUnprovenAccount`: ONE transaction under `SELECT … FOR UPDATE` on the user row,
    //      its state re-read under the lock — empties the account AND marks the address verified.
    //      From that commit the row cannot be moved to another address (only an unverified row
    //      can), cannot be "cleaned" a second time by a simultaneous callback, and has no
    //      credential at all.
    //   2. Better Auth links the provider identity.
    //   3. `sweepAfterLink`, in `session.create.before`, under the same row lock: whatever was
    //      attached in between is deleted again, a doubled link is reduced to one, and only then
    //      is the owner's session created. If the sweep fails, the callback issues no session.
    // An abort between 1 and 2 leaves an account that is verified, has no credential and no
    // provider link: nobody can enter it with anything the stranger had, and its owner gets in
    // with Google again (now the "verified" case) or by resetting the password by mail.
    account: {
      // A provider's tokens are written as null, on the first link and on every later sign-in
      // (Better Auth refreshes them then: oauth2/link-account.mjs `updateAccount`).
      update: {
        before: async (data: Record<string, unknown>) => {
          const kept: Record<string, null> = {};
          for (const field of PROVIDER_TOKEN_FIELDS) if (field in data) kept[field] = null;
          return Object.keys(kept).length > 0 ? { data: kept } : undefined;
        },
      },
      create: {
        before: async (account: { userId: string; providerId: string }, ctx: HookContext) => {
          if (account.providerId === "credential") return;
          await beforeProviderLink(account, ctx);
          return { data: NO_PROVIDER_TOKENS };
        },
        after: afterProviderLink,
      },
    },
    session: {
      create: {
        before: async (session: { userId: string; impersonatedBy?: string | null }, ctx: HookContext) => {
          // The first session of an account that was emptied and linked in this request: sweep
          // it AGAIN first (delete → link → delete). Anything attached to the row between the
          // cleanup and the link — by a request that was already in flight — dies here, before
          // the owner's session exists. If the sweep cannot complete, no session is issued.
          const linking = scope.facts.linking;
          if (linking?.cleaned && linking.userId === session.userId && !linking.swept) {
            const swept = await sweepAfterLink(scope.db, session.userId);
            linking.swept = true;
            if (swept.accounts + swept.sessions + swept.passkeys + swept.twoFactor + swept.tokens > 0) {
              record(
                scope.deps,
                "auth.prehijack_cleanup",
                { type: "user", id: session.userId },
                { ...swept, phase: "after_link" },
                {
                  actorUserId: session.userId,
                  actorType: "user",
                },
              );
            }
          }
          try {
            await checkSessionStart(
              scope,
              session.userId,
              Boolean(session.impersonatedBy),
              // A session the verification click creates carries no admin grant: the role comes
              // with a sign-in (auth/mailbox-proof.ts).
              !LINK_SESSION_PATHS.has(scope.facts.endpointPath ?? ""),
            );
          } catch (error) {
            return refused(error);
          }
          const client = clientOf(scope, ctx);
          return {
            data: {
              country: client.country,
              uaFamily: uaFamily(client.userAgent),
              // Always written, null included: a session Better Auth makes by copying another
              // must not inherit it (auth/second-factor.ts).
              secondFactorAt: secondFactorOfNewSession(scope, session),
            },
          };
        },
        after: async (session: {
          id: string;
          userId: string;
          impersonatedBy?: string | null;
          country?: string | null;
          uaFamily?: string | null;
        }) => {
          scope.facts.newSessions.push({
            id: session.id,
            userId: session.userId,
            impersonatedBy: session.impersonatedBy ?? null,
            country: session.country ?? null,
            uaFamily: session.uaFamily ?? null,
          });
        },
      },
    },
  };

  const before = createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    // Only an HTTP request names "the endpoint this request reached"; an in-Worker
    // `auth.api.getSession` (the session middleware) must not overwrite it.
    if (ctx.request) scope.facts.endpointPath = path ?? null;
    if (typeof path !== "string") return;
    if (path.startsWith("/admin/")) await adminGate(scope, ctx);
    // Better Auth's own session list hands the browser every session's token and IP address. The
    // account page lists them through GET /api/account/sessions (no token, no address), so a
    // signed-in caller gets a 404 here; without a session Better Auth answers its own 401
    // (T23 review m4). Matched on the path as Better Auth's router read it: no spelling slips by.
    if (path === "/list-sessions" && ctx.request) {
      const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
      if (session) throw new APIError("NOT_FOUND", { code: "NOT_FOUND", message: "Not found" });
    }
    if (OWN_MAIL_PATHS.has(path) && ctx.request) scope.facts.ownAddress = await ownAddressOf(scope, ctx);
    if (path === "/verify-email" && ctx.request) await beforeVerifyEmail(scope, ctx);
    if (TWO_FACTOR_MANAGE_PATHS.has(path)) await beforeTwoFactorManage(scope, ctx);
    if (path === VERIFY_TOTP_PATH || path === VERIFY_BACKUP_CODE_PATH) {
      const body = await beforeSecondFactor(scope, ctx);
      if (body) return { context: { body } };
    }
    if (path === SIGN_IN_PATH && ctx.request) await beforeSignIn(scope, ctx);
    // After the second-factor gate above (a request it refuses tests no password) — and before
    // the breach look-up and Better Auth's own check.
    if (SESSION_PASSWORD_PATHS.has(path) && ctx.request) await beforeSessionPassword(scope, ctx);
    if (path === "/sign-up/email" && ctx.request) {
      // The cheap refusals first — before the password is hashed and looked up in the breach
      // corpus. They depend only on what was submitted, never on whether the address has an
      // account, so answering them early tells a caller nothing about anyone.
      try {
        const body = (ctx.body ?? {}) as { email?: unknown };
        const email = typeof body.email === "string" ? body.email.toLowerCase() : null;
        await precheckSignup(scope, email, parseStatement(ctx.body), clientOf(scope, ctx));
      } catch (error) {
        refused(error);
      }
    }
    if (ctx.request && REAUTH_PATHS.has(path)) {
      // The owner again, not just a session (auth/mailbox-proof.ts `ownerAgain`).
      const throttle = {
        admit: (email: string) => beforeSignIn(scope, { body: { email } }),
        settle: () => afterSignIn(scope),
      };
      const marked = (session: unknown) => hasSecondFactor(session as Parameters<typeof hasSecondFactor>[0]);
      if (PASSKEY_MANAGE_PATHS.has(path)) {
        // Only for a key that counts as a second factor; there the mark suffices.
        const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
        const id = (ctx.body as { id?: unknown } | null | undefined)?.id;
        if (session && (await isSecondFactorKey(scope, id, session.user.id))) {
          await ownerAgain(ctx, scope.reauthPassword, throttle, marked, true);
        }
      } else if (path === "/change-email") {
        await beforeChangeEmail(ctx, scope.reauthPassword, throttle, marked);
      } else if (path === "/link-social") {
        await ownerAgain(ctx, scope.reauthPassword, throttle, marked);
      } else {
        await beforeUnlinkAccount(
          ctx,
          (id, userId) => linkedProvider(scope.db, id, userId),
          scope.reauthPassword,
          throttle,
          marked,
        );
      }
    }
    if (BREACH_PATHS.has(path) && ctx.request) {
      // Input first (auth/parity.ts, auth/breach-check.ts): a password of acceptable length is
      // looked up in the breach corpus BEFORE anything is looked up about any account or token —
      // so the answer to a breached password is the same whoever the request is about, and a
      // reset token is not spent on a password that will be refused. (A length Better Auth
      // refuses anyway is left to it.)
      const body = (ctx.body ?? {}) as { password?: unknown; newPassword?: unknown };
      const password = path === "/sign-up/email" ? body.password : body.newPassword;
      if (typeof password === "string" && password.length >= 12 && password.length <= 128) {
        await refuseBreachedPassword(env, password);
      }
    }
    if (path === "/change-password" && ctx.request) {
      // A changed password ends every other session, whatever the client asked for
      // (api/routes/update-user.mjs honours `revokeOtherSessions` only when the body says so).
      return { context: { body: { ...((ctx.body ?? {}) as object), revokeOtherSessions: true } } };
    }
  });

  const after = createAuthMiddleware(async (ctx) => {
    const path = ctx.path;
    if (path === VERIFY_TOTP_PATH || path === VERIFY_BACKUP_CODE_PATH) {
      await afterSecondFactor(scope, ctx);
      return;
    }
    if (path === SIGN_IN_PATH && ctx.request) {
      await afterSignIn(scope);
      return;
    }
    // A session's password check: its count is given back on proof, like a sign-in's.
    if (ctx.request && typeof path === "string" && SESSION_PASSWORD_PATHS.has(path)) await afterSignIn(scope);
    const uncharged = ctx.request && typeof path === "string" ? UNSENT_KIND[path] : undefined;
    if (path === "/send-verification-email" && ctx.request && !(ctx.context.returned instanceof Error)) {
      // A resend from the browser that signed up RENEWS its proof (auth/signed-cookie.ts): the
      // new link must not outlive the cookie that makes its click keep the password. Decided by
      // the caller's own cookie alone — nothing about any account is read for it.
      const asked = (ctx.body as { email?: unknown } | undefined)?.email;
      const cookies = ctx.headers?.get("cookie") ?? ctx.request.headers.get("cookie");
      const held = await readPending(env, scope.keys, cookies, now());
      if (held && typeof asked === "string" && held.email === asked.toLowerCase()) {
        const value = await mintPending(scope.keys, held, held.changes, now());
        ctx.setCookie(cookieName(env, PENDING_COOKIE), value, cookieAttributes(env, PENDING_COOKIE));
      }
    }
    if (uncharged) {
      // The mail budgets are charged the same whether or not a mail results (services/email.ts
      // `chargeUnsent`) — after the answer, like the mail itself, and never awaited.
      const address = (ctx.body as { email?: unknown } | undefined)?.email;
      scope.deps.defer(
        afterAnswer(scope, async () => {
          if (!scope.facts.mailed.includes(uncharged)) {
            await chargeUnsent(scope.deps, uncharged, address, {
              client: scope.client?.ip ?? null,
              // The same budget the mail itself would have been counted on.
              own:
                typeof address === "string" && scope.facts.ownAddress?.email === address.toLowerCase()
                  ? scope.facts.ownAddress.accountId
                  : null,
            });
          }
        }),
      );
      return;
    }
    if (path === "/change-email" && ctx.request) {
      scope.deps.defer(
        afterAnswer(scope, () =>
          quietly(env, "change_email", () =>
            afterChangeEmail(scope, ctx, (mail) => sendChangeEmailConfirmation(scope.deps, mail)),
          ),
        ),
      );
      return;
    }
    if (ctx.request && typeof path === "string" && SECOND_FACTOR_AFTER.has(path)) {
      // The bookkeeping of auth/second-factor.ts. It must not be skipped silently: a failure
      // here fails the request (the action itself has happened and is not undone).
      await SECOND_FACTOR_AFTER.get(path)!(scope, ctx);
      return;
    }
    if (path === "/change-password" && ctx.request && !(ctx.context.returned instanceof Error)) {
      // "Remember this device" does not outlive the password it was granted under.
      const userId = ctx.context.session?.user.id;
      // What stood on the old password goes (auth/second-factor.ts `endStandingProofs`). Better
      // Auth has already written the password and ended the other sessions; the cleanup is
      // tried twice, and if it still fails the request is answered 5xx — by the route, AFTER
      // the audit row and the notice, and with the caller's new session cookie kept.
      if (userId) await cleanUpOrFlag(scope, "password_change", () => endPasswordStanding(scope.db, userId));
      return;
    }
    if (path === "/get-session") {
      // An account past its deletion date behaves as deleted. The session middleware already
      // treats such a session as absent; this ends it, the first time it is seen.
      const found = ctx.context.returned as
        | {
            user?: {
              id?: string;
              deleteScheduledAt?: unknown;
              role?: unknown;
              email?: unknown;
              emailVerified?: unknown;
            };
          }
        | null
        | undefined;
      const scheduled = found?.user?.deleteScheduledAt;
      const userId = found?.user?.id;
      // THE BOOTSTRAP ROLE IS RE-EVALUATED on every session read: an admin whose STORED, verified
      // address is not (or no longer) on ADMIN_EMAILS — the address was changed, or the entry was
      // removed — loses a role that the list gave (db/queries/auth-lifecycle.ts
      // `revokeBootstrapAdmin`: only a role carrying the list's mark; one given by another admin
      // is not the list's to take). From this very request on.
      const seen = found?.user;
      if (
        userId &&
        seen &&
        hasAdminRole(typeof seen.role === "string" ? seen.role : null) &&
        !(seen.emailVerified === true && typeof seen.email === "string" && isAdminEmail(env, seen.email))
      ) {
        if (await revokeBootstrapAdmin(scope.db, userId)) {
          seen.role = "user";
          record(scope.deps, "auth.admin_revoked", { type: "user", id: userId }, { source: "ADMIN_EMAILS" });
        }
      }
      if (userId && scheduled) {
        const at = scheduled instanceof Date ? scheduled : new Date(scheduled as string);
        if (!Number.isNaN(at.getTime()) && at.getTime() <= now().getTime()) {
          scope.deps.defer(
            quietly(env, "revoke_deleted", async () => void (await revokeAllAccess(scope.deps, userId))),
          );
        }
      }
      return;
    }
    if (path === "/sign-up/email" && ctx.request) {
      const returned = ctx.context.returned;
      if (returned instanceof Error) {
        const code = (returned as { body?: { code?: unknown } }).body?.code;
        await releaseUnusedReservation(scope, code === FAILED_TO_CREATE_USER);
        return;
      }
      const submitted = (ctx.body as { email?: unknown } | undefined)?.email;
      if (!scope.facts.createdUserId && typeof submitted === "string") {
        // The look-alike answer: the address already has an account, and Better Auth has answered
        // as if it had made one (api/routes/sign-up.mjs — it hashes the password too, and never
        // reaches the `user.create` hook). A new sign-up would have used its invite and taken
        // its place in the day's counts at this point; so does this one — otherwise "is my
        // invite still good?" or "how many sign-ups do I have left today?" would tell the
        // caller, one request later, that the address was taken. A refusal here (the invite
        // went to somebody else in between) is the refusal a new address would have got.
        const address = submitted.toLowerCase();
        let grant: SignupGrant;
        try {
          grant = await takeSignup(scope, address, parseStatement(ctx.body), clientOf(scope, ctx), null);
        } catch (error) {
          scope.reservation = null;
          return refused(error);
        }
        // Spent, not held: there is no account creation left to wait for.
        scope.reservation = null;
        // Better Auth's made-up user has only the fields' defaults. A real new user carries what
        // the policy wrote on it (the terms it accepted and when, the role) — so the made-up one
        // is given the same, or the two answers could be told apart by reading them.
        const body = returned as { user?: Record<string, unknown> } | null | undefined;
        if (body?.user && typeof body.user === "object") {
          Object.assign(body.user, {
            termsAcceptedAt: grant.termsAcceptedAt,
            termsVersion: grant.termsVersion,
            ageVerifiedAt: grant.ageVerifiedAt,
            quotaBytes: grant.quotaBytes,
            role: "user",
          });
        }
        // The owner hears about it — a notice, never a link: whoever sent the request must not
        // be able to make the owner's inbox hand them anything.
        scope.deps.defer(
          afterAnswer(scope, () =>
            quietly(env, "signup_attempt", async () => {
              const owner = await getAccountByEmail(scope.db, address);
              if (owner) {
                await sendSignupAttempt(scope.deps, {
                  to: owner.email,
                  by: { client: scope.client?.ip ?? null },
                });
              }
            }),
          ),
        );
      }
      // "This browser just signed up with that address" — what lets the next screen fix a
      // mistyped address. Set for EVERY successful answer, the look-alike one for an address
      // that already has an account included: its presence says nothing about that.
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      if (typeof email === "string") {
        // The id is the one in the ANSWER: the new account's — or, for the look-alike answer
        // (no account was created), the id of the user Better Auth made up for it. The cookie is
        // signed, not encrypted: an id of its own there would differ from the answer's exactly
        // when the address was taken, and say so in one request.
        const answered = (ctx.context.returned as { user?: { id?: unknown } } | null | undefined)?.user?.id;
        const who = {
          email: email.toLowerCase(),
          userId: typeof answered === "string" && answered !== "" ? answered : generateId(),
        };
        const value = await mintPending(scope.keys, who, 0, now());
        ctx.setCookie(cookieName(env, PENDING_COOKIE), value, cookieAttributes(env, PENDING_COOKIE));
      }
      return;
    }
    if (path && OAUTH_SIGNUP_PATHS.has(path) && scope.facts.createdUserId) {
      // The intent has been used (its nonce is gone); drop the cookie too.
      ctx.setCookie(cookieName(env, INTENT_COOKIE), "", cookieAttributes(env, INTENT_COOKIE, 0));
    }
  });

  return { databaseHooks, before, after };
}
