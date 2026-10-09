// The allow-list in front of Better Auth's admin plugin.
//
// The plugin mounts a whole endpoint family under /api/auth/admin/*: create, update and remove
// users, set anyone's password, list users and sessions, revoke sessions, ban, set roles,
// impersonate. Holdfast uses FIVE of them (the admin console's Ban / Unban, Set role, Impersonate
// and its stop). Everything else is refused — by PREFIX, not by a deny-list, so an endpoint a
// later Better Auth adds under /admin/ is refused the day it appears:
//   - user removal always goes through `scheduleDeletion` (the seven-day window, legal hold);
//     `/admin/remove-user` would bypass both, and `deleteUser.beforeDelete` does not veto it;
//   - a password is only ever changed by its owner (`/admin/set-user-password` is refused);
//   - sessions are revoked by `revokeSessions`, not by the plugin's revoke endpoints.
// Adding a sixth path is the orchestrator's decision, not this file's or the admin console's.
//
// WHO MAY REACH AN ALLOWED PATH
//   ban-user, unban-user, set-role, impersonate-user: the session's user has the `admin` role
//     AND two-factor enabled, AND THIS SESSION has passed a second factor (auth/second-factor.ts;
//     otherwise 403 `admin_requires_2fa`), AND the session is not an impersonated one — the same condition
//     as `requireAdmin` (middleware/guards.ts), evaluated here because /api/auth/* does not pass
//     through that guard. Role and two-factor are read from the DATABASE, with the cookie cache
//     bypassed: a demoted admin stops at once, not within 60 s.
//   stop-impersonating: called FROM the impersonated session, whose user is the target and not
//     an admin — allowed exactly when the session carries the plugin's `impersonatedBy` marker.
//
// A refusal is `403` and ONE audit row `auth.admin_endpoint_denied`, written and awaited before
// the answer (`meta: { path, method }` — never the body, never an id from it).
//
// Two layers enforce this, and each request meets exactly one refusal:
//   1. the route (routes/auth.ts → `isAdminPluginPath` / `refuseAdminRequest`) looks at the RAW
//      request path before Better Auth sees it: anything that is, or decodes or normalises to,
//      a path under /admin/ and is not spelled exactly as one of the five is refused there;
//   2. Better Auth's `hooks.before` (`adminGate`) runs for every dispatch of an /admin/ endpoint,
//      including `auth.api.*` calls made inside the Worker, and applies the full rule above.

import { APIError, getSessionFromCtx } from "better-auth/api";
import { hasAdminRole } from "../../shared/roles";
import { getAccount } from "../db/queries/auth-lifecycle";
import type { ServiceDeps } from "../services/request-context";
import { count, record, sinkPath } from "./observe";
import { hasSecondFactor } from "./second-factor";
import type { AuthScope } from "./scope";

/** Relative to Better Auth's `basePath` (/api/auth). The five plugin calls the admin console makes. */
export const ADMIN_PLUGIN_ALLOWED = Object.freeze([
  "/admin/ban-user",
  "/admin/unban-user",
  "/admin/set-role",
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
] as const);

export const ADMIN_STOP_IMPERSONATING = "/admin/stop-impersonating";

const ALLOWED: readonly string[] = ADMIN_PLUGIN_ALLOWED;

export const ADMIN_DENIED_CODE = "ADMIN_ENDPOINT_DENIED";
const DENIED_MESSAGE = "This admin action is not available.";
export const ADMIN_REQUIRES_2FA_CODE = "ADMIN_REQUIRES_2FA";
const ADMIN_REQUIRES_2FA_MESSAGE = "Confirm your two-factor code to continue.";

/**
 * Is this path (relative to /api/auth, exactly as it was sent) addressed at the admin plugin?
 * Generous on purpose — percent-decoded (twice), lower-cased, repeated slashes collapsed, dot
 * segments and matrix parameters dropped — because the question is "could any router read this
 * as /admin/…", and a path that is NOT then spelled exactly as an allowed one is refused.
 */
