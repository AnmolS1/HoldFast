// Host separation and the header sets. The files host must never set a cookie, never serve HTML
// or an asset, and never answer with a JSON envelope; the app host must send the full policy.
import { exports } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createFilesHost } from "../../../src/worker/files-host";
import { filesHostHeaders, htmlCsp } from "../../../src/worker/middleware/security-headers";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { TEST_APP_ORIGIN, TEST_FILES_ORIGIN } from "../../setup/test-vars";
import { appWith, call, fakeCore, type CallOptions } from "./helpers";

const HTTPS = {
  APP_ORIGIN: "https://app.example.test",
  FILES_ORIGIN: "https://files.example.test",
  SENTRY_DSN_WEB: "https://publickey@o123.ingest.sentry.example.test/456",
};

/** Every header except the ones the runtime adds per response (x-mf-* is the local assets simulator's own log header). */
function headersOf(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (!["content-length", "date", "etag", "cf-cache-status", "x-mf-additional-response-log"].includes(name))
      out[name] = value;
  });
  return out;
}

describe("host dispatch (the Worker entry)", () => {
  it("app host → the SPA shell", async () => {
    const response = await exports.default.fetch(`${TEST_APP_ORIGIN}/`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^text\/html/);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(await response.text()).toContain('data-harness="test-shell"');
  });

  it("files host → 404 text/plain with no cookie, for /, /index.html and /api/health", async () => {
    for (const path of ["/", "/index.html", "/api/health", "/assets/app.js", "/__meta"]) {
      const response = await exports.default.fetch(`${TEST_FILES_ORIGIN}${path}`);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("set-cookie"), path).toBeNull();
      expect(await response.text(), path).toBe("Not found\n");
    }
  });

  it("any other host → 421", async () => {
    for (const url of ["http://127.0.0.1/", "http://evil.example/api/health", `${TEST_APP_ORIGIN}:8080/`]) {
      const response = await exports.default.fetch(url);
      expect(response.status, url).toBe(421);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
      await response.text();
    }
  });
});

