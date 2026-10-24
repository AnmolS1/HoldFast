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
//     through that guard. Role and two-factor are read from the DATABASE: a demoted admin stops
//     at once.
//   stop-impersonating: called FROM the impersonated session, whose user is the target and not
//     an admin — allowed exactly when the session carries the plugin's `impersonatedBy` marker.
//   ban-user and set-role then keep the console's rules for your own account and the last admin
//     (`keepAnAdmin`: `400 self_action`, `409 last_admin`) — they are not endpoint denials.
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
import { getAccount, undoAdminPluginChange, writeAdminPluginChange } from "../db/queries/auth-lifecycle";
import { refuseLastAdmin, refuseSelfAction } from "../services/account-state";
import { AppError } from "../services/errors";
import type { ServiceDeps } from "../services/request-context";
import { count, record, reportError, sinkPath } from "./observe";
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

/** An account id as Better Auth makes them, and nothing the plugin's coercion could turn into one. */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** The two roles the console sets (the plugin is configured with no `roles`, so it checks none). */
const CONSOLE_ROLES: readonly string[] = ["user", "admin"];

const malformed = () => new AppError("validation", "This request is not valid.");

/**
 * The body as the plugin will act on it — read HERE, strictly, because the before-hook runs on
 * the parsed but NOT yet validated body (better-auth api/dispatch.mjs: hooks, then the endpoint's
 * schema), and that schema coerces `userId` (`z.coerce.string()`: `["id"]` is "id"). Anything
 * this cannot read exactly as the plugin will — a `userId` that is not a plain id string, a ban
 * field of the wrong type, a role the console does not set — is `400 validation` (fail closed),
 * so the gate never checks one account while the plugin acts on another, and never writes a
 * change the plugin's schema would then refuse.
 */
function pluginChange(
  path: string,
  body: unknown,
): { userId: string; change: Parameters<typeof writeAdminPluginChange>[2] } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw malformed();
  const fields = body as { userId?: unknown; role?: unknown; banReason?: unknown; banExpiresIn?: unknown };
  const userId = fields.userId;
  if (typeof userId !== "string" || !ACCOUNT_ID.test(userId)) throw malformed();
  if (path === "/admin/ban-user") {
    const { banReason, banExpiresIn } = fields;
    if (banReason !== undefined && typeof banReason !== "string") throw malformed();
    if (banExpiresIn !== undefined && !(typeof banExpiresIn === "number" && Number.isFinite(banExpiresIn))) {
      throw malformed();
    }
    const banExpires = banExpiresIn ? new Date(Date.now() + banExpiresIn * 1000) : null;
    // An expiry that is no date (1e300 seconds) would fail the plugin's write after the gate's.
    if (banExpires !== null && Number.isNaN(banExpires.getTime())) throw malformed();
    // The plugin's own values (routes.mjs `banUser`; no default reason or expiry is configured).
    return {
      userId,
      change: {
        banned: true,
        banReason: banReason || "No reason",
        banExpires,
      },
    };
  }
  if (typeof fields.role !== "string" || !CONSOLE_ROLES.includes(fields.role)) throw malformed();
  return { userId, change: { role: fields.role } };
}

/**
 * Ban and Set role keep the console's two rules (ruling Q4, R1D auth-1), as Suspend does
 * (services/account-state.ts): `400 self_action` on the admin's own account, and `409 last_admin`
 * when the change leaves no admin who can still act. The check and the change share ONE
 * transaction under `lockActiveAdmins`' lock — the change is written here, ahead of the plugin
 * (`writeAdminPluginChange`) — so two admins banning or demoting each other at once, or one
 * suspending while the other bans, are served one after the other and the second sees the first.
 * A promotion takes nothing away and is not checked. The body is read first (`pluginChange`).
 */
async function keepAnAdmin(scope: AuthScope, actorId: string, path: string, body: unknown): Promise<void> {
  try {
    const { userId, change } = pluginChange(path, body);
    refuseSelfAction({ type: "admin", userId: actorId }, userId);
    if ("role" in change && hasAdminRole(change.role)) return;
    const previous = await scope.db.transaction(async (tx) => {
      await refuseLastAdmin(tx, userId);
      return writeAdminPluginChange(tx, userId, change);
    });
    // Until the plugin's own write lands; put back if it never does (auth/create-auth.ts).
    if (previous) scope.facts.adminPreWrite = { userId, wrote: change, previous };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    // In our own words (`error`, which the client's code table reads) and Better Auth's (`code`).
    throw new APIError(error.status === 409 ? "CONFLICT" : "BAD_REQUEST", {
      message: error.message,
      code: error.code.toUpperCase(),
      error: error.code,
    });
  }
}

/**
 * After the handler: a ban / role the gate wrote whose plugin write never landed (the plugin
 * refused or failed after the gate) is put back, so a failed request leaves nothing behind — the
 * plugin ended no session and audited nothing either (both follow its write). A failure here is
 * reported and the request's own answer stands.
 */
export async function undoUnlandedPreWrite(scope: AuthScope): Promise<void> {
  const pending = scope.facts.adminPreWrite;
  if (!pending) return;
  scope.facts.adminPreWrite = null;
  try {
    await undoAdminPluginChange(scope.db, pending.userId, pending.wrote, pending.previous);
  } catch (error) {
    reportError(error, { kind: "auth", reason: "admin_prewrite_undo" });
  }
}

/**
 * `hooks.before` for every Better Auth dispatch. Returns for a path outside /admin/ and for an
 * allowed call; otherwise writes the audit row and throws `403`.
 */
export async function adminGate(scope: AuthScope, ctx: GateContext): Promise<void> {
  const path = ctx.path;
  if (typeof path !== "string" || !path.startsWith("/admin/")) return;
  const method = ctx.request?.method ?? ctx.method ?? "";

  // Straight from the database: neither a revoked session nor a stale role survives here.
  const session = await getSessionFromCtx(ctx, { disableCookieCache: true }).catch(() => null);
  const sessionUserId = session?.user.id ?? null;
  const impersonatedBy = (session?.session as { impersonatedBy?: string | null } | undefined)?.impersonatedBy;

  let allowed = false;
  let needsSecondFactor = false;
  if (session && ALLOWED.includes(path)) {
    if (path === ADMIN_STOP_IMPERSONATING) {
      allowed = Boolean(impersonatedBy);
      // For auth/second-factor.ts: whose impersonation this request ends.
      scope.facts.impersonatorId = impersonatedBy || null;
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
  if (allowed) {
    if (path === "/admin/set-role") {
      // The role as it is before the plugin writes the new one: `auth.role_changed`'s `from`.
      const userId = (ctx as { body?: { userId?: unknown } }).body?.userId;
      if (typeof userId === "string" && userId !== "") {
        const target = await getAccount(scope.db, userId);
        scope.facts.roleChange = { userId, from: target?.role ?? null };
      }
    }
    if (path === "/admin/ban-user" || path === "/admin/set-role") {
      await keepAnAdmin(scope, session!.user.id, path, (ctx as { body?: unknown }).body);
    }
    return;
  }

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
