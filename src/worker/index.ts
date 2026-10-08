// Worker entry: host dispatch plus the queue, cron and container exports.
// This is the skeleton. It is self-contained on purpose: it imports nothing but the build stamp.

import { Container } from "@cloudflare/containers";
import { metaResponse } from "./meta";

/** Scanner container. A placeholder image (containers/clamav) until the real scanner lands. */
export class ScannerContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "10m";
}

/** `host` of an origin string, including a non-default port. Null when the value is not a URL. */
function hostOf(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.host === hostOf(env.APP_ORIGIN)) {
      if (url.pathname === "/api/health") {
        return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/__meta") return metaResponse();
      return env.ASSETS.fetch(request);
    }

    // The files host serves user content only: no cookies, no HTML, and never the SPA shell.
    if (url.host === hostOf(env.FILES_ORIGIN)) return plain(404, "Not found\n");

    return plain(421, "Misdirected request\n");
  },

  // No scan consumer yet: acknowledge everything so nothing is retried or dead-lettered.
  async queue(batch): Promise<void> {
    batch.ackAll();
  },

  // No scheduled jobs yet.
  async scheduled(): Promise<void> {},
} satisfies ExportedHandler<Env>;
