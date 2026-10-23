// /api/auth/* → Better Auth's handler. Paths are relative to /api.
//
// IN FRONT of this route the pipeline has already: resolved the session (middleware/session.ts —
// which also applies the allow-list for suspended, deleted and impersonated sessions,
// auth/endpoint-policy.ts), refused every (method, path) that is not an endpoint of the handler,
// and applied RL_AUTH to the credential-bearing POSTs (middleware/rate-limit.ts). Better Auth then runs
// its own origin check, its own rate limit (the `rate_limit` table) and the Turnstile check.
//
// THIS ROUTE adds four things around `auth.handler()`:
//   1. the admin-plugin allow-list by RAW path (auth/admin-gate.ts): a request addressed at
//      /api/auth/admin/* that is not spelled exactly as one of the five allowed paths is answered
//      403 here and never reaches Better Auth;
//   2. the client facts the hooks cannot see for themselves (the address the pipeline resolved,
//      Cloudflare's ASN and country);
//   3. the WATCHDOG for Better Auth issue #10315 (auth/watchdog.ts) — detection, not cure: the
//      handler is raced against a 10 s timer; a hang is a 503, an error report and
//      `metric("auth", { outcome: "hang" })`. The session read in front of this route
//      (middleware/session.ts) is under the same watchdog;
//   4. the audit rows, the auth metric and the security emails (auth/audit.ts), from the
//      finished response.
// And two failures inside the handler that are a lost RACE, not an error, are answered as what
// they are: a unique violation on a verification link (the address was taken a moment ago) and
// on an OAuth callback (the identity was linked a moment ago) — a redirect each, never a 500.
//
// THE DELETION LINK (GET /delete-user/callback, R1 func-9) is a link in an email, so it answers
// with a page, never Better Auth's 404 JSON: signed out → the sign-in page saying so; another
// account's session → the account page, and Better Auth is NOT called (it consumes the token
// before it compares users, which burned the owner's link); a dead link → the account page.

