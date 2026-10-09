import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
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

// ── an error that arrived in the URL ────────────────────────────────────────────────────────
//
// A refused Google sign-up, a failed OAuth callback and a dead verification link all come back
// as a redirect to /login or /signup with `?error=<code>` (and sometimes `error_description`).
// Both are text anybody can put in a link to this site. Neither is ever shown: a known code picks
// one of OUR sentences, anything else gets the generic one, and `error_description` is not read.

const REDIRECT_ERRORS = new Map<string, MessageKey>([
  // The sign-up policy's refusals (src/worker/services/signup-policy.ts), as a Google sign-up meets them.
  ["SIGNUP_PAUSED", "auth.redirect.signupPaused"],
  ["TERMS_NOT_ACCEPTED", "signup.error.assent"],
  ["SIGNUP_NOT_AVAILABLE", "auth.redirect.notAvailable"],
  ["EMAIL_NOT_ALLOWED", "auth.redirect.emailNotAllowed"],
  ["SIGNUP_LIMIT", "auth.redirect.signupLimit"],
  ["INVITE_INVALID", "auth.redirect.inviteInvalid"],
  ["SIGNUP_INTENT_REQUIRED", "auth.redirect.intentRequired"],
  ["PROVIDER_EMAIL_UNVERIFIED", "auth.redirect.providerUnverified"],
  ["ACCOUNT_SUSPENDED", "login.suspended"],
  // A verification link (Better Auth's GET /verify-email).
  ["TOKEN_EXPIRED", "auth.redirect.linkExpired"],
  ["INVALID_TOKEN", "auth.redirect.linkInvalid"],
  ["USER_NOT_FOUND", "auth.redirect.linkInvalid"],
  ["INVALID_USER", "auth.redirect.linkOtherAccount"],
  // The provider, or the person at its consent screen.
  ["access_denied", "auth.redirect.cancelled"],
  ["email_not_found", "auth.redirect.providerNoEmail"],
  ["email_not_verified", "auth.redirect.providerUnverified"],
  ["account_already_linked_to_different_user", "auth.redirect.accountLinked"],
  ["email_does_not_match", "auth.redirect.accountLinked"],
  ["unable_to_link_account", "auth.redirect.accountLinked"],
]);

/** The sentence for an `?error=` code. Never the code, never anything else from the URL. */
export function redirectErrorMessage(code: string): string {
  return t(REDIRECT_ERRORS.get(code) ?? "auth.redirect.generic");
}

/**
 * Reads `error` out of a query string. Returns our sentence for it (null when there is none) and
 * the same query without `error` and `error_description`, for the address bar.
 */
export function takeRedirectError(search: string): { message: string | null; search: string } {
  const params = new URLSearchParams(search);
  const code = params.get("error");
  if (code === null && !params.has("error_description")) return { message: null, search };
  params.delete("error");
  params.delete("error_description");
  const rest = params.toString();
  return {
    message: code === null ? null : redirectErrorMessage(code),
    search: rest === "" ? "" : `?${rest}`,
  };
}

/**
 * An `?error=` that arrived with the page (a refused Google sign-up, a dead confirmation link):
 * read ONCE into state as one of our own sentences, then removed from the address — together
 * with `error_description`, which is never read — so a reload or a copied link does not carry it.
 */
export function useRedirectError(): string | null {
  const location = useLocation();
  const navigate = useNavigate();
  const [message] = useState<string | null>(() => takeRedirectError(location.search).message);
  useEffect(() => {
    const taken = takeRedirectError(location.search);
    if (taken.search === location.search) return;
    navigate(
      { pathname: location.pathname, search: taken.search, hash: location.hash },
      { replace: true, state: location.state },
    );
  }, [location, navigate]);
  return message;
}

/** The header that carries the Turnstile token. */
export function captchaOptions(token: string | null): { headers: Record<string, string> } | undefined {
  return token ? { headers: { [CAPTCHA_HEADER]: token } } : undefined;
}
