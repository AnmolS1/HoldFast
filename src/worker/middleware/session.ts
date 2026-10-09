// Resolves the session for /api/* and decides whether its user may act.
//
// Runs for every /api/* path except /api/public/*, /api/health and /api/_test/* — those never
// read a session, so they never open the database for one. Sets `c.var.user`, `c.var.session`,
// `c.var.impersonating`, `c.var.termsStale`.
//
// THE SESSION IS READ FROM THE DATABASE, on every request — never from Better Auth's cookie cache.
// The cache is a signed copy of the session AND of the user row that the browser holds for up to
// 60 s. Read from it, a session that was revoked a second ago (a suspension, a ban, a password
// reset, "sign out everywhere") went on being a session for the rest of the minute, and the
// user's flags below were the flags of a minute ago: a just-suspended account kept the whole API.
// One indexed read per request is the price of "revoked" meaning revoked. (The cache still
// serves the browser's own GET /api/auth/get-session, which only decides what the shell draws;
// every request the shell then makes comes through here.)
//
// The user's own flags are checked as well, because a revoke is not the only way to lose access:
//
//   deletion date passed     the session does not exist: user = null on every path (→ 401 from
//                            requireUser on our routes), whether or not the purge has run.
//   banned (not expired)     our routes: 403 forbidden, details.reason = "account_suspended".
//   or suspended
//   deletion date in future  allowed: the owner must reach the cancel banner and their files.
//
// Under /api/auth/* Better Auth answers, and it honours the cookie whatever those flags say. So
// for a session in a restricted state — impersonated, past its deletion date, suspended or
// banned — this middleware consults the allow-list in auth/endpoint-policy.ts BEFORE the auth
// handler runs: only the endpoints listed there for that state pass; everything else, known or
// unknown, GET or not, is refused here (401 for a deleted account, 403 otherwise). The session
// read of a deleted account is answered as signed out.
//
// Still read by the routes themselves where a decision hangs on one field: the terms gate.

import type { MiddlewareHandler } from "hono";
import { AUTH_PREFIX, authGateDecision, type AuthGateState } from "../auth/endpoint-policy";
import type { SessionUser } from "../auth/types";
import { HANG, hungAnswer, watched } from "../auth/watchdog";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { auth, settings, type AppEnv } from "../services/request-context";

const SKIPPED_PREFIXES = ["/api/public/", "/api/_test/"];

function refusal(state: AuthGateState): AppError {
  switch (state) {
    case "impersonating":
      return new AppError("forbidden", "This is not available while impersonating.", {
        reason: "impersonation_read_only",
      });
    case "suspended":
      return new AppError("forbidden", "This account is suspended.", { reason: "account_suspended" });
    case "deleted":
      // The answer a request with no session gets: the account behaves as deleted, and the answer
      // is the same whether the purge has run, is pending, or is held back.
      return new AppError("unauthorized");
  }
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

  // Under the #10315 watchdog (auth/watchdog.ts): this is the first Better Auth call of every
  // /api/* request, so a hang here would hang every API route — it is answered 503 instead.
  const found = await watched(
    auth(c).api.getSession({
      headers: c.req.raw.headers,
      query: { disableCookieCache: true },
    }),
  );
  if (found === HANG) return hungAnswer(c, "session");
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
  const deleted = deleteAt === undefined || (deleteAt !== null && deleteAt.getTime() <= at);
  const banExpires = toDate(user.banExpires as unknown);
  const banned = user.banned === true && !(banExpires instanceof Date && banExpires.getTime() <= at);
  const suspended = user.suspendedAt !== null && user.suspendedAt !== undefined;

  // Impersonation first: whatever the target account's state, the admin must be able to stop.
  const state: AuthGateState | null = c.get("impersonating")
    ? "impersonating"
    : deleted
      ? "deleted"
      : banned || suspended
        ? "suspended"
        : null;
  const onAuth = path.startsWith(`${AUTH_PREFIX}/`);
  if (onAuth && state) {
    // The path exactly as it was sent, not Hono's percent-decoded one: the allow-list matches
    // literal spellings only, so an encoded or otherwise unusual path is simply not on it.
    const decision = authGateDecision(state, new URL(c.req.url).pathname);
    if (decision === "deny") throw refusal(state);
    // Better Auth's own signed-out body, without reaching Better Auth.
    if (decision === "signed_out") return c.json(null);
  }

  if (deleted) return next();
  if (banned || suspended) {
    if (onAuth) return next();
    throw refusal("suspended");
  }

  c.set("user", user);
  c.set("session", found.session);
  c.set("termsStale", user.termsVersion !== (await settings(c)).termsVersion);
  return next();
};
