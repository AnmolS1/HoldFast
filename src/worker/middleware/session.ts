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
//   deletion date passed     the session does not exist: user = null on every path (→ 401 from
//                            requireUser on our routes), whether or not the purge has run.
//                            Under /api/auth/* Better Auth would still honour the cookie, so a
//                            request there that is not a GET or HEAD is answered 401 here —
//                            except sign-out and the sign-in / sign-up endpoints, which do not
//                            act on that account. Reads go through (the auth task makes the
//                            session read itself answer "signed out" for such a user).
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

/** Auth endpoints that end a session or start another one: they never change the signed-in account. */
const SESSION_NEUTRAL_AUTH = ["/api/auth/sign-out", "/api/auth/sign-in/", "/api/auth/sign-up/"];

/** A request under /api/auth/* that could change the account the session belongs to. */
function isAuthWriteOnAccount(method: string, path: string): boolean {
  if (!path.startsWith("/api/auth/") || method === "GET" || method === "HEAD") return false;
  return !SESSION_NEUTRAL_AUTH.some((allowed) =>
    allowed.endsWith("/") ? path.startsWith(allowed) : path === allowed,
  );
}

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

  // Before any early return below: an impersonated session stays read-only even when its user is
  // suspended, banned or past its deletion date and is therefore not put on c.var. Better Auth
  // would still honour the cookie on /api/auth/*.
  c.set("impersonating", Boolean(found.session.impersonatedBy));

  const user = withDates(found.user);
  const at = now(c).getTime();

  // Fail closed on an unreadable date: a deletion date that cannot be read counts as passed, a
  // ban expiry that cannot be read as "no expiry".
  const deleteAt = toDate(user.deleteScheduledAt as unknown);
  if (deleteAt === undefined || (deleteAt !== null && deleteAt.getTime() <= at)) {
    // The same answer a request with no session gets: the account behaves as deleted, and the
    // answer is identical whether the purge has run, is pending, or is held back.
    // (An impersonated session is left to the read-only rule that follows: it refuses every
    // write but `stop-impersonating`, which an admin must still be able to reach.)
    if (!c.get("impersonating") && isAuthWriteOnAccount(c.req.method, path)) {
      throw new AppError("unauthorized");
    }
    return next();
  }

  const banExpires = toDate(user.banExpires as unknown);
  const banned = user.banned === true && !(banExpires instanceof Date && banExpires.getTime() <= at);
  const suspended = user.suspendedAt !== null && user.suspendedAt !== undefined;
  if (banned || suspended) {
    if (path.startsWith("/api/auth/")) return next();
    throw new AppError("forbidden", "This account is suspended.", { reason: "account_suspended" });
  }

  c.set("user", user);
  c.set("session", found.session);
  c.set("termsStale", user.termsVersion !== (await settings(c)).termsVersion);
  return next();
};
