// The preview dialog in a real browser, against `vite dev`.
//
//   npm run e2e -- tests/e2e/preview.spec.ts
//
// MOCKED (the default): `mockShell` signs the SPA in; this spec answers `/api/nodes/*` from the
// preview's own fixtures (parsed by the contract's schemas) and plays the files host — the
// `/i/`, `/t/` and `/d/` URLs — from small real files: a PNG, a three-page PDF, a `.ts` file, an
// MP4, an SVG, an HTML page, a WebP thumbnail. What runs for real: the dialog, pdf.js and its
// worker, the highlighter, the media element, the app's Content-Security-Policy.
//
// REAL (`HOLDFAST_E2E_REAL=1`): the journeys need files uploaded through the upload API and
// scanned, which exist only on the integrated branch. Until the arrangement for that is written
// there (post-integration), every journey here says `mockedOnly()`.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page, Request, Route } from "@playwright/test";
import type { NodeDto } from "../../src/shared/schemas/node";
import { detailOf, ID, NODES, nodeOf, pageOf } from "../unit/client/preview/fixtures";
import { expect, expectNoA11yViolations, mockedOnly, mockEnvelope, mockShell, test } from "./fixtures";

const FILES_DIR = join(dirname(fileURLToPath(import.meta.url)), "../unit/client/preview/fixtures/files");
const file = (name: string) => readFileSync(join(FILES_DIR, name));

const BYTES: Record<string, { body: Buffer; type: string }> = {
  [ID.png]: { body: file("sample.png"), type: "image/png" },
  [ID.pdf]: { body: file("three-pages.pdf"), type: "application/pdf" },
  [ID.ts]: { body: file("sample-ts.txt"), type: "text/plain" },
  [ID.mp4]: { body: file("sample.mp4"), type: "video/mp4" },
  [ID.svg]: { body: file("sample-svg.txt"), type: "application/octet-stream" },
  [ID.html]: { body: file("sample-html.txt"), type: "application/octet-stream" },
};
const THUMBNAIL = file("sample-thumb.webp");

interface Origins {
  app: string;
  files: string;
  port: number;
}

interface Arranged {
  /** Every mint the SPA asked for, in order. */
  mints: Array<{ nodeId: string; kind: "inline" | "download" | "thumb"; size?: number }>;
  /** Every request to the files host: method, path, the Range asked for, the status answered. */
  served: Array<{ method: string; path: string; range: string | null; status: number }>;
  /** What the node routes answer; a test may change a node while the page is open. */
  nodes: Map<string, NodeDto>;
  /** Origins other than the app's and the files host's that anything was requested from. */
  foreign: string[];
  /** CSP violations and uncaught page errors. */
  problems: string[];
}

interface ArrangeOptions {
  /** Answer the files host itself (return true once fulfilled); otherwise the fixture is served. */
  files?: (route: Route, path: string) => Promise<boolean> | boolean;
}

