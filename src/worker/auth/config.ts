// The minimal Better Auth config. Its only job is to drive `npm run auth:generate`, which writes
// src/worker/db/auth-schema.ts; the runtime instance is built per request in create-auth.ts.
//
// The `auth` CLI imports this file under Node: no `cloudflare:*` import and no `env` access at
// module scope. The database below is never connected to.
//
// The plugin list and the two `additionalFields` objects decide the generated tables and columns.
// create-auth.ts imports both objects from here, so the generated schema and the runtime config
// cannot drift.

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { admin, captcha, haveIBeenPwned, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";

/** 5 GiB, the beta quota. */
const DEFAULT_QUOTA_BYTES = 5_368_709_120;

/**
 * Persisted on `user`. Every field is `input: false`: none can be set through a Better Auth
 * request body (sign-up, update-user); the server writes them.
 *
 * The four `date` fields generate as `timestamp` WITHOUT time zone (see db/client.ts).
 * Never persisted, so not declared: birth year and month, the invite code, the terms checkbox.
 */
export const userAdditionalFields = {
  // 64-bit columns (`bigint: true`); Better Auth returns them as JS numbers.
  quotaBytes: {
    type: "number",
    bigint: true,
    required: true,
    defaultValue: DEFAULT_QUOTA_BYTES,
    input: false,
  },
  usedBytes: { type: "number", bigint: true, required: true, defaultValue: 0, input: false },
  ageVerifiedAt: { type: "date", required: false, input: false },
  termsAcceptedAt: { type: "date", required: false, input: false },
  termsVersion: { type: "string", required: false, input: false },
  /** The inviting user's id. A plain value, not a foreign key. */
  invitedBy: { type: "string", required: false, input: false },
  suspendedAt: { type: "date", required: false, input: false },
  suspendedReason: { type: "string", required: false, input: false },
  legalHold: { type: "boolean", required: true, defaultValue: false, input: false },
  deleteScheduledAt: { type: "date", required: false, input: false },
  displayNameKey: { type: "string", required: false, input: false },
  /** IANA name. The only home of the time zone. */
  timezone: { type: "string", required: false, input: false },
  locale: { type: "string", required: true, defaultValue: "en", input: false },
  /** Id of the user's `system = 'avatar'` node, or null. A plain value, not a foreign key. */
  avatarNodeId: { type: "string", required: false, input: false },
} as const;

/** Persisted on `session`; written by the session-create hook. */
export const sessionAdditionalFields = {
  /** From `request.cf.country`. */
  country: { type: "string", required: false, input: false },
  uaFamily: { type: "string", required: false, input: false },
} as const;

export const auth = betterAuth({
  appName: "Holdfast",
  baseURL: "http://localhost",
  secret: "schema-generation-only-never-used-at-runtime",
  database: drizzleAdapter(drizzle("postgres://generate:generate@localhost:5432/never_connected"), {
    provider: "pg",
  }),
  emailAndPassword: { enabled: true },
  socialProviders: { google: { clientId: "schema-generation-only", clientSecret: "schema-generation-only" } },
  // Without `storage: "database"` the `rate_limit` table is not generated.
  rateLimit: { storage: "database" },
  user: { additionalFields: userAdditionalFields },
  session: { additionalFields: sessionAdditionalFields },
  plugins: [
    passkey(),
    twoFactor(),
    admin(),
    captcha({ provider: "cloudflare-turnstile", secretKey: "schema-generation-only" }),
    haveIBeenPwned(),
  ],
});
