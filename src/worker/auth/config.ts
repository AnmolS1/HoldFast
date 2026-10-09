// The minimal Better Auth config. Its only job is to drive `npm run auth:generate`, which writes
// src/worker/db/auth-schema.ts; the runtime instance is built per request in create-auth.ts.
//
// The `auth` CLI imports this file under Node: no `cloudflare:*` import and no `env` access at
// module scope. The database below is never connected to.
//
// The plugin list and the two `additionalFields` objects decide the generated tables and columns.
// The objects are defined once, in ./fields, which create-auth.ts imports directly (importing
// this module at runtime would build a second, module-scope instance).

import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import { betterAuth } from "better-auth";
import { admin, captcha, haveIBeenPwned, twoFactor } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/node-postgres";

// The two `additionalFields` objects live in ./fields (a module with no imports, which the
// runtime can import without evaluating this one) and are re-exported here: one definition, so
// the generator's input and the runtime cannot drift. `returned: false` on three of them is not
// a column attribute and does not change the generated schema.
import { sessionAdditionalFields, userAdditionalFields } from "./fields";

export { sessionAdditionalFields, userAdditionalFields };

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
