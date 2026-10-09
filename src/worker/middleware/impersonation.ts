// An impersonated session is read-only. An admin looking at an account through it cannot change
// anything: every state-changing /api/* request is refused, wherever its route lives.
//
// Exempt, exact paths only: stopping the impersonation and signing out. /api/auth/* as a whole is
// NOT exempt — change-password, delete-user and passkey registration live there.
//
// Under /api/auth/* the session middleware has already applied the allow-list of
// auth/endpoint-policy.ts to an impersonated session — GETs included (some of them return session
// tokens or act on the account). The two exempt paths below are allowed there too.
//
// Minting content access is a GET in places (download URLs), so those routes call
// `forbidImpersonation(c)` themselves (through the permissions service).

import { requestMethod, requestPath } from "./canonical";
import type { Context, MiddlewareHandler } from "hono";
import { AppError } from "../services/errors";
import type { AppEnv } from "../services/request-context";
import { SAFE_METHODS } from "./csrf";

/** Better Auth 1.7.7: admin plugin `POST /admin/stop-impersonating`, core `POST /sign-out`. */
export const IMPERSONATION_EXEMPT_PATHS: readonly string[] = Object.freeze([
  "/api/auth/admin/stop-impersonating",
  "/api/auth/sign-out",
]);

function refuse(): never {
  throw new AppError("forbidden", "This is not available while impersonating.", {
    reason: "impersonation_read_only",
  });
}

/** Throws `403 forbidden` (`impersonation_read_only`) when the session is an impersonated one. */
export function forbidImpersonation(c: Context<AppEnv>): void {
  if (c.get("impersonating")) refuse();
}

export const impersonationReadOnly: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get("impersonating") || SAFE_METHODS.has(requestMethod(c))) return next();
  if (IMPERSONATION_EXEMPT_PATHS.includes(requestPath(c))) return next();
  refuse();
};