/** The signed-in SPA, the node API for `nodes`, and the files host. */
async function arrange(
  page: Page,
  origins: Origins,
  nodes: NodeDto[],
  options: ArrangeOptions = {},
): Promise<Arranged> {
  const arranged: Arranged = {
    mints: [],
    served: [],
    nodes: new Map(nodes.map((node) => [node.id, node])),
    foreign: [],
    problems: [],
  };

  page.on("request", (request: Request) => {
    const url = request.url();
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    const origin = new URL(url).origin;
    if (origin !== origins.app && origin !== origins.files) arranged.foreign.push(url);
  });
  page.on("console", (message) => {
    if (
      /content security policy|refused to (load|execute|apply|connect|frame|create)/i.test(message.text())
    ) {
      arranged.problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => arranged.problems.push(`pageerror: ${error.message}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      console.error(`Content Security Policy violation: ${event.violatedDirective} ${event.blockedURI}`);
    });
  });

  await mockShell(page, origins.port);
  let minted = 0;
  const expiresAt = (seconds: number) => new Date(Date.now() + seconds * 1000).toISOString();
  // Registered after mockShell, so asked first; what is not a node route falls back to it.
  await page.route("**/api/nodes/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const match = /^\/api\/nodes\/([^/]+)(\/[a-z-]+)?$/.exec(url.pathname);
    const node = match ? arranged.nodes.get(decodeURIComponent(match[1]!)) : undefined;
    if (match?.[2] === "/children") {
      return route.fulfill({ json: pageOf(Array.from(arranged.nodes.values())) });
    }
    if (!match || !node) return route.fallback();
    if (!match[2] && request.method() === "GET") return route.fulfill({ json: detailOf(node) });
    if (match[2] === "/download-url" && request.method() === "POST") {
      const { kind } = request.postDataJSON() as { kind: "inline" | "download" };
      minted += 1;
      arranged.mints.push({ nodeId: node.id, kind });
      return route.fulfill({
        json: {
          url: `${origins.files}/${kind === "inline" ? "i" : "d"}/${node.id}/tok-${minted}`,
          expiresAt: expiresAt(kind === "inline" ? 900 : 300),
        },
      });
    }
    if (match[2] === "/thumb-url" && request.method() === "GET") {
      const size = Number(url.searchParams.get("size"));
      arranged.mints.push({ nodeId: node.id, kind: "thumb", size });
      // As the real API: a thumbnail URL is the same string for every mint within its bucket.
      return route.fulfill({
        json: { url: `${origins.files}/t/${node.id}/${size}/thumb-bucket`, expiresAt: expiresAt(600) },
      });
    }
    return route.fallback();
  });

  // The files host: plain bytes, CORS for the app origin, 206 for a Range — and plain text for
  // every failure, as the real one answers.
  const cors = { "access-control-allow-origin": origins.app, vary: "Origin" };
  await page.route(`${origins.files}/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const range = request.headers()["range"] ?? null;
    const record = (status: number) =>
      arranged.served.push({ method: request.method(), path, range, status });
    if (options.files && (await options.files(route, path))) {
      record(0);
      return;
    }
    const [, kind, nodeId] = path.split("/");
    if (kind === "t") {
      record(200);
      return route.fulfill({
        status: 200,
        body: THUMBNAIL,
        headers: { ...cors, "content-type": "image/webp" },
      });
    }
    const found = nodeId ? BYTES[nodeId] : undefined;
    if (!found || (kind !== "i" && kind !== "d")) {
      record(404);
      return route.fulfill({
        status: 404,
        body: "Not found.",
        headers: { ...cors, "content-type": "text/plain" },
      });
    }
    const headers = { ...cors, "content-type": found.type, "accept-ranges": "bytes" };
    const wanted = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    if (wanted) {
      const start = Number(wanted[1]);
      const end = wanted[2] ? Math.min(Number(wanted[2]), found.body.length - 1) : found.body.length - 1;
      record(206);
      return route.fulfill({
        status: 206,
        body: found.body.subarray(start, end + 1),
        headers: { ...headers, "content-range": `bytes ${start}-${end}/${found.body.length}` },
      });
    }
    record(200);
    return route.fulfill({ status: 200, body: found.body, headers });
  });
  return arranged;
}

const dialog = (page: Page) => page.getByRole("dialog");
const renderer = (page: Page, kind: string) => page.locator(`[data-preview-renderer="${kind}"]`);

async function open(page: Page, nodeId: string): Promise<void> {
  const response = await page.goto(`/preview/${nodeId}`);
  // "No CSP violation" means something only on a page that was served WITH the policy.
  const csp = response?.headers()["content-security-policy"] ?? "";
  expect(csp, "the page's Content-Security-Policy").toContain("default-src 'self'");
  expect(csp).toContain("worker-src 'self' blob:");
  expect(csp).toMatch(/script-src 'self' 'wasm-unsafe-eval'/);
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-(inline|eval)'/);
  await expect(dialog(page)).toBeVisible();
}

/** Nothing came from anywhere but this app and its files host, and nothing broke the CSP. */
function expectClean(arranged: Arranged): void {
  expect(arranged.foreign, "requests to another origin").toEqual([]);
  expect(arranged.problems, "CSP violations and page errors").toEqual([]);
}

test.describe("previews (mocked API and files host)", () => {
  test.beforeEach(() => {
    mockedOnly("the journeys script the node API and the files host; real uploads are post-integration");
  });

  test("a PNG opens from its inline URL, with the 320 thumbnail as the blur-up", async ({
    page,
    origins,
  }) => {
    // The original is held back until the blur-up has been asked for: a fast image needs none,
    // and this test is about the slow one.
    const blurUp: { asked: boolean } = { asked: false };
    const arranged = await arrange(page, origins, [NODES.png], {
      files: async (_route, path) => {
        if (path.startsWith("/t/")) blurUp.asked = true;
        if (path.startsWith("/i/")) await expect.poll(() => blurUp.asked).toBe(true);
        return false;
      },
    });
    await open(page, ID.png);
    await expect(dialog(page)).toHaveAccessibleName("sample.png");
    await expect(dialog(page)).toHaveAttribute("aria-modal", "true");
    const image = renderer(page, "image").getByRole("img", { name: "sample.png" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
    expect(await image.getAttribute("src")).toMatch(new RegExp(`^${origins.files}/i/${ID.png}/`));
    expect(arranged.mints.map((mint) => [mint.kind, mint.size])).toContainEqual(["inline", undefined]);
    expect(arranged.mints.map((mint) => [mint.kind, mint.size])).toContainEqual(["thumb", 320]);
    expect(arranged.mints.some((mint) => mint.kind === "download")).toBe(false);
    // The page underneath is still there, and inert.
    await expect(page.locator('[data-background="kept"]')).toHaveAttribute("inert", "");
    expectClean(arranged);
  });

  test("a PDF: page 1 is drawn with selectable text; page 3 is reached; a link out asks first", async ({
    page,
    origins,
  }) => {
    const arranged = await arrange(page, origins, [NODES.pdf]);
    const workers: string[] = [];
    page.on("request", (request) => {
      if (/pdf\.worker/.test(request.url())) workers.push(request.url());
    });
    await open(page, ID.pdf);
    await expect(renderer(page, "pdf")).toBeVisible();
    await expect(page.locator("[data-pdf-page-count]")).toHaveText("of 3");

    const first = page.locator('[data-pdf-page="1"]');
    await expect(first.locator(".textLayer")).toContainText("Holdfast preview fixture, page 1");
    // Drawn: the canvas has pixels that are not all one colour.
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

    await page.getByRole("button", { name: "Next page" }).click();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator("[data-pdf-page-input]")).toHaveValue("3");
    await expect(page.locator('[data-pdf-page="3"] .textLayer')).toContainText("page 3");
    await expect(page.locator('[data-pdf-page="3"]')).toBeInViewport();

    // The document's link: a question first, and Cancel opens nothing.
    await page.locator("[data-pdf-page-input]").fill("1");
    await page.locator("[data-pdf-page-input]").press("Enter");
    const popups: string[] = [];
    page.on("popup", (popup) => popups.push(popup.url()));
    await page.locator('[data-pdf-link="external"]').click();
    const leaving = page.getByRole("dialog", { name: "You're leaving Holdfast" });
    await expect(leaving).toContainText("https://example.com/holdfast-fixture");
    await leaving.getByRole("button", { name: "Cancel" }).click();
    await expect(leaving).toHaveCount(0);
    expect(popups).toEqual([]);

    // One whole-file fetch with an inline URL; the worker is this app's own file.
    expect(arranged.mints).toEqual([{ nodeId: ID.pdf, kind: "inline" }]);
    expect(
      arranged.served.filter((entry) => entry.path.startsWith("/i/")).map((entry) => entry.range),
    ).toEqual([null]);
    expect(workers.length).toBeGreaterThan(0);
    for (const url of workers) expect(new URL(url).origin).toBe(origins.app);
    await expect(page.locator("iframe, embed, object")).toHaveCount(0);
    expectClean(arranged);
  });

  test("a .ts file is highlighted, and the markup in it stays text", async ({ page, origins }) => {
    const arranged = await arrange(page, origins, [NODES.ts]);
    await open(page, ID.ts);
    const text = renderer(page, "text");
    await expect(text).toBeVisible();
    await expect(text).toHaveAttribute("data-highlighted", "true");
    await expect(text.locator('[data-token="keyword"]').first()).toBeVisible();
    await expect(text.locator('[data-token="comment"]').first()).toHaveText(
      "// A fixture for the text viewer.",
    );
    await expect(text.locator("[data-line]")).toHaveCount(9);
    await expect(text.locator("pre")).toContainText('const markup = "<script>alert(1)</script>";');
    await expect(text.locator("script")).toHaveCount(0);
    // The wrap toggle.
    await page.getByRole("checkbox", { name: "Wrap lines" }).check();
    await expect(text.locator("pre")).toHaveAttribute("data-wrap", "true");
    expect(arranged.mints).toEqual([{ nodeId: ID.ts, kind: "inline" }]);
    expectClean(arranged);
  });

  test("a crafted file inside every size bound: highlighting never holds the page, and Escape answers at once", async ({
    page,
    origins,
  }) => {
    // 200 lines of 999 characters that a grammar cuts into ~200,000 pieces: this took one
    // uninterruptible 13 s on the main thread before highlighting was bounded in time.
    const body = Buffer.from(`${"a<".repeat(499)}\n`.repeat(200));
    const crafted = nodeOf({ ...NODES.ts, size: body.length });
    await page.addInitScript(() => {
      const probe = window as unknown as { __long: Array<[number, number]>; __keyDelay: number[] };
      probe.__long = [];
      probe.__keyDelay = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) probe.__long.push([entry.startTime, entry.duration]);
      }).observe({ entryTypes: ["longtask"] });
      // How long a key press waited before any handler ran.
      document.addEventListener(
        "keydown",
        (event) => probe.__keyDelay.push(performance.now() - event.timeStamp),
        true,
      );
    });
    const arranged = await arrange(page, origins, [crafted], {
      files: async (route, path) => {
        if (!path.startsWith("/i/")) return false;
        await route.fulfill({
          status: 200,
          body,
          headers: { "access-control-allow-origin": origins.app, "content-type": "text/plain" },
        });
        return true;
      },
    });
    await open(page, ID.ts);
    const text = renderer(page, "text");
    await expect(text.locator("[data-line]")).toHaveCount(200);
    const shownAt = await page.evaluate(() => performance.now());
    // The run ends by itself — here by passing the piece cap — and the text stays plain.
    await expect(text).toHaveAttribute("data-highlight", "plain");
    await expect(text).toHaveAttribute("data-highlighted", "false");
    const longest = await page.evaluate(
      (from) =>
        Math.max(
          0,
          ...(window as unknown as { __long: Array<[number, number]> }).__long
            .filter(([start]) => start >= from)
            .map(([, duration]) => duration),
        ),
      shownAt,
    );
    // A slice is 8 ms of work plus at most one line's 8 ms; 200 ms leaves room for a loaded machine.
    expect(longest).toBeLessThan(200);

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    const delays = await page.evaluate(() => (window as unknown as { __keyDelay: number[] }).__keyDelay);
    expect(delays.length).toBeGreaterThan(0);
    // Within a frame or two of being pressed (it was seconds).
    expect(Math.max(...delays)).toBeLessThan(50);
    expectClean(arranged);
  });

  test("an MP4 plays from its inline URL and seeks to 50 % by Range", async ({ page, origins }) => {
    const arranged = await arrange(page, origins, [NODES.mp4]);
    await open(page, ID.mp4);
    const video = renderer(page, "video").locator("video");
    await expect(video).toBeVisible();
    await expect
      .poll(() => video.evaluate((el: HTMLVideoElement) => el.readyState))
      .toBeGreaterThanOrEqual(1);
    const duration = await video.evaluate((el: HTMLVideoElement) => el.duration);
    expect(duration).toBeGreaterThan(5);
    const landed = await video.evaluate(
      (el: HTMLVideoElement) =>
        new Promise<number>((resolve, reject) => {
          el.addEventListener("seeked", () => resolve(el.currentTime), { once: true });
          el.addEventListener("error", () => reject(new Error(`media error ${el.error?.code}`)), {
            once: true,
          });
          el.currentTime = el.duration / 2;
        }),
    );
    expect(Math.abs(landed - duration / 2)).toBeLessThan(0.5);
    expect(await video.evaluate((el: HTMLVideoElement) => el.error)).toBeNull();
    // The element asked the files host in ranges, and was answered 206.
    const ranged = arranged.served.filter((entry) => entry.path.startsWith(`/i/${ID.mp4}/`));
    expect(ranged.length).toBeGreaterThan(0);
    expect(ranged.every((entry) => entry.range !== null && entry.status === 206)).toBe(true);
    expect(arranged.mints).toEqual([{ nodeId: ID.mp4, kind: "inline" }]);
    expectClean(arranged);
  });

  for (const [name, node] of [
    ["an SVG", NODES.svg],
    ["an HTML file", NODES.html],
  ] as const) {
    test(`${name} is never rendered: no preview, nothing fetched, nothing of it runs`, async ({
      page,
      origins,
    }) => {
      const arranged = await arrange(page, origins, [node]);
      await open(page, node.id);
      await expect(renderer(page, "none")).toBeVisible();
      await expect(renderer(page, "none")).toContainText("No preview for this type");
      await expect(dialog(page).getByRole("button", { name: "Download" })).toHaveCount(1);
      await expect(dialog(page).locator("img, iframe, object, embed, #fixture-html-heading")).toHaveCount(0);
      expect(
        await page.evaluate(() => {
          const flags = window as unknown as { __svgRan?: boolean; __htmlRan?: boolean };
          return [flags.__svgRan, flags.__htmlRan];
        }),
      ).toEqual([undefined, undefined]);
      expect(arranged.mints).toEqual([]);
      expect(arranged.served).toEqual([]);
      expectClean(arranged);
    });
  }

  test("a file still being scanned says so, and opens by itself when the status flips", async ({
    page,
    origins,
  }) => {
    const arranged = await arrange(page, origins, [nodeOf({ scanStatus: "pending" })]);
    // The page's clock is the test's: the 5 s between two polls is stepped over, not waited for.
    await page.clock.install();
    await open(page, ID.png);
    await expect(page.locator('[data-preview-state="scanning"]')).toBeVisible();
    await expect(page.getByRole("progressbar", { name: "Scanning sample.png" })).toBeAttached();
    expect(arranged.mints).toEqual([]);
    arranged.nodes.set(ID.png, NODES.png);
    // The dialog asks again every 5 s: the preview appears at the next poll.
    await page.clock.fastForward(5_000);
    await expect(renderer(page, "image")).toBeVisible();
    await expect(page.locator('[data-preview-state="scanning"]')).toHaveCount(0);
    expectClean(arranged);
  });

  test("HEIC is shown through its 1280 thumbnail, with the line that says so", async ({ page, origins }) => {
    mockedOnly("the local image service cannot decode HEIC; the real path is a dev-deploy check");
    const arranged = await arrange(page, origins, [NODES.heic]);
    await open(page, ID.heic);
    const image = renderer(page, "heic").getByRole("img", { name: "IMG_0042.HEIC" });
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(64);
    expect(await image.getAttribute("src")).toMatch(new RegExp(`^${origins.files}/t/${ID.heic}/1280/`));
    await expect(renderer(page, "heic")).toContainText("Original is HEIC — download for full quality");
    // Never the original: no browser decodes it.
    expect(arranged.mints.every((mint) => mint.kind === "thumb")).toBe(true);
    expect(arranged.served.some((entry) => entry.path.startsWith("/i/"))).toBe(false);
    expectClean(arranged);
  });

  test("a HEIC whose thumbnail the files host answers 404: no preview, not a skeleton for ever", async ({
    page,
    origins,
  }) => {
    mockedOnly("the files host's 404 is scripted");
    const arranged = await arrange(page, origins, [NODES.heic], {
      files: async (route, path) => {
        if (!path.startsWith("/t/")) return false;
        await route.fulfill({ status: 404, body: "Not found.", headers: { "content-type": "text/plain" } });
        return true;
      },
    });
    await open(page, ID.heic);
    // The re-mint answers the same URL (see `arrange`): the dialog must not wait for a reload.
    await expect(renderer(page, "none")).toBeVisible();
    await expect(renderer(page, "none")).toContainText("No preview for this image — download to see it");
    await expect(page.locator("[data-preview-blurup]")).toHaveCount(0);
    await expect(dialog(page).getByRole("button", { name: "Download" })).toHaveCount(1);
    expect(arranged.mints.filter((mint) => mint.size === 1280).length).toBe(2);
    expect(arranged.mints.some((mint) => mint.kind === "inline")).toBe(false);
  });

  test("a refused URL: one more is minted, one retry is made, then the error state — whatever the refusal says", async ({
    page,
    origins,
  }) => {
    const texts = ["You don't have access to this file.", "This file is blocked."];
    let refused = 0;
    const arranged = await arrange(page, origins, [NODES.ts], {
      files: async (route) => {
        await route.fulfill({
          status: 403,
          body: texts[refused++ % texts.length]!,
          headers: {
            "access-control-allow-origin": origins.app,
            "content-type": "text/plain; charset=utf-8",
          },
        });
        return true;
      },
    });
    await open(page, ID.ts);
    await expect(page.locator('[data-preview-state="error"]')).toBeVisible();
    await expect(dialog(page)).toContainText("Couldn't open this preview");
    // The files host sends no request id, so none is shown.
    await expect(dialog(page).getByText(/^req /)).toHaveCount(0);
    expect(arranged.mints).toEqual([
      { nodeId: ID.ts, kind: "inline" },
      { nodeId: ID.ts, kind: "inline" },
    ]);
    expect(arranged.served.length).toBe(2);
    expect(arranged.problems.filter((problem) => problem.startsWith("pageerror"))).toEqual([]);
  });

  test("keyboard: arrows walk the files, Escape closes, and focus returns to what opened the preview", async ({
    page,
    origins,
  }) => {
    const nodes = [NODES.svg, NODES.html, NODES.png];
    const arranged = await arrange(page, origins, nodes);
    await page.goto("/shared");
    await expect(page.locator("[data-frame]")).toBeVisible();
    // Stand in for a row of the list underneath: a button inside the page the preview covers,
    // which opens the preview the way the explorer does (router state: the ids and `from`).
    await page.evaluate(
      ({ ids, first }) => {
        const opener = document.createElement("button");
        opener.id = "opener";
        opener.textContent = "open";
        opener.addEventListener("click", () => {
          const index = ((history.state as { idx?: number } | null)?.idx ?? 0) + 1;
          history.pushState(
            { usr: { siblingIds: ids, from: "/shared" }, key: "e2e-open", idx: index },
            "",
            `/preview/${first}`,
          );
          window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
        });
        document.querySelector("#main > div")!.append(opener);
      },
      { ids: nodes.map((node) => node.id), first: ID.svg },
    );
    await page.locator("#opener").focus();
    await page.keyboard.press("Enter");

    await expect(dialog(page)).toHaveAccessibleName("sample.svg");
    await expect(page).toHaveURL(new RegExp(`/preview/${ID.svg}$`));
    await expect(dialog(page).locator("[data-preview-meta]")).toContainText("1 of 3");
    // Focus is inside the dialog, and the opener's page is inert.
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.closest('[role="presentation"]') !== null))
      .toBe(true);
    await expect(page.locator('[data-background="kept"]')).toHaveAttribute("inert", "");

    await page.keyboard.press("ArrowRight");
    await expect(dialog(page)).toHaveAccessibleName("sample.html");
    await expect(page).toHaveURL(new RegExp(`/preview/${ID.html}$`));
    await page.keyboard.press("ArrowRight");
    await expect(dialog(page)).toHaveAccessibleName("sample.png");
    await expect(renderer(page, "image")).toBeVisible();
    // The last file: the key that leads nowhere does nothing.
    await page.keyboard.press("ArrowRight");
    await expect(page).toHaveURL(new RegExp(`/preview/${ID.png}$`));
    await page.keyboard.press("ArrowLeft");
    await expect(dialog(page)).toHaveAccessibleName("sample.html");

    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/shared$/);
    await expect(page.locator("#opener")).toBeFocused();
    // Prev/next replaced the entry: one step back was the page, and one forward is the preview.
    expect(await page.evaluate(() => (history.state as { idx?: number } | null)?.idx)).toBe(0);
    expectClean(arranged);
  });

  test("the close button, on a cold link, goes to the file's folder", async ({ page, origins }) => {
    await arrange(page, origins, [NODES.svg]);
    await open(page, ID.svg);
    await dialog(page).getByRole("button", { name: "Close preview" }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/folder/${ID.folder}$`));
  });

  test("the dialog has no accessibility violations (light): a preview, and a file without one", async ({
    page,
    origins,
  }) => {
    await arrange(page, origins, [NODES.png, NODES.svg]);
    await open(page, ID.png);
    await expect(renderer(page, "image").getByRole("img", { name: "sample.png" })).toBeVisible();
    await expectNoA11yViolations(page);
    await open(page, ID.svg);
    await expect(renderer(page, "none")).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("the PDF and text viewers have no accessibility violations (light)", async ({ page, origins }) => {
    await arrange(page, origins, [NODES.pdf, NODES.ts]);
    await open(page, ID.pdf);
    await expect(page.locator('[data-pdf-page="1"] .textLayer')).toContainText("page 1");
    await expectNoA11yViolations(page);
    await open(page, ID.ts);
    await expect(renderer(page, "text")).toHaveAttribute("data-highlighted", "true");
    await expectNoA11yViolations(page);
  });
});

test.describe("the dialog's error state (every /api request refused)", () => {
  test.beforeEach(() => {
    mockedOnly("the API's refusals are scripted");
  });

  test("404 for everything: the dialog says the file isn't here, with the request id — no page error", async ({
    page,
    origins,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockShell(page, origins.port);
    await open(page, "node-1");
    await expect(page.locator('[data-preview-state="error"]')).toBeVisible();
    await expect(dialog(page).getByRole("heading", { name: "This file isn't here" })).toBeVisible();
    await expect(dialog(page)).toContainText("req req-e2e");
    await expect(page.locator("[data-preview-renderer]")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    expect(errors).toEqual([]);
  });

  test("500 for everything: the dialog's error state, Try again asks again — no page error", async ({
    page,
    origins,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let asked = 0;
    await mockShell(page, origins.port, {
      api: async (route, path) => {
        if (!path.startsWith("/api/nodes")) return false;
        asked += 1;
        await route.fulfill({ status: 500, json: mockEnvelope("internal", "Something went wrong.") });
        return true;
      },
    });
    await open(page, "node-1");
    await expect(page.locator('[data-preview-state="error"]')).toBeVisible();
    await expect(dialog(page).getByRole("heading", { name: "Couldn't open this preview" })).toBeVisible();
    await expect(dialog(page)).toContainText("req req-e2e");
    const before = asked;
    await dialog(page).getByRole("button", { name: "Try again" }).click();
    await expect.poll(() => asked).toBeGreaterThan(before);
    await expect(page.locator('[data-preview-state="error"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});
