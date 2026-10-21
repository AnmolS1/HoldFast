// Route coverage: the wrapper the Vitest hook (./vitest-hits.ts) puts around a route's own (LAST)
// handler. A hit is recorded when that handler runs, with the status of the answer it returned.
import type { Context } from "hono";
import type { Hit } from "./routes";

export type RouteHandler = (c: Context, next: () => Promise<void>) => unknown;

/** `handler`, recording a hit through `record` each time it runs. */
export function wrapRouteHandler(
  handler: RouteHandler,
  record: (hit: Hit) => void,
  file: () => string,
): RouteHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const hit: Hit = {
      source: "vitest",
      // The test origins (tests/setup/test-vars.ts): files.localhost is the files host.
      host: url.hostname.startsWith("files.") ? "files" : url.pathname.startsWith("/api/") ? "app" : null,
      method: c.req.method.toUpperCase(),
      path: url.pathname,
      status: 0,
      handler: true,
      file: file(),
    };
    record(hit);
    let result: unknown;
    try {
      result = await handler(c, next);
      return result;
    } finally {
      // The Response the handler RETURNED: Hono sets it on `c.res` only after this returns, so
      // reading `c.res` here would give its default (always 200; review D2). A handler that threw
      // (its answer is the error handler's) or returned no Response: 0, not known here.
      hit.status = result instanceof Response ? result.status : 0;
    }
  };
}
