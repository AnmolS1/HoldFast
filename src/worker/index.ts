// Worker entry: host dispatch plus the queue, cron and container exports.
//
// SEAM. This is the only file that imports the concrete database and auth modules; everything
// else receives them as `CoreDeps`. Its import paths are final — later work replaces the files
// behind them (./auth/create-auth, ./scan/consumer, ./scheduled, ./scan/container), never this.
// `./auth/create-auth` stays the FIRST import: the auth task's module must be evaluated before
// anything else in the graph.

import { createAuth } from "./auth/create-auth";
import { createApp } from "./app";
import { createDb } from "./db/client";
import { insertAudit } from "./db/queries/audit";
import { getSettings } from "./db/queries/settings";
import { termsVersionOf } from "./db/queries/users";
import { createFilesHost } from "./files-host";
import * as consumer from "./scan/consumer";
import * as scheduledImpl from "./scheduled";
import { withSentry } from "./sentry";
import { runBackground, type CoreDeps } from "./services/request-context";

export { ScannerContainer } from "./scan/container";

const core: CoreDeps = { createDb, createAuth, getSettings, termsVersionOf, insertAudit };
const app = createApp(core);
const filesHost = createFilesHost(core);

/** `host` of an origin string, including a non-default port. Null when the value is not a URL. */
function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function misdirected(): Response {
  return new Response("Misdirected request\n", {
    status: 421,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default withSentry({
  // Strict host separation. The full host is compared, port included, so localhost:<port> and
  // files.localhost:<port> separate locally exactly as the two domains do when deployed.
  async fetch(request, env, ctx): Promise<Response> {
    const host = new URL(request.url).host;
    if (host === hostOf(env.APP_ORIGIN)) return app.fetch(request, env, ctx);
    if (host === hostOf(env.FILES_ORIGIN)) return filesHost.fetch(request, env, ctx);
    return misdirected();
  },

  async queue(batch, env, ctx): Promise<void> {
    await runBackground(env, ctx, (bg) => consumer.queue(batch, env, ctx, bg), core);
  },

  async scheduled(event, env, ctx): Promise<void> {
    await runBackground(env, ctx, (bg) => scheduledImpl.scheduled(event, env, ctx, bg), core);
  },
} satisfies ExportedHandler<Env>);
