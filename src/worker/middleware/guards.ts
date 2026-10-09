// What a route asks of the session. Each returns the user or throws.
//
//   const user = requireUser(c);       401 unauthorized — the source of a 401 on our routes
//   const user = requireVerified(c);   + 403 forbidden (email_unverified)
//   const admin = requireAdmin(c);     + 403 forbidden (not an admin, or an impersonated session)
//                                      + 403 admin_requires_2fa (an admin without two-factor, or
//                                        whose SESSION has not passed a second factor)

import type { Context } from "hono";
import { hasAdminRole } from "../../shared/roles";
import { hasSecondFactor } from "../auth/second-factor";
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

export function requireAdmin(c: Context<AppEnv>): SessionUser {
  const user = requireUser(c);
  // An impersonated session belongs to the target user; it is never an admin session.
  if (c.get("impersonating")) {
    throw new AppError("forbidden", undefined, { reason: "impersonation_read_only" });
  }
  if (!hasAdminRole(user.role)) throw new AppError("forbidden");
  if (user.twoFactorEnabled !== true) throw new AppError("admin_requires_2fa");
  // Two-factor on the ACCOUNT is not enough: this session must have passed it — a session made
  // by Google, a passkey without user verification, a trusted device or a mailed link has not
  // (auth/second-factor.ts). The way through is a step-up: POST /api/auth/two-factor/verify-totp.
  if (!hasSecondFactor(c.get("session"))) throw new AppError("admin_requires_2fa");
  return user;
}
