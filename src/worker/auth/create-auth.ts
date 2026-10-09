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
// Ids: Better Auth's own generator (32 characters of [A-Za-z0-9]) — `advanced.database.generateId`
// is deliberately not set. Our own tables use UUIDs; the two families never mix.
//
// The plugin list and the additional fields decide the generated schema (db/auth-schema.ts, from
// auth/config.ts); a unit test holds this file and that one to the same list.

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin, captcha, haveIBeenPwned, twoFactor } from "better-auth/plugins";
import type { Db } from "../db/client";
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
import { createScope, emptyFacts, type AuthScope } from "./scope";
import { installTestOutbound } from "./test-outbound";
import type { Auth } from "./types";

export const SESSION_EXPIRES_IN_S = 60 * 60 * 24 * 14;
export const SESSION_UPDATE_AGE_S = 60 * 60 * 24;
/** The upper bound on how long a revoked session or a changed user field can linger in a cookie. */
export const COOKIE_CACHE_MAX_AGE_S = 60;
export const IMPERSONATION_SESSION_S = 60 * 15;
export const VERIFICATION_EXPIRES_IN_S = 60 * 60;

export const PASSWORD_COMPROMISED_MESSAGE = "This password appears in a known breach. Choose another.";

/** Endpoints that need a Turnstile token (`x-captcha-response`). */
export const CAPTCHA_ENDPOINTS = [
  "/sign-up/email",
  "/sign-in/email",
  "/request-password-reset",
  "/send-verification-email",
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
    advanced: {
      useSecureCookies: secure,
      cookiePrefix: "hf",
      database: { joins: true },
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      // Passed as a reference: this IS the request's defer.
      backgroundTasks: { handler: deps.defer },
    },
    session: {
      expiresIn: SESSION_EXPIRES_IN_S,
      updateAge: SESSION_UPDATE_AGE_S,
      cookieCache: { enabled: true, maxAge: COOKIE_CACHE_MAX_AGE_S },
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
      sendResetPassword: async ({ user, url }: { user: { email: string; name: string }; url: string }) => {
        await sendPasswordReset(deps, { to: user.email, name: user.name, url });
      },
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        scope.facts.passwordResetUserId = user.id;
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
        if (isAddressChangeToken(token)) {
          await sendNewAddressVerification(deps, { to: user.email, name: user.name, url });
        } else {
          const resend = scope.facts.endpointPath === "/send-verification-email";
          await sendVerification(deps, { to: user.email, name: user.name, url, resend });
        }
      },
    },
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        prompt: "select_account" as const,
      },
    },
    account: {
      // Google's tokens are not used after sign-in; what is stored of them is stored encrypted.
      encryptOAuthTokens: true,
    },
    // An OAuth error with no page of its own lands on the sign-in screen, not on a page served
    // from /api/auth.
    onAPIError: { errorURL: `${env.APP_ORIGIN}/login` },
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
          await sendChangeEmailConfirmation(deps, { to: user.email, name: user.name, newEmail, url });
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
          if (request && new URL(request.url).pathname.endsWith("/delete-user/callback")) {
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
      passkey({ rpID: new URL(env.APP_ORIGIN).hostname, rpName: "Holdfast", origin: env.APP_ORIGIN }),
      twoFactor({
        issuer: "Holdfast",
        totpOptions: { digits: 6, period: 30 },
        backupCodeOptions: { amount: 10, length: 10 },
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
      haveIBeenPwned({ customPasswordCompromisedMessage: PASSWORD_COMPROMISED_MESSAGE }),
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
      }
    },
  };
  scopes.set(auth, scope);
  return auth;
}
