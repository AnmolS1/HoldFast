// Response headers of both hosts, written out in full. No origin is hardcoded: the files origin
// and the Sentry origin come from the environment, so production, the dev deploy and
// http://localhost get working previews from the same code.
//
// App host, by kind of response:
//   HTML (the SPA shell)   the full policy below, with a nonce of its own; never stored.
//   /assets/ JavaScript    the SAME policy (a fresh nonce nothing uses): a Web Worker runs under
//                          the policy of its own script response, not the page's — without it a
//                          worker could eval, compile wasm and fetch anywhere. Still immutable.
//   other static assets    nosniff; hashed files under /assets/ are immutable, the rest no-cache.
//   /api/* and /__meta     nosniff, no-store, `default-src 'none'`, no-referrer.
// Files host: one fixed set on every response, and never a cookie.
//
// Scripts run only by nonce: `'strict-dynamic'` hands the trust of a nonced script to the scripts
// it loads, and `'self'` / host sources are ignored by every browser that honours it (Turnstile's
// host stays for the others). There is no `'unsafe-inline'` anywhere and no hash. Styles: our own
// stylesheets ('self') and nonced <style> elements (Emotion reads the nonce from the meta tag
// html-nonce.ts writes). `'wasm-unsafe-eval'` stays: hash-wasm compiles WebAssembly.
// A later policy must keep every directive here that it does not deliberately tighten.

import { requestPath } from "./canonical";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "../services/request-context";

type HeaderEnv = Pick<Env, "APP_ORIGIN" | "FILES_ORIGIN" | "SENTRY_DSN_WEB">;

const TURNSTILE = "https://challenges.cloudflare.com";
const CSP_REPORT_PATH = "/api/public/csp-report";
/** One year, every subdomain, no preload (the preload list is a commitment the zone owner makes). */
const HSTS = "max-age=31536000; includeSubDomains";
const REPORTING_ENDPOINTS = `csp="${CSP_REPORT_PATH}"`;

const isHttps = (env: HeaderEnv) => env.APP_ORIGIN.startsWith("https://");

