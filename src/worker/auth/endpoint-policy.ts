// What a session in a restricted state may still reach under /api/auth/*.
//
// Better Auth honours a session cookie whatever our own columns say about its user, and its
// endpoints do not sort into "reads" and "writes" by HTTP method: links that change an account
// are GETs (/verify-email, /delete-user/callback, /reset-password/:token, the OAuth callback),
// and GETs such as /list-sessions hand out session tokens. So the gate is not by method. It is
// an ALLOW-LIST by path, with one row per endpoint of the installed Better Auth and a decision
// for each restricted state; anything that is not an allowed row — an endpoint added by an
// upgrade or a new plugin, a path spelled differently — is DENIED.
//
// The states (decided by middleware/session.ts, in this order of precedence):
//   impersonating   an admin looking through a user's session: read-only. It may read the
//                   session and stop impersonating (or sign out). Nothing else — also no GET
//                   that returns tokens or acts on the account.
//   deleted         the user's deletion date has passed: the account behaves as deleted, whether
//                   or not the purge has run. Sign-out only; the session read answers as signed
//                   out (JSON null), so the shell shows the sign-in screen.
//   suspended       suspended or banned: sign-out, and the session read the shell needs to show
//                   the "suspended" notice.
// A session in none of these states, and a request with no session, is not restricted here: the
// admin plugin has its own allow-list in the auth task, and the read-only kill switch exempts
// /api/auth/* as a whole (middleware/kill-switch.ts — admins must be able to sign in to switch
// it off; sign-up is refused by the sign-up policy).
//
// THE TABLE is the route table of better-auth 1.7.7 + @better-auth/passkey 1.7.7 with the plugins
// of auth/config.ts (passkey, twoFactor, admin, captcha, haveIBeenPwned), read from the built
// instance: `Object.values(auth.api)` → `endpoint.path`, `endpoint.options.method`.
// tests/unit/worker-core/auth-endpoints.test.ts rebuilds that list from the installed packages
// and fails when it differs from this table — a new endpoint cannot appear without a decision.
// `/ok` and `/error` take no session and return a constant.

export type AuthGateState = "impersonating" | "deleted" | "suspended";
/** `signed_out`: answer the session read with Better Auth's own signed-out body, JSON `null`. */
export type AuthGateDecision = "allow" | "deny" | "signed_out";

type Row = readonly [
  methods: string,
  path: string,
  deleted: AuthGateDecision,
  suspended: AuthGateDecision,
  impersonating: AuthGateDecision,
];

