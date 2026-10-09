// The two hosts, in a real browser against `vite dev`. Neither half touches the database.
//   app origin    HTML with the full Content-Security-Policy, and the shell runs under it without
//                 a single CSP violation
//   files origin  404 text/plain, no cookie, no HTML — never the SPA
import { expect, test } from "./fixtures";

test.describe("app origin", () => {
  test("serves the shell with the security headers and no CSP violation", async ({ page, origins }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (
        /content security policy|refused to (load|execute|apply|connect|frame|create)/i.test(message.text())
      ) {
        violations.push(message.text());
      }
    });
    page.on("pageerror", (error) => violations.push(`pageerror: ${error.message}`));
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
      });
    });

    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    const headers = response?.headers() ?? {};
    expect(headers["content-type"]).toMatch(/^text\/html/);

    const csp = headers["content-security-policy"] ?? "";
    for (const directive of [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval' https://challenges.cloudflare.com",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${origins.files}`,
      `media-src ${origins.files} blob:`,
      `connect-src 'self' ${origins.files} https://challenges.cloudflare.com`,
      "frame-src https://challenges.cloudflare.com",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "report-uri /api/public/csp-report",
    ]) {
      expect(csp, directive).toContain(directive);
    }
    // http://localhost: no HSTS, no upgrade-insecure-requests, and never a blanket inline allowance.
    expect(csp).not.toContain("upgrade-insecure-requests");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-eval'/);
    expect(headers["strict-transport-security"]).toBeUndefined();
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(headers["reporting-endpoints"]).toBe('csp="/api/public/csp-report"');
    expect(headers["permissions-policy"]).toContain("publickey-credentials-get=(self)");
    expect(headers["cache-control"]).toBe("no-cache");

    // The shell must actually run under the policy: React renders.
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await page.waitForTimeout(500);
    expect(violations).toEqual([]);
  });

  test("answers the API in JSON with its own headers, and refuses a cross-site POST", async ({ request }) => {
    // Under /api/public/ on purpose: no session is read there, so this needs no database.
    const missing = await request.get("/api/public/does-not-exist");
    expect(missing.status()).toBe(404);
    expect(missing.headers()["content-type"]).toMatch(/^application\/json/);
    expect(missing.headers()["cache-control"]).toBe("no-store");
    expect(missing.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(await missing.json()).toMatchObject({ error: "not_found", requestId: expect.any(String) });

    const crossSite = await request.post("/api/nodes/folder", {
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      data: {},
    });
    expect(crossSite.status()).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: "forbidden" });
  });
});

test.describe("files origin", () => {
  test("is 404 text with no cookie and no HTML, on every path", async ({ page, origins }) => {
    for (const path of [
      "/",
      "/index.html",
      "/api/health",
      "/api/public/config",
      "/assets/anything.js",
      "/__meta",
    ]) {
      // In the browser: Chromium resolves *.localhost to loopback, Node's resolver may not.
      const response = await page.goto(`${origins.files}${path}`);
      expect(response?.status(), path).toBe(404);
      const headers = response?.headers() ?? {};
      expect(headers["content-type"], path).toBe("text/plain; charset=utf-8");
      expect(headers["set-cookie"], path).toBeUndefined();
      expect(headers["content-security-policy"], path).toBe(
        "sandbox; default-src 'none'; frame-ancestors 'none'",
      );
      expect(headers["cache-control"], path).toBe("private, no-store");
      expect(headers["x-content-type-options"], path).toBe("nosniff");
      expect(headers["access-control-allow-origin"], path).toBe(origins.app);
      const body = (await response?.text()) ?? "";
      expect(body, path).toBe("Not found\n");
      expect(body.toLowerCase(), path).not.toContain("<html");
    }
    expect(await page.context().cookies()).toEqual([]);
  });
});
