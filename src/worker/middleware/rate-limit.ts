// Coarse rate limits on /api/* (services/ratelimit.ts explains what the binding can and cannot do).
//
// EVERY KEY IS ONE CLIENT'S OWN. No limiter here is keyed so that one client's traffic can use up
// another's: a key is the caller's normalised address, or the signed-in user. There is no shared
// or global counter (one was tried on the hashing endpoints and withdrawn — whoever filled it
// would have locked everybody out of sign-in).
//
//   RL_AUTH   by client address, for exactly the (method, path) pairs below — table-driven, and
//             anything not in the table is NOT counted:
//               ip:<addr>      POST to an endpoint of the auth handler that carries or tests a
//                              credential (auth/endpoint-policy.ts `spendsAuthBudget`: the POST
//                              rows of its table, less /sign-out and /get-session)
//               intent:<addr>  POST /api/auth-intent
//               inv:<addr>     /api/invites/* (an invite code is guessable, so even reading
//                              one is throttled) — under a key of its own, so that looking at
//                              invites cannot spend the budget for signing in
//             A GET, a HEAD or an OPTIONS under /api/auth/* never spends it — above all the
//             session read the shell makes in every route guard and on every window focus:
//             people behind one address would otherwise spend each other's sign-in attempts.
//   RL_API    by user (`u:<id>`) when signed in, else by client address, on every /api/* path
//
// THE PATH AND THE METHOD are the canonical ones (middleware/canonical.ts): that step has already
// answered 404 to anything that is not, byte for byte, a path in canonical form, and to anything
// under /api/auth/* that is not an exact (method, path) of the installed auth handler — an
// unknown path, a known path with another method, a trailing slash, an encoded spelling. So no
// spelling of a request reaches a handler without having been counted here as that handler's.
// (Better Auth's own limiter is keyed by address and PATH whatever the method: without that
// step, `GET /api/auth/sign-in/email` would spend that address's sign-in attempts.)
//
// "By client address" is the NORMALISED address (services/ip-hash.ts): an IPv4 address as it
// is, an IPv6 address as its /64. One subscriber owns a whole /64, so the raw address would give
// them a fresh bucket for every request.
//
// The binding is per Cloudflare location and eventually consistent — accepted for these coarse
// limits. The counts that must be exact (second-factor attempts, the sign-in throttle, invite
// uses, the mail ledger) are in Postgres.
//
// This runs AFTER `session` — the user key needs it, and a rate-limited auth request has then
// still passed through `getSession`, so a 429 can never hide a hung auth layer. Do not reorder.

import { requestMethod, requestPath } from "./canonical";
import type { MiddlewareHandler } from "hono";
import { AUTH_PREFIX, spendsAuthBudget } from "../auth/endpoint-policy";
import { normalise } from "../services/ip-hash";
import { enforceRateLimit, type LimiterName } from "../services/ratelimit";
import type { AppEnv } from "../services/request-context";

/**
 * The `RL_AUTH` key prefix this exact request spends, or null: not counted. `path` is the path as
 * it was sent (not percent-decoded).
 */
export function authBudgetOf(method: string, path: string): "ip" | "intent" | "inv" | null {
  if (path === "/api/auth-intent") return method === "POST" ? "intent" : null;
  if (path.startsWith("/api/invites/")) return "inv";
  if (path.startsWith(`${AUTH_PREFIX}/`) && spendsAuthBudget(method, path.slice(AUTH_PREFIX.length))) {
    return "ip";
  }
  return null;
}

/** The limiter key of a client address. */
export function ipKey(ip: string): string {
  return `ip:${normalise(ip)}`;
}

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = requestPath(c);
  const method = requestMethod(c);
  const key = ipKey(c.get("ip"));
  const budget = authBudgetOf(method, path);
  if (budget)
    await enforceRateLimit(c.env, "RL_AUTH", budget === "ip" ? key : `${budget}:${normalise(c.get("ip"))}`);
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
