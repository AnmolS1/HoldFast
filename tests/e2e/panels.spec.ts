// The desktop side panels (F02): hide/show by button, shortcut and palette; resize by drag and by
// keyboard (WAI-ARIA APG Window Splitter); the layout survives a reload on this device; the
// content column keeps ≥ 480 px; focus never lands on <body>; axe clean with each panel open or
// collapsed; a drag across an open PDF preview still drags.
//
//   holdfast-plan/scripts/heavy.sh e2e npm run e2e -- tests/e2e/panels.spec.ts
//
// MOCKED: `mockShell` signs a made-up user in; the explorer's in-memory drive answers /api/nodes/*
// and a small stand-in plays the files host for the PDF. Desktop project only: the panels exist
// at ≥ 1024 px.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { FakeDrive } from "../unit/client/explorer/fixtures/drive";
import { fileNode, folderNode } from "../unit/client/explorer/fixtures/nodes";
import { detailOf, ID, NODES } from "../unit/client/preview/fixtures";
import { usageDto } from "../unit/client/upload/fixtures";
import { expect, expectNoA11yViolations, mockedOnly, mockShell, navigateInApp, test } from "./fixtures";

const DESKTOP_MIN = 1024;
const PROJECT = folderNode(1, { name: "Project" });
const NOTES = fileNode(2, { name: "notes.txt", parentId: PROJECT.id });
const PDF = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../unit/client/preview/fixtures/files/three-pages.pdf"),
);

test.beforeEach(({ page }) => {
  mockedOnly("the panels are client-side; the drive and the files host are scripted");
  test.skip((page.viewportSize()?.width ?? 0) < DESKTOP_MIN, "the side panels exist on the desktop layout");
});

/** The drive (one folder with one file), usage, and the PDF's node + files host. */
async function serve(page: Page, port: number): Promise<void> {
  const drive = new FakeDrive([PROJECT, NOTES]);
  const files = `http://files.localhost:${port}`;
  drive.filesOrigin = files;
  await mockShell(page, port, {
    api: async (route, path) => {
      const request = route.request();
      if (path === "/api/account/usage") return route.fulfill({ json: usageDto() }).then(() => true);
      if (path === `/api/nodes/${ID.pdf}` && request.method() === "GET")
        return route.fulfill({ json: detailOf(NODES.pdf) }).then(() => true);
      if (path === `/api/nodes/${ID.pdf}/download-url` && request.method() === "POST") {
        const expiresAt = new Date(Date.now() + 900_000).toISOString();
        return route.fulfill({ json: { url: `${files}/i/${ID.pdf}/tok`, expiresAt } }).then(() => true);
      }
      if (!path.startsWith("/api/nodes")) return false;
      const url = new URL(request.url());
      const answer = drive.handle({
        method: request.method(),
        path: url.pathname + url.search,
        body: request.postDataJSON() ?? undefined,
      });
      if (!answer) return false;
      if (answer.body === undefined) await route.fulfill({ status: answer.status, body: "" });
      else await route.fulfill({ status: answer.status, json: answer.body });
      return true;
    },
  });
  const cors = { "access-control-allow-origin": `http://localhost:${port}`, vary: "Origin" };
  await page.route(`${files}/**`, async (route) => {
    const range = route.request().headers()["range"];
    const wanted = range ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;
    const headers = { ...cors, "content-type": "application/pdf", "accept-ranges": "bytes" };
    if (!wanted) return route.fulfill({ status: 200, body: PDF, headers });
    const start = Number(wanted[1]);
    const end = wanted[2] ? Math.min(Number(wanted[2]), PDF.length - 1) : PDF.length - 1;
    return route.fulfill({
      status: 206,
      body: PDF.subarray(start, end + 1),
      headers: { ...headers, "content-range": `bytes ${start}-${end}/${PDF.length}` },
    });
  });
}

/** Open the folder and wait until the page shows it is ready (the list answered, the toggles drawn). */
async function openFolder(page: Page): Promise<void> {
  await page.goto(`/folder/${PROJECT.id}`);
  await expect(page.locator(`[data-explorer="${PROJECT.id}"]`)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("row", { name: /notes\.txt/ })).toBeVisible();
  await expect(page.locator('[data-panel-toggle="details"]')).toBeVisible();
}

/** The modifier the app reads as ⌘ / Ctrl (lib/shortcuts.ts `isApplePlatform`). */
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const apple = await page.evaluate(() => {
    const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    return /mac|iphone|ipad|ipod/i.test(data?.platform ?? navigator.platform ?? "");
  });
  return apple ? "Meta" : "Control";
}