// prettier-ignore
export const AUTH_ENDPOINTS: readonly Row[] = [
  // methods, path (relative to /api/auth), deleted, suspended, impersonating
  ["GET", "/account-info", "deny", "deny", "deny"],
  ["POST", "/admin/ban-user", "deny", "deny", "deny"],
  ["POST", "/admin/create-user", "deny", "deny", "deny"],
  ["GET", "/admin/get-user", "deny", "deny", "deny"],
  ["POST", "/admin/has-permission", "deny", "deny", "deny"],
  ["POST", "/admin/impersonate-user", "deny", "deny", "deny"],
  ["POST", "/admin/list-user-sessions", "deny", "deny", "deny"],
  ["GET", "/admin/list-users", "deny", "deny", "deny"],
  ["POST", "/admin/remove-user", "deny", "deny", "deny"],
  ["POST", "/admin/revoke-user-session", "deny", "deny", "deny"],
  ["POST", "/admin/revoke-user-sessions", "deny", "deny", "deny"],
  ["POST", "/admin/set-role", "deny", "deny", "deny"],
  ["POST", "/admin/set-user-password", "deny", "deny", "deny"],
  ["POST", "/admin/stop-impersonating", "deny", "deny", "allow"],
  ["POST", "/admin/unban-user", "deny", "deny", "deny"],
  ["POST", "/admin/update-user", "deny", "deny", "deny"],
  ["GET,POST", "/callback/:id", "deny", "deny", "deny"],
  ["POST", "/change-email", "deny", "deny", "deny"],
  ["POST", "/change-password", "deny", "deny", "deny"],
  ["POST", "/delete-user", "deny", "deny", "deny"],
  ["GET", "/delete-user/callback", "deny", "deny", "deny"],
  ["GET", "/error", "allow", "allow", "allow"],
  ["POST", "/get-access-token", "deny", "deny", "deny"],
  ["GET,POST", "/get-session", "signed_out", "allow", "allow"],
  ["POST", "/link-social", "deny", "deny", "deny"],
  ["GET", "/list-accounts", "deny", "deny", "deny"],
  ["GET", "/list-sessions", "deny", "deny", "deny"],
  ["GET", "/ok", "allow", "allow", "allow"],
  ["POST", "/passkey/delete-passkey", "deny", "deny", "deny"],
  ["GET", "/passkey/generate-authenticate-options", "deny", "deny", "deny"],
  ["GET", "/passkey/generate-register-options", "deny", "deny", "deny"],
  ["GET", "/passkey/list-user-passkeys", "deny", "deny", "deny"],
  ["POST", "/passkey/update-passkey", "deny", "deny", "deny"],
  ["POST", "/passkey/verify-authentication", "deny", "deny", "deny"],
  ["POST", "/passkey/verify-registration", "deny", "deny", "deny"],
  ["POST", "/refresh-token", "deny", "deny", "deny"],
  ["POST", "/request-password-reset", "deny", "deny", "deny"],
  ["POST", "/reset-password", "deny", "deny", "deny"],
  ["GET", "/reset-password/:token", "deny", "deny", "deny"],
  ["POST", "/revoke-other-sessions", "deny", "deny", "deny"],
  ["POST", "/revoke-session", "deny", "deny", "deny"],
  ["POST", "/revoke-sessions", "deny", "deny", "deny"],
  ["POST", "/send-verification-email", "deny", "deny", "deny"],
  ["POST", "/sign-in/email", "deny", "deny", "deny"],
  ["POST", "/sign-in/social", "deny", "deny", "deny"],
  ["POST", "/sign-out", "allow", "allow", "allow"],
  ["POST", "/sign-up/email", "deny", "deny", "deny"],
  ["POST", "/two-factor/disable", "deny", "deny", "deny"],
  ["POST", "/two-factor/enable", "deny", "deny", "deny"],
  ["POST", "/two-factor/generate-backup-codes", "deny", "deny", "deny"],
  ["POST", "/two-factor/get-totp-uri", "deny", "deny", "deny"],
  ["POST", "/two-factor/send-otp", "deny", "deny", "deny"],
  ["POST", "/two-factor/verify-backup-code", "deny", "deny", "deny"],
  ["POST", "/two-factor/verify-otp", "deny", "deny", "deny"],
  ["POST", "/two-factor/verify-totp", "deny", "deny", "deny"],
  ["POST", "/unlink-account", "deny", "deny", "deny"],
  ["POST", "/update-session", "deny", "deny", "deny"],
  ["POST", "/update-user", "deny", "deny", "deny"],
  ["GET", "/verify-email", "deny", "deny", "deny"],
  ["POST", "/verify-password", "deny", "deny", "deny"],
];

export const AUTH_PREFIX = "/api/auth";

const COLUMN: Record<AuthGateState, 2 | 3 | 4> = { deleted: 2, suspended: 3, impersonating: 4 };

/** A table path as an exact matcher: `:name` is one non-empty segment, everything else literal. */
function matcher(pattern: string): RegExp {
  const source = pattern
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

const MATCHERS = AUTH_ENDPOINTS.map((row) => ({ row, test: matcher(row[1]) }));

/**
 * The decision for a request path (the full path, `/api/auth/…`) of a session in that state.
 * Exact matching only: no case folding, no trailing slash, no decoding — a path the table does
 * not spell is denied, whatever the auth handler's own router would make of it.
 */
export function authGateDecision(state: AuthGateState, path: string): AuthGateDecision {
  if (!path.startsWith(`${AUTH_PREFIX}/`)) return "deny";
  const relative = path.slice(AUTH_PREFIX.length);
  const found = MATCHERS.find((entry) => entry.test.test(relative));
  return found ? found.row[COLUMN[state]] : "deny";
}
