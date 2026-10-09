// The auth audit trail, the auth metric and the security emails that follow an auth request.
//
// THE ACTION VOCABULARY (audit_log.action), in one place:
//   auth.sign_in                 a session was started (meta.method: password, totp, backup_code,
//                                passkey, google, email_link; meta.uaFamily)
//   auth.failed                  a credential was refused (meta.path, meta.status, meta.code)
//   auth.sign_out
//   auth.password_changed        by its owner (change) or through a reset link (meta.via)
//   auth.2fa_enabled | auth.2fa_disabled
//   auth.passkey_added | auth.passkey_removed
//   auth.email_changed
//   auth.impersonation_started | auth.impersonation_stopped
//   auth.admin_endpoint_denied   written by auth/admin-gate.ts
//   auth.admin_granted           written by services/signup-policy.ts (the ADMIN_EMAILS bootstrap)
// `meta` holds short facts only: never a raw address, a password, a token, a code or an email
// that is not an account's.
//
// WHY THIS RUNS IN THE ROUTE AND NOT IN `hooks.after`. Better Auth has no hook for a FAILED
// sign-in, and its plugins' after-hooks run after ours: when a password is right but the account
// has two-factor on, the two-factor plugin deletes the session the sign-in just made — after
// `hooks.after` has returned. Only the final response says what happened. So the hooks record
// facts on the request's scope (auth/scope.ts), and `afterAuthRequest`, called by routes/auth.ts
// with the finished response, decides. It also has the Hono context, so each row carries the
// request's `ipHashDaily`, `ua`, `country` and `requestId` (services/audit.ts) — a hook has none
// of them.

import type { Context } from "hono";
import { getAccount, getAccountByEmail, knownDevices } from "../db/queries/auth-lifecycle";
import { audit } from "../services/audit";
import { now } from "../services/clock";
import {
  sendNewDeviceSignIn,
  sendPasskeyAdded,
  sendPasskeyRemoved,
  sendPasswordChanged,
  sendTwoFactorDisabled,
  sendTwoFactorEnabled,
} from "../services/email";
import { metric } from "../services/metrics";
import { db, defer, deps, type AppEnv } from "../services/request-context";
import type { AuthScope } from "./scope";

/** How a completed sign-in is named, by the endpoint that completed it. */
const SIGN_IN_METHOD: Record<string, string> = {
  "/sign-in/email": "password",
  "/two-factor/verify-totp": "totp",
  "/two-factor/verify-backup-code": "backup_code",
  "/two-factor/verify-otp": "otp",
  "/passkey/verify-authentication": "passkey",
  "/callback/:id": "google",
  "/sign-in/social": "google",
  "/verify-email": "email_link",
};

/** Endpoints that test a credential: a 4xx from one of them is an `auth.failed` row. */
const CREDENTIAL_PATHS = new Set([
  "/sign-in/email",
  "/two-factor/verify-totp",
  "/two-factor/verify-backup-code",
  "/two-factor/verify-otp",
  "/two-factor/enable",
  "/two-factor/disable",
  "/passkey/verify-authentication",
  "/change-password",
  "/reset-password",
  "/verify-password",
  "/delete-user",
  "/callback/:id",
]);

export const NEW_DEVICE_WINDOW_DAYS = 30;

export type AuthRequestInfo = {
  /** The request path relative to /api/auth, as sent. */
  relativePath: string;
  method: string;
  response: Response;
  /** The JSON request body, when the route kept it (sign-in only): for the failed-sign-in target. */
  body: unknown;
};

/** Does the response start a session — set a session-token cookie with a value? */
export function setsSessionCookie(response: Response, env: Pick<Env, "APP_ORIGIN">): boolean {
  const name = `${env.APP_ORIGIN.startsWith("https://") ? "__Secure-" : ""}hf.session_token=`;
  return response.headers.getSetCookie().some((cookie) => {
    if (!cookie.startsWith(name)) return false;
    const value = cookie.slice(name.length).split(";")[0] ?? "";
    return value !== "" && !/;\s*max-age=0\b/i.test(cookie);
  });
}

async function errorCodeOf(response: Response): Promise<string | null> {
  const location = response.headers.get("location");
  if (location) {
    try {
      return new URL(location, "http://x").searchParams.get("error")?.slice(0, 64) ?? null;
    } catch {
      return null;
    }
  }
  if (!(response.headers.get("content-type") ?? "").includes("json")) return null;
  try {
    const body = (await response.clone().json()) as { code?: unknown };
    return typeof body?.code === "string" ? body.code.slice(0, 64) : null;
  } catch {
    return null;
  }
}

/**
 * Writes the audit rows, the metric and the security emails for one finished request to
 * /api/auth/*. Everything it starts is deferred (drained before the pool closes); the one thing
 * it awaits is the known-devices read, which must see the audit table BEFORE this sign-in's own
 * row is added to it. Never throws.
 */
export async function afterAuthRequest(
  c: Context<AppEnv>,
  scope: AuthScope,
  info: AuthRequestInfo,
): Promise<void> {
  try {
    await record(c, scope, info);
  } catch {
    metric("error", { kind: "auth_audit" });
  }
}

