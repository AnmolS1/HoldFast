import "./als-preseed"; // MUST stay the first import: Better Auth issue #10315, see als-preseed.ts.

// The Better Auth instance. `createAuth(env, db, ctx)` is called at most once per request, by
// the request context (`auth(c)`); the instance is NEVER cached on the isolate, and nothing in
// this file (or anything it imports) loads Better Auth through a dynamic `import()` — the two
// rules, with the pre-seed above, that keep an aborted request from hanging an isolate.
//
// `ctx` is not the Worker's ExecutionContext: its `waitUntil` is the request's `defer`, so
// whatever Better Auth runs "in the background" (the mails, its rate-limit pruning) is drained
// before the database pool closes.
//
// Ids: Better Auth's own (32 characters of [A-Za-z0-9]) — no id function is configured under
// `advanced.database`, deliberately. Our own tables use UUIDs; the two families never mix.
//
// The plugin list and the additional fields decide the generated schema (db/auth-schema.ts, from
// auth/config.ts); a unit test holds this file and that one to the same list.

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, captcha, twoFactor } from "better-auth/plugins";
import type { Db } from "../db/client";
import { deleteTrustedDevices } from "../db/queries/auth-lifecycle";
import * as schema from "../db/schema";
import { scheduleDeletion } from "../services/account-state";
import {
  sendChangeEmailConfirmation,
  sendDeleteAccountVerification,
  sendNewAddressVerification,
  sendPasswordReset,
  sendVerification,
} from "../services/email";
import type { AuthContext, ServiceDeps } from "../services/request-context";
import { sessionAdditionalFields, userAdditionalFields } from "./fields";
import { buildHooks, releaseUnusedReservation } from "./hooks";
import { authLog } from "./logger";
import { VERIFY_LINK_EXPIRES_IN_S } from "./mailbox-proof";
import { hashPassword, verifyPassword } from "./password";
import { passkeyAuthentication } from "./second-factor";
import { COOKIE_HOST_PREFIX } from "./signed-cookie";
import { afterAnswer, createScope, emptyFacts, type AuthScope } from "./scope";
import { installTestOutbound } from "./test-outbound";
import type { Auth } from "./types";

export const SESSION_EXPIRES_IN_S = 60 * 60 * 24 * 14;
export const SESSION_UPDATE_AGE_S = 60 * 60 * 24;
export const IMPERSONATION_SESSION_S = 60 * 15;
export const VERIFICATION_EXPIRES_IN_S = VERIFY_LINK_EXPIRES_IN_S;

export { PASSWORD_COMPROMISED_MESSAGE } from "./breach-check";

/**
 * Endpoints that need a valid Turnstile token (`x-captcha-response`) — every unauthenticated
 * endpoint that hashes a password or does work that depends on an account. The plugin verifies
 * it in `onRequest` (better-auth/dist/plugins/captcha/index.mjs:22, called from api/index.mjs:174
 * — after the per-address limiter at :172, before the endpoint and its hooks).
 */
export const CAPTCHA_ENDPOINTS = [
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/send-verification-email",
  "/reset-password",
];

/** Does a verification token change an address (rather than verify a new account's)? */
function isAddressChangeToken(token: string): boolean {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    return typeof (JSON.parse(json) as { updateTo?: unknown }).updateTo === "string";
  } catch {
    return false;
  }
}

