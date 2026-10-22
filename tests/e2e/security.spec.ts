// The Content-Security-Policy in a real browser (T26 item 1), against `vite dev`.
//
//   holdfast-plan/scripts/heavy.sh e2e npm run e2e -- tests/e2e/security.spec.ts
//
// Route classes: login (the Turnstile stand-in), the explorer, a PDF preview, a video preview and
// the public link page — each listening for `securitypolicyviolation` events, CSP console lines,
// page errors and the reports the browser posts to /api/public/csp-report (the only place a
// WORKER's violations show). Zero of each. Part B adds the admin console's Data Grid pages (T25)
// and, on the public link page, the report dialog and the dangerous-file interstitial (T22). Runs
// on the projects playwright.config.ts has (chromium, mobile-chrome) until the firefox / webkit
// projects land (a T28 seam).
//
// The Data Grid inserts a <style> of its own CSS variables outside Emotion (spike S5), which only
// the `nonce` prop of AdminDataGrid.tsx makes legal. The grid LOOKS right without it, so only the
// violation count catches a regression: zero on three grid pages, and the control — the same
// wrapper served without its nonce — one `style-src-elem` violation per grid, whose sample is the
// grid's own CSS, and which the browser reports to the endpoint.
//
// Workers: under `vite dev` a worker's script is not an /assets/ file, so it carries no policy of
// its own (the built app's do: tests/unit/security/csp.test.ts, and `vite preview` in the report).
// Here each worker script is served WITH the page's own policy — taken from the document's
// header, less `report-to` so that its reports are sent (see `policyOnScripts`) — to show that the
// policy, applied to a worker, lets the hash worker and pdf.js's worker run with no violation
// reported; and, the control, that a policy without 'wasm-unsafe-eval' on the hash worker's script
// makes it fail AND is reported. So the header does govern the worker, and "no report" is evidence.
//
// Also: a cross-site form POST to the API is refused (item 5); a planted violation carries its
// sample (`'report-sample'`); and a burst of violations on one page is counted as the browser
// really sends it, and its report answered 204 by the real endpoint (item 2, standing check (c);
// the redaction of a sample is the unit test's, tests/unit/security/csp-report.test.ts).
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { FakeDrive } from "../unit/client/explorer/fixtures/drive";
import { fileNode, folderNode } from "../unit/client/explorer/fixtures/nodes";
import { detailOf, ID, NODES, pageOf } from "../unit/client/preview/fixtures";
import { expect, mockedOnly, mockShell, navigateInApp, stubTurnstile, test } from "./fixtures";

const FILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../unit/client/preview/fixtures/files");
const BYTES: Record<string, { body: Buffer; type: string }> = {
  [ID.pdf]: { body: readFileSync(join(FILES_DIR, "three-pages.pdf")), type: "application/pdf" },
  [ID.mp4]: { body: readFileSync(join(FILES_DIR, "sample.mp4")), type: "video/mp4" },
};

interface Watched {
  /** `securitypolicyviolation` events of the document, CSP console lines and page errors. */
  problems: string[];
  /** The bodies the browser posted to the report endpoint (workers' violations land only here). */
  reports: string[];
}

/** Listen for every sign of a violation. Call BEFORE the first navigation, AFTER mockShell. */
async function watch(page: Page, options: { answerReports?: boolean } = {}): Promise<Watched> {
  const watched: Watched = { problems: [], reports: [] };
  page.on("console", (message) => {
    if (
      /content security policy|refused to (load|execute|apply|connect|frame|create|compile)/i.test(
        message.text(),
      )
    )
      watched.problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => watched.problems.push(`pageerror: ${error.message}`));
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/public/csp-report")
      watched.reports.push(request.postData() ?? "");
  });
  // Registered after mockShell: asked first. Answered here, or — where the real endpoint is the
  // subject — sent on to the Worker.
  await page.route("**/api/public/csp-report", (route) =>
    options.answerReports === false ? route.continue() : route.fulfill({ status: 204, body: "" }),
  );
  await page.addInitScript(() => {
    const seen: Array<{ directive: string; sample: string }> = [];
    (window as unknown as { __violations: typeof seen }).__violations = seen;
    document.addEventListener("securitypolicyviolation", (event) => {
      seen.push({ directive: event.effectiveDirective, sample: event.sample });
      console.error(`Content Security Policy violation: ${event.effectiveDirective} ${event.blockedURI}`);
    });
  });
  return watched;
}