async function record(c: Context<AppEnv>, scope: AuthScope, info: AuthRequestInfo): Promise<void> {
  const { response } = info;
  const facts = scope.facts;
  const path = facts.endpointPath;
  const status = response.status;
  const before = c.get("user");
  const userTarget = (id: string) => ({ type: "user", id });
  const self = before ? { actorUserId: before.id, actorType: "user" as const } : {};

  if (facts.adminDenied) return; // counted and audited by the gate
  if (status === 429) {
    metric("auth", { outcome: "limited", kind: "better_auth" });
    return;
  }
  // The request never reached an endpoint (captcha refused it, the origin check, a 404 …).
  if (!path) {
    if (status >= 400) metric("auth", { outcome: "refused", kind: String(status) });
    return;
  }

  const code = status >= 400 || response.headers.has("location") ? await errorCodeOf(response) : null;
  const redirectedWithError = status >= 300 && status < 400 && code !== null;
  const ok = status < 400 && !redirectedWithError;

  // ── a session was started ────────────────────────────────────────────────────────────────
  const started = facts.newSessions.filter((s) => !s.impersonatedBy).at(-1);
  if (ok && started && started.userId !== before?.id && setsSessionCookie(response, c.env)) {
    const method = SIGN_IN_METHOD[path] ?? "other";
    const since = new Date(now(c).getTime() - NEW_DEVICE_WINDOW_DAYS * 86_400_000);
    const known = await knownDevices(db(c), started.userId, since, started.id);
    audit(
      c,
      "auth.sign_in",
      userTarget(started.userId),
      { method, uaFamily: started.uaFamily },
      {
        actorUserId: started.userId,
        actorType: "user",
      },
    );
    metric("auth", { outcome: "ok", kind: method });
    // Never on the very first sign-in (nothing to compare with), only when this browser family
    // or country matches nothing the account has signed in from in the last 30 days.
    const seen = known.some((d) => d.country === started.country && d.uaFamily === started.uaFamily);
    if (known.length > 0 && !seen) {
      const account = await getAccount(db(c), started.userId);
      if (account) {
        defer(
          c,
          sendNewDeviceSignIn(deps(c), {
            to: account.email,
            name: account.name,
            country: started.country,
            uaFamily: started.uaFamily,
            at: now(c),
          }),
        );
      }
    }
    return;
  }

  // ── impersonation ────────────────────────────────────────────────────────────────────────
  if (path === "/admin/impersonate-user" && ok) {
    const target = facts.newSessions.find((s) => s.impersonatedBy)?.userId ?? null;
    audit(c, "auth.impersonation_started", target ? userTarget(target) : null);
    metric("auth", { outcome: "ok", kind: "impersonate" });
    return;
  }
  if (path === "/admin/stop-impersonating" && ok) {
    // requestActor() names the admin behind an impersonated session.
    audit(c, "auth.impersonation_stopped", before ? userTarget(before.id) : null);
    return;
  }

  if (ok) {
    const account = before ? { to: before.email, name: before.name } : null;
    switch (path) {
      case "/sign-out":
        if (before) audit(c, "auth.sign_out", userTarget(before.id));
        break;
      case "/change-password":
        if (before && account) {
          audit(c, "auth.password_changed", userTarget(before.id), { via: "change" }, self);
          defer(c, sendPasswordChanged(deps(c), account));
        }
        break;
      case "/reset-password":
        if (facts.passwordResetUserId) {
          const id = facts.passwordResetUserId;
          audit(
            c,
            "auth.password_changed",
            userTarget(id),
            { via: "reset" },
            { actorUserId: id, actorType: "user" },
          );
          const owner = await getAccount(db(c), id);
          if (owner) defer(c, sendPasswordChanged(deps(c), { to: owner.email, name: owner.name }));
        }
        break;
      case "/two-factor/verify-totp":
        // With a session and two-factor not yet on, a correct code is what switches it on.
        if (before && account && before.twoFactorEnabled !== true) {
          audit(c, "auth.2fa_enabled", userTarget(before.id), null, self);
          defer(c, sendTwoFactorEnabled(deps(c), account));
        }
        break;
      case "/two-factor/disable":
        if (before && account) {
          audit(c, "auth.2fa_disabled", userTarget(before.id), null, self);
          defer(c, sendTwoFactorDisabled(deps(c), account));
        }
        break;
      case "/passkey/verify-registration":
        if (before && account) {
          audit(c, "auth.passkey_added", userTarget(before.id), null, self);
          defer(c, sendPasskeyAdded(deps(c), account));
        }
        break;
      case "/passkey/delete-passkey":
        if (before && account) {
          audit(c, "auth.passkey_removed", userTarget(before.id), null, self);
          defer(c, sendPasskeyRemoved(deps(c), account));
        }
        break;
    }
    if (facts.emailChangedUserId) {
      const id = facts.emailChangedUserId;
      audit(c, "auth.email_changed", userTarget(id), null, { actorUserId: id, actorType: "user" });
    }
    return;
  }

  // ── a credential was refused ─────────────────────────────────────────────────────────────
  if (CREDENTIAL_PATHS.has(path)) {
    let target = before ? userTarget(before.id) : null;
    if (!target && path === "/sign-in/email") {
      // Whose account was tried, when the address is an account's. The address itself is not kept.
      const email = (info.body as { email?: unknown } | null)?.email;
      if (typeof email === "string" && email.length <= 254) {
        const tried = await getAccountByEmail(db(c), email.trim().toLowerCase());
        if (tried) target = userTarget(tried.id);
      }
    }
    audit(
      c,
      "auth.failed",
      target,
      { path, status, code },
      before ? self : { actorUserId: null, actorType: "system" },
    );
    metric("auth", {
      outcome: "failed",
      kind: SIGN_IN_METHOD[path] ?? "credential",
      reason: code ?? String(status),
    });
  }
}
