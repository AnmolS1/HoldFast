// First middleware of both apps: builds the per-request context (services/request-context.ts),
// sets the eager values on `c.var`, emits the `request` metric, and — in a `finally` — hands the
// drain-then-close of the database pool to `waitUntil`.

import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { writeMetric } from "../services/metrics";
import {
  finishRequestContext,
  openRequestContext,
  type AppEnv,
  type CoreDeps,
} from "../services/request-context";

/** A route pattern without its parameter regexes: `/api/nodes/:id`, never a concrete path. */
function routeTag(pattern: string): string {
  return pattern.replace(/\{(?:[^{}]|\{[^{}]*\})*\}/g, "");
}

export function requestContext(core: CoreDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = Date.now();
    const requestId = crypto.randomUUID();
    // Only Cloudflare's own header. Anything else (x-forwarded-for) is client-controlled.
    const ip = c.req.header("cf-connecting-ip") ?? "127.0.0.1";
    const cf = c.req.raw.cf as { colo?: unknown } | undefined;
    const colo = typeof cf?.colo === "string" ? cf.colo : null;

    openRequestContext(c, core, { requestId, ip, colo });
    c.set("requestId", requestId);
    c.set("ip", ip);
    c.set("user", null);
    c.set("session", null);
    c.set("impersonating", false);
    c.set("termsStale", false);

    try {
      await next();
    } finally {
      // After the chain has run, the current route index is the handler that answered.
      let route = "";
      try {
        route = routeTag(routePath(c));
      } catch {
        route = "";
      }
      const status = c.res?.status ?? 500;
      writeMetric(c.env, "request", {
        outcome: `${Math.floor(status / 100)}xx`,
        route,
        ms: Date.now() - started,
      });
      finishRequestContext(c);
    }
  };
}
