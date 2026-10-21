// The app host's Content-Security-Policy (T26 item 1): one nonce per HTML response, in the header
// and on every script and style of the page; the same policy on /assets/ scripts, so a Web Worker
// is bound by it too; origins from the environment only; no 'unsafe-inline' and no hash anywhere.
import { env, exports } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { canonicalRequest } from "../../../src/worker/middleware/canonical";
import { buildCsp, securityHeaders } from "../../../src/worker/middleware/security-headers";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN } from "../../setup/test-vars";
import { appWith, call, fakeCore, type CallOptions } from "../worker-core/helpers";

const NONCE = "AAAAAAAAAAAAAAAAAAAAAA==";

// Three environment shapes. The Sentry DSNs are made up (one per shape, so that "no other
// environment's origin" can fail); the real public DSN is in wrangler.jsonc `vars`.
const LOCAL = {
  APP_ORIGIN: "http://localhost:5190",
  FILES_ORIGIN: "http://files.localhost:5190",
  SENTRY_DSN_WEB: "",
};
const DEV = {
  APP_ORIGIN: "https://holdfast-dev.ponderance.dev",
  FILES_ORIGIN: "https://dev.holdfastusercontent.com",
  SENTRY_DSN_WEB: "https://publickey@o1111111111111111.ingest.us.sentry.io/2",
};
const PROD = {
  APP_ORIGIN: "https://holdfast.ponderance.dev",
  FILES_ORIGIN: "https://holdfastusercontent.com",
  SENTRY_DSN_WEB: "https://publickey@o2222222222222222.ingest.us.sentry.io/3",
};
const SHAPES = { LOCAL, DEV, PROD } as const;

