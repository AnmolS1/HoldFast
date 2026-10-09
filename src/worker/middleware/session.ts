// Resolves the session for /api/* and decides whether its user may act.
//
// Runs for every /api/* path except /api/public/*, /api/health and /api/_test/* — those never
// read a session, so they never open the database for one. Sets `c.var.user`, `c.var.session`,
// `c.var.impersonating`, `c.var.termsStale`.
//
// The session's user comes from Better Auth's cookie cache and can be up to 60 s old, and
// revoking sessions is only as fast as that cache. So the user's own flags are checked here on
// every request instead of trusting the revoke:
//
//   deletion date passed     the session does not exist, on every path (user = null → 401 from
//                            requireUser). True whether or not the purge has run.
//   banned (not expired)     /api/auth/*: treated as signed out, Better Auth answers.
//   or suspended             anywhere else: 403 forbidden, details.reason = "account_suspended".
//   deletion date in future  allowed: the owner must reach the cancel banner and their files.
//
// Anything that must be immediate (not ≤ 60 s) reads the database, not this.

import type { MiddlewareHandler } from "hono";
import type { SessionUser } from "../auth/types";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { auth, settings, type AppEnv } from "../services/request-context";

const SKIPPED_PREFIXES = ["/api/public/", "/api/_test/"];

/**
 * A date field as a Date. Through the cookie cache Better Auth re-creates only `createdAt`,
 * `updatedAt` and `expiresAt`; every other date arrives as the ISO string it was serialised to.
 * `undefined` for a value that is present but not a date.
 */
function toDate(value: unknown): Date | null | undefined {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

const DATE_FIELDS = [
  "banExpires",
  "suspendedAt",
  "deleteScheduledAt",
  "termsAcceptedAt",
  "ageVerifiedAt",
] as const;

/** The user with every date field a real Date (or null). An unreadable value is kept as it came. */
function withDates(user: SessionUser): SessionUser {
  const out: Record<string, unknown> = { ...user };
  for (const field of DATE_FIELDS) {
    const parsed = toDate(out[field]);
    if (parsed !== undefined) out[field] = parsed;
  }
  return out as SessionUser;
}

export const session: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  if (
    !path.startsWith("/api/") ||
    path === "/api/health" ||
    SKIPPED_PREFIXES.some((p) => path.startsWith(p))
  ) {
    return next();
  }

  const found = await auth(c).api.getSession({ headers: c.req.raw.headers });
  if (!found) return next();

  const user = withDates(found.user);
  const at = now(c).getTime();

  // Fail closed on an unreadable date: a deletion date that cannot be read counts as passed, a
  // ban expiry that cannot be read as "no expiry".
  const deleteAt = toDate(user.deleteScheduledAt as unknown);
  if (deleteAt === undefined || (deleteAt !== null && deleteAt.getTime() <= at)) return next();

  const banExpires = toDate(user.banExpires as unknown);
  const banned = user.banned === true && !(banExpires instanceof Date && banExpires.getTime() <= at);
  const suspended = user.suspendedAt !== null && user.suspendedAt !== undefined;
  if (banned || suspended) {
    if (path.startsWith("/api/auth/")) return next();
    throw new AppError("forbidden", "This account is suspended.", { reason: "account_suspended" });
  }

  c.set("user", user);
  c.set("session", found.session);
  c.set("impersonating", Boolean(found.session.impersonatedBy));
  c.set("termsStale", user.termsVersion !== (await settings(c)).termsVersion);
  return next();
};