function sentryOrigin(env: HeaderEnv): string | null {
  if (!env.SENTRY_DSN_WEB) return null;
  try {
    const url = new URL(env.SENTRY_DSN_WEB);
    // An origin the browser can actually connect to, or none at all — never a widening value.
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** 128 random bits, base64. One per response. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** The Content-Security-Policy of the app host's HTML and of its /assets/ scripts. */
export function buildCsp(env: HeaderEnv, nonce: string): string {
  const files = env.FILES_ORIGIN;
  const sentry = sentryOrigin(env);
  const directives = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' 'report-sample' ${TURNSTILE}`,
    `style-src 'self' 'nonce-${nonce}' 'report-sample'`,
    `img-src 'self' data: blob: ${files}`,
    `media-src ${files} blob:`,
    ["connect-src 'self'", files, TURNSTILE, ...(sentry ? [sentry] : [])].join(" "),
    `frame-src ${TURNSTILE}`,
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    `report-uri ${CSP_REPORT_PATH}`,
    "report-to csp",
    // Only on https: locally it would rewrite the http://files.localhost origin.
    ...(isHttps(env) ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

// The nonce html-nonce.ts wrote into this request's HTML, for the header set after `next()`.
// Keyed by the request's Hono Context: one per request, and gone with it.
const responseNonces = new WeakMap<Context<AppEnv>, string>();

/** Called by html-nonce.ts with the nonce it stamped into the page. */
export function useNonceFor(c: Context<AppEnv>, nonce: string): void {
  responseNonces.set(c, nonce);
}

export function htmlHeaders(env: HeaderEnv, path: string, nonce: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildCsp(env, nonce),
    "Reporting-Endpoints": REPORTING_ENDPOINTS,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    // The nonce is per response: a stored or revalidated copy would pair an old body with a new
    // header (or the reverse), and nothing on the page would run.
    "Cache-Control": "no-store",
  };
  if (isHttps(env)) headers["Strict-Transport-Security"] = HSTS;
  // Public-link pages and the admin console stay out of search indexes.
  if (path.startsWith("/s/") || path === "/admin" || path.startsWith("/admin/")) {
    headers["X-Robots-Tag"] = "noindex, nofollow";
  }
  // A public-link page carries the link's token in its path: no Referer leaves it, not even an origin.
  if (path.startsWith("/s/")) headers["Referrer-Policy"] = "no-referrer";
  return headers;
}

/** Validators of an HTML response: with them a browser would revalidate a body whose nonces are stale. */
const HTML_DROPPED = ["etag", "last-modified"];

const JAVASCRIPT = /^(text|application)\/(javascript|ecmascript)\b/i;

/** A script under /assets/: the bundle, its chunks, the workers (`.js` and `.mjs` alike). */
export function isAssetScript(path: string, response: Response): boolean {
  return path.startsWith("/assets/") && JAVASCRIPT.test(response.headers.get("content-type") ?? "");
}

export function assetHeaders(path: string, status: number): Record<string, string> {
  const hashed = path.startsWith("/assets/") && (status === 200 || status === 304);
  return {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
  };
}

/** An /assets/ script: the asset set plus the page's policy, so a worker started from it is bound too. */
export function assetScriptHeaders(env: HeaderEnv, path: string, status: number): Record<string, string> {
  return {
    ...assetHeaders(path, status),
    "Content-Security-Policy": buildCsp(env, newNonce()),
    "Reporting-Endpoints": REPORTING_ENDPOINTS,
  };
}

export function apiHeaders(env: HeaderEnv): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
  };
  if (isHttps(env)) headers["Strict-Transport-Security"] = HSTS;
  return headers;
}

/** Every files-host response. Route files add Content-Type / Content-Disposition on top; they never weaken this. */
export function filesHeaders(env: HeaderEnv): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "private, no-store",
    "X-Robots-Tag": "noindex, nofollow, noarchive",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Access-Control-Allow-Origin": env.APP_ORIGIN,
    Vary: "Origin",
  };
  if (isHttps(env)) headers["Strict-Transport-Security"] = HSTS;
  return headers;
}

const isHtml = (response: Response) => (response.headers.get("content-type") ?? "").startsWith("text/html");
const isApiPath = (path: string) => path === "/api" || path.startsWith("/api/") || path === "/__meta";

function rebuilt(
  response: Response,
  body: BodyInit | null,
  set: Record<string, string>,
  drop: string[] = [],
): Response {
  const headers = new Headers(response.headers);
  for (const name of drop) headers.delete(name);
  for (const [name, value] of Object.entries(set)) headers.set(name, value);
  return new Response(body, { status: response.status, statusText: response.statusText, headers });
}

/** App host. Second in the pipeline, so it sees every response, error envelopes included. */
export const securityHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const response = c.res;
  if (response.status === 101) return;
  const path = requestPath(c);

  let replacement: Response;
  if (isApiPath(path)) {
    replacement = rebuilt(response, response.body, apiHeaders(c.env));
  } else if (isHtml(response)) {
    // HTML that did not come through html-nonce.ts gets a nonce no element carries: nothing in it runs.
    const nonce = responseNonces.get(c) ?? newNonce();
    replacement = rebuilt(response, response.body, htmlHeaders(c.env, path, nonce), HTML_DROPPED);
  } else if (isAssetScript(path, response)) {
    replacement = rebuilt(response, response.body, assetScriptHeaders(c.env, path, response.status));
  } else {
    replacement = rebuilt(response, response.body, assetHeaders(path, response.status));
  }
  // Clear first: assigning over an existing response would merge its headers back in.
  c.res = undefined;
  c.res = replacement;
};

/** Files host. Whatever a route returned, it leaves with this set and without a cookie. */
export const filesHostHeaders: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  const response = c.res;
  const replacement = rebuilt(response, response.body, filesHeaders(c.env), ["set-cookie"]);
  c.res = undefined;
  c.res = replacement;
};