/** The task's policy line, verbatim, with the derived values filled in. */
const policy = (files: string, sentry: string | null, https: boolean) =>
  [
    "default-src 'self'",
    `script-src 'nonce-${NONCE}' 'strict-dynamic' 'wasm-unsafe-eval' 'report-sample' https://challenges.cloudflare.com`,
    `style-src 'self' 'nonce-${NONCE}' 'report-sample'`,
    `img-src 'self' data: blob: ${files}`,
    `media-src ${files} blob:`,
    `connect-src 'self' ${files} https://challenges.cloudflare.com${sentry ? ` ${sentry}` : ""}`,
    "frame-src https://challenges.cloudflare.com",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "report-uri /api/public/csp-report",
    "report-to csp",
    ...(https ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

const hostsIn = (csp: string) =>
  [...new Set([...csp.matchAll(/https?:\/\/[^\s;]+/g)].map((m) => m[0]))].sort();

describe("buildCsp", () => {
  it("is the task's policy, for each of the three environment shapes", () => {
    expect(buildCsp(LOCAL, NONCE)).toBe(policy(LOCAL.FILES_ORIGIN, null, false));
    expect(buildCsp(DEV, NONCE)).toBe(
      policy(DEV.FILES_ORIGIN, "https://o1111111111111111.ingest.us.sentry.io", true),
    );
    expect(buildCsp(PROD, NONCE)).toBe(
      policy(PROD.FILES_ORIGIN, "https://o2222222222222222.ingest.us.sentry.io", true),
    );
  });

  it("names that environment's files and Sentry origins and no other environment's", () => {
    const origins = (shape: (typeof SHAPES)[keyof typeof SHAPES]) =>
      [shape.FILES_ORIGIN, shape.SENTRY_DSN_WEB ? new URL(shape.SENTRY_DSN_WEB).origin : null].filter(
        (value): value is string => value !== null,
      );
    for (const [name, shape] of Object.entries(SHAPES)) {
      const csp = buildCsp(shape, NONCE);
      expect(hostsIn(csp), name).toEqual([...origins(shape), "https://challenges.cloudflare.com"].sort());
      for (const [other, otherShape] of Object.entries(SHAPES)) {
        if (other === name) continue;
        for (const origin of origins(otherShape))
          expect(csp, `${name} names ${other}'s ${origin}`).not.toContain(origin);
      }
    }
  });

  it("an unset or unparseable SENTRY_DSN_WEB leaves the Sentry source out — never a wider one", () => {
    for (const dsn of [
      "",
      "not a url",
      "o123.ingest.sentry.io",
      "javascript:alert(1)",
      "data:text/plain,x",
    ]) {
      const csp = buildCsp({ ...DEV, SENTRY_DSN_WEB: dsn }, NONCE);
      const connect = csp.split("; ").find((directive) => directive.startsWith("connect-src"));
      expect(connect, dsn).toBe(`connect-src 'self' ${DEV.FILES_ORIGIN} https://challenges.cloudflare.com`);
      expect(csp, dsn).not.toMatch(/\*|https?:(?=[\s;])|javascript:|data:text/);
    }
  });

  it("has no 'unsafe-inline', no 'unsafe-eval' and no hash in any directive", () => {
    for (const shape of Object.values(SHAPES)) {
      const csp = buildCsp(shape, NONCE);
      expect(csp).not.toContain("'unsafe-inline'");
      expect(csp).not.toContain("'unsafe-eval'");
      expect(csp).not.toMatch(/'sha(256|384|512)-/);
    }
  });
});

// A shell shaped like the build's: a classic external script, module preloads, the module entry,
// an inline style and an inline script (Vite's dev preamble is one).
const SHELL =
  "<!doctype html><html><head><meta charset=utf-8><title>t</title>" +
  '<script src="/color-scheme-init.js"></script>' +
  '<link rel="modulepreload" crossorigin href="/assets/vendor-abc.js">' +
  '<link rel="stylesheet" href="/assets/index-abc.css">' +
  '<script type="module" crossorigin src="/assets/index-abc.js"></script>' +
  "<style>body{margin:0}</style>" +
  '<script type="module">import "/@react-refresh";</script>' +
  '</head><body><div id="root"></div><script nonce="planted-by-content">x()</script></body></html>';

const shellAssets = (body = SHELL, extra: Record<string, string> = {}) => ({
  fetch: async () =>
    new Response(body, { headers: { "content-type": "text/html; charset=utf-8", etag: '"abc"', ...extra } }),
});

const appCall = (path: string, options: CallOptions = {}) => call(appWith(fakeCore()), path, options);
const nonceOfHeader = (csp: string) => /script-src 'nonce-([^']+)'/.exec(csp)?.[1];

describe("the SPA shell", () => {
  it("every <script>, <style> and module preload carries the response's nonce, and so does the meta the Emotion cache reads", async () => {
    const { response } = await appCall("/files", { env: { ASSETS: shellAssets() } });
    const csp = response.headers.get("content-security-policy") ?? "";
    const nonce = nonceOfHeader(csp);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(csp).toContain(`style-src 'self' 'nonce-${nonce}' 'report-sample'`);
    const html = await response.text();

    const tags = [...html.matchAll(/<(?:script|style|link rel="modulepreload")[\s>][^>]*>?/g)].map(
      (m) => m[0],
    );
    expect(tags).toHaveLength(6);
    for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
    // A nonce that came with the content is replaced, never kept.
    expect(html).not.toContain("planted-by-content");
    // The stylesheet link needs none ('self').
    expect(html).toMatch(/<link rel="stylesheet" href="\/assets\/index-abc.css">/);
    expect(html).toContain(`<meta name="csp-nonce" content="${nonce}">`);
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
    expect(html.indexOf('<meta name="csp-nonce"')).toBeLessThan(html.indexOf("</head>"));
  });

  it("a fresh nonce per response; the shell is never stored and carries no validator", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const { response } = await appCall("/", { env: { ASSETS: shellAssets() } });
      seen.add(nonceOfHeader(response.headers.get("content-security-policy") ?? "") ?? "");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("last-modified")).toBeNull();
      await response.text();
    }
    expect(seen.size).toBe(5);
  });

  it("control: a script added to the page after the nonce was written carries none", async () => {
    // What a later transform (or an injection) would add: it is not covered by the policy.
    const { response } = await appCall("/", { env: { ASSETS: shellAssets() } });
    const nonce = nonceOfHeader(response.headers.get("content-security-policy") ?? "");
    const planted = new HTMLRewriter()
      .on("body", {
        element: (body) => {
          body.append("<script>planted()</script>", { html: true });
        },
      })
      .transform(response);
    const html = await planted.text();
    const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.filter((tag) => !tag.includes(`nonce="${nonce}"`))).toEqual(["<script>"]);
  });

  it("HTML that did not come through html-nonce.ts still gets the policy — with a nonce nothing on it carries", async () => {
    const app = new Hono<AppEnv>();
    app.use("*", canonicalRequest("app"), securityHeaders);
    app.get("/elsewhere", (c) => c.html("<script>x()</script>"));
    const { response } = await call(app, "/elsewhere");
    const csp = response.headers.get("content-security-policy") ?? "";
    expect(nonceOfHeader(csp)).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(await response.text()).toBe("<script>x()</script>");
  });

  it("a conditional request is answered with the whole page under a fresh nonce, never a 304", async () => {
    // The real assets binding (tests/fixtures/assets). Its own validator, as a browser holding a
    // copy from before this policy would send it (the Worker's answer no longer carries one).
    const direct = await env.ASSETS.fetch(`${TEST_APP_ORIGIN}/files`);
    const etag = direct.headers.get("etag");
    await direct.text();
    expect(etag).toBeTruthy();
    const revalidated = await env.ASSETS.fetch(`${TEST_APP_ORIGIN}/files`, {
      headers: { "if-none-match": etag! },
    });
    expect(revalidated.status, "the binding itself answers 304").toBe(304);
    await revalidated.text();
    const conditional = await exports.default.fetch(`${TEST_APP_ORIGIN}/files`, {
      headers: { "if-none-match": etag! },
    });
    expect(conditional.status).toBe(200);
    const nonce = nonceOfHeader(conditional.headers.get("content-security-policy") ?? "");
    expect(await conditional.text()).toContain(`<meta name="csp-nonce" content="${nonce}">`);
  });
});