import { requestMethod, requestPath } from "../middleware/canonical";
import { Hono } from "hono";
import { INTERNAL_ERROR } from "../../shared/errors";
import { ADMIN_PLUGIN_ALLOWED, isAdminPluginPath, recordAdminDenial } from "../auth/admin-gate";
import { afterAuthRequest } from "../auth/audit";
import { scopeOf } from "../auth/create-auth";
import { AUTH_PREFIX, isAuthEndpoint } from "../auth/endpoint-policy";
import { CHANGE_EMAIL_UNAVAILABLE, REAUTH_PATHS } from "../auth/mailbox-proof";
import { count, guard, isAnswer, reportError } from "../auth/observe";
import { LINK_ERROR_BUDGET, padStatements, STATEMENT_BUDGET } from "../auth/parity";
import { preflight } from "../auth/preflight";
import { HANG, hungAnswer, watched } from "../auth/watchdog";
import { isUniqueViolation } from "../db/errors";
import { deletionTokenOwner } from "../db/queries/auth-lifecycle";
import { AppError } from "../services/errors";
import { auth, db, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

const ALLOWED_ADMIN: readonly string[] = ADMIN_PLUGIN_ALLOWED;
/** The unique index on `account (provider_id, account_id)` (drizzle/0003). */
const PROVIDER_IDENTITY_INDEX = "account_provider_account_uidx";
/** Where the loser of two simultaneous provider links is sent (Better Auth's own code for it). */
export const ALREADY_LINKED = "/login?error=unable_to_link_account";
/** The one error a verification link answers with (the client has one sentence for it). */
export const LINK_INVALID = "LINK_INVALID";
/** Where the deletion link sends a browser that is not signed in (R1 func-9). */
export const DELETION_SIGN_IN = "/login?error=DELETION_SIGN_IN";
/** … one signed in to ANOTHER account (the link is left unused for its owner). */
export const DELETION_OTHER_ACCOUNT = "/account?deletion=other_account";
/** … and the owner, when the link is used, expired or unknown. */
export const DELETION_LINK_INVALID = "/account?deletion=link_invalid";
const DELETION_CALLBACK = "/delete-user/callback";

/** `request` with the client address the pipeline resolved, when the edge did not send one. */
function withClientAddress(request: Request, ip: string): Request {
  // Cloudflare sets (and overwrites) cf-connecting-ip on every deployed request, so this only
  // ever applies locally — where, without it, Better Auth's own rate limiter would put every
  // client into one shared bucket.
  if (request.headers.has("cf-connecting-ip")) return request;
  const headers = new Headers(request.headers);
  headers.set("cf-connecting-ip", ip);
  return new Request(request, { headers });
}

/** A link's answer that is a redirect carrying `error=`. */
function linkFailed(relativePath: string, response: Response): boolean {
  if (relativePath !== "/verify-email" || response.status !== 302) return false;
  return /[?&]error=/.test(response.headers.get("location") ?? "");
}

/**
 * ONE answer for a verification link that did not work — unknown, expired, tampered, for an
 * address no account has any more, or for another account: Better Auth names each
 * (`TOKEN_EXPIRED`, `INVALID_TOKEN`, `USER_NOT_FOUND`, `INVALID_USER`), which tells whoever holds
 * a link things about the account behind it. They all become `LINK_INVALID`.
 */
function genericLinkError(response: Response): Response {
  if (response.status !== 302) return response;
  const location = response.headers.get("location");
  if (!location || !/[?&]error=/.test(location)) return response;
  const headers = new Headers(response.headers);
  headers.set("location", location.replace(/([?&]error=)[^&#]*/, `$1${LINK_INVALID}`));
  return new Response(null, { status: 302, headers });
}

router.all(
  "/auth/*",
  guard("auth", async (c) => {
    const instance = auth(c);
    const scope = scopeOf(instance);
    // The canonical path and method (middleware/canonical.ts): what every layer in front of this
    // route decided on, and — being canonical — exactly what Better Auth's router will read.
    const relativePath = requestPath(c).slice(AUTH_PREFIX.length);
    const method = requestMethod(c);

    // 1. The admin plugin: by raw path, before Better Auth routes anything.
    if (isAdminPluginPath(relativePath) && !ALLOWED_ADMIN.includes(relativePath)) {
      if (scope) await recordAdminDenial(scope, c.get("user")?.id ?? null, relativePath, method);
      throw new AppError("forbidden", "This admin action is not available.", {
        reason: "admin_endpoint_denied",
      });
    }

    // 1b. Only an exact (method, path) of the installed handler goes on (the pipeline has already
    // refused the rest — middleware/rate-limit.ts; this is the same rule for the admin paths it
    // lets through to the refusal above, and for a caller that mounts this route alone).
    if (!isAuthEndpoint(method, relativePath)) throw new AppError("not_found");

    // 2. What the hooks need from the request.
    const cf = c.req.raw.cf as { asn?: unknown; country?: unknown } | undefined;
    if (scope) {
      scope.client = {
        ip: c.get("ip"),
        asn: typeof cf?.asn === "number" ? cf.asn : null,
        country: typeof cf?.country === "string" ? cf.country : null,
        userAgent: c.req.header("user-agent") ?? null,
      };
    }
    const request = withClientAddress(c.req.raw, c.get("ip"));

    // (a) Free refusals — before Better Auth, the database or a hash is touched for this request
    // (auth/preflight.ts). `RL_AUTH` has already run in the pipeline, for its own table of pairs.
    const checked = await preflight(method, relativePath, request);
    if (checked.refusal) return c.json(checked.refusal.body, checked.refusal.status);
    // The one body the audit step needs (a failed sign-in names the account it tried).
    const body = relativePath === "/sign-in/email" ? checked.body : null;
    // The password some requests must come with (the owner again — auth/mailbox-proof.ts
    // `REAUTH_PATHS`): Better Auth's schemas for those endpoints do not know the field, so the
    // hooks get it from here.
    if (scope && REAUTH_PATHS.has(relativePath)) {
      scope.reauthPassword = (checked.body as { password?: unknown } | null)?.password;
    }

    // (b) The deletion link, before Better Auth sees it (the header comment).
    if (method === "GET" && relativePath === DELETION_CALLBACK) {
      const viewer = c.get("user")?.id ?? null;
      if (viewer === null) return c.redirect(`${c.env.APP_ORIGIN}${DELETION_SIGN_IN}`, 302);
      const token = c.req.query("token") ?? "";
      const owner = token ? await deletionTokenOwner(db(c), token) : null;
      if (owner !== null && owner !== viewer) {
        return c.redirect(`${c.env.APP_ORIGIN}${DELETION_OTHER_ACCOUNT}`, 302);
      }
    }

    // Mail this request causes waits until it has been answered (auth/scope.ts `afterAnswer`).
    if (scope) scope.answered.held = true;
    try {
      return await answer();
    } finally {
      scope?.answered.release();
    }

    async function answer(): Promise<Response> {
      // 3. The watchdog (auth/watchdog.ts).
      let response: Response;
      try {
        const outcome = await watched(instance.handler(request));
        if (outcome === HANG) return hungAnswer(c, "handler");
        response = outcome;
      } catch (error) {
        // Not one of Better Auth's own errors (those are answers): a failure inside the handler.
        // It is reported from here as a sanitised copy — the class, the code and the scanned
        // message; a database error carries the row it was about, and none of that may leave with
        // it — and answered here. The caught object goes nowhere: not to a sink, and not to the
        // app's error handler.
        if (isAnswer(error)) throw error;
        if (relativePath === "/verify-email" && isUniqueViolation(error)) {
          // The address a change-of-address link confirms was taken between the look-up and the
          // write (two accounts confirming one address at the same moment): not an error page on a
          // link somebody clicked — the same answer as "taken a while ago" (auth/mailbox-proof.ts).
          return c.redirect(`${c.env.APP_ORIGIN}${CHANGE_EMAIL_UNAVAILABLE}`, 302);
        }
        if (
          method === "GET" &&
          relativePath.startsWith("/callback/") &&
          isUniqueViolation(error, [PROVIDER_IDENTITY_INDEX])
        ) {
          // Two simultaneous first links of one provider identity: the loser's insert met the
          // unique index on (provider_id, account_id) — THAT index and no other; any other
          // failure, another unique violation included, is the 500 below, reported. On its
          // sign-in path Better Auth catches this itself and answers `unable_to_link_account`;
          // on the explicit-link path it does not (oauth2/link-account.mjs `linkOAuthAccount`).
          // The same answer here — and it goes on through step 4 like any answer of the
          // handler's, so the refusal is audited (`auth.failed`) and counted.
          response = c.redirect(`${c.env.APP_ORIGIN}${ALREADY_LINKED}`, 302);
        } else {
          count("auth", { outcome: "error" });
          reportError(error, { kind: "auth_handler" });
          return c.json(
            { error: INTERNAL_ERROR, message: "Something went wrong.", requestId: c.get("requestId") },
            500,
          );
        }
      }

      // 3b. One answer, one amount of work (auth/parity.ts) — for a request that REACHED the
      // work: one that Better Auth's own limiter or the captcha turned away is not padded (it
      // would be work to be had for nothing). `hooks.before` sets the endpoint once it runs.
      if (method === "GET" && relativePath === "/verify-email") response = genericLinkError(response);
      // A deletion link Better Auth refused (used, expired, unknown): a page, not its JSON.
      if (method === "GET" && relativePath === DELETION_CALLBACK && response.status === 404) {
        response = c.redirect(`${c.env.APP_ORIGIN}${DELETION_LINK_INVALID}`, 302);
      }
      // … and not one the sign-in throttle turned away (its answer depends on the request alone).
      const reached = scope !== null && scope.facts.endpointPath !== null && !scope.facts.throttled;
      const budget = linkFailed(relativePath, response) ? LINK_ERROR_BUDGET : STATEMENT_BUDGET[relativePath];

      // 4. What happened, for the audit log. Its rows are written after the answer
      // (auth/observe.ts `recordAfterAnswer`); what it READS for them is part of the request's
      // own work, so the padding comes after it — the last thing before the answer.
      if (scope) await afterAuthRequest(c, scope, { relativePath, method, response, body });
      if (reached && budget !== undefined) await padStatements(db(c), budget);
      // 5. A cleanup that takes trust away failed, twice (auth/second-factor.ts
      // `cleanUpOrFlag`). The change itself happened and has just been audited and announced:
      // the caller is told it did not complete — with whatever cookies the handler set (a
      // changed password's new session), so they are not signed out by the failure.
      if (scope?.facts.cleanupFailed) {
        const failed = c.json(
          { error: INTERNAL_ERROR, message: "Something went wrong.", requestId: c.get("requestId") },
          500,
        );
        for (const cookie of response.headers.getSetCookie()) failed.headers.append("set-cookie", cookie);
        return failed;
      }
      return response;
    }
  }),
);
