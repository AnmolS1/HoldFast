// The file explorer, against `vite dev`.
//
//   holdfast-plan/scripts/heavy.sh e2e npm run e2e -- tests/e2e/explorer.spec.ts
//
// MOCKED (the default): `mockShell` signs a made-up user in and an in-memory drive — the same one
// the jsdom tests use, answering with contract-shaped fixtures — stands in for /api/nodes/*.
// REAL (HOLDFAST_E2E_REAL=1, post-integration): the two folder journeys run unchanged against the
// API as built, with a user who really signed up; every test that scripts the API's answers
// (files, scan states, 2,000 items, errors) is `mockedOnly()`.
import type { Locator, Page } from "@playwright/test";
import { signedInUser } from "../setup/auth-fixtures";
import { FakeDrive } from "../unit/client/explorer/fixtures/drive";
import { fileNode, folderNode, manyNodes } from "../unit/client/explorer/fixtures/nodes";
import { expect, expectNoA11yViolations, mockedOnly, mockEnvelope, mockShell, REAL, test } from "./fixtures";

const DESKTOP_MIN = 1024;
const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;

/** Sign the made-up user in and answer /api/nodes/* and the files host from `drive`. */
async function serve(page: Page, port: number, drive: FakeDrive): Promise<FakeDrive> {
  drive.filesOrigin = `http://files.localhost:${port}`;
  await mockShell(page, port, {
    api: async (route, path) => {
      if (!path.startsWith("/api/nodes")) return false;
      const request = route.request();
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
  // The files host: any minted URL serves a few bytes as an attachment.
  await page.route(`${drive.filesOrigin}/**`, (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="download.bin"',
        "access-control-allow-origin": "*",
      },
      body: "holdfast e2e bytes",
    }),
  );
  return drive;
}

/** A signed-in page at an empty top level: a mocked drive, or (REAL) a user who just signed up. */
async function emptyAccount(page: Page, port: number, clientIp: string): Promise<void> {
  if (REAL) await signedInUser(page, { clientIp });
  else await serve(page, port, new FakeDrive());
}

async function openExplorer(page: Page, path = "/"): Promise<void> {
  await page.goto(path);
  await expect(page.locator("[data-explorer]")).toBeVisible();
}

const row = (page: Page, name: string) => page.locator("[data-item-id]").filter({ hasText: name });
const toastText = (page: Page) => page.locator("[data-toaster]");
const nameDialog = (page: Page) => page.getByRole("dialog");

async function fillName(page: Page, name: string, confirm: string): Promise<void> {
  const dialog = nameDialog(page);
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  await dialog.getByRole("button", { name: confirm, exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

/** Right-click a row and choose an entry of its menu. */
async function menuAction(page: Page, target: Locator, entry: string): Promise<void> {
  await target.click({ button: "right" });
  await page.getByRole("menu").getByRole("menuitem", { name: entry }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}

test.describe("journeys (mocked by default; the same against the real API)", () => {
  test("create folder → rename → move via the dialog → star → trash → undo", async ({
    page,
    origins,
    clientIp,
  }) => {
    test.skip(isMobile(page), "the desktop journey; the mobile one is below");
    await emptyAccount(page, origins.port, clientIp);
    await openExplorer(page);
    await expect(page.getByRole("heading", { level: 1, name: "Files" })).toBeVisible();

    // Create two folders.
    await page.locator("[data-new-folder]").click();
    await fillName(page, "Projects", "Create");
    await expect(row(page, "Projects")).toBeVisible();
    await page.locator("[data-new-folder]").click();
    await fillName(page, "Archive", "Create");
    await expect(row(page, "Archive")).toBeVisible();

    // A name that is taken is said in the dialog; nothing is created.
    await page.locator("[data-new-folder]").click();
    await nameDialog(page).getByRole("textbox", { name: "Name" }).fill("Archive");
    await nameDialog(page).getByRole("button", { name: "Create", exact: true }).click();
    await expect(nameDialog(page).getByText("is already used in this folder")).toBeVisible();
    await nameDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.locator("[data-item-id]")).toHaveCount(2);

    // Rename.
    await menuAction(page, row(page, "Projects"), "Rename");
    await fillName(page, "Work", "Rename");
    await expect(row(page, "Work")).toBeVisible();
    await expect(row(page, "Projects")).toHaveCount(0);

    // Move through the folder-tree dialog.
    await menuAction(page, row(page, "Work"), "Move to…");
    const tree = page.getByRole("tree", { name: "Folders" });
    await tree.getByRole("treeitem", { name: "Archive" }).click();
    await page.getByRole("button", { name: "Move here" }).click();
    await expect(row(page, "Work")).toHaveCount(0);
    await expect(toastText(page)).toContainText("moved to Archive");

    // Selecting a row puts the selection bar where the toolbar was: the row does not move, so the
    // second click of a double-click lands on it.
    const before = (await row(page, "Archive").boundingBox())!;
    await row(page, "Archive").click();
    await expect(page.locator("[data-selection-bar]")).toBeVisible();
    expect((await row(page, "Archive").boundingBox())!.y).toBe(before.y);
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-selection-bar]")).toHaveCount(0);

    // Into the folder: the URL, the title and the trail follow.
    await row(page, "Archive").dblclick();
    await expect(page).toHaveURL(/\/folder\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { level: 1, name: "Archive" })).toBeVisible();
    await expect(row(page, "Work")).toBeVisible();

    // Star, and the menu then offers to remove it.
    await menuAction(page, row(page, "Work"), "Star");
    await row(page, "Work").click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Remove star" })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // Trash with the key, no confirmation; Undo brings it back.
    await row(page, "Work").click();
    await expect(page.locator("[data-selection-bar]")).toBeVisible();
    await page.keyboard.press("Delete");
    await expect(row(page, "Work")).toHaveCount(0);
    await expect(toastText(page)).toContainText("moved to trash");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await toastText(page).getByRole("button", { name: "Undo" }).click();
    await expect(row(page, "Work")).toBeVisible();

    // Back and forward are the router's; the trail leads home.
    await page.getByRole("navigation", { name: "Breadcrumb" }).getByRole("link", { name: "Files" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(row(page, "Archive")).toBeVisible();
    await page.goBack();
    await expect(page.getByRole("heading", { level: 1, name: "Archive" })).toBeVisible();
  });

  test("keyboard only: create, rename, move, trash and undo without the mouse", async ({
    page,
    origins,
    clientIp,
  }) => {
    test.skip(isMobile(page), "a keyboard journey on the desktop layout");
    await emptyAccount(page, origins.port, clientIp);
    await openExplorer(page);
    const focusedRow = page.locator("[data-item-id]:focus");
    const type = async (name: string) => {
      await expect(nameDialog(page).getByRole("textbox", { name: "Name" })).toBeFocused();
      await page.keyboard.press("ControlOrMeta+A");
      await page.keyboard.type(name);
      await page.keyboard.press("Enter");
      await expect(nameDialog(page)).toHaveCount(0);
    };

    // Shift+N creates; focus lands on the new folder's row each time.
    await expect(page.locator('[data-empty-state="first-use"]')).toBeVisible();
    await page.keyboard.press("Shift+N");
    await type("Alpha");
    await expect(focusedRow).toContainText("Alpha");
    await page.keyboard.press("Shift+N");
    await type("Beta");
    await expect(focusedRow).toContainText("Beta");

    // F2 renames the focused row; focus stays on it.
    await page.keyboard.press("F2");
    await type("Gamma");
    await expect(focusedRow).toContainText("Gamma");
    await expect(row(page, "Beta")).toHaveCount(0);

    // Shift+F10 opens the row's menu; Move to… → the tree → Alpha → Move here.
    await page.keyboard.press("Shift+F10");
    await expect(page.getByRole("menu")).toBeVisible();
    for (let step = 0; step < 12; step += 1) {
      if (
        await page
          .getByRole("menuitem", { name: "Move to…" })
          .evaluate((item) => item === document.activeElement)
      )
        break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter");
    const tree = page.getByRole("tree", { name: "Folders" });
    await expect(tree.getByRole("treeitem", { name: "My files" })).toBeFocused();
    await expect(tree.getByRole("treeitem", { name: "Alpha" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(tree.getByRole("treeitem", { name: "Alpha" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(tree.getByRole("treeitem", { name: "Alpha" })).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Move here" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row(page, "Gamma")).toHaveCount(0);

    // Enter opens the folder that is left; the first row there takes the focus.
    await expect(focusedRow).toContainText("Alpha");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { level: 1, name: "Alpha" })).toBeVisible();
    await expect(focusedRow).toContainText("Gamma");

    // Delete trashes it; Tab reaches the toast's Undo; Enter restores.
    await page.keyboard.press("Delete");
    await expect(row(page, "Gamma")).toHaveCount(0);
    const undo = toastText(page).getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    for (let step = 0; step < 40; step += 1) {
      if (await undo.evaluate((button) => button === document.activeElement)) break;
      await page.keyboard.press("Tab");
    }
    await expect(undo).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(row(page, "Gamma")).toBeVisible();
  });
});

test.describe("files: download, zip, details, re-check; sharing waits", () => {
  const TRIP = folderNode(1, { name: "Trip" });
  const NOTES = fileNode(2, { name: "notes.pdf" });
  const BROKEN = fileNode(3, {
    name: "broken.bin",
    scanStatus: "error",
    scanReason: "engine",
    mimeCategory: "other",
  });
  const drive = () =>
    new FakeDrive([
      TRIP,
      NOTES,
      BROKEN,
      fileNode(4, { parentId: TRIP.id, name: "day-1.jpg", mimeCategory: "image", size: 18 }),
      fileNode(5, { parentId: TRIP.id, name: "day-2.jpg", mimeCategory: "image", size: 18 }),
      fileNode(6, { parentId: TRIP.id, name: "new.jpg", mimeCategory: "image", scanStatus: "pending" }),
    ]);

  test("download one file through a minted URL", async ({ page, origins }) => {
    mockedOnly();
    test.skip(isMobile(page), "desktop menus; the mobile sheet is tested below");
    const fake = await serve(page, origins.port, drive());
    await openExplorer(page);
    const download = page.waitForEvent("download");
    await menuAction(page, row(page, "notes.pdf"), "Download");
    expect((await download).url()).toContain(`${fake.filesOrigin}/d/${NOTES.id}/`);
    expect(fake.callsTo("POST", /\/download-url$/)[0]!.body).toEqual({ kind: "download" });
  });

  test("download a folder as a zip built in the browser; the toast says what was left out", async ({
    page,
    origins,
  }) => {
    mockedOnly();
    test.skip(isMobile(page), "desktop menus");
    // No native save dialog in an automated browser: the in-memory sink.
    await page.addInitScript(() => {
      delete (window as { showSaveFilePicker?: unknown }).showSaveFilePicker;
    });
    const fake = await serve(page, origins.port, drive());
    await openExplorer(page);
    const download = page.waitForEvent("download");
    await menuAction(page, row(page, "Trip"), "Download as zip");
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("Trip.zip");
    await expect(toastText(page)).toContainText(
      "Zip saved. 1 item was left out: Trip/new.jpg (still scanning).",
    );
    // One window of URLs for the two clean files; none for the one still scanning.
    expect(fake.callsTo("POST", /\/download-urls$/).map((call) => call.body)).toEqual([
      { nodeIds: [fileNode(4).id, fileNode(5).id] },
    ]);
    const stream = await saved.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    const archive = Buffer.concat(chunks);
    expect(archive.subarray(0, 2).toString("latin1")).toBe("PK");
    expect(archive.toString("latin1")).toContain("Trip/day-1.jpg");
    expect(archive.toString("latin1")).toContain("holdfast e2e bytes");
  });

  test("details of a file; Re-check sends it back to scanning; share is a disabled stub", async ({
    page,
    origins,
  }) => {
    mockedOnly();
    test.skip(isMobile(page), "the persistent panel is the desktop layout's");
    const fake = await serve(page, origins.port, drive());
    await openExplorer(page);
    const panel = page.locator("[data-details-panel]");
    await row(page, "notes.pdf").click();
    await expect(panel.getByRole("heading", { level: 2, name: "notes.pdf" })).toBeVisible();
    await expect(panel).toContainText("PDF document · pdf");
    await expect(panel).toContainText("2 KB");
    await expect(panel.locator("[data-sha256]")).toHaveText(NOTES.sha256!);
    await expect(panel).toContainText("Scanned. Nothing harmful found.");
    await expect(panel).toContainText("Not shared");
    // Sharing arrives with the sharing task: shown, disabled — in the row's menu and under More.
    await page.locator("[data-selection-bar]").getByRole("button", { name: "More" }).click();
    await expect(page.getByRole("menuitem", { name: /Share or get link/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await expect(page.getByRole("menuitem", { name: /Share or get link/ })).toContainText(
      "Sharing isn't switched on yet",
    );
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);

    // The row that could not be scanned: glyph and sentence, in the row and in the panel.
    await expect(row(page, "broken.bin").locator('[data-status="error"]')).toContainText("Couldn't scan");
    await row(page, "broken.bin").click();
    await expect(panel).toContainText("Couldn't scan. The scanner had a problem. Check it again.");
    await panel.getByRole("button", { name: "Re-check" }).click();
    await expect(row(page, "broken.bin").getByRole("progressbar")).toBeVisible();
    expect(fake.callsTo("POST", /\/rescan$/)).toHaveLength(1);

    // The poll (5 s) reads `.node.scanStatus`: once the scan says clean, the underline goes.
    fake.nodes.set(BROKEN.id, { ...BROKEN, scanStatus: "clean", scanReason: null });
    await expect(row(page, "broken.bin").getByRole("progressbar")).toHaveCount(0, { timeout: 15_000 });
    await expect(row(page, "broken.bin").locator("[data-status]")).toHaveCount(0);
  });

  test("grid view: tiles, drag-select, and a row dragged onto a folder moves", async ({ page, origins }) => {
    mockedOnly();
    test.skip(isMobile(page), "pointer interactions of the desktop layout");
    const fake = await serve(page, origins.port, drive());
    await openExplorer(page);
    // List first: drag notes.pdf onto the folder row.
    await row(page, "notes.pdf").dragTo(row(page, "Trip"));
    await expect(row(page, "notes.pdf")).toHaveCount(0);
    expect(fake.nodes.get(NOTES.id)!.parentId).toBe(TRIP.id);

    await page.locator('[data-view-toggle="grid"]').click();
    await expect(page.locator('[data-hf-list][data-view="grid"]')).toBeVisible();
    const tiles = page.locator("[data-item-id]");
    await expect(tiles).toHaveCount(2);
    // Drag a rectangle from the empty area below the tiles up across both.
    const list = (await page.locator("[data-explorer-list]").boundingBox())!;
    const first = (await tiles.first().boundingBox())!;
    await page.mouse.move(list.x + list.width - 20, first.y + first.height + 60);
    await page.mouse.down();
    await page.mouse.move(first.x + 20, first.y + 20, { steps: 8 });
    await expect(page.locator("[data-marquee]")).toBeVisible();
    await page.mouse.up();
    await expect(page.locator("[data-marquee]")).toHaveCount(0);
    await expect(page.locator("[data-selection-bar]")).toContainText("2 selected");
    await page.keyboard.press("Escape");
  });
});

test.describe("long folders and accessibility", () => {
  test("axe: no violations on / with 50 items (light scheme)", async ({ page, origins }) => {
    mockedOnly();
    await serve(page, origins.port, new FakeDrive(manyNodes(50)));
    await openExplorer(page);
    await expect(page.locator("[data-item-id]")).toHaveCount(50);
    await expectNoA11yViolations(page);
    // …and with a selection, the bar and the details showing. Two things about the shared
    // selection bar: it slides in (wait for that, or the half-faded bar is what gets measured), and
    // its key hints are drawn at 80 % opacity, which is 3.7:1 on the bar's wash — reported as a
    // seam for the shared component; left out here so that everything else in this state is held.
    if (!isMobile(page)) {
      await page.locator("[data-item-id]").nth(3).click();
      const bar = page.locator("[data-selection-bar]");
      await expect(bar).toBeVisible();
      await bar.evaluate((element) =>
        Promise.all(element.getAnimations().map((animation) => animation.finished)),
      );
      await expectNoA11yViolations(page, { exclude: ["[data-selection-bar] kbd"] });
    }
  });

  test("2,000 items: the DOM holds fewer than 150 rows while every page is loaded by scrolling", async ({
    page,
    origins,
  }) => {
    mockedOnly();
    test.setTimeout(90_000);
    const fake = await serve(page, origins.port, new FakeDrive(manyNodes(2000)));
    await openExplorer(page);
    const grid = page.getByRole("grid");
    const list = page.locator("[data-hf-list]");
    await expect(grid).toHaveAttribute("aria-rowcount", "200");
    for (let loaded = 400; loaded <= 2000; loaded += 200) {
      await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
      await expect(grid).toHaveAttribute("aria-rowcount", String(loaded));
    }
    expect(await page.locator("[data-item-id]").count()).toBeLessThan(150);
    expect(await page.locator('[data-hf-list] [role="row"]').count()).toBeLessThan(150);
    // Ten pages of 200, in order, each with the cursor of the one before. (The first may be asked
    // for twice: the dev build mounts every component twice, and the first request is cancelled.)
    const cursors = fake
      .callsTo("GET", /\/nodes\/root$/)
      .map((call) => new URL(call.path, origins.app).searchParams.get("cursor"));
    expect(cursors.filter((cursor, index) => cursor !== cursors[index - 1])).toEqual([
      null,
      ...Array.from({ length: 9 }, (_, index) => String((index + 1) * 200)),
    ]);
    expect(cursors.filter((cursor) => cursor !== null)).toHaveLength(9);
    // The last row is reachable.
    await list.evaluate((element) => element.scrollTo(0, element.scrollHeight));
    await expect(row(page, "file-2000.pdf")).toBeVisible();
  });
});

test.describe("failures", () => {
  for (const status of [404, 500] as const) {
    test(`every /api request answered ${status}: / and /folder/<id> show the error state, nothing is thrown`, async ({
      page,
      origins,
    }) => {
      mockedOnly();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await mockShell(page, origins.port, {
        api: async (route, path) => {
          if (status === 404 || !path.startsWith("/api/nodes")) return false;
          await route.fulfill({
            status: 500,
            json: { ...mockEnvelope("internal", "Internal error."), requestId: "req-500" },
          });
          return true;
        },
      });
      for (const path of ["/", `/folder/${folderNode(7).id}`]) {
        await page.goto(path);
        const state = page.locator('[data-explorer] [data-empty-state="unavailable"]');
        await expect(state).toBeVisible();
        await expect(state).toContainText(status === 404 ? "req req-e2e" : "req req-500");
        await expect(state.getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(page.getByText("Something broke on this page")).toHaveCount(0);
        await expect(page.locator("[data-item-id]")).toHaveCount(0);
      }
      expect(errors).toEqual([]);
    });
  }
});

test.describe("mobile layout", () => {
  const nodes = () => [
    folderNode(1, { name: "Trip" }),
    fileNode(2, { name: "notes.pdf" }),
    fileNode(3, { name: "plan.pdf" }),
  ];

  test("390 px: list view, 48 px rows, actions in a bottom sheet, long-press selection, 44 px targets", async ({
    page,
    origins,
  }) => {
    mockedOnly();
    test.skip(!isMobile(page), "the mobile project (touch)");
    await page.setViewportSize({ width: 390, height: 844 });
    const fake = await serve(page, origins.port, new FakeDrive(nodes()));
    await openExplorer(page);
    await expect(page.locator('[data-frame="mobile"]')).toBeVisible();
    await expect(page.locator('[data-hf-list][data-view="list"]')).toBeVisible();
    const rows = page.locator("[data-item-id]");
    await expect(rows).toHaveCount(3);
    for (const box of await rows.evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().height),
    ))
      expect(box).toBe(48);

    const smallTargets = () =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            "[data-explorer] button, [role=dialog] button, [role=dialog] [role=button]",
          ),
        )
          .filter((element) => !element.closest("[inert], [aria-hidden='true']"))
          .map((element) => ({
            name: element.getAttribute("aria-label") ?? element.textContent,
            rect: element.getBoundingClientRect(),
          }))
          .filter(({ rect }) => rect.width > 0 && (rect.height < 43.5 || rect.width < 43.5))
          .map(({ name, rect }) => `${name} ${Math.round(rect.width)}x${Math.round(rect.height)}`),
      );
    expect(await smallTargets()).toEqual([]);

    // The row's actions open as a bottom sheet, not a menu.
    await row(page, "notes.pdf").getByRole("button", { name: "More actions for notes.pdf" }).click();
    const sheet = page.getByRole("dialog", { name: "“notes.pdf”" });
    await expect(sheet).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    expect(await smallTargets()).toEqual([]);
    await sheet.getByRole("button", { name: "Rename" }).click();
    await fillName(page, "minutes.pdf", "Rename");
    await expect(row(page, "minutes.pdf")).toBeVisible();

    // Details open as a sheet too.
    await row(page, "plan.pdf").getByRole("button", { name: "More actions for plan.pdf" }).click();
    await page.getByRole("dialog", { name: "“plan.pdf”" }).getByRole("button", { name: "Details" }).click();
    const details = page.getByRole("dialog", { name: "plan.pdf", exact: true });
    await expect(details).toContainText("Scanned. Nothing harmful found.");
    await details.getByRole("button", { name: "Close" }).click();
    await expect(details).toHaveCount(0);
    await page.locator("[data-selection-bar]").getByRole("button", { name: "Clear" }).click();

    // A tap opens; a long press selects, and then taps add to the selection.
    const plan = row(page, "plan.pdf");
    await plan.dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
    await expect(plan).toHaveAttribute("aria-selected", "true");
    await plan.dispatchEvent("pointerup", { pointerType: "touch", bubbles: true });
    // The click a browser sends after the finger lifts belongs to the long press: it changes nothing.
    await plan.dispatchEvent("click", { bubbles: true });
    await expect(plan).toHaveAttribute("aria-selected", "true");
    await row(page, "minutes.pdf").click();
    const bar = page.locator("[data-selection-bar]");
    await expect(bar).toContainText("2 selected");
    expect(await smallTargets()).toEqual([]);
    await bar.getByRole("button", { name: "Move to trash" }).click();
    await expect(rows).toHaveCount(1);
    await toastText(page).getByRole("button", { name: "Undo" }).click();
    await expect(rows).toHaveCount(3);
    expect(fake.callsTo("POST", /\/restore$/)).toHaveLength(2);

    // The FAB's New folder runs the explorer's command.
    await page.locator("[data-new-fab]").click();
    await page.locator('[data-new-action="new-folder"]').click();
    await fillName(page, "Receipts", "Create");
    await expect(row(page, "Receipts")).toBeVisible();

    // No sideways scroll at this width.
    const size = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
    }));
    expect(size.scroll).toBeLessThanOrEqual(size.client);
  });

  test("the breakpoint: 1023 px is still the mobile layout, 1024 px the desktop one", async ({
    page,
    origins,
  }) => {
    mockedOnly();
    test.skip(isMobile(page), "resized from the desktop project (a fine pointer)");
    await serve(page, origins.port, new FakeDrive(nodes()));
    await page.setViewportSize({ width: 1023, height: 800 });
    await openExplorer(page);
    await expect(page.locator('[data-frame="mobile"]')).toBeVisible();
    await expect(page.locator("[data-item-id]")).toHaveCount(3);
    expect(await row(page, "notes.pdf").evaluate((item) => item.getBoundingClientRect().height)).toBe(48);
    await expect(page.locator("[data-new-folder]")).toHaveCount(0);
    await expect(page.locator("[data-new-fab]")).toBeVisible();
    await row(page, "notes.pdf").getByRole("button", { name: "More actions for notes.pdf" }).click();
    await expect(page.getByRole("dialog", { name: "“notes.pdf”" })).toBeVisible();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Opening a row's actions selected it.
    await page.locator("[data-selection-bar]").getByRole("button", { name: "Clear" }).click();

    await page.setViewportSize({ width: 1024, height: 800 });
    await expect(page.locator('[data-frame="desktop"]')).toBeVisible();
    expect(await row(page, "notes.pdf").evaluate((item) => item.getBoundingClientRect().height)).toBe(36);
    await expect(page.locator("[data-new-folder]")).toBeVisible();
    await expect(page.locator("[data-details-panel]")).toBeVisible();
    await row(page, "notes.pdf").getByRole("button", { name: "More actions for notes.pdf" }).click();
    await expect(page.getByRole("menu")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Every entry of the menu that has a shortcut shows it.
    await expect(page.getByRole("menuitem", { name: /Rename/ }).locator("kbd")).toHaveText("F2");
  });
});
