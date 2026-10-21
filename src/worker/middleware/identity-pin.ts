// The identity pin (W2S4). The SPA keeps the state of ONE account in memory and names it on every
// API request in `X-Holdfast-User`. The session cookie is the browser's, shared by every tab: a
// second tab that signs in as another account changes who THIS tab's next request runs as. Such a
// request is refused here, right after the session is read and before anything of that other
// account is consulted (its impersonation, its terms, its limiter bucket) — the SPA then adopts the
// account the browser is now signed in as (purges, re-reads the session, starts again at /).
//
//   no header                 passes: a client that names nobody (curl, tests, anything but the SPA)
//   header, no session user   passes: the route's own 401, which opens the SPA's re-auth
//   header ≠ session user     403 forbidden, details.reason = "identity_mismatch", every method
//
// Not on the paths that never read a session for an account's data: /api/auth/* (Better Auth's
// own), /api/public/*, /api/_test/*, /api/health.

import { requestPath } from "./canonical";
import type { MiddlewareHandler } from "hono";
import { AppError } from "../services/errors";
import type { AppEnv } from "../services/request-context";

/** Lower case, as Hono reads it. The client's lib/api.ts names the same header (a test pins it). */
export const IDENTITY_HEADER = "x-holdfast-user";

const EXEMPT_PREFIXES = ["/api/auth/", "/api/public/", "/api/_test/"];

export const identityPin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = requestPath(c);
  if (!path.startsWith("/api/") || path === "/api/health") return next();
  if (EXEMPT_PREFIXES.some((prefix) => path.startsWith(prefix))) return next();
  const claimed = c.req.header(IDENTITY_HEADER);
  const user = c.get("user");
  if (claimed === undefined || !user) return next();
  if (claimed !== user.id) {
    throw new AppError("forbidden", "This browser is signed in to another account now.", {
      reason: "identity_mismatch",
    });
  }
  return next();
};