describe("files host", () => {
  const filesCall = (path: string, options: CallOptions = {}) => {
    const fake = fakeCore();
    const assets: string[] = [];
    // An ASSETS that would hand out the SPA shell with a cookie, if anything ever asked it.
    const ASSETS = {
      fetch: async (request: Request) => {
        assets.push(request.url);
        return new Response("<!doctype html><title>shell</title>", {
          headers: { "content-type": "text/html", "set-cookie": "leak=1" },
        });
      },
    };
    return call(createFilesHost(fake.core), path, {
      origin: TEST_FILES_ORIGIN,
      ...options,
      env: { ASSETS, ...options.env },
    }).then((result) => ({ ...result, fake, assets }));
  };

  it("never asks ASSETS, never opens the database, never answers HTML or JSON", async () => {
    for (const path of [
      "/",
      "/index.html",
      "/api/health",
      "/api/public/config",
      "/s/sometoken1234567890",
      "/download",
      "/x/y/z",
    ]) {
      const { response, ctx, fake, assets } = await filesCall(path);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type"), path).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("set-cookie"), path).toBeNull();
      expect(await response.text()).toBe("Not found\n");
      await ctx.settle();
      expect(assets, path).toEqual([]);
      expect(fake.calls, path).toEqual([]);
    }
  });

  it("the three content routes are 501 text stubs", async () => {
    for (const path of ["/d/abc/def", "/i/abc/def", "/t/abc/256/def"]) {
      const { response } = await filesCall(path);
      expect(response.status, path).toBe(501);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      await response.text();
    }
    const post = await filesCall("/d/abc/def", { method: "POST" });
    expect(post.response.status).toBe(404);
    await post.response.text();
  });

  it("sends the full files header set", async () => {
    const plain = await filesCall("/");
    expect(headersOf(plain.response)).toEqual({
      "access-control-allow-origin": "http://localhost",
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "content-type": "text/plain; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      vary: "Origin",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    });
    await plain.response.text();

    const secure = await filesCall("/", { origin: HTTPS.FILES_ORIGIN, env: HTTPS });
    expect(headersOf(secure.response)).toEqual({
      "access-control-allow-origin": "https://app.example.test",
      "cache-control": "private, no-store",
      "content-security-policy": "sandbox; default-src 'none'; frame-ancestors 'none'",
      "content-type": "text/plain; charset=utf-8",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-resource-policy": "cross-origin",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "referrer-policy": "no-referrer",
      "strict-transport-security": "max-age=86400",
      vary: "Origin",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow, noarchive",
    });
    await secure.response.text();
  });

  it("strips a cookie whatever a route returned", async () => {
    // The header middleware on its own, in front of a route that tries to set cookies.
    const app = new Hono<AppEnv>();
    app.use("*", filesHostHeaders);
    app.get("/leak", (c) => {
      c.header("set-cookie", "a=1", { append: true });
      c.header("set-cookie", "b=2", { append: true });
      return c.text("x");
    });
    app.get(
      "/raw",
      () => new Response("x", { headers: { "set-cookie": "c=3", "cache-control": "public, max-age=600" } }),
    );
    for (const path of ["/leak", "/raw"]) {
      const { response } = await call(app, path, { origin: TEST_FILES_ORIGIN });
      expect(response.headers.get("set-cookie"), path).toBeNull();
      expect(response.headers.getSetCookie(), path).toEqual([]);
      expect(response.headers.get("cache-control"), path).toBe("private, no-store");
      expect(response.headers.get("content-security-policy"), path).toContain("sandbox");
      await response.text();
    }
  });

  it("answers a preflight for the app origin only", async () => {
    const ok = await filesCall("/d/abc/def", { method: "OPTIONS", headers: { origin: TEST_APP_ORIGIN } });
    expect(ok.response.status).toBe(204);
    expect(ok.response.headers.get("access-control-allow-origin")).toBe(TEST_APP_ORIGIN);
    expect(ok.response.headers.get("access-control-allow-methods")).toBe("GET, HEAD, OPTIONS");
    for (const headers of [{ origin: "https://evil.example" }, {}] as Array<Record<string, string>>) {
      const refused = await filesCall("/d/abc/def", { method: "OPTIONS", headers });
      expect(refused.response.status).toBe(404);
      expect(refused.response.headers.get("access-control-allow-methods")).toBeNull();
      await refused.response.text();
    }
  });

  it("rate-limits by IP on RL_FILES, in plain text", async () => {
    const seen: string[] = [];
    const RL_FILES = {
      limit: async ({ key }: { key: string }) => {
        seen.push(key);
        return { success: false };
      },
    };
    const { response } = await filesCall("/d/abc/def", {
      env: { RL_FILES },
      headers: { "cf-connecting-ip": "203.0.113.9" },
    });
    expect(response.status).toBe(429);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("retry-after")).toBe("60");
    expect(seen).toEqual(["ip:203.0.113.9"]);
    expect(await response.text()).not.toContain("{");
  });
});

describe("app host headers", () => {
  const appCall = (path: string, options: CallOptions = {}) => call(appWith(fakeCore()), path, options);
  const script = {
    fetch: async () =>
      new Response("export {}", {
        headers: { "content-type": "text/javascript", "cache-control": "public, max-age=0" },
      }),
  };

  const CSP_HTTP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://files.localhost; " +
    "media-src http://files.localhost blob:; connect-src 'self' http://files.localhost https://challenges.cloudflare.com; " +
    "frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; font-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
    "report-uri /api/public/csp-report; report-to csp";
  const CSP_HTTPS =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://files.example.test; " +
    "media-src https://files.example.test blob:; " +
    "connect-src 'self' https://files.example.test https://challenges.cloudflare.com https://o123.ingest.sentry.example.test; " +
    "frame-src https://challenges.cloudflare.com; worker-src 'self' blob:; manifest-src 'self'; font-src 'self'; " +
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; " +
    "report-uri /api/public/csp-report; report-to csp; upgrade-insecure-requests";
  const HTML_COMMON = {
    "cache-control": "no-cache",
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), publickey-credentials-get=(self), publickey-credentials-create=(self)",
    "referrer-policy": "strict-origin-when-cross-origin",
    "reporting-endpoints": 'csp="/api/public/csp-report"',
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };

  it("HTML under http://localhost: the full set, no HSTS, no upgrade-insecure-requests", async () => {
    const { response } = await appCall("/files/some/folder");
    expect(response.status).toBe(200);
    const headers = headersOf(response);
    expect(headers["content-type"]).toMatch(/^text\/html/);
    delete headers["content-type"];
    expect(headers).toEqual({ ...HTML_COMMON, "content-security-policy": CSP_HTTP });
    await response.text();
  });

  it("HTML under https origins: HSTS, upgrade-insecure-requests, the files and Sentry origins", async () => {
    const { response } = await appCall("/", { origin: HTTPS.APP_ORIGIN, env: HTTPS });
    const headers = headersOf(response);
    delete headers["content-type"];
    expect(headers).toEqual({
      ...HTML_COMMON,
      "content-security-policy": CSP_HTTPS,
      "strict-transport-security": "max-age=86400",
    });
    await response.text();
  });

  it("names no host that did not come from the environment", () => {
    const csp = htmlCsp({ APP_ORIGIN: "https://a.test", FILES_ORIGIN: "https://f.test", SENTRY_DSN_WEB: "" });
    const hosts = [...csp.matchAll(/https?:\/\/[^\s;]+/g)].map((match) => match[0]);
    // Turnstile is the one third party the policy names by design.
    expect([...new Set(hosts)].sort()).toEqual(["https://challenges.cloudflare.com", "https://f.test"]);
    expect(csp).not.toMatch(/holdfast|ponderance|sentry/);
  });

  it("X-Robots-Tag only on /s/* and /admin/*", async () => {
    for (const [path, expected] of [
      ["/s/abcdefghijklmnop", "noindex, nofollow"],
      ["/admin", "noindex, nofollow"],
      ["/admin/users", "noindex, nofollow"],
      ["/files", null],
      ["/administrator", null],
    ] as const) {
      const { response } = await appCall(path);
      expect(response.headers.get("x-robots-tag"), path).toBe(expected);
      await response.text();
    }
  });

  it("static assets: nosniff; hashed files immutable, everything else no-cache; no CSP", async () => {
    const hashed = await appCall("/assets/index-abc123.js", { env: { ASSETS: script } });
    expect(headersOf(hashed.response)).toEqual({
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "text/javascript",
      "x-content-type-options": "nosniff",
    });
    await hashed.response.text();
    const other = await appCall("/manifest.webmanifest", { env: { ASSETS: script } });
    expect(headersOf(other.response)).toEqual({
      "cache-control": "no-cache",
      "content-type": "text/javascript",
      "x-content-type-options": "nosniff",
    });
    await other.response.text();
    // A missing hashed file falls back to the shell: that is HTML, and must not be cached as immutable.
    const missing = await appCall("/assets/missing-000.js");
    expect(missing.response.headers.get("cache-control")).toBe("no-cache");
    await missing.response.text();
  });

  it("API responses and /__meta: nosniff, no-store, default-src 'none', no-referrer", async () => {
    const expected = {
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
      "content-type": "application/json",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
    };
    for (const path of ["/api/nope", "/__meta"]) {
      const plain = await appCall(path);
      expect(headersOf(plain.response), path).toEqual(expected);
      await plain.response.text();
      await plain.ctx.settle();
      const secure = await appCall(path, { origin: HTTPS.APP_ORIGIN, env: HTTPS });
      expect(headersOf(secure.response), path).toEqual({
        ...expected,
        "strict-transport-security": "max-age=86400",
      });
      await secure.response.text();
      await secure.ctx.settle();
    }
  });

  it("local dev only: an inline script in the served HTML is allowed by its hash, never on https", async () => {
    const inline = "window.$RefreshReg$ = () => {};";
    const page = `<!doctype html><script type="module">${inline}</script><script type="module" src="/x.js"></script>`;
    const ASSETS = { fetch: async () => new Response(page, { headers: { "content-type": "text/html" } }) };
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(inline));
    const hash = `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;

    const local = await appCall("/", { env: { ASSETS } });
    const localCsp = local.response.headers.get("content-security-policy") ?? "";
    expect(localCsp).toContain(
      `script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com ${hash};`,
    );
    expect(localCsp).not.toContain("'unsafe-inline' https");
    expect(await local.response.text()).toBe(page);

    const deployed = await appCall("/", { origin: HTTPS.APP_ORIGIN, env: { ...HTTPS, ASSETS } });
    expect(deployed.response.headers.get("content-security-policy")).toBe(CSP_HTTPS);
    await deployed.response.text();
  });

  it("the asset path opens neither the database nor a session", async () => {
    const fake = fakeCore();
    const { response, ctx } = await call(appWith(fake), "/files");
    await response.text();
    await ctx.settle();
    expect(fake.calls).toEqual([]);
  });
});
