// Coarse rate limits on /api/* (services/ratelimit.ts explains what the binding can and cannot do).
//
//   RL_AUTH   by client address, on
//               - every request to /api/auth/* that is not a GET or a HEAD (sign-in, sign-up,
//                 password reset, two-factor … — the requests that carry or test a credential),
//               - /api/auth-intent and /api/invites/* with any method (an invite code is
//                 guessable, so even reading one is throttled).
//             A GET under /api/auth/* — above all the session read the shell makes in every
//             route guard and on every window focus — is NOT counted here: people behind one
//             address would otherwise spend each other's sign-in attempts and be shown
//             "couldn't start". Such a read is limited by RL_API like any other request.
//   RL_API    by user (`u:<id>`) when signed in, else by client address, on every /api/* path
//
// "By client address" is the NORMALISED address (services/ip-hash.ts): an IPv4 address as it
// is, an IPv6 address as its /64. One subscriber owns a whole /64, so the raw address would give
// them a fresh bucket for every request.
//
// This runs AFTER `session` — the user key needs it, and a rate-limited auth request has then
// still passed through `getSession`, so a 429 can never hide a hung auth layer. Do not reorder.

import type { MiddlewareHandler } from "hono";
import { normalise } from "../services/ip-hash";
import { enforceRateLimit, type LimiterName } from "../services/ratelimit";
import type { AppEnv } from "../services/request-context";

const READ_METHODS = new Set(["GET", "HEAD"]);

/** Does this request spend the auth bucket? */
export function countsAsAuthAttempt(method: string, path: string): boolean {
  if (path === "/api/auth-intent" || path.startsWith("/api/invites/")) return true;
  return path.startsWith("/api/auth/") && !READ_METHODS.has(method.toUpperCase());
}

/** The limiter key of a client address. */
export function ipKey(ip: string): string {
  return `ip:${normalise(ip)}`;
}

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = ipKey(c.get("ip"));
  if (countsAsAuthAttempt(c.req.method, c.req.path)) await enforceRateLimit(c.env, "RL_AUTH", key);
  const user = c.get("user");
  await enforceRateLimit(c.env, "RL_API", user ? `u:${user.id}` : key);
  return next();
};

/** One limiter keyed by client address, for a whole app or a route group (`RL_FILES`, `RL_LINKS`). */
export function rateLimitByIp(name: LimiterName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceRateLimit(c.env, name, ipKey(c.get("ip")));
    return next();
  };
}
