// A user whose accepted terms are older than the current version may read but not change
// anything until they accept: state-changing /api/* → 403 terms_required.
//
// The session's user can lag an accept by up to 60 s (cookie cache), so before refusing this
// re-reads `user.termsVersion` from the database — one primary-key read — and lets the request
// through when it is current. An accept therefore takes effect at once.
//
// Exempt: /api/auth/*, /api/public/*, the accept route itself, and the deletion routes (a user
// must always be able to leave).

import type { MiddlewareHandler } from "hono";
import { AppError } from "../services/errors";
import { coreOf, db, settings, type AppEnv } from "../services/request-context";
import { SAFE_METHODS } from "./csrf";

function exempt(path: string): boolean {
  return (
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/public/") ||
    path === "/api/account/accept-terms" ||
    path === "/api/account/deletion" ||
    path.startsWith("/api/account/deletion/")
  );
}

export const termsGate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get("user");
  if (!user || !c.get("termsStale") || SAFE_METHODS.has(c.req.method) || exempt(c.req.path)) return next();

  const current = (await settings(c)).termsVersion;
  const stored = await coreOf(c).termsVersionOf(db(c), user.id);
  if (stored === current) {
    c.set("termsStale", false);
    return next();
  }
  throw new AppError("terms_required");
};