const script = (contentType = "text/javascript") => ({
  fetch: async () =>
    new Response("export {}", {
      headers: { "content-type": contentType, "cache-control": "public, max-age=0" },
    }),
});

describe("/assets/ scripts carry the policy too (a worker runs under its own script's header)", () => {
  it("a .js and a .mjs under /assets/: the policy and Reporting-Endpoints, still immutable", async () => {
    for (const [path, type] of [
      ["/assets/index-abc123.js", "text/javascript"],
      ["/assets/sha256.worker-abc123.js", "text/javascript; charset=utf-8"],
      ["/assets/pdf.worker.min-abc123.mjs", "application/javascript"],
    ] as const) {
      const { response } = await appCall(path, { env: { ASSETS: script(type) } });
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp, path).toMatch(
        /^default-src 'self'; script-src 'nonce-[A-Za-z0-9+/]{22}==' 'strict-dynamic' 'wasm-unsafe-eval'/,
      );
      expect(csp, path).toContain(
        "connect-src 'self' http://files.localhost https://challenges.cloudflare.com",
      );
      // report-uri only (Addendum 3 F2): with report-to in a policy Chromium ignores report-uri, and a
      // worker's Reporting-API delivery is proven nowhere; report-uri is (tests/e2e/security.spec.ts).
      expect(csp, path).toMatch(/; report-uri \/api\/public\/csp-report$/);
      expect(csp, path).not.toContain("report-to");
      expect(response.headers.get("reporting-endpoints"), path).toBeNull();
      expect(response.headers.get("cache-control"), path).toBe("public, max-age=31536000, immutable");
      expect(await response.text(), path).toBe("export {}");
    }
  });

  it("no policy on anything else: a stylesheet, a script outside /assets/, the manifest", async () => {
    for (const [path, type] of [
      ["/assets/index-abc123.css", "text/css"],
      ["/color-scheme-init.js", "text/javascript"],
      ["/manifest.webmanifest", "application/manifest+json"],
    ] as const) {
      const { response } = await appCall(path, { env: { ASSETS: script(type) } });
      expect(response.headers.get("content-security-policy"), path).toBeNull();
      await response.text();
    }
  });
});
