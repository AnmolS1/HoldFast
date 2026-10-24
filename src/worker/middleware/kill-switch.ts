// The operator's kill switches (the `settings` table; changed at runtime, no deploy).
//
// `killSwitch` (in the pipeline): `readOnly` → every state-changing /api/* request answers
// 503 read_only. Exempt: ALL of /api/auth/* (signing in needs the TOTP, backup-code, passkey and
// admin endpoints too — exempting only sign-in would lock out the admins who must switch
// read-only off; sign-up is refused by the sign-up policy), /api/admin/*, the CSP report, and
// the account's two ways out (R1 func-2, ruling Q5): cancelling a scheduled deletion — the purge
// keeps running under read-only, so the cancel must too — and accepting the current terms, without
// which the terms gate holds every page. Exact paths: nothing else under /api/account.
//
// `requireSwitch(name)` (used by route files): 503 feature_disabled when that switch is off.
//     router.post("/uploads", requireSwitch("uploadsEnabled"), handler)
// This file does not enforce `uploadsEnabled` / `linksEnabled` anywhere itself.

import { requestMethod, requestPath } from "./canonical";
import type { MiddlewareHandler } from "hono";
import { AppError } from "../services/errors";
import { settings, type AppEnv } from "../services/request-context";
import { SAFE_METHODS } from "./csrf";

/** Writes read-only does not stop, by exact path. */
const EXEMPT_PATHS: ReadonlySet<string> = new Set([
  "/api/public/csp-report",
  "/api/account/deletion/cancel",
  "/api/account/accept-terms",
]);

function exempt(path: string): boolean {
  return path.startsWith("/api/auth/") || path.startsWith("/api/admin/") || EXEMPT_PATHS.has(path);
}

export const killSwitch: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (SAFE_METHODS.has(requestMethod(c)) || exempt(requestPath(c))) return next();
  if ((await settings(c)).readOnly) throw new AppError("read_only");
  return next();
};

export type FeatureSwitch = "uploadsEnabled" | "linksEnabled";

/** `details.reason` of a `feature_disabled` answer (PLAN §10). */
export const SWITCH_REASON = {
  uploadsEnabled: "uploads_disabled",
  linksEnabled: "links_disabled",
} as const satisfies Record<FeatureSwitch, string>;

const SWITCH_MESSAGE: Record<FeatureSwitch, string> = {
  uploadsEnabled: "Uploads are switched off right now.",
  linksEnabled: "Public links are switched off right now.",
};

export function requireSwitch(name: FeatureSwitch): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!(await settings(c))[name]) {
      throw new AppError("feature_disabled", SWITCH_MESSAGE[name], { reason: SWITCH_REASON[name] });
    }
    return next();
  };
}
