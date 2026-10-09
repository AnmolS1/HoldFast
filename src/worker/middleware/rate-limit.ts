// Coarse rate limits on /api/* (services/ratelimit.ts explains what the binding can and cannot do).
//
//   RL_AUTH   by IP, on /api/auth/*, /api/auth-intent and /api/invites/*
//   RL_API    by user (`u:<id>`) when signed in, else by IP (`ip:<ip>`), on every /api/* path
//
// This runs AFTER `session` — the user key needs it, and a rate-limited auth request has then
// still passed through `getSession`, so a 429 can never hide a hung auth layer. Do not reorder.

import type { MiddlewareHandler } from "hono";
import { enforceRateLimit, type LimiterName } from "../services/ratelimit";
import type { AppEnv } from "../services/request-context";

function isAuthPath(path: string): boolean {
  return path.startsWith("/api/auth/") || path === "/api/auth-intent" || path.startsWith("/api/invites/");
}

export const rateLimit: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ip = c.get("ip");
  if (isAuthPath(c.req.path)) await enforceRateLimit(c.env, "RL_AUTH", `ip:${ip}`);
  const user = c.get("user");
  await enforceRateLimit(c.env, "RL_API", user ? `u:${user.id}` : `ip:${ip}`);
  return next();
};

/** One limiter keyed by client IP, for a whole app or a route group (`RL_FILES`, `RL_LINKS`). */
export function rateLimitByIp(name: LimiterName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await enforceRateLimit(c.env, name, `ip:${c.get("ip")}`);
    return next();
  };
}
