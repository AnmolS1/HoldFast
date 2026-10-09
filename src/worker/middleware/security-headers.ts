// Response headers of both hosts, written out in full. No origin is hardcoded: the files origin
// and the Sentry origin come from the environment, so production, the dev deploy and
// http://localhost get working previews from the same code.
//
// App host, by kind of response:
//   HTML (the SPA shell)   the full policy below. Applied to HTML only, so it is not inherited by
//                          Web Workers through script responses.
//   static assets          nosniff; hashed files under /assets/ are immutable, the rest no-cache.
//   /api/* and /__meta     nosniff, no-store, `default-src 'none'`, no-referrer.
// Files host: one fixed set on every response, and never a cookie.
//
// `style-src 'unsafe-inline'` is the one temporary directive (runtime-injected styles); the
// hardening task replaces it and `script-src 'self'` with nonces. `'wasm-unsafe-eval'` stays.
// A later policy must keep every directive here that it does not deliberately tighten.

import { requestMethod, requestPath } from "./canonical";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../services/request-context";

type HeaderEnv = Pick<Env, "APP_ORIGIN" | "FILES_ORIGIN" | "SENTRY_DSN_WEB">;

const TURNSTILE = "https://challenges.cloudflare.com";
const CSP_REPORT_PATH = "/api/public/csp-report";
/** Raised by the hardening task after the first production deploy. */
const HSTS = "max-age=86400";

const isHttps = (env: HeaderEnv) => env.APP_ORIGIN.startsWith("https://");

function sentryOrigin(env: HeaderEnv): string | null {
  if (!env.SENTRY_DSN_WEB) return null;
  try {
    return new URL(env.SENTRY_DSN_WEB).origin;
  } catch {
    return null;
  }
}

/** The Content-Security-Policy of an HTML response. `scriptHashes` is for local dev only. */
export function htmlCsp(env: HeaderEnv, scriptHashes: readonly string[] = []): string {
  const files = env.FILES_ORIGIN;
  const sentry = sentryOrigin(env);
  const directives = [
    "default-src 'self'",
    ["script-src 'self' 'wasm-unsafe-eval'", TURNSTILE, ...scriptHashes.map((hash) => `'${hash}'`)].join(" "),
    "style-src 'self' 'unsafe-inline'",
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
    ...(isHttps(env) ? ["upgrade-insecure-requests"] : []),
  ];
  return directives.join("; ");
}

export function htmlHeaders(
  env: HeaderEnv,
  path: string,
  scriptHashes: readonly string[] = [],
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": htmlCsp(env, scriptHashes),
    "Reporting-Endpoints": `csp="${CSP_REPORT_PATH}"`,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "Cache-Control": "no-cache",
  };
  if (isHttps(env)) headers["Strict-Transport-Security"] = HSTS;
  // Public-link pages and the admin console stay out of search indexes.
  if (path.startsWith("/s/") || path === "/admin" || path.startsWith("/admin/")) {
    headers["X-Robots-Tag"] = "noindex, nofollow";
  }
  return headers;
}

export function assetHeaders(path: string, status: number): Record<string, string> {
  const hashed = path.startsWith("/assets/") && (status === 200 || status === 304);
  return {
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": hashed ? "public, max-age=31536000, immutable" : "no-cache",
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

/**
 * LOCAL DEV ONLY (an http:// APP_ORIGIN — every deploy is https). The Vite dev server injects an
 * inline React-refresh preamble into index.html; under `script-src 'self'` it is blocked and the
 * SPA never renders. Instead of loosening the policy, that one script is allowed by its hash.
 *
 * Only the preamble: any OTHER inline script stays blocked locally exactly as it is on a deploy,
 * so a script added to index.html fails here first instead of only in production.
 */
const VITE_REACT_PREAMBLE = "/@react-refresh";

async function vitePreambleHashes(html: string): Promise<string[]> {
  const hashes: string[] = [];
  for (const match of html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi)) {
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    if (/\ssrc\s*=/i.test(attributes) || !body.includes(VITE_REACT_PREAMBLE)) continue;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    hashes.push(`sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`);
  }
  return hashes;
}

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
    if (!isHttps(c.env) && response.body && requestMethod(c) === "GET") {
      const html = await response.text();
      replacement = rebuilt(response, html, htmlHeaders(c.env, path, await vitePreambleHashes(html)));
    } else {
      replacement = rebuilt(response, response.body, htmlHeaders(c.env, path));
    }
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
