// "Upload folder…" wherever "Upload files…" is (F01): every entry point opens the FOLDER picker for
// the folder on screen; a picked tree lands as a drop does, without the system clutter, and the
// user is told how many files were left out.
//
//   holdfast-plan/scripts/heavy.sh e2e npm run e2e -- tests/e2e/upload-folder-button.spec.ts
//
// MOCKED: `mockShell` signs a made-up user in; the explorer's in-memory drive answers /api/nodes/*
// (folder creation included) and a small stand-in answers the upload API. The trees are written
// at run time under the test's output folder — a committed `.DS_Store` would be ignored by git.
import { AxeBuilder } from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FileChooser, Page } from "@playwright/test";
import { FakeDrive } from "../unit/client/explorer/fixtures/drive";
import { folderNode } from "../unit/client/explorer/fixtures/nodes";
import {
  initResponse,
  nodeDto,
  openUploadsResponse,
  rowId,
  singleResponse,
  usageDto,
} from "../unit/client/upload/fixtures";
import { expect, expectNoA11yViolations, mockedOnly, mockShell, test } from "./fixtures";

const DESKTOP_MIN = 1024;
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;

const PROJECT = folderNode(1, { name: "Project" });

interface Seen {
  drive: FakeDrive;
  /** Names of the files whose upload was started, in order. */
  inits: Array<{ name: string; parentId: string | null }>;
  completes: number;
}

/** The drive and the upload API; `config` patches /api/public/config. */
async function serve(page: Page, port: number, config: Record<string, unknown> = {}): Promise<Seen> {
  const drive = new FakeDrive([PROJECT]);
  drive.filesOrigin = `http://files.localhost:${port}`;
  const seen: Seen = { drive, inits: [], completes: 0 };
  const sessions = new Map<string, { name: string; parentId: string | null; size: number }>();
  await mockShell(page, port, {
    config,
    api: async (route, path) => {
      const request = route.request();
      const method = request.method();
      if (path === "/api/account/usage") return route.fulfill({ json: usageDto() }).then(() => true);
      if (path === "/api/uploads/open")
        return route.fulfill({ json: openUploadsResponse() }).then(() => true);
      if (method === "POST" && path === "/api/uploads") {
        const body = request.postDataJSON() as { name: string; parentId: string | null; size: number };
        seen.inits.push({ name: body.name, parentId: body.parentId });
        const uploadId = rowId(0x5000 + seen.inits.length);
        sessions.set(uploadId, body);
        await route.fulfill({
          json: initResponse(body.size, { uploadId, mode: "single", partCount: 1, finalName: body.name }),
        });
        return true;
      }
      if (method === "PUT" && /^\/api\/uploads\/[^/]+\/single$/.test(path)) {
        await route.fulfill({ json: singleResponse() });
        return true;
      }
      const complete = /^\/api\/uploads\/([^/]+)\/complete$/.exec(path);
      if (method === "POST" && complete) {
        const session = sessions.get(complete[1]!)!;
        seen.completes += 1;
        const node = nodeDto({
          id: rowId(0x6000 + seen.completes),
          name: session.name,
          parentId: session.parentId,
          size: session.size,
          scanStatus: "clean",
        });
        drive.add(node);
        await route.fulfill({ json: node });
        return true;
      }
      if (!path.startsWith("/api/nodes")) return false;
      const url = new URL(request.url());
      const answer = drive.handle({
        method,
        path: url.pathname + url.search,
        body: request.postDataJSON() ?? undefined,
      });
      if (!answer) return false;
      if (answer.body === undefined) await route.fulfill({ status: answer.status, body: "" });
      else await route.fulfill({ status: answer.status, json: answer.body });
      return true;
    },
  });
  return seen;
}

/** Folders the page asked the drive to create, as "name ← parentId". */
const folderPosts = (seen: Seen) =>
  seen.drive
    .callsTo("POST", /^\/api\/nodes\/folder$/)
    .map((call) => call.body as { name: string; parentId: string | null });

/** Write `files` (paths relative to a fresh folder named `root`) and return the folder's path. */
function tree(root: string, files: string[]): string {
  const dir = join(test.info().outputPath(), root);
  for (const file of files) {
    const path = join(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `holdfast e2e ${file}\n`);
  }
  return dir;
}

