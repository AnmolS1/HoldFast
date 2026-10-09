// GET /api/public/config → PublicConfig (src/shared/public-config.ts). No auth, no session read.
// Env values, with the settings table over them for signupMode, termsVersion and the three
// switches. Nothing secret is ever added to this object.

import { Hono } from "hono";
import { PublicConfig } from "../../shared/public-config";
import { buildMeta } from "../meta";
import { settings, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

router.get("/public/config", async (c) => {
  const env = c.env;
  const current = await settings(c);
  const config: PublicConfig = {
    signupMode: current.signupMode,
    quotaBytes: Number(env.QUOTA_BYTES),
    maxFileBytes: Number(env.MAX_FILE_BYTES),
    partBytes: Number(env.PART_BYTES),
    turnstileSiteKey: env.TURNSTILE_SITEKEY,
    appOrigin: env.APP_ORIGIN,
    filesOrigin: env.FILES_ORIGIN,
    termsVersion: current.termsVersion,
    uploadsEnabled: current.uploadsEnabled,
    linksEnabled: current.linksEnabled,
    readOnly: current.readOnly,
    sentryDsnWeb: env.SENTRY_DSN_WEB || null,
    sentryEnvironment: env.SENTRY_ENVIRONMENT,
    release: buildMeta().commit,
  };
  // Parsed on the way out: a missing or non-numeric var fails here, not in the browser.
  return c.json(PublicConfig.parse(config));
});