export function isAdminPluginPath(relativePath: string): boolean {
  let path = relativePath;
  for (let round = 0; round < 2; round++) {
    try {
      path = decodeURIComponent(path);
    } catch {
      // Malformed escapes: judge what is there.
    }
  }
  const segments = path
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.split(";")[0]!.trim())
    .filter((segment) => segment !== "" && segment !== ".");
  const resolved: string[] = [];
  for (const segment of segments) {
    if (segment === "..") resolved.pop();
    else resolved.push(segment);
  }
  return resolved[0] === "admin";
}

/** An audit row that is in the table before this returns. */
async function auditNow(
  scope: AuthScope,
  actorUserId: string | null,
  meta: { path: string; method: string },
): Promise<void> {
  const local: Promise<unknown>[] = [];
  const deps: ServiceDeps = { db: scope.db, env: scope.env, defer: (promise) => void local.push(promise) };
  record(deps, "auth.admin_endpoint_denied", { type: "auth_endpoint" }, meta, {
    actorUserId,
    actorType: actorUserId ? "user" : "system",
  });
  while (local.length) await Promise.allSettled(local.splice(0));
}

/** Records the refusal (awaited) and counts it. The caller answers 403. */
export async function recordAdminDenial(
  scope: AuthScope,
  actorUserId: string | null,
  path: string,
  method: string,
): Promise<void> {
  scope.facts.adminDenied = true;
  count("auth", { outcome: "denied", kind: "admin_endpoint" });
  // The path is attacker-controlled text: recorded capped, and scanned like any free text (an
  // address or a token typed into it does not belong in the audit log).
  await auditNow(scope, actorUserId, {
    path: sinkPath(path),
    method: /^[A-Z]{1,16}$/.test(method) ? method : "OTHER",
  });
}

type GateContext = Parameters<typeof getSessionFromCtx>[0] & { path?: string; method?: string };

/**
 * `hooks.before` for every Better Auth dispatch. Returns for a path outside /admin/ and for an
 * allowed call; otherwise writes the audit row and throws `403`.
 */
export async function adminGate(scope: AuthScope, ctx: GateContext): Promise<void> {
  const path = ctx.path;
  if (typeof path !== "string" || !path.startsWith("/admin/")) return;
  const method = ctx.request?.method ?? ctx.method ?? "";

  // Straight from the database: neither a revoked session nor a stale role survives 60 s here.
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  const sessionUserId = session?.user.id ?? null;
  const impersonatedBy = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy;

  let allowed = false;
  let needsSecondFactor = false;
  if (session && ALLOWED.includes(path)) {
    if (path === ADMIN_STOP_IMPERSONATING) {
      allowed = Boolean(impersonatedBy);
    } else if (!impersonatedBy) {
      const account = await getAccount(scope.db, session.user.id);
      const isAdmin =
        account !== null && hasAdminRole(account.role) && !account.banned && account.suspendedAt === null;
      // Two-factor on the account AND on this session (auth/second-factor.ts): a session made by
      // Google, a passkey without user verification, a trusted device or a link has not passed it.
      const passed =
        isAdmin &&
        account.twoFactorEnabled &&
        hasSecondFactor(session.session as { secondFactorAt?: unknown });
      allowed = passed;
      needsSecondFactor = isAdmin && !passed;
    }
  }
  if (allowed) return;

  await recordAdminDenial(scope, sessionUserId, path, method);
  if (needsSecondFactor) {
    // An admin who has not passed the second factor on this session: told so, in the words our
    // own routes use (`error`) and Better Auth's (`code`), so the console can ask for a code.
    throw new APIError("FORBIDDEN", {
      message: ADMIN_REQUIRES_2FA_MESSAGE,
      code: ADMIN_REQUIRES_2FA_CODE,
      error: "admin_requires_2fa",
    });
  }
  throw new APIError("FORBIDDEN", { message: DENIED_MESSAGE, code: ADMIN_DENIED_CODE });
}