export function buildAuthOptions(scope: AuthScope) {
  const { env, db, deps } = scope;
  const secure = env.APP_ORIGIN.startsWith("https://");
  const hooks = buildHooks(scope);

  return {
    appName: "Holdfast",
    // Explicit, so that no link and no cookie attribute is ever derived from a request's Host.
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [env.APP_ORIGIN],
    database: drizzleAdapter(db, { provider: "pg", schema }),
    telemetry: { enabled: false },
    // Warnings and errors only, and every line redacted before it reaches the Worker's log.
    logger: { disabled: false, level: "warn" as const, log: authLog },
    advanced: {
      // On https every cookie is `__Host-hf.<name>; Secure; Path=/` with no Domain (see
      // COOKIE_HOST_PREFIX in signed-cookie.ts for why not `__Secure-`). Better Auth's own
      // switch can only produce `__Secure-` (cookies/index.mjs: `secureCookiePrefix`), so it is
      // left off and the prefix and the Secure attribute are given here; every cookie it and
      // its plugins create goes through the same `createCookie`, with Path=/ and no Domain.
      useSecureCookies: false,
      cookiePrefix: secure ? `${COOKIE_HOST_PREFIX}hf` : "hf",
      defaultCookieAttributes: secure ? { secure: true } : {},
      database: { joins: true },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Passed as a reference: this IS the request's defer.
      backgroundTasks: { handler: deps.defer },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: SESSION_UPDATE_AGE_S,
      // OFF, explicitly. The cache is a signed copy of the session AND of the user row that the
      // browser holds and Better Auth answers from without asking the database: with it, a
      // session revoked a second ago (a suspension, a ban, a password reset, "sign out
      // everywhere") went on working until the copy expired. Every request reads the session row
      // instead; nothing is cached in a cookie. (A `session_data` cookie a browser still holds
      // from before is ignored: api/routes/session.mjs reads it only when the cache is enabled.)
      cookieCache: { enabled: false },
      additionalFields: sessionAdditionalFields,
    },
    rateLimit: {
      enabled: true,
      storage: "database" as const,
      window: 60,
      max: 30,
      customRules: {
        // The shell reads the session in every route guard and on every window focus. Better
        // Auth's default (30 a minute per address and path) would make people behind one
        // address fail each other's page loads; the read is limited by RL_API instead.
        "/get-session": false as const,
        "/sign-in/email": { window: 60, max: 5 },
        "/sign-up/email": { window: 3600, max: 5 },
        "/request-password-reset": { window: 3600, max: 3 },
        "/send-verification-email": { window: 3600, max: 3 },
        "/two-factor/verify-totp": { window: 60, max: 5 },
        "/two-factor/verify-backup-code": { window: 60, max: 5 },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // Better Auth's own scrypt, through a module a test can count calls on (./password.ts).
      password: { hash: hashPassword, verify: verifyPassword },
      sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        // Handed to the request's deferred work and started only once the request is answered —
        // never awaited here: an answer that waited for a mail, or shared its round trips with
        // one, would be slower exactly when the address has an account (auth/parity.ts).
        deps.defer(
          afterAnswer(scope, () => sendPasswordReset(deps, { to: user.email, name: user.name, url })),
        );
      },
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        scope.facts.passwordResetUserId = user.id;
        // "Remember this device" does not outlive the password it was granted under.
        await deleteTrustedDevices(db, user.id);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: VERIFICATION_EXPIRES_IN_S,
      sendVerificationEmail: async ({
        user,
        url,
        token,
      }: {
        user: { email: string; name: string };
        url: string;
        token: string;
      }) => {
        // Deferred, never awaited (see `sendResetPassword` above).
        if (isAddressChangeToken(token)) {
          deps.defer(
            afterAnswer(scope, () =>
              sendNewAddressVerification(deps, { to: user.email, name: user.name, url }),
            ),
          );
        } else {
          const resend = scope.facts.endpointPath === "/send-verification-email";
          deps.defer(
            afterAnswer(scope, () =>
              sendVerification(deps, { to: user.email, name: user.name, url, resend }),
            ),
          );
        }
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account" as const,
        // Only the redirect flow (state row + signed state cookie + PKCE). The shortcut that
        // takes an ID token in a POST — no redirect, no state, an optional caller-chosen nonce —
        // is something the app never uses (api/routes/sign-in.mjs → ID_TOKEN_NOT_SUPPORTED).
        disableIdTokenSignIn: true,
      },
    },
    account: {
      // Google's tokens are not used after sign-in, and none is stored: the `account` hooks
      // (auth/hooks.ts) write null for the ID token — a signed statement of the person's name and
      // address, which this option would not have encrypted — and for the access and refresh
      // tokens. The option stays on for anything that might ever be stored.
      encryptOAuthTokens: true,
      // Linking a provider identity to an existing account (see the `account.create` hook in
      // auth/hooks.ts, which is where the policy for an UNVERIFIED local account lives):
      //  - no trusted providers: a link needs the provider to say the address is verified;
      //  - never to a different address;
      //  - `requireLocalEmailVerified: false` hands the unverified-local case to our hook, which
      //    either empties the account first or refuses. Better Auth's default (true) refuses it
      //    outright — safe, but then whoever signed up first with someone's address locks that
      //    person out of signing in with Google for good.
      accountLinking: {
        enabled: true,
        trustedProviders: [],
        allowDifferentEmails: false,
        requireLocalEmailVerified: false,
        updateUserInfoOnLink: false,
      },
    },
    onAPIError: {
      // An OAuth error with no page of its own lands on the sign-in screen, not on a page
      // served from /api/auth.
      errorURL: `${env.APP_ORIGIN}/login`,
      // An error that is not Better Auth's own (a database failure, say) is THROWN out of the
      // handler instead of being printed by the router underneath: better-call's fallback is
      // `console.error("# SERVER_ERROR: ", error)` (better-call/dist/router.mjs:93) — the whole
      // error object, unredacted, straight to the Worker's log. routes/auth.ts catches it and
      // reports a sanitised copy. An APIError is answered exactly as before (router.mjs:88).
      throw: true,
    },
    user: {
      additionalFields: userAdditionalFields,
      changeEmail: {
        enabled: true,
        // To the CURRENT address; the new one is verified after that link is followed.
        sendChangeEmailConfirmation: async ({
          user,
          newEmail,
          url,
        }: {
          user: { email: string; name: string };
          newEmail: string;
          url: string;
        }) => {
          deps.defer(
            afterAnswer(scope, () =>
              sendChangeEmailConfirmation(deps, { to: user.email, name: user.name, newEmail, url }),
            ),
          );
        },
      },
      deleteUser: {
        enabled: true,
        sendDeleteAccountVerification: async ({
          user,
          url,
        }: {
          user: { email: string; name: string };
          url: string;
        }) => {
          await sendDeleteAccountVerification(deps, { to: user.email, name: user.name, url });
        },
        // THE VETO. Better Auth deletes the account the moment this returns, so it never
        // returns: it schedules the deletion instead and always throws, and the thrown APIError
        // IS the client's answer. Everything it starts — the audit row, the email — has settled
        // before it throws (a local `defer`, drained here): nothing is left to the request's
        // deferred work, and `ctx.waitUntil` is never called from this hook.
        // No `afterDelete`, and no `databaseHooks.user.delete` (returning false from that one
        // is not a veto: sessions and accounts are already gone by then).
        beforeDelete: async (user: { id: string }, request?: Request): Promise<void> => {
          const local: Promise<unknown>[] = [];
          const localDeps: ServiceDeps = { db, env, defer: (promise) => void local.push(promise) };
          await scheduleDeletion(localDeps, user.id);
          while (local.length) await Promise.allSettled(local.splice(0));
          // The endpoint the request reached, as Better Auth matched it (hooks.before records it).
          if (request && scope.facts.endpointPath === "/delete-user/callback") {
            throw new APIError("FOUND", undefined, {
              Location: `${env.APP_ORIGIN}/account?deletion=scheduled`,
            });
          }
          throw new APIError("OK", { success: true, message: "Deletion scheduled" });
        },
      },
    },
    databaseHooks: hooks.databaseHooks,
    hooks: { before: hooks.before, after: hooks.after },
    // The same plugins in the same order as auth/config.ts (the schema generator's input).
    plugins: [
      passkey({
        rpID: new URL(env.APP_ORIGIN).hostname,
        rpName: "Holdfast",
        origin: env.APP_ORIGIN,
        // Lets the assertion's user-verification flag be seen (auth/second-factor.ts): the
        // plugin itself never requires it.
        authentication: passkeyAuthentication(scope),
      }),
      twoFactor({
        issuer: "Holdfast",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: 10, length: 10 },
        // The plugin's own lock reads the counter, checks and then counts — and only for the
        // sign-in challenge. auth/second-factor.ts keeps the account's attempt budget instead,
        // in one statement, for every way a code can be offered.
        accountLockout: { enabled: false },
      }),
      admin({
        defaultRole: "user",
        adminRoles: ["admin"],
        impersonationSessionDuration: IMPERSONATION_SESSION_S,
      }),
      captcha({
        provider: "cloudflare-turnstile",
        secretKey: env.TURNSTILE_SECRET,
        endpoints: CAPTCHA_ENDPOINTS,
      }),
    ],
  };
}

const scopes = new WeakMap<Auth, AuthScope>();

/** The per-request scope behind an instance `createAuth` returned (routes/auth.ts uses it). */
export function scopeOf(auth: Auth): AuthScope | null {
  return scopes.get(auth) ?? null;
}

export function createAuth(env: Env, db: Db, ctx: AuthContext): Auth {
  // Test mode only (never on a deploy): stand-ins for the third parties Better Auth calls.
  installTestOutbound(env);
  const scope = createScope(env, db, ctx);
  const instance = betterAuth(buildAuthOptions(scope));
  const auth: Auth = {
    api: instance.api,
    async handler(request) {
      scope.facts = emptyFacts();
      try {
        return await instance.handler(request);
      } finally {
        // A sign-up that took an invite and velocity counts but did not create its account
        // (it failed, or threw) gives them back.
        await releaseUnusedReservation(scope);
        // Called without the route (a test, a script): the handler's return IS the answer.
        if (!scope.answered.held) scope.answered.release();
      }
    },
  };
  scopes.set(auth, scope);
  return auth;
}
