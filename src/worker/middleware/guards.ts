// What a route asks of the session. Each returns the user or throws.
//
//   const user = requireUser(c);       401 unauthorized — the source of a 401 on our routes
//   const user = requireVerified(c);   + 403 forbidden (email_unverified)
//   const admin = requireAdmin(c);     + 403 forbidden (not an admin, or an impersonated session)
//                                      + 403 admin_requires_2fa (an admin without two-factor)

import type { Context } from "hono";
import type { SessionUser } from "../auth/types";
import { AppError } from "../services/errors";
import type { AppEnv } from "../services/request-context";

export function requireUser(c: Context<AppEnv>): SessionUser {
  const user = c.get("user");
  if (!user) throw new AppError("unauthorized");
  return user;
}

export function requireVerified(c: Context<AppEnv>): SessionUser {
  const user = requireUser(c);
  if (!user.emailVerified) {
    throw new AppError("forbidden", "Verify your email address first.", { reason: "email_unverified" });
  }
  return user;
}

/** Better Auth's admin plugin stores one role or a comma-separated list. */
export function hasAdminRole(user: Pick<SessionUser, "role">): boolean {
  return (user.role ?? "").split(",").some((role) => role.trim() === "admin");
}

export function requireAdmin(c: Context<AppEnv>): SessionUser {
  const user = requireUser(c);
  // An impersonated session belongs to the target user; it is never an admin session.
  if (c.get("impersonating")) {
    throw new AppError("forbidden", undefined, { reason: "impersonation_read_only" });
  }
  if (!hasAdminRole(user)) throw new AppError("forbidden");
  if (user.twoFactorEnabled !== true) throw new AppError("admin_requires_2fa");
  return user;
}