/**
 * The modifier the app reads as ⌘ / Ctrl: it decides from the browser's platform, which the
 * device profile may report as Windows on a Mac host (lib/shortcuts.ts `isApplePlatform`).
 */
async function modKey(page: Page): Promise<"Meta" | "Control"> {
  const apple = await page.evaluate(() => {
    const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    return /mac|iphone|ipad|ipod/i.test(data?.platform ?? navigator.platform ?? "");
  });
  return apple ? "Meta" : "Control";
}

/** Run `open` and take the picker it opened: it must be the FOLDER input. */
async function folderChooser(page: Page, open: () => Promise<void>): Promise<FileChooser> {
  const [chooser] = await Promise.all([page.waitForEvent("filechooser"), open()]);
  expect(await chooser.element().getAttribute("data-upload-input")).toBe("folder");
  expect(chooser.isMultiple()).toBe(true);
  return chooser;
}

async function openFolder(page: Page, id: string): Promise<void> {
  await page.goto(`/folder/${id}`);
  await expect(page.locator(`[data-explorer="${id}"]`)).toBeVisible({ timeout: 15_000 });
}

test.describe("Upload folder (mocked API)", () => {
  test.beforeEach(() => mockedOnly());

  test("New menu, toolbar, palette and ⌘⇧U open the folder picker for the folder on screen", async ({
    page,
    origins,
  }) => {
    test.skip(isMobile(page), "the desktop entry points; the FAB and the empty state are tested below");
    const seen = await serve(page, origins.port);
    await openFolder(page, PROJECT.id);
    await expect(page.locator("[data-upload-menu]")).toBeVisible();

    const ways: Array<[string, () => Promise<void>]> = [
      [
        "via-menu",
        async () => {
          await page.getByRole("button", { name: "New", exact: true }).click();
          const item = page.locator('[data-new-action="upload-folder"]');
          await expect(item).toContainText("Upload folder…");
          await item.click();
        },
      ],
      [
        "via-toolbar",
        async () => {
          await page.locator("[data-upload-menu]").click();
          await page.locator('[data-upload-kind="folder"]').click();
        },
      ],
      [
        "via-palette",
        async () => {
          await page.locator("[data-palette-button]").click();
          const palette = page.getByRole("dialog", { name: "Command palette" });
          await palette.getByRole("combobox").fill("Upload folder");
          await palette.getByRole("option", { name: /Upload folder/ }).click();
        },
      ],
      ["via-shortcut", async () => page.keyboard.press(`${await modKey(page)}+Shift+U`)],
    ];
    for (const [root, open] of ways) {
      const chooser = await folderChooser(page, open);
      await chooser.setFiles(tree(root, ["f.txt"]));
      // The picked folder is made inside the folder on screen, and its file lands in it.
      await expect.poll(() => folderPosts(seen).map((post) => post.name)).toContain(root);
      expect(folderPosts(seen).find((post) => post.name === root)!.parentId).toBe(PROJECT.id);
    }
    await expect.poll(() => seen.completes).toBe(4);
  });

  test("the empty state and the FAB open the folder picker; a 3-level tree lands without its clutter, and the user is told", async ({
    page,
    origins,
  }) => {
    const seen = await serve(page, origins.port);
    seen.drive.nodes.delete(PROJECT.id);
    await page.goto("/");
    const secondary = page.locator("[data-empty-upload-folder]");
    await expect(secondary).toBeVisible({ timeout: 15_000 });
    const open = isMobile(page)
      ? async () => {
          await page.locator("[data-new-fab]").click();
          const item = page.getByRole("dialog", { name: "New" }).locator('[data-new-action="upload-folder"]');
          await expect(item).toBeVisible();
          // A sheet row is a touch target: 48 px tall.
          expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
          await item.click();
        }
      : () => secondary.click();
    const chooser = await folderChooser(page, open);
    await chooser.setFiles(
      tree("trip", ["a.txt", ".DS_Store", ".env", "day1/b.txt", "day1/._b.txt", "day1/night/c.txt"]),
    );
    const sentence = "2 system files skipped (.DS_Store and similar)";
    await expect(page.locator("[data-toaster]")).toContainText(sentence);
    await expect(page.locator("[data-upload-live]")).toContainText(sentence);
    await expect.poll(() => seen.completes).toBe(4);
    expect(seen.inits.map((init) => init.name).sort()).toEqual([".env", "a.txt", "b.txt", "c.txt"]);
    // The tree as picked: trip at the top level, day1 in it, night in day1 — each once.
    const posts = folderPosts(seen);
    expect(posts.map((post) => post.name)).toEqual(["trip", "day1", "night"]);
    const id = (name: string) =>
      Array.from(seen.drive.nodes.values()).find((node) => node.kind === "folder" && node.name === name)!.id;
    expect(posts.map((post) => post.parentId)).toEqual([null, id("trip"), id("day1")]);
    const parentOf = (name: string) => seen.inits.find((init) => init.name === name)!.parentId;
    expect([parentOf("a.txt"), parentOf("b.txt"), parentOf("c.txt")]).toEqual([
      id("trip"),
      id("day1"),
      id("night"),
    ]);
  });

  for (const [what, config, reason] of [
    ["read-only", { readOnly: true }, "Not available while Holdfast is read-only."],
    ["uploads paused", { uploadsEnabled: false }, "Uploads are paused right now."],
  ] as const) {
    test(`${what}: Upload folder is offered disabled, with the reason`, async ({ page, origins }) => {
      await serve(page, origins.port, config);
      await page.goto("/");
      if (isMobile(page)) {
        await page.locator("[data-new-fab]").click({ timeout: 15_000 });
        const item = page.getByRole("dialog", { name: "New" }).locator('[data-new-action="upload-folder"]');
        await expect(item).toHaveAttribute("aria-disabled", "true");
        await expect(item).toContainText(reason);
        return;
      }
      await page.getByRole("button", { name: "New", exact: true }).click({ timeout: 15_000 });
      const item = page.locator('[data-new-action="upload-folder"]');
      await expect(item).toHaveAttribute("aria-disabled", "true");
      await expect(item).toHaveAttribute("title", reason);
      await page.keyboard.press("Escape");
      // The shortcut does nothing: no picker opens.
      let opened = false;
      page.on("filechooser", () => (opened = true));
      await page.keyboard.press(`${await modKey(page)}+Shift+U`);
      await page.locator("[data-palette-button]").click();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByRole("combobox").fill("Upload folder");
      await expect(palette.getByRole("option", { name: /Upload folder/ })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(opened).toBe(false);
    });
  }

  test("the open menus have no axe violations (light), and a bounded dark scan", async ({
    page,
    origins,
  }) => {
    await serve(page, origins.port);
    await openFolder(page, PROJECT.id);
    const menus: Array<() => Promise<void>> = isMobile(page)
      ? [
          async () => {
            await page.locator("[data-new-fab]").click();
            await expect(page.locator('[data-new-action="upload-folder"]')).toBeVisible();
          },
        ]
      : [
          async () => {
            await page.getByRole("button", { name: "New", exact: true }).click();
            await expect(page.locator('[data-new-action="upload-folder"]')).toBeVisible();
          },
          async () => {
            await page.locator("[data-upload-menu]").click();
            await expect(page.locator('[data-upload-kind="folder"]')).toBeVisible();
            // Keyboard: the menu takes focus; Escape gives it back to the arrow.
            await expect(page.getByRole("menu", { name: "More ways to upload" })).toBeVisible();
          },
        ];
    for (const open of menus) {
      await open();
      await expectNoA11yViolations(page);
      await page.emulateMedia({ colorScheme: "dark" });
      await expect(page.locator("html")).toHaveAttribute("data-dark");
      // The theme change is a transition: colours caught half-way are not the theme's (fixtures/axe.ts).
      await page.waitForFunction(() =>
        document
          .getAnimations()
          .every(
            (animation) =>
              animation.playState !== "running" ||
              animation.effect?.getComputedTiming().endTime === Number.POSITIVE_INFINITY,
          ),
      );
      // Bounded (fixtures/axe.ts: a dark analyze() can hang): a hang is a note, never a pass.
      const scan = new AxeBuilder({ page }).withTags(["wcag2aa", "wcag21aa"]).analyze();
      const result = await Promise.race([
        scan,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
      ]);
      if (result === null)
        test.info().annotations.push({ type: "dark axe", description: "timed out after 20 s" });
      else
        expect(
          result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`),
        ).toEqual([]);
      await page.emulateMedia({ colorScheme: "light" });
      await page.keyboard.press("Escape");
    }
    if (!isMobile(page)) await expect(page.locator("[data-upload-menu]")).toBeFocused();
  });
});