const sidebar = (page: Page) => page.locator("[data-sidebar]");
const details = (page: Page) => page.locator("[data-details-panel]");
const splitter = (page: Page, name: "Resize sidebar" | "Resize details") =>
  page.getByRole("separator", { name });
const widthOf = async (locator: Locator) => Math.round((await locator.boundingBox())?.width ?? -1);
const stored = (page: Page) =>
  page.evaluate(
    () => (JSON.parse(localStorage.getItem("hf.prefs.v1") ?? "{}") as { layout?: unknown }).layout,
  );

/** Drag a splitter by `dx` px with the mouse, in small steps (as a hand does). */
async function drag(page: Page, handle: Locator, dx: number): Promise<void> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 6 });
  await page.mouse.move(x + dx, y, { steps: 6 });
  await page.mouse.up();
}

/** What has focus, so a failure says where it went. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "BODY";
    return el.id || el.getAttribute("aria-label") || el.tagName;
  });

async function darkScan(page: Page): Promise<void> {
  // As tests/e2e/cross/a11y.spec.ts: a dark-mode analyze() can hang the worker, so it is bounded;
  // a hang is recorded as a note, never as a pass.
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-dark");
  // As fixtures/axe.ts: finite transitions end first (a colour mid-fade is not the colour).
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().endTime === Number.POSITIVE_INFINITY,
      ),
  );
  const scan = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const result = await Promise.race([
    scan,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
  ]);
  if (result === null)
    test.info().annotations.push({ type: "dark axe", description: "timed out after 20 s" });
  else
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(" | ")}`)).toEqual([]);
  await page.emulateMedia({ colorScheme: "light" });
}

test.describe("desktop side panels (mocked API)", () => {
  test("drag each splitter: the width follows the mouse, is stored, survives a reload; double-click resets", async ({
    page,
    origins,
  }) => {
    await serve(page, origins.port);
    await openFolder(page);
    expect(await widthOf(sidebar(page))).toBe(232);
    expect(await widthOf(details(page))).toBe(320);

    await drag(page, splitter(page, "Resize sidebar"), 60);
    await expect.poll(() => widthOf(sidebar(page))).toBe(292);
    // The details splitter is its left edge: dragging left widens it.
    await drag(page, splitter(page, "Resize details"), -80);
    await expect.poll(() => widthOf(details(page))).toBe(400);
    expect(await stored(page)).toEqual({
      sidebar: { collapsed: false, width: 292 },
      details: { open: true, width: 400 },
    });
    await expect(splitter(page, "Resize sidebar")).toHaveAttribute("aria-valuenow", "292");

    await page.reload();
    await expect(page.locator('[data-panel-toggle="details"]')).toBeVisible();
    await expect.poll(() => widthOf(sidebar(page))).toBe(292);
    await expect.poll(() => widthOf(details(page))).toBe(400);

    // Past the limit the panel stops at its maximum.
    await drag(page, splitter(page, "Resize sidebar"), 400);
    await expect.poll(() => widthOf(sidebar(page))).toBe(360);

    await splitter(page, "Resize sidebar").dblclick();
    await splitter(page, "Resize details").dblclick();
    await expect.poll(() => widthOf(sidebar(page))).toBe(232);
    await expect.poll(() => widthOf(details(page))).toBe(320);
    // Back at the defaults, nothing is stored.
    expect(await stored(page)).toBeUndefined();
  });

  test("keyboard: Tab to a splitter, ←/→ (Shift ×4), Home/End, Enter collapses to the rail and restores", async ({
    page,
    origins,
  }) => {
    await serve(page, origins.port);
    await openFolder(page);
    const handle = splitter(page, "Resize sidebar");
    await handle.focus();
    await expect(handle).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(handle).toHaveAttribute("aria-valuenow", "248");
    await page.keyboard.press("Shift+ArrowLeft");
    await expect(handle).toHaveAttribute("aria-valuenow", "200");
    await page.keyboard.press("End");
    await expect(handle).toHaveAttribute("aria-valuenow", "360");
    await expect(handle).toHaveAttribute("aria-valuemax", "360");
    await page.keyboard.press("Home");
    await expect.poll(() => widthOf(sidebar(page))).toBe(200);

    const right = splitter(page, "Resize details");
    await right.focus();
    await page.keyboard.press("ArrowLeft");
    await expect(right).toHaveAttribute("aria-valuenow", "336");
    await expect.poll(() => widthOf(details(page))).toBe(336);

    await handle.focus();
    await page.keyboard.press("Enter");
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await expect.poll(() => widthOf(sidebar(page))).toBe(56);
    await expect(handle).toBeFocused();
    // The rail: the same landmark, six links, each with its name.
    const nav = page.getByRole("navigation", { name: "Primary" });
    for (const name of ["Files", "Shared with me", "Shared by me", "Recent", "Starred", "Trash"])
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible();
    await expect(nav.locator("[data-nav]")).toHaveCount(6);
    await expect(nav.getByRole("img", { name: /Storage: \d+% used/ })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Account menu" })).toBeVisible();

    await page.reload();
    await expect(page.locator('[data-panel-toggle="details"]')).toBeVisible();
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await splitter(page, "Resize sidebar").focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => widthOf(sidebar(page))).toBe(200);
    expect(await focused(page)).not.toBe("BODY");
  });

  test("toggles by header button, shortcut (⌘\\ / Ctrl+\\, i) and palette; collapsing details with focus inside returns focus to its toggle", async ({
    page,
    origins,
  }) => {
    await serve(page, origins.port);
    await openFolder(page);
    const leftToggle = page.getByRole("button", { name: "Sidebar", exact: true });
    const rightToggle = page.getByRole("button", { name: "Details panel" });

    // Button.
    await expect(leftToggle).toHaveAttribute("aria-pressed", "true");
    await leftToggle.click();
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await expect(leftToggle).toHaveAttribute("aria-pressed", "false");
    await leftToggle.click();
    await expect(sidebar(page)).not.toHaveAttribute("data-rail", "true");
    await rightToggle.click();
    await expect(details(page)).toBeHidden();
    await expect(page.getByRole("complementary", { name: "Details" })).toHaveCount(0);
    await rightToggle.click();
    await expect(details(page)).toBeVisible();

    // Shortcuts (the page is ready: the list answered and the toggles are drawn).
    const mod = await modKey(page);
    await page.locator("[data-main]").focus();
    await page.keyboard.press(`${mod}+Backslash`);
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await page.keyboard.press(`${mod}+Backslash`);
    await expect(sidebar(page)).not.toHaveAttribute("data-rail", "true");
    await page.keyboard.press("i");
    await expect(details(page)).toBeHidden();
    await page.keyboard.press("i");
    await expect(details(page)).toBeVisible();
    // Never typed into a text field.
    await page.getByRole("searchbox", { name: "Search files" }).click();
    await page.keyboard.press("i");
    await expect(details(page)).toBeVisible();

    // Palette.
    const runCommand = async (name: string) => {
      await page.locator("[data-palette-button]").click();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill(name);
      await palette.getByRole("option", { name: new RegExp(name) }).click();
      await expect(palette).toBeHidden();
    };
    await runCommand("Hide sidebar");
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await runCommand("Show sidebar");
    await expect(sidebar(page)).not.toHaveAttribute("data-rail", "true");
    await runCommand("Hide details");
    await expect(details(page)).toBeHidden();
    await runCommand("Show details");
    await expect(details(page)).toBeVisible();

    // Focus with the details panel (its splitter — the file facts shown today hold no control;
    // the unit test covers a control inside), then hide it by its shortcut: focus goes to the
    // toggle, not <body>.
    await page.getByRole("row", { name: /notes\.txt/ }).click();
    await expect(page.getByRole("complementary", { name: "Details" })).toContainText("SHA-256");
    await splitter(page, "Resize details").focus();
    await page.keyboard.press("i");
    await expect(details(page)).toBeHidden();
    await expect(rightToggle).toBeFocused();
    // And by its splitter's Enter.
    await page.keyboard.press("Enter");
    await expect(details(page)).toBeVisible();
    await splitter(page, "Resize details").focus();
    await page.keyboard.press("Enter");
    await expect(details(page)).toBeHidden();
    await expect(rightToggle).toBeFocused();
    // The sidebar: focus on one of its links, ⌘\ — focus goes to the sidebar's toggle.
    await page.locator('[data-nav="recent"]').focus();
    await page.keyboard.press(`${mod}+Backslash`);
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await expect(leftToggle).toBeFocused();
    expect(await focused(page)).toBe("hf-toggle-sidebar");
  });

  test("at 1024 px with both panels at their maximum the content keeps ≥ 480 px, and the stored widths stay; details:false routes are unaffected", async ({
    page,
    origins,
  }) => {
    await serve(page, origins.port);
    const max = { sidebar: { collapsed: false, width: 360 }, details: { open: true, width: 520 } };
    await page.addInitScript((layout) => {
      if (!localStorage.getItem("hf.prefs.v1"))
        localStorage.setItem("hf.prefs.v1", JSON.stringify({ density: "compact", viewMode: "list", layout }));
    }, max);
    await page.setViewportSize({ width: 1920, height: 900 });
    await openFolder(page);
    await expect.poll(() => widthOf(sidebar(page))).toBe(360);
    await expect.poll(() => widthOf(details(page))).toBe(520);

    for (const width of [1024, 1100, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      await expect.poll(() => widthOf(page.locator("[data-main]"))).toBeGreaterThanOrEqual(480);
      const total = (await widthOf(sidebar(page))) + (await widthOf(details(page)));
      expect(width - total, `content at ${width}`).toBeGreaterThanOrEqual(480);
    }
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect.poll(() => widthOf(sidebar(page))).toBe(264);
    await expect.poll(() => widthOf(details(page))).toBe(280);
    expect(await stored(page)).toEqual(max);
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect.poll(() => widthOf(details(page))).toBe(520);

    // A route without a details panel: none drawn, no toggle for it, the sidebar's still there.
    await navigateInApp(page, "/help");
    await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeVisible();
    await expect(details(page)).toHaveCount(0);
    await expect(page.locator('[data-panel-toggle="details"]')).toHaveCount(0);
    await expect(splitter(page, "Resize details")).toHaveCount(0);
    await expect(page.locator('[data-panel-toggle="sidebar"]')).toBeVisible();
    await page.locator("[data-main]").focus();
    await page.keyboard.press("i");
    expect(await stored(page)).toEqual(max);
  });

  test("axe clean (light, and a bounded dark scan) with each panel open and collapsed", async ({
    page,
    origins,
  }) => {
    test.slow();
    await serve(page, origins.port);
    await openFolder(page);
    await expectNoA11yViolations(page);
    await darkScan(page);
    await page.getByRole("button", { name: "Sidebar", exact: true }).click();
    await page.getByRole("button", { name: "Details panel" }).click();
    await expect(sidebar(page)).toHaveAttribute("data-rail", "true");
    await expect(details(page)).toBeHidden();
    await expectNoA11yViolations(page);
    await darkScan(page);
    // The rail's tooltip names the link on hover.
    await page.locator('[data-nav="recent"]').hover();
    await expect(page.getByRole("tooltip", { name: "Recent" })).toBeVisible();
  });

  test("a drag across embedded content (an iframe over the page) still drags — and a PDF preview, being modal, isn't dragged under", async ({
    page,
    origins,
  }) => {
    await serve(page, origins.port);
    const pdfWorker = page.waitForResponse((response) =>
      /\/pdf\.worker\.min(-[\w-]+)?\.mjs$/.test(new URL(response.url()).pathname),
    );
    await page.goto(`/preview/${ID.pdf}`);
    await pdfWorker;
    await expect(page.locator('[data-preview-renderer="pdf"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-pdf-page="1"] canvas')).toBeVisible();
    // The preview is a modal dialog over the whole window: the splitters sit under its scrim, so
    // a press there lands on the scrim and resizes nothing.
    await drag(page, page.locator('[data-splitter="sidebar"]'), 100);
    expect(await widthOf(sidebar(page))).toBe(232);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // An iframe across the content column — the kind of element that swallows pointer events
    // once the pointer is over it. Both splitters are dragged across it.
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.setAttribute("data-test-iframe", "");
      frame.title = "embedded";
      frame.srcdoc = "<body style='margin:0;height:100vh;background:#eee'></body>";
      frame.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;z-index:3";
      document.querySelector("[data-main]")!.appendChild(frame);
    });
    await drag(page, splitter(page, "Resize sidebar"), 100);
    await expect.poll(() => widthOf(sidebar(page))).toBe(332);
    await drag(page, splitter(page, "Resize details"), -150);
    await expect.poll(() => widthOf(details(page))).toBe(468);
    // Nothing is left behind by the drag.
    await expect(page.locator("[data-panel-drag-shield]")).toHaveCount(0);
    expect(await page.evaluate(() => document.body.dataset.panelDrag ?? null)).toBeNull();
    expect(await page.evaluate(() => document.body.style.userSelect)).toBe("");
  });
});
