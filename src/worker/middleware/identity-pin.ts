// The identity pin (W2S4). The SPA keeps the state of ONE account in memory and names it on every
// API request in `X-Holdfast-User`. The session cookie is the browser's, shared by every tab: a
// second tab that signs in as another account changes who THIS tab's next request runs as. Such a
// request is refused here, right after the session is read and before anything of that other
// account is consulted (its impersonation, its terms, its limiter bucket) — the SPA then adopts the
// account the browser is now signed in as (purges, re-reads the session, starts again at /).
//
//   no header                 passes: a client that names nobody (curl, tests, anything but the SPA)
//   header, no session user   passes: the route's own 401, which opens the SPA's re-auth
//   header ≠ session user     403 forbidden, details.reason = "identity_mismatch", every method
//
// Not on the paths that never read a session for an account's data: /api/public/*, /api/_test/*,
// /api/health. Under /api/auth/* only the endpoints of PIN_EXEMPT_AUTH_ROUTES go unpinned.

import { requestPath } from "./canonical";
import type { MiddlewareHandler } from "hono";
import { HEADER_USER } from "../../shared/constants";
import { AppError } from "../services/errors";
import type { AppEnv } from "../services/request-context";

/** src/shared/constants.ts — the client's lib/api.ts sends the same header. */
export const IDENTITY_HEADER = HEADER_USER.toLowerCase();

const EXEMPT_PREFIXES = ["/api/public/", "/api/_test/"];
const AUTH_PREFIX = "/api/auth";

/**
 * The Better Auth endpoints (paths after `/api/auth`, as in auth/endpoint-policy.ts) that run
 * WITHOUT a matching pin, each with why: they establish, read or end the browser's identity, or
 * they are reached by a link from a mail or a provider (a navigation: no header can be sent), or
 * they are a step of signing IN. Every other endpoint of the installed Better Auth is pinned —
 * account mutations (password, address, deletion, second factor, passkeys, sessions) and admin/*.
 * tests/unit/worker-core/identity-pin-auth.test.ts enumerates the installed route table and
 * fails on a route that is neither pinned nor named here.
 */
export const PIN_EXEMPT_AUTH_ROUTES: Readonly<Record<string, string>> = {
  "/sign-in/email": "signs the browser in as whoever this is: the result is the browser's identity",
  "/sign-in/social": "starts a provider sign-in: the result is the browser's identity",
  "/callback/:id": "the provider's redirect back: a navigation, no header",
  "/sign-up/email": "creates an account and signs the browser in as it",
  "/sign-out": "ends the browser's session, whoever it is: a stale tab must still be able to sign out",
  "/get-session": "reads the browser's identity: the adoption itself asks it",
  "/verify-email": "the link in the confirmation mail: a navigation, no header",
  "/request-password-reset": "takes an address, not a session",
  "/reset-password": "takes the token from the mail, not a session",
  "/reset-password/:token": "the link in the reset mail: a navigation, no header",
  "/two-factor/verify-totp": "the second factor of a sign-in",
  "/two-factor/verify-backup-code": "the second factor of a sign-in",
  "/two-factor/verify-otp": "the second factor of a sign-in",
  "/two-factor/send-otp": "sends the second factor of a sign-in",
  "/passkey/generate-authenticate-options": "the first step of a passkey sign-in",
  "/passkey/verify-authentication": "a passkey sign-in",
};

/** A route pattern as an exact matcher: `:name` is one non-empty segment, the rest literal. */
function matcher(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

const EXEMPT_AUTH = Object.keys(PIN_EXEMPT_AUTH_ROUTES).map(matcher);

/** Is this request path (the full `/api/auth/…`, as sent) an endpoint that goes unpinned? */
export function pinExemptAuthPath(path: string): boolean {
  if (!path.startsWith(`${AUTH_PREFIX}/`)) return false;
  const relative = path.slice(AUTH_PREFIX.length);
  return EXEMPT_AUTH.some((test) => test.test(relative));
}

export const identityPin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = requestPath(c);
  if (!path.startsWith("/api/") || path === "/api/health") return next();
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();
  if (pinExemptAuthPath(path)) return next();
  const claimed = c.req.header(IDENTITY_HEADER);
  const user = c.get("user");
  if (claimed === undefined || !user) return next();
  if (claimed !== user.id) {
    throw new AppError("forbidden", "This browser is signed in to another account now.", {
      reason: "identity_mismatch",
    });
  }
  return next();
};
