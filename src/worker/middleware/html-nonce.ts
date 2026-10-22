// The CSP nonce of the SPA shell. app.ts calls this for every text/html response of the asset
// fallback: a fresh 128-bit nonce per response goes on every <script>, <style> and module
// preload of the page, and into two meta tags in <head>:
//   <meta name="csp-nonce" content="…">   read by the Emotion cache (client/theme/emotion.ts)
//   <meta property="csp-nonce" nonce="…">  read by Vite's dev client for the <style> elements it
//                                          inserts for CSS imports (`vite dev` only; inert in a build)
// The header itself is set by security-headers.ts, which picks the nonce up through `useNonceFor`.
//
// A conditional request is answered from scratch: a 304 would pair the browser's stored body (its
// old nonces) with this response's header, and nothing on the page would run.

import type { Context } from "hono";
import type { AppEnv } from "../services/request-context";
import { newNonce, useNonceFor } from "./security-headers";

const CONDITIONAL = ["if-none-match", "if-modified-since", "if-match", "if-unmodified-since", "if-range"];

function unconditional(request: Request): Request {
  const headers = new Headers(request.headers);
  for (const name of CONDITIONAL) headers.delete(name);
  // The same request (its URL and method copied, not read) without the validators.
  return new Request(request, { headers });
}

async function stamped(res: Response, c: Context<AppEnv>): Promise<Response> {
  let response = res;
  if (response.status === 304) {
    await response.body?.cancel();
    response = await c.env.ASSETS.fetch(unconditional(c.req.raw));
  }
  const nonce = newNonce();
  useNonceFor(c, nonce);
  const stamp = {
    element(element: Element) {
      element.setAttribute("nonce", nonce);
    },
  };
  const rewritten = new HTMLRewriter()
    .on("script", stamp)
    .on("style", stamp)
    .on('link[rel="modulepreload"]', stamp)
    .on("head", {
      element(head) {
        head.append(
          `<meta name="csp-nonce" content="${nonce}"><meta property="csp-nonce" nonce="${nonce}">`,
          { html: true },
        );
      },
    })
    .transform(response);
  // The deployed asset binding answers `text/html` with no charset (local Miniflare adds one): name it,
  // so no browser guesses the shell's encoding (T26 headers snapshot, Gate-B run 2026-10-22).
  const headers = new Headers(rewritten.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(rewritten.body, {
    status: rewritten.status,
    statusText: rewritten.statusText,
    headers,
  });
}

export const htmlNonce = (res: Response, c: Context<AppEnv>): Response | Promise<Response> => stamped(res, c);