/** The policy of the document the page navigated to last. */
function documentPolicy(page: Page): () => string {
  let policy = "";
  page.on("response", (response) => {
    const request = response.request();
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      policy = response.headers()["content-security-policy"] ?? policy;
    }
  });
  return () => policy;
}

/**
 * Serve every script whose path matches `pattern` with `policyOf()` as its own CSP header — WITHOUT
 * `report-to`: with it Chromium ignores `report-uri`, and on http it sends no report at all (see
 * the burst test), so a worker's violation would be invisible and "no report" would prove nothing.
 * With `report-uri` alone a worker's violation reaches the report endpoint, where `watch` sees it.
 * This is exactly what the built app sends on its /assets/ scripts (security-headers.ts
 * `assetScriptHeaders`, Addendum 3 F2).
 */
async function policyOnScripts(page: Page, pattern: RegExp, policyOf: () => string): Promise<string[]> {
  const served: string[] = [];
  await page.route(
    (url) => pattern.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      const policy = policyOf().replace("; report-to csp", "");
      expect(policy, "the document's policy, read before the worker starts").toContain("script-src 'nonce-");
      expect(policy).toContain("report-uri /api/public/csp-report");
      served.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": policy },
      });
    },
  );
  return served;
}

/** The signed-in SPA with the preview fixtures' node API and files host. */
async function arrangePreview(page: Page, origins: { app: string; files: string; port: number }) {
  await mockShell(page, origins.port);
  const nodes = new Map([NODES.pdf, NODES.mp4].map((node) => [node.id, node]));
  await page.route("**/api/nodes/**", async (route) => {
    const request = route.request();
    const match = /^\/api\/nodes\/([^/]+)(\/[a-z-]+)?$/.exec(new URL(request.url()).pathname);
    const node = match ? nodes.get(decodeURIComponent(match[1]!)) : undefined;
    if (match?.[2] === "/children") return route.fulfill({ json: pageOf([...nodes.values()]) });
    if (!match || !node) return route.fallback();
    if (!match[2]) return route.fulfill({ json: detailOf(node) });
    if (match[2] === "/download-url") {
      return route.fulfill({
        json: {
          url: `${origins.files}/i/${node.id}/token-made-up-for-the-test`,
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        },
      });
    }
    if (match[2] === "/thumb-url") return route.fulfill({ status: 404, json: { error: "not_found" } });
    return route.fallback();
  });
  const cors = { "access-control-allow-origin": origins.app, vary: "Origin" };
  await page.route(`${origins.files}/**`, async (route) => {
    const [, , nodeId] = new URL(route.request().url()).pathname.split("/");
    const found = nodeId ? BYTES[nodeId] : undefined;
    if (!found) return route.fulfill({ status: 404, body: "Not found.", headers: cors });
    const range = route.request().headers()["range"];
    const wanted = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    const headers = { ...cors, "content-type": found.type, "accept-ranges": "bytes" };
    if (wanted) {
      const start = Number(wanted[1]);
      const end = wanted[2] ? Math.min(Number(wanted[2]), found.body.length - 1) : found.body.length - 1;
      return route.fulfill({
        status: 206,
        body: found.body.subarray(start, end + 1),
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${found.body.length}` },
      });
    }
    return route.fulfill({ status: 200, body: found.body, headers });
  });
}

async function expectPdfDrawn(page: Page) {
  const first = page.locator('[data-pdf-page="1"]');
  await expect(first.locator(".textLayer")).toContainText("Holdfast preview fixture, page 1");
  await expect
    .poll(() =>
      first.locator("canvas").evaluate((canvas: HTMLCanvasElement) => {
        const context = canvas.getContext("2d");
        if (!context || canvas.width === 0) return 0;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const seen = new Set<number>();
        for (let index = 0; index < data.length; index += 4 * 97) {
          seen.add((data[index]! << 16) | (data[index + 1]! << 8) | data[index + 2]!);
        }
        return seen.size;
      }),
    )
    .toBeGreaterThan(1);
}

/** Hash "abc" in the app's own SHA-256 worker (the one the uploader starts). */
function hashInWorker(page: Page) {
  return page.evaluate(
    () =>
      new Promise<{ type: string; sha256?: string; message?: string }>((resolve) => {
        const worker = new Worker("/src/client/workers/sha256.worker.ts?worker_file&type=module", {
          type: "module",
        });
        worker.onmessage = (event: MessageEvent<{ type: string; sha256?: string; message?: string }>) => {
          if (event.data.type === "progress") return;
          worker.terminate();
          resolve(event.data);
        };
        worker.onerror = (event) => {
          worker.terminate();
          resolve({ type: "error", message: event.message || "the worker failed" });
        };
        worker.postMessage({ file: new Blob(["abc"]) });
      }),
  );
}

const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

test.describe("the policy in a real browser (mocked API)", () => {
  test.beforeEach(() => mockedOnly());

  test("login, with the Turnstile stand-in rendered by the page's own code: no violation", async ({
    page,
    origins,
  }) => {
    await mockShell(page, origins.port, { user: null });
    await stubTurnstile(page);
    const watched = await watch(page);
    const response = await page.goto("/login");
    expect(response?.headers()["content-security-policy"]).toMatch(
      /script-src 'nonce-[^']+' 'strict-dynamic'/,
    );
    await expect(page.getByRole("button", { name: /sign in/i }).first()).toBeVisible();
    // The widget's script was inserted by the page's code (allowed by 'strict-dynamic') and ran.
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as { __turnstileStub?: { issued: number } }).__turnstileStub?.issued ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
  });

  test("the explorer: no violation", async ({ page, origins }) => {
    const drive = new FakeDrive([folderNode(1, { name: "Reports" }), fileNode(2, { name: "notes.txt" })]);
    drive.filesOrigin = origins.files;
    await mockShell(page, origins.port, {
      api: async (route, path) => {
        if (!path.startsWith("/api/nodes")) return false;
        const request = route.request();
        const url = new URL(request.url());
        const answer = drive.handle({
          method: request.method(),
          path: url.pathname + url.search,
          body: undefined,
        });
        if (!answer) return false;
        await route.fulfill({ status: answer.status, json: answer.body });
        return true;
      },
    });
    const watched = await watch(page);
    await page.goto("/");
    await expect(page.locator("[data-explorer]")).toBeVisible();
    await expect(page.locator("[data-item-id]").filter({ hasText: "notes.txt" })).toBeVisible();
    await expect(page.locator("[data-item-id]").filter({ hasText: "Reports" })).toBeVisible();
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
  });

  test("a PDF preview and a video preview: no violation — pdf.js's worker served under the page's policy", async ({
    page,
    origins,
  }) => {
    await arrangePreview(page, origins);
    const watched = await watch(page);
    const policy = documentPolicy(page);
    const served = await policyOnScripts(page, /pdf\.worker/, policy);
    // As preview.spec.ts does: pdf.js's worker is fetched and run cold (no HTTP cache with routes),
    // most of the 5 s at 8× CPU throttle — wait for it, so that the 5 s below are for drawing only.
    const pdfWorker = page.waitForResponse((response) =>
      /pdf\.worker/.test(new URL(response.url()).pathname),
    );
    await page.goto(`/preview/${ID.pdf}`);
    await pdfWorker;
    await expectPdfDrawn(page);
    expect(served.length, "pdf.js's worker script was served with the policy").toBeGreaterThan(0);

    await page.goto(`/preview/${ID.mp4}`);
    const video = page.locator('[data-preview-renderer="video"] video');
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThanOrEqual(1);
    expect(watched.problems).toEqual([]);
    // Under `vite dev` pdf.js's worker is served through Vite, which puts its HMR client in it; that
    // client's socket to ws://127.0.0.1 is outside `connect-src 'self'` (the page is on localhost).
    // A dev-only artefact (the built worker has no Vite client) — and the proof that a WORKER's
    // violation does reach the endpoint here, so that no other report is evidence.
    const viteHmr = (body: string) => {
      const report = (JSON.parse(body) as { "csp-report"?: Record<string, string> })["csp-report"] ?? {};
      return (
        report["effective-directive"] === "connect-src" &&
        /^ws:\/\/127\.0\.0\.1:\d+\//.test(report["blocked-uri"] ?? "") &&
        /\/@vite\/client$/.test(report["source-file"] ?? "") &&
        /pdf\.worker/.test(report["document-uri"] ?? "")
      );
    };
    await expect.poll(() => watched.reports.filter(viteHmr).length).toBeGreaterThan(0);
    expect(watched.reports.filter((body) => !viteHmr(body))).toEqual([]);
  });

  test("the public link page: no violation", async ({ page, origins }) => {
    await mockShell(page, origins.port, {
      user: null,
      api: async (route, path) => {
        if (path !== "/api/public/links/AbCdEfGhIjKlMnOpQrStUv") return false;
        await route.fulfill({
          json: { requiresPassword: true, node: null, allowPreview: true, dangerous: false },
        });
        return true;
      },
    });
    const watched = await watch(page);
    const response = await page.goto("/s/AbCdEfGhIjKlMnOpQrStUv");
    expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(page.getByRole("heading", { name: "This link is protected" })).toBeVisible();
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
  });
});

const AT = "2099-01-01T00:00:00.000Z";
const ADMIN_ANSWERS: Record<string, unknown> = {
  "/api/admin/users": {
    items: [
      {
        id: "b".repeat(32),
        email: "grace@example.com",
        displayName: "Grace Hopper",
        role: "user",
        emailVerified: true,
        twoFactorEnabled: false,
        createdAt: AT,
        quotaBytes: 5_000_000_000,
        usedBytes: 1234,
        banned: false,
        banReason: null,
        suspendedAt: null,
        suspendedReason: null,
        deleteScheduledAt: null,
        legalHold: false,
        activeStrikes: 0,
        lastActiveAt: null,
      },
    ],
    nextCursor: null,
  },
  "/api/admin/invites": {
    items: [
      {
        code: "made-up-invite-code-for-e2e",
        createdBy: "a".repeat(32),
        maxUses: 1,
        uses: 0,
        expiresAt: null,
        revokedAt: null,
        note: null,
        createdAt: AT,
      },
    ],
    nextCursor: null,
  },
  "/api/admin/audit": {
    items: [
      {
        id: "0199d3c2-7a10-7000-8000-0000000000e1",
        at: AT,
        actorUserId: "a".repeat(32),
        actorType: "admin",
        action: "admin.user_suspended",
        targetType: "user",
        targetId: "b".repeat(32),
        ua: "Chrome",
        country: null,
        requestId: "req-e2e",
        meta: null,
      },
    ],
    nextCursor: null,
    actors: { ["a".repeat(32)]: null },
  },
};

/** The signed-in SPA as an admin, with one row on each of three Data Grid pages. */
async function arrangeAdmin(page: Page, port: number) {
  await mockShell(page, port, {
    user: { role: "admin" },
    api: async (route, path) => {
      const answer = ADMIN_ANSWERS[path];
      if (answer === undefined) return false;
      await route.fulfill({ json: answer });
      return true;
    },
  });
}

/** Visit the three grid pages (one document load), each with its grid mounted and its row drawn. */
async function visitGrids(page: Page) {
  await page.goto("/admin/users");
  for (const [path, row] of [
    ["/admin/users", "grace@example.com"],
    ["/admin/invites", "made-up-invite-code-for-e2e"],
    ["/admin/audit", "admin.user_suspended"],
  ] as const) {
    if (path !== "/admin/users") await navigateInApp(page, path);
    const grid = page.locator(".MuiDataGrid-root");
    await expect(grid, path).toHaveCount(1);
    await expect(grid.locator(".MuiDataGrid-row"), path).toHaveCount(1);
    await expect(grid.getByText(row, { exact: false }), path).toBeVisible();
  }
}

type Violation = { directive: string; sample: string };
const violationsOf = (page: Page) =>
  page.evaluate(() => (window as unknown as { __violations: Violation[] }).__violations);

test.describe("the admin console's Data Grid (mocked API)", () => {
  test.beforeEach(() => mockedOnly());

  test("three grid pages: no violation — the grid's own <style> carries the page's nonce", async ({
    page,
    origins,
  }) => {
    await arrangeAdmin(page, origins.port);
    const watched = await watch(page);
    await visitGrids(page);
    // The grid's variables really are in the document, inside a nonced <style>.
    const styles = await page.evaluate(() =>
      [...document.querySelectorAll("style")]
        .filter((style) => style.textContent?.startsWith(".MuiDataGridVariables-"))
        .map((style) => style.nonce),
    );
    expect(styles.length).toBeGreaterThan(0);
    for (const nonce of styles) expect(nonce).not.toBe("");
    expect(await violationsOf(page)).toEqual([]);
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
  });

  test("control: the wrapper served WITHOUT its nonce — one style-src-elem violation per grid, its sample the grid's CSS, reported to the endpoint", async ({
    page,
    origins,
  }) => {
    await arrangeAdmin(page, origins.port);
    const watched = await watch(page);
    // AdminDataGrid.tsx as Vite serves it, the nonce prop's value taken out (the module that is
    // the ONE door to the grid; eslint and a source scan keep it so).
    let rewritten = 0;
    await page.route(
      (url) => url.pathname === "/src/client/features/admin/components/AdminDataGrid.tsx",
      async (route) => {
        const response = await route.fetch();
        const text = await response.text();
        const without = text.replace("nonce: readNonceFromMeta()", "nonce: undefined");
        expect(without, "the transformed module still names the nonce prop as expected").not.toBe(text);
        rewritten += 1;
        await route.fulfill({ response, body: without });
      },
    );
    // The document's policy WITHOUT `report-to`: with it, Chromium sends nothing on http (Part A,
    // the burst test below), and the report this control shows would never leave the page.
    await page.route(
      (url) => url.pathname.startsWith("/admin"),
      async (route) => {
        if (route.request().resourceType() !== "document") return route.fallback();
        const response = await route.fetch();
        const policy = response.headers()["content-security-policy"] ?? "";
        expect(policy).toContain("; report-to csp");
        await route.fulfill({
          response,
          headers: {
            ...response.headers(),
            "content-security-policy": policy.replace("; report-to csp", ""),
          },
        });
      },
    );
    await visitGrids(page);
    expect(rewritten).toBe(1);
    // One more thing differs from the page above, and it is dev-only: once the document itself is
    // answered through page.route, Vite's HMR client (/@vite/client) falls back from its first
    // socket to ws://127.0.0.1:<port>, outside `connect-src 'self'` — the shape the PDF test allows
    // on pdf.js's worker. The built app has no Vite client. Nothing else is allowed.
    const viteHmr = (text: string) => /connect-src/.test(text) && /ws:\/\/127\.0\.0\.1:\d+\//.test(text);
    const violations = (await violationsOf(page)).filter(
      (violation) => violation.directive !== "connect-src",
    );
    expect(violations.length).toBeGreaterThan(0);
    for (const violation of violations) {
      expect(violation.directive).toBe("style-src-elem");
      expect(violation.sample).toMatch(/^\.MuiDataGridVariables-/);
    }
    // Every console line and page error is one of those violations — nothing else broke.
    expect(
      watched.problems.filter((line) => !/style-src-elem|style-src '/.test(line) && !viteHmr(line)),
    ).toEqual([]);
    expect(
      watched.reports.filter((body) => !body.includes("MuiDataGridVariables-") && !viteHmr(body)),
    ).toEqual([]);
    // …and the browser posted it, with its sample ('report-sample'), to the report endpoint.
    await expect
      .poll(() => watched.reports.filter((body) => body.includes("MuiDataGridVariables-")).length)
      .toBeGreaterThan(0);
    const report = JSON.parse(watched.reports.find((body) => body.includes("MuiDataGridVariables-"))!) as {
      "csp-report": {
        "effective-directive"?: string;
        "violated-directive"?: string;
        "script-sample"?: string;
      };
    };
    expect(report["csp-report"]["effective-directive"] ?? report["csp-report"]["violated-directive"]).toBe(
      "style-src-elem",
    );
    expect(report["csp-report"]["script-sample"]).toMatch(/^\.MuiDataGridVariables-/);
  });
});

test.describe("the report dialog and the dangerous-file interstitial (mocked API)", () => {
  test.beforeEach(() => mockedOnly());

  const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
  const file = {
    id: "0199d3c2-7a10-7000-8000-0000000000f2",
    name: "setup.exe",
    kind: "file",
    size: 1234,
    mimeCategory: "other",
    ext: "exe",
    mimeSniffed: "application/x-msdownload",
    thumb: false,
  };

  test("the public file page of a dangerous file: the interstitial, then the report dialog with its Turnstile — no violation", async ({
    page,
    origins,
  }) => {
    let minted = 0;
    await mockShell(page, origins.port, {
      user: null,
      api: async (route, path) => {
        if (path === `/api/public/links/${TOKEN}`) {
          await route.fulfill({
            json: { requiresPassword: false, node: file, allowPreview: true, dangerous: true },
          });
          return true;
        }
        if (path.startsWith(`/api/public/links/${TOKEN}/download-url`)) minted += 1;
        return false;
      },
    });
    const watched = await watch(page);
    await page.goto(`/s/${TOKEN}`);
    await expect(page.getByRole("heading", { name: file.name })).toBeVisible();

    // The interstitial: a dialog of its own, nothing minted until the visitor chooses.
    await page.locator("[data-public-download]").click();
    const warning = page.getByRole("dialog", { name: `Download ${file.name}?` });
    await expect(warning).toBeVisible();
    await warning.getByRole("button", { name: "Cancel" }).click();
    await expect(warning).toBeHidden();
    expect(minted).toBe(0);

    // The report dialog, with the Turnstile widget rendered by the page's own code.
    await page.locator("[data-report-link]").click();
    const dialog = page.getByRole("dialog", { name: "Report this file" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("[data-turnstile='ready']")).toBeAttached();
    await dialog.getByLabel("Spam").check();

    expect(await violationsOf(page)).toEqual([]);
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
  });
});

test.describe("a worker runs under its own script's policy", () => {
  test.beforeEach(() => mockedOnly());

  test("the hash worker, served with the page's policy, hashes with no violation", async ({
    page,
    origins,
  }) => {
    await mockShell(page, origins.port);
    const watched = await watch(page);
    const policy = documentPolicy(page);
    const served = await policyOnScripts(page, /\/sha256\.worker\.ts$/, policy);
    await page.goto("/files");
    expect(await hashInWorker(page)).toEqual({ type: "done", sha256: SHA256_ABC });
    expect(served).toEqual(["/src/client/workers/sha256.worker.ts"]);
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
  });

  test("control: the same worker under a policy without 'wasm-unsafe-eval' cannot compile hash-wasm", async ({
    page,
    origins,
  }) => {
    await mockShell(page, origins.port);
    const watched = await watch(page);
    const policy = documentPolicy(page);
    await policyOnScripts(page, /\/sha256\.worker\.ts$/, () => policy().replace(" 'wasm-unsafe-eval'", ""));
    await page.goto("/files");
    const result = await hashInWorker(page);
    expect(result.type).toBe("error");
    expect(result.sha256).toBeUndefined();
    // The worker's own refusal: WebAssembly compilation blocked by the policy of ITS script.
    expect(result.message).toMatch(/content security policy|unsafe-eval|blocked by CSP/i);
    // …naming the policy it ran under: the worker's own `script-src`, which lacks the source.
    expect(result.message).toMatch(/script-src 'nonce-[^']+' 'strict-dynamic' 'report-sample'/);
    // The document saw nothing of it. (This Chromium sends no report for a worker's wasm-eval
    // refusal — seen: 0 in 3 s; a worker's connect-src violation it does report: the PDF test.)
    expect(watched.problems).toEqual([]);
  });
});

test.describe("the report endpoint and CSRF, from a browser", () => {
  test.beforeEach(() => mockedOnly());

  test("planted violations carry their sample ('report-sample')", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await watch(page);
    await page.goto("/");
    // <style> elements added without the nonce: blocked, each with the first characters of its text.
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) {
        const style = document.createElement("style");
        style.textContent = `.planted-by-the-test-${i}{color:red}`;
        document.head.append(style);
      }
    });
    const events = await page.evaluate(
      () =>
        (window as unknown as { __violations: Array<{ directive: string; sample: string }> }).__violations,
    );
    expect(events.filter((event) => event.sample.startsWith(".planted-by-the-test"))).toEqual([
      { directive: "style-src-elem", sample: ".planted-by-the-test-0{color:red}" },
      { directive: "style-src-elem", sample: ".planted-by-the-test-1{color:red}" },
      { directive: "style-src-elem", sample: ".planted-by-the-test-2{color:red}" },
    ]);
  });

  test("a burst of 25 violations on one page: what the browser sends, and the real endpoint answers it 204", async ({
    page,
    request,
  }) => {
    // Measured on the `report-uri` path. With `report-to` in the policy, Chromium ignores
    // `report-uri`, and it sends Reporting-API reports only to an https endpoint — so on
    // http://localhost NOTHING is reported (seen: 0 requests in 120 s, to the app and to a server
    // of the test's own). On the deploys (https) the Reporting API delivers, in batches outside the
    // page: a post-integration check. Here: the APP'S OWN policy without `report-to`, its
    // `report-uri` pointed at a server of the test's own, which sees what the browser sends.
    const policy = (await request.get("/")).headers()["content-security-policy"] ?? "";
    expect(policy).toContain("; report-to csp");
    const received: Array<{ type: string; body: string }> = [];
    const PLANTED = 25;
    const server = createServer((req, res) => {
      if (req.method === "POST") {
        let body = "";
        req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
        req.on("end", () => {
          received.push({ type: req.headers["content-type"] ?? "", body });
          res.writeHead(204).end();
        });
        return;
      }
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const own = policy
        .replace("report-uri /api/public/csp-report", `report-uri ${base}/report`)
        .replace("; report-to csp", "");
      res.writeHead(200, { "content-type": "text/html", "content-security-policy": own });
      res.end(
        `<!doctype html><title>burst</title><script>
          for (let i = 0; i < ${PLANTED}; i++) { const s = document.createElement("style");
            s.textContent = ".burst-" + i + "{color:red}"; document.head.append(s); }
        </script>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      // The page's own inline script is what violates (no nonce): it also never runs, so the
      // styles are planted by evaluate once the page is there.
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.evaluate((count) => {
        for (let i = 0; i < count; i++) {
          const style = document.createElement("style");
          style.textContent = `.burst-${i}{color:red}`;
          document.head.append(style);
        }
      }, PLANTED);
      await expect.poll(() => received.length).toBeGreaterThan(0);
      // Whatever else is still on its way.
      await page.waitForLoadState("networkidle");
      const reports = received.flatMap(({ type, body }) => {
        const parsed = JSON.parse(body) as unknown;
        return type.startsWith("application/reports+json") ? (parsed as unknown[]) : [parsed];
      });
      console.log(
        `csp-report burst: ${PLANTED + 1} violations on one page → ${received.length} request(s) carrying ${reports.length} report(s); types ${[...new Set(received.map((r) => r.type))].join(", ")}`,
      );
      // Bounded: never more requests than violations, every one under the endpoint's 8 KB cap.
      expect(received.length).toBeLessThanOrEqual(PLANTED + 1);
      for (const { body } of received) expect(Buffer.byteLength(body)).toBeLessThanOrEqual(8 * 1024);
      expect(JSON.stringify(reports)).toContain(".burst-0");
      // What the browser sent, sent on to the real endpoint as it was: 204.
      const replayed = await request.post("/api/public/csp-report", {
        headers: { "content-type": received[0]!.type },
        data: received[0]!.body,
      });
      expect(replayed.status()).toBe(204);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("a cross-site form POST to the API is refused 403", async ({ page, origins }) => {
    // A page on another site that posts a form to the app, as an attacker's page would.
    await page.route("http://attacker.example/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><form method="post" action="${origins.app}/api/nodes/folder" enctype="text/plain">
          <input name='{"parentId":null,"name":"x","pad":"' value='"}'></form>
          <script>document.forms[0].submit()</script>`,
      }),
    );
    const refused = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/api/nodes/folder",
    );
    await page.goto("http://attacker.example/");
    const answer = await refused;
    expect(answer.status()).toBe(403);
    expect(await answer.json()).toMatchObject({ error: "forbidden", details: { reason: "csrf" } });
    expect((await answer.request().allHeaders())["origin"]).toBe("http://attacker.example");
  });
});
