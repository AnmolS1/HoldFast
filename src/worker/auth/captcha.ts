// The Turnstile check for a route of OURS (PATCH /api/account/pending-email). The endpoints of
// the auth handler are checked by Better Auth's captcha plugin (auth/create-auth.ts
// CAPTCHA_ENDPOINTS); this is the same check — the same header, the same siteverify request, the
// same two refusals — for a route the plugin never sees.
//
// A token is SINGLE-USE: verify it once per request, and never on a request the plugin also
// verifies.
//
// In test mode the request is answered inside the Worker (auth/test-outbound.ts — `createAuth`
// installs it, and every route that calls this has built the request's auth instance first); no
// test reaches Cloudflare.

import { AppError } from "../services/errors";
import { CAPTCHA_HEADER } from "./preflight";

export const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
/** Well under the auth watchdog (auth/watchdog.ts): a slow Turnstile is a 503, not a "hang". */
export const CAPTCHA_TIMEOUT_MS = 5_000;

/** The token of a request, or a 400 that says only that it is missing (no network, no database). */
export function captchaToken(request: Request): string {
  const token = request.headers.get(CAPTCHA_HEADER);
  if (!token || token.length > 4096) {
    throw new AppError("validation", "Missing CAPTCHA response", { code: "MISSING_RESPONSE" });
  }
  return token;
}

/** Resolves when Turnstile accepts the token; throws 403 when it does not, 503 when it cannot say. */
export async function verifyCaptcha(
  env: Pick<Env, "TURNSTILE_SECRET">,
  token: string,
  ip: string,
): Promise<void> {
  let data: { success?: unknown } | null = null;
  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: ip }),
      signal: AbortSignal.timeout(CAPTCHA_TIMEOUT_MS),
    });
    if (response.ok) data = (await response.json()) as { success?: unknown };
  } catch {
    data = null;
  }
  if (!data) {
    throw new AppError("feature_disabled", "The check could not be completed. Try again.", {
      reason: "captcha_unavailable",
    });
  }
  if (data.success !== true) {
    throw new AppError("forbidden", "Captcha verification failed", { code: "VERIFICATION_FAILED" });
  }
}
