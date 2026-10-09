// The Hono app of the app host (APP_ORIGIN): the middleware pipeline every route plugs into, the
// registry mounts, the JSON 404 for /api/*, the build stamp and the SPA fallback.
//
// A route is added by replacing a placeholder under routes/ (see routes/index.ts) — never by
// editing this file. The order of the pipeline below is load-bearing and asserted by a test.

import { Hono, type MiddlewareHandler } from "hono";
import { metaResponse } from "./meta";
import { cookieGuard } from "./middleware/cookie-guard";
import { csrf } from "./middleware/csrf";
import { htmlNonce } from "./middleware/html-nonce";
import { impersonationReadOnly } from "./middleware/impersonation";
import { killSwitch } from "./middleware/kill-switch";
import { rateLimit } from "./middleware/rate-limit";
import { requestContext } from "./middleware/request-context";
import { securityHeaders } from "./middleware/security-headers";
import { session } from "./middleware/session";
import { termsGate } from "./middleware/terms-gate";
import { apiRouters } from "./routes/index";
import { AppError, handleError } from "./services/errors";
import { registerCoreDeps, type AppEnv, type CoreDeps } from "./services/request-context";

export type PipelineStep = { name: string; path: string; handler: MiddlewareHandler<AppEnv> };

/**
 * The middleware of the app host, in order. `createApp` mounts exactly this list.
 *  1 requestContext          per-request context; closes the pool after deferred work
 *  2 securityHeaders         the header set of every response
 *  3 csrf                    cross-site state changes → 403
 *  4 session                 who is asking; suspension, bans, scheduled deletion
 *  5 impersonationReadOnly   an impersonated session cannot change anything
 *  6 termsGate               stale terms → 403 terms_required on a state change
 *  7 killSwitch              settings.readOnly → 503 read_only on a state change
 *  8 rateLimit               after session (the user key), so a 429 never hides the auth layer
 */
export function buildPipeline(core: CoreDeps): PipelineStep[] {
  return [
    { name: "requestContext", path: "*", handler: requestContext(core) },
    { name: "securityHeaders", path: "*", handler: securityHeaders },
    { name: "csrf", path: "/api/*", handler: csrf },
    // In front of everything that reads a cookie: one strict reading of the header.
    { name: "cookieGuard", path: "/api/*", handler: cookieGuard },
    { name: "session", path: "/api/*", handler: session },
    { name: "impersonationReadOnly", path: "/api/*", handler: impersonationReadOnly },
    { name: "termsGate", path: "/api/*", handler: termsGate },
    { name: "killSwitch", path: "/api/*", handler: killSwitch },
    { name: "rateLimit", path: "/api/*", handler: rateLimit },
  ];
}

export type AppOptions = {
  /**
   * Routers mounted under /api AFTER the registry. For unit tests that need a route of their own
   * behind the real pipeline; the Worker entry passes none.
   */
  extraRouters?: Array<Hono<AppEnv>>;
};

export function createApp(core: CoreDeps, options: AppOptions = {}): Hono<AppEnv> {
  registerCoreDeps(core);
  const app = new Hono<AppEnv>();
  app.onError(handleError);

  for (const step of buildPipeline(core)) app.use(step.path, step.handler);

  for (const { router } of apiRouters) app.route("/api", router);
  for (const router of options.extraRouters ?? []) app.route("/api", router);
  app.all("/api/*", () => {
    throw new AppError("not_found");
  });

  app.get("/__meta", () => metaResponse());

  // Everything else is the SPA: a static asset, or index.html for a client-side route. This path
  // never touches the database or the session.
  app.all("*", async (c) => {
    const response = await c.env.ASSETS.fetch(c.req.raw);
    const html = (response.headers.get("content-type") ?? "").startsWith("text/html");
    return html ? htmlNonce(response, c) : response;
  });

  return app;
}
