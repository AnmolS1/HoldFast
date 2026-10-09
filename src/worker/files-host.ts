// The Hono app of the files host (FILES_ORIGIN): user content only. Skeleton — the download,
// inline and thumbnail routes are stubs until the files-host task replaces this file.
//
// What must stay true whatever replaces it: never a cookie, never `env.ASSETS` (no HTML, no SPA
// shell), never a JSON error envelope — bodies are plain text — and the fixed header set of
// middleware/security-headers.ts on every response.

import { Hono } from "hono";
import { rateLimitByIp } from "./middleware/rate-limit";
import { requestContext } from "./middleware/request-context";
import { filesHostHeaders } from "./middleware/security-headers";
import { handlePlainError } from "./services/errors";
import { registerCoreDeps, type AppEnv, type CoreDeps } from "./services/request-context";

const TEXT = { "content-type": "text/plain; charset=utf-8" };

export function createFilesHost(core: CoreDeps): Hono<AppEnv> {
  registerCoreDeps(core);
  const app = new Hono<AppEnv>();
  app.onError(handlePlainError);
  app.notFound(() => new Response("Not found\n", { status: 404, headers: TEXT }));

  app.use("*", requestContext(core));
  app.use("*", filesHostHeaders);
  app.use("*", rateLimitByIp("RL_FILES"));

  // CORS preflight: only the app origin may ask. Anything else gets the ordinary 404.
  app.options("*", (c) => {
    if (c.req.header("origin") !== c.env.APP_ORIGIN) return c.notFound();
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range",
        "Access-Control-Max-Age": "600",
      },
    });
  });

  const notImplemented = () => new Response("Not implemented\n", { status: 501, headers: TEXT });
  app.on(["GET", "HEAD"], "/d/*", notImplemented);
  app.on(["GET", "HEAD"], "/i/*", notImplemented);
  app.on(["GET", "HEAD"], "/t/*", notImplemented);

  return app;
}
