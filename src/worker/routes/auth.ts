// /api/auth/* → Better Auth's handler. Paths are relative to /api.
//
// IN FRONT of this route the pipeline has already: resolved the session (middleware/session.ts —
// which also applies the allow-list for suspended, deleted and impersonated sessions,
// auth/endpoint-policy.ts), and applied RL_AUTH to every non-GET request. Better Auth then runs
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

import { Hono } from "hono";
import { INTERNAL_ERROR } from "../../shared/errors";
import { ADMIN_PLUGIN_ALLOWED, isAdminPluginPath, recordAdminDenial } from "../auth/admin-gate";
import { afterAuthRequest } from "../auth/audit";
import { scopeOf } from "../auth/create-auth";
import { AUTH_PREFIX } from "../auth/endpoint-policy";
import { count, guard, isAnswer, reportError } from "../auth/observe";
import { HANG, hungAnswer, watched } from "../auth/watchdog";
import { AppError } from "../services/errors";
import { auth, type AppEnv } from "../services/request-context";

export const router = new Hono<AppEnv>();

const ALLOWED_ADMIN: readonly string[] = ADMIN_PLUGIN_ALLOWED;

/** The only request body this route keeps a copy of: a sign-in's, to name the account a failed attempt tried. */
const KEEP_BODY_PATH = "/sign-in/email";
const KEEP_BODY_MAX_BYTES = 8 * 1024;

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

/**
 * A copy of a small JSON request body, or null. Never more than `KEEP_BODY_MAX_BYTES` is read:
 * a larger body (declared, or discovered while reading) is abandoned.
 */
async function smallJsonBody(request: Request): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > KEEP_BODY_MAX_BYTES)) return null;
  const reader = request.clone().body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > KEEP_BODY_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

router.all(
  "/auth/*",
  guard("auth", async (c) => {
    const instance = auth(c);
    const scope = scopeOf(instance);
    // The path exactly as it was sent (Hono's `c.req.path` is percent-decoded).
    const relativePath = new URL(c.req.url).pathname.slice(AUTH_PREFIX.length);
    const method = c.req.method;

    // 1. The admin plugin: by raw path, before Better Auth routes anything.
    if (isAdminPluginPath(relativePath) && !ALLOWED_ADMIN.includes(relativePath)) {
      if (scope) await recordAdminDenial(scope, c.get("user")?.id ?? null, relativePath, method);
      throw new AppError("forbidden", "This admin action is not available.", {
        reason: "admin_endpoint_denied",
      });
    }

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
    const body = method === "POST" && relativePath === KEEP_BODY_PATH ? await smallJsonBody(request) : null;

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
      count("auth", { outcome: "error" });
      reportError(error, { kind: "auth_handler" });
      return c.json(
        { error: INTERNAL_ERROR, message: "Something went wrong.", requestId: c.get("requestId") },
        500,
      );
    }

    // 4. What happened, for the audit log.
    if (scope) await afterAuthRequest(c, scope, { relativePath, method, response, body });
    return response;
  }),
);
