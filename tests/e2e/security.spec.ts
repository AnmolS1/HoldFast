// The Content-Security-Policy in a real browser (T26 item 1), against `vite dev`.
//
//   holdfast-plan/scripts/heavy.sh e2e npm run e2e -- tests/e2e/security.spec.ts
//
// Route classes: login (the Turnstile stand-in), the explorer, a PDF preview, a video preview and
// the public link page — each listening for `securitypolicyviolation` events, CSP console lines,
// page errors and the reports the browser posts to /api/public/csp-report (the only place a
// WORKER's violations show). Zero of each. Admin, the report dialog and the interstitial pages are
// Part B (T25, T22). Runs on the projects playwright.config.ts has (chromium, mobile-chrome) until
// the firefox / webkit projects land (a T28 seam).
//
// Workers: under `vite dev` a worker's script is not an /assets/ file, so it carries no policy of
// its own (the built app's do: tests/unit/security/csp.test.ts, and `vite preview` in the report).
// Here each worker script is served WITH the page's own policy — taken from the document's
// header — to show that the policy, applied to a worker, lets the hash worker and pdf.js's worker
// run with no violation; and, the control, that a policy without 'wasm-unsafe-eval' on the hash
// worker's script makes it fail. So the header does govern the worker.
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
import { expect, mockedOnly, mockShell, stubTurnstile, test } from "./fixtures";

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

/** Serve every script whose path matches `pattern` with `policyOf()` as its own CSP header. */
async function policyOnScripts(page: Page, pattern: RegExp, policyOf: () => string): Promise<string[]> {
  const served: string[] = [];
  await page.route(
    (url) => pattern.test(url.pathname),
    async (route) => {
      const response = await route.fetch();
      const policy = policyOf();
      expect(policy, "the document's policy, read before the worker starts").toContain("script-src 'nonce-");
      served.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        response,
        headers: {
          ...response.headers(),
          "content-security-policy": policy,
          "reporting-endpoints": 'csp="/api/public/csp-report"',
        },
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
    await page.goto(`/preview/${ID.pdf}`);
    await expectPdfDrawn(page);
    expect(served.length, "pdf.js's worker script was served with the policy").toBeGreaterThan(0);

    await page.goto(`/preview/${ID.mp4}`);
    const video = page.locator('[data-preview-renderer="video"] video');
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThanOrEqual(1);
    expect(watched.problems).toEqual([]);
    expect(watched.reports).toEqual([]);
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
    // The document saw nothing of it: the worker's policy is not the page's.
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
