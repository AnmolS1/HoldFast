import type { AuthError } from "../../lib/auth-contract";
import { CAPTCHA_HEADER } from "../../lib/auth-contract";
import { t, type MessageKey } from "../../lib/i18n";

/** One sentence for an auth failure. Server sentences are shown as they are when they exist. */
export function authErrorMessage(error: AuthError, fallback: MessageKey = "auth.error.generic"): string {
  if (error.code === "NOT_WIRED") return t("auth.notWired");
  if (error.status === 429) return t("auth.error.rate");
  if (error.status === 401) return t("auth.error.credentials");
  if (error.message && error.status >= 400 && error.status < 500) return error.message;
  return t(fallback);
}

/** The header that carries the Turnstile token. */
export function captchaOptions(token: string | null): { headers: Record<string, string> } | undefined {
  return token ? { headers: { [CAPTCHA_HEADER]: token } } : undefined;
}
