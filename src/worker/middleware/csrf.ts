// CSRF for the cookie-authenticated API (Fetch Metadata, with Origin as the fallback).
//
// A state-changing request to /api/* must come from this origin: `Sec-Fetch-Site` is
// `same-origin` or `none`, or `Origin` equals APP_ORIGIN. A request that carries neither header
// is refused — absent is not `none`.
//
// Exempt: /api/public/* (no session is ever read there), /api/auth/* (Better Auth checks its own
// trusted origins), /api/_test/* (exists only in test mode). /api/auth-intent is NOT exempt.

import { requestMethod, requestPath } from "./canonical";
import type { MiddlewareHandler } from "hono";
import { AppError } from "../services/errors";
import type { AppEnv } from "../services/request-context";

/** Everything else is state-changing as far as the CSRF, impersonation, terms and read-only checks go. */
export const SAFE_METHODS = new Set(["GET", "HEAD"]);

const EXEMPT_PREFIXES = ["/api/public/", "/api/auth/", "/api/_test/"];

export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(requestMethod(c))) return next();
  const path = requestPath(c);
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();

  const site = c.req.header("sec-fetch-site");
  const origin = c.req.header("origin");
  const sameSite = site === "same-origin" || site === "none";
  const sameOrigin = origin !== undefined && origin === c.env.APP_ORIGIN;
  if (!sameSite && !sameOrigin)
    throw new AppError("forbidden", "Cross-site request refused.", { reason: "csrf" });
  return next();
};
