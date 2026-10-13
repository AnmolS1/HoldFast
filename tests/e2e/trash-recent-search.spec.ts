// The views: Trash, Recent, Starred, Search and Storage, against `vite dev`.
//
//   npm run e2e -- tests/e2e/trash-recent-search.spec.ts
//
// MOCKED by default (fixtures/mode.ts): `mockShell` signs a made-up user in and this spec answers
// the views' own routes, from the same schema-parsed fixtures the jsdom tests use. The one block
// that needs the API as built starts with `realOnly()` and runs on the integrated branch.
import type { Locator, Page, Route } from "@playwright/test";
import { signedInUser } from "../setup/auth-fixtures";
import {
  node,
  nodeId,
  RECENT,
  RECENT_NOW,
  remaining,
  restored,
  SEARCH,
  SEARCH_NONE,
  SEARCH_PDF,
  STARRED,
  TRASH,
  trashItems,
  trashPage,
  USAGE,
  USAGE_AFTER_EMPTY,
} from "../unit/client/views/fixtures";
import {
  expect,
  expectNoA11yViolations,
  mockedOnly,
  mockEnvelope,
  mockShell,
  realOnly,
  test,
} from "./fixtures";

const DESKTOP_MIN = 1024;
const TOUCH_ROW = 48;
const TOUCH_TARGET = 44;

const isMobile = (page: Page) => (page.viewportSize()?.width ?? 0) < DESKTOP_MIN;
const row = (page: Page, id: string) => page.locator(`[data-item-id="${id}"]`);
const rows = (page: Page) => page.locator("[data-item-id]");
const view = (page: Page, name: string) => page.locator(`[data-view-page="${name}"]`);
const viewError = (page: Page, name: string) => page.locator(`[data-view-error="${name}"]`);

const [REPORT, NOTES, FOLDER] = TRASH.items as [
  (typeof TRASH.items)[number],
  (typeof TRASH.items)[number],
  (typeof TRASH.items)[number],
];

interface ViewsApi {
  api(route: Route, path: string): Promise<boolean>;
  /** Method and path of every request this mock answered. */
  seen: string[];
  /** Let a held `DELETE /api/trash` answer. */
  release(): void;
}

/**
 * The views' API, in the browser. It keeps the one piece of state the journeys depend on: what
 * a restore or a delete answered `2xx` for is no longer in the trash, and an emptied trash moves
 * the storage numbers.
 *
 * `emptyAnswers`: what `DELETE /api/trash` answers `202 { remaining }` with, in order, before its
 * `204`. With `hold`, every call after the first waits for `release()`.
 */
function viewsApi(
  options: { trash?: typeof TRASH.items; emptyAnswers?: number[]; hold?: boolean } = {},
): ViewsApi {
  let trash = [...(options.trash ?? TRASH.items)];
  let emptied = false;
  const emptyAnswers = [...(options.emptyAnswers ?? [])];
  let deletes = 0;
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const seen: string[] = [];
  return {
    seen,
    release,
    async api(route, path) {
      const request = route.request();
      const method = request.method();
      const query = new URL(request.url()).searchParams;
      const answer = async (body: unknown, status = 200) => {
        seen.push(`${method} ${path}`);
        await route.fulfill(body === null ? { status } : { status, json: body });
        return true;
      };
      if (method === "GET" && path === "/api/trash") return answer(trashPage(trash));
      if (method === "GET" && path === "/api/recent") return answer(RECENT);
      if (method === "GET" && path === "/api/starred") return answer(STARRED);
      if (method === "GET" && path === "/api/account/usage")
        return answer(emptied ? USAGE_AFTER_EMPTY : USAGE);
      if (method === "GET" && path === "/api/search") {
        if (!(query.get("q") ?? "").startsWith("rep")) return answer(SEARCH_NONE);
        const found = query.get("category") === "pdf" ? SEARCH_PDF : SEARCH;
        const kind = query.get("kind");
        return answer(kind ? { ...found, items: found.items.filter((item) => item.kind === kind) } : found);
      }
      if (method === "DELETE" && path === "/api/trash") {
        deletes += 1;
        if (options.hold && deletes > 1) await held;
        const left = emptyAnswers.shift();
        if (left !== undefined) return answer(remaining(left), 202);
        trash = [];
        emptied = true;
        return answer(null, 204);
      }
      const id = /^\/api\/nodes\/([^/]+)(\/restore)?$/.exec(path);
      const target = id ? trash.find((item) => item.id === id[1]) : undefined;
      if (target && method === "POST" && id?.[2]) {
        trash = trash.filter((item) => item !== target);
        return answer(restored(target));
      }
      if (target && method === "DELETE" && !id?.[2]) {
        trash = trash.filter((item) => item !== target);
        return answer(null, 204);
      }
      return false;
    },
  };
}

async function open(page: Page, port: number, path: string, mock: ViewsApi = viewsApi()): Promise<ViewsApi> {
  await mockShell(page, port, { api: (route, apiPath) => mock.api(route, apiPath) });
  await page.goto(path);
  await expect(page.locator("[data-frame]")).toBeVisible();
  return mock;
}

/** The row's actions: a menu on desktop, a bottom sheet on mobile — menu items in both. */
async function rowAction(page: Page, name: string, action: string | RegExp): Promise<void> {
  await page.getByRole("button", { name: `More actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

/** The page cannot be scrolled sideways. */
async function expectNoOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, "horizontal overflow of the page, px").toBeLessThanOrEqual(0);
}

const height = async (locator: Locator) => (await locator.boundingBox())?.height ?? 0;

test.describe("trash", () => {
  test.beforeEach(() => mockedOnly());

  test("lists what was deleted and when it goes for good; restore → the row is gone", async ({
    page,
    origins,
  }) => {
    const mock = await open(page, origins.port, "/trash");
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, REPORT.id)).toContainText("report.pdf");
    await expect(row(page, REPORT.id)).toContainText("Deleted Oct 02 · Deleted forever on Nov 01");
    await expect(page.locator("[data-trash-count]")).toHaveText("3 items");

    await rowAction(page, "report.pdf", "Restore");
    await expect(row(page, REPORT.id)).toHaveCount(0);
    await expect(rows(page)).toHaveCount(2);
    await expect(page.getByText("report.pdf restored")).toBeVisible();
    expect(mock.seen).toContain(`POST /api/nodes/${REPORT.id}/restore`);
    await expect(page).toHaveURL(/\/trash$/);
  });

  test("a restore the API refuses says the one sentence and keeps the row", async ({ page, origins }) => {
    await open(page, origins.port, "/trash");
    await page.route(`**/api/nodes/${NOTES.id}/restore`, (route) =>
      route.fulfill({
        status: 409,
        json: {
          error: "conflict",
          message: "server words that must not be shown",
          requestId: "req-e2e",
          details: { reason: "held" },
        },
      }),
    );
    await expect(rows(page)).toHaveCount(3);
    await rowAction(page, "notes.txt", "Restore");
    await expect(page.locator("[data-trash-conflict]")).toHaveText("Restore the folder this was in first");
    await expect(row(page, NOTES.id)).toBeVisible();
    await expect(page.getByText("server words that must not be shown")).toHaveCount(0);
  });

  test("delete forever: the confirmation states finality and the count; confirmed, the row is gone", async ({
    page,
    origins,
  }) => {
    const mock = await open(page, origins.port, "/trash");
    await expect(rows(page)).toHaveCount(3);
    await rowAction(page, "Old projects", /Delete forever/);
    const dialog = page.getByRole("dialog", { name: "Delete Old projects forever?" });
    await expect(dialog).toContainText(
      "This can't be undone. 1 item. Folders are deleted with everything in them.",
    );
    // Cancel has the focus: Enter by reflex destroys nothing.
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(dialog).toHaveCount(0);
    await expect(row(page, FOLDER.id)).toBeVisible();
    expect(mock.seen.filter((entry) => entry.startsWith("DELETE"))).toEqual([]);

    await rowAction(page, "Old projects", /Delete forever/);
    await page.getByRole("dialog").getByRole("button", { name: "Delete forever" }).click();
    await expect(row(page, FOLDER.id)).toHaveCount(0);
    await expect(page.getByText("Old projects deleted forever")).toBeVisible();
    expect(mock.seen).toContain(`DELETE /api/nodes/${FOLDER.id}`);
  });

  test("nothing opens from the trash", async ({ page, origins }) => {
    await open(page, origins.port, "/trash");
    await row(page, REPORT.id).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByText("Restore this item to open it.")).toBeVisible();
    await expect(page).toHaveURL(/\/trash$/);
  });

  test("empty trash with 101 items requires typing; the loop shows what is left until nothing is", async ({
    page,
    origins,
  }) => {
    const mock = await open(
      page,
      origins.port,
      "/trash",
      viewsApi({ trash: trashItems(101), emptyAnswers: [60, 20], hold: true }),
    );
    await expect(page.locator("[data-trash-count]")).toHaveText("101 items");
    await page.getByRole("button", { name: "Empty trash" }).click();
    const dialog = page.getByRole("dialog", { name: "Empty the trash?" });
    await expect(dialog).toContainText("This can't be undone. 101 items.");
    const confirm = dialog.getByRole("button", { name: "Empty trash" });
    const word = dialog.getByLabel("Type DELETE to confirm");
    await expect(confirm).toBeDisabled();
    await word.fill("delete");
    await expect(confirm).toBeDisabled();
    expect(mock.seen.filter((entry) => entry === "DELETE /api/trash")).toEqual([]);
    await word.fill("DELETE");
    await expect(confirm).toBeEnabled();
    await confirm.click();

    const progress = page.locator("[data-empty-trash-progress]");
    await expect(progress).toHaveText("Deleting… 60 left");
    mock.release();
    await expect(page.getByRole("heading", { name: "Trash is empty" })).toBeVisible();
    await expect(progress).toHaveText("");
    await expect(page.getByText("Trash emptied")).toBeVisible();
    expect(mock.seen.filter((entry) => entry === "DELETE /api/trash")).toHaveLength(3);
    await expect(page.getByRole("button", { name: "Empty trash" })).toBeDisabled();
  });

  test("with 100 items no typing is asked", async ({ page, origins }) => {
    await open(page, origins.port, "/trash", viewsApi({ trash: trashItems(100) }));
    await expect(page.locator("[data-trash-count]")).toHaveText("100 items");
    await page.getByRole("button", { name: "Empty trash" }).click();
    const dialog = page.getByRole("dialog", { name: "Empty the trash?" });
    await expect(dialog.getByRole("textbox")).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Empty trash" })).toBeEnabled();
  });
});

test.describe("recent, starred, search, storage", () => {
  test.beforeEach(() => mockedOnly());

  test("/recent groups by day", async ({ page, origins }) => {
    await page.clock.setFixedTime(new Date(RECENT_NOW));
    await open(page, origins.port, "/recent");
    await expect(rows(page)).toHaveCount(4);
    await expect(page.locator("[data-group-label]")).toHaveText([
      "Today",
      "Yesterday",
      "This week",
      "Earlier",
    ]);
    await expect(rows(page)).toContainText(["today.pdf", "yesterday.pdf", "this-week.pdf", "earlier.pdf"]);
  });

  test("/recent: opening a file goes to its preview and remembers where from", async ({ page, origins }) => {
    await open(page, origins.port, "/recent");
    await row(page, nodeId(11)).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/preview/${nodeId(11)}$`));
    expect(await page.evaluate(() => (history.state as { usr?: unknown }).usr)).toEqual({
      siblingIds: RECENT.items.map((item) => item.id),
      from: "/recent",
    });
  });

  test("/starred lists; a folder opens in the explorer", async ({ page, origins }) => {
    await open(page, origins.port, "/starred");
    await expect(rows(page)).toHaveCount(2);
    await expect(rows(page)).toContainText(["Projects", "contract.pdf"]);
    await row(page, nodeId(21)).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(new RegExp(`/folder/${nodeId(21)}$`));
  });

  test("/search?q=reprot shows report.pdf; the type menu narrows the results", async ({ page, origins }) => {
    const mock = await open(page, origins.port, "/search?q=reprot");
    await expect(rows(page)).toHaveCount(3);
    await expect(row(page, nodeId(31))).toContainText("report.pdf");
    await expect(row(page, nodeId(31))).toContainText("Work");
    await expect(page.locator("[data-search-count]")).toHaveText("3 results");

    if (isMobile(page)) await page.getByRole("button", { name: "Filters" }).click();
    await page.getByLabel("Type", { exact: true }).selectOption("pdf");
    await expect(rows(page)).toHaveCount(1);
    await expect(page).toHaveURL(/\/search\?q=reprot&category=pdf$/);
    await expect(row(page, nodeId(31))).toContainText("report.pdf");
    expect(mock.seen).toContain("GET /api/search");

    // The address is the search: a reload restores it.
    await page.reload();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.locator("[data-search-input]")).toHaveValue("reprot");
  });

  test("/search: typing searches after a pause; no match and the scope with nothing shared say so", async ({
    page,
    origins,
  }) => {
    await open(page, origins.port, "/search");
    await expect(page.getByRole("heading", { name: "Search your files" })).toBeVisible();
    await page.locator("[data-search-input]").pressSequentially("report");
    await expect(page).toHaveURL(/\/search\?q=report$/);
    await expect(rows(page)).toHaveCount(3);
    // ↓ from the box reaches the results.
    await page.locator("[data-search-input]").press("ArrowDown");
    await expect(row(page, nodeId(31))).toBeFocused();

    await page.locator("[data-search-input]").fill("zzzz");
    await expect(page.getByRole("heading", { name: "No files match" })).toBeVisible();
    await expect(page).toHaveURL(/\/search\?q=zzzz$/);
  });

  test("/storage: the numbers change after empty trash", async ({ page, origins }) => {
    await open(page, origins.port, "/storage", viewsApi({ emptyAnswers: [1] }));
    const storage = view(page, "usage");
    await expect(storage.getByText("1.4 GB of 5 GB")).toBeVisible();
    await expect(storage.locator("[data-usage-free]")).toHaveText("3.6 GB free");
    await expect(storage.locator("[data-usage-part]")).toHaveText([
      "Files900 MB",
      "Trash300 MB",
      "Previous versions150 MB",
      "Uploads in progress50 MB",
    ]);
    await expect(
      storage.getByText(
        "Items in the trash and earlier versions of replaced files count toward your storage until they're deleted for good.",
      ),
    ).toBeVisible();

    await storage.getByRole("button", { name: "Empty trash" }).click();
    const dialog = page.getByRole("dialog", { name: "Empty the trash?" });
    await expect(dialog).toContainText("This can't be undone. 3 items.");
    await dialog.getByRole("button", { name: "Empty trash" }).click();
    await expect(storage.locator('[data-usage-part="trash"]')).toHaveText("Trash0 B");
    await expect(storage.getByText("1.1 GB of 5 GB")).toBeVisible();
    await expect(storage.locator("[data-usage-free]")).toHaveText("3.9 GB free");
    if (!isMobile(page))
      await expect(page.locator("[data-sidebar]").getByText("1.1 GB of 5 GB")).toBeVisible();
  });

  test("the header's suggestions: the top matches under the box, picked by id", async ({ page, origins }) => {
    await open(page, origins.port, "/starred");
    await page.getByRole("searchbox", { name: "Search files" }).fill("rep");
    const suggestions = page.getByRole("list", { name: "Suggestions" });
    // Files only: a suggestion opens a preview, which a folder has not.
    await expect(suggestions.getByRole("button")).toHaveText(["report.pdfWork", "reported-bugs.txt"]);
    await suggestions.getByRole("button").first().click();
    await expect(page).toHaveURL(new RegExp(`/preview/${nodeId(31)}$`));
  });
});

test.describe("review fixes", () => {
  test.beforeEach(() => mockedOnly());

  test("a failed next page is asked for ONCE: the rows stay, the list says so, and it waits for 'Try again'", async ({
    page,
    origins,
  }) => {
    let pageTwo = 0;
    let fail = true;
    await mockShell(page, origins.port, { api: (route, path) => viewsApi().api(route, path) });
    await page.route("**/api/starred**", (route) => {
      if (new URL(route.request().url()).searchParams.get("cursor") !== "c2") {
        return route.fulfill({ json: { ...STARRED, nextCursor: "c2" } });
      }
      pageTwo += 1;
      return fail
        ? route.fulfill({
            status: 429,
            headers: { "retry-after": "4" },
            json: mockEnvelope("rate_limited", "Too many requests."),
          })
        : route.fulfill({
            json: { items: [node(23, { name: "third.pdf", starred: true })], nextCursor: null },
          });
    });
    await page.goto("/starred");
    const notice = page.locator('[data-list-notice="starred"]');
    await expect(notice).toContainText("Couldn't load more of this list.");
    await expect(notice).toContainText("req req-e2e");
    await expect(rows(page)).toHaveCount(2);
    // The API named a wait (Retry-After): the retry is off until it has passed.
    const retry = notice.getByRole("button", { name: "Try again" });
    await expect(retry).toBeDisabled();
    await expect(notice).toContainText("You can try again shortly.");
    // Two seconds with nobody touching the page. It is an ABSENCE that is measured — requests
    // that must not be made — so there is no event to wait for instead.
    await page.waitForTimeout(2000);
    expect(pageTwo, "requests for the page that failed").toBe(1);
    await expect(rows(page)).toHaveCount(2);

    // Then the retry comes back — a full-size target with nothing floating over it (on the phone
    // layout the "New" button sits in that corner).
    await expect(retry).toBeEnabled();
    if (isMobile(page)) expect(await height(retry)).toBeGreaterThanOrEqual(TOUCH_TARGET);
    fail = false;
    await retry.click();
    await expect(rows(page)).toHaveCount(3);
    await expect(notice).toHaveCount(0);
    expect(pageTwo).toBe(2);
  });

  test("a failed page stays failed through every refresh: events, returns to the tab, reconnects and a whole Empty trash run request it ONCE", async ({
    page,
    context,
    origins,
  }) => {
    let pageTwo = 0;
    let firstPage = 0;
    let batches = 0;
    await mockShell(page, origins.port, { api: (route, path) => viewsApi().api(route, path) });
    await page.route("**/api/trash**", (route) => {
      const request = route.request();
      if (request.method() === "DELETE") {
        batches += 1;
        return batches <= 8
          ? route.fulfill({ status: 202, json: remaining(90 - batches * 10) })
          : route.fulfill({ status: 204 });
      }
      if (new URL(request.url()).searchParams.get("cursor") !== "c2") {
        firstPage += 1;
        return route.fulfill({ json: trashPage(TRASH.items, "c2") });
      }
      pageTwo += 1;
      return route.fulfill({
        status: 429,
        headers: { "retry-after": "30" },
        json: mockEnvelope("rate_limited", "Too many requests."),
      });
    });
    await page.goto("/trash");
    const notice = page.locator('[data-list-notice="trash"]');
    await expect(notice).toContainText("Couldn't load more of this list.");
    await expect(notice.getByRole("button", { name: "Try again" })).toBeDisabled();
    expect(pageTwo).toBe(1);
    const readsBefore = firstPage;

    // 8 tree-changed events (what a star toggle or a finished upload sends), each given longer
    // than the views take to turn it into a round of reads. Absences are measured from here on:
    // there is no event to wait for when the point is that nothing happens.
    for (let index = 0; index < 8; index++) {
      await page.evaluate(() =>
        window.dispatchEvent(new CustomEvent("holdfast:nodes-changed", { detail: { parentIds: [null] } })),
      );
      await page.waitForTimeout(350);
    }
    // 4 returns to the tab.
    for (let index = 0; index < 4; index++) {
      await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await page.waitForTimeout(100);
    }
    // 3 reconnects.
    for (let index = 0; index < 3; index++) {
      await context.setOffline(true);
      await context.setOffline(false);
      await page.waitForTimeout(100);
    }
    expect(pageTwo, "the failed cursor, after events, focus and reconnects").toBe(1);
    expect(firstPage, "reads of a list inside its Retry-After").toBe(readsBefore);

    // An Empty trash run of 8 batches. The list may not be read (the API named a wait), so the
    // confirmation does not know the size and asks for the word.
    await page.getByRole("button", { name: "Empty trash" }).click();
    const dialog = page.getByRole("dialog", { name: "Empty the trash?" });
    await dialog.getByLabel("Type DELETE to confirm").fill("DELETE");
    await dialog.getByRole("button", { name: "Empty trash" }).click();
    await expect(page.getByText("Trash emptied")).toBeVisible();
    expect(batches).toBe(9);
    await page.waitForTimeout(500);
    expect(pageTwo, "the failed cursor, in total").toBe(1);
    await expect(notice).toContainText("Couldn't load more of this list.");
  });

  test("Empty trash goes on when the user leaves the page: the trash shows the same run, then what the server has", async ({
    page,
    origins,
  }) => {
    const mock = await open(page, origins.port, "/storage", viewsApi({ emptyAnswers: [60, 20], hold: true }));
    const storage = view(page, "usage");
    await storage.getByRole("button", { name: "Empty trash" }).click();
    await page
      .getByRole("dialog", { name: "Empty the trash?" })
      .getByRole("button", { name: "Empty trash" })
      .click();
    const progress = page.locator("[data-empty-trash-progress]");
    await expect(progress).toHaveText("Deleting… 60 left");

    await storage.getByRole("link", { name: "Open the trash" }).click();
    await expect(page).toHaveURL(/\/trash$/);
    await expect(view(page, "trash")).toBeVisible();
    await expect(progress).toHaveText("Deleting… 60 left");
    await expect(page.getByRole("button", { name: "Empty trash" })).toBeDisabled();

    mock.release();
    await expect(page.getByRole("heading", { name: "Trash is empty" })).toBeVisible();
    await expect(progress).toHaveText("");
    await expect(page.getByText("Trash emptied")).toBeVisible();
    expect(mock.seen.filter((entry) => entry === "DELETE /api/trash")).toHaveLength(3);
  });
});

const VIEWS = [
  { path: "/trash", name: "trash", ready: (page: Page) => expect(rows(page)).toHaveCount(3) },
  { path: "/recent", name: "recent", ready: (page: Page) => expect(rows(page)).toHaveCount(4) },
  { path: "/starred", name: "starred", ready: (page: Page) => expect(rows(page)).toHaveCount(2) },
  { path: "/search?q=report", name: "search", ready: (page: Page) => expect(rows(page)).toHaveCount(3) },
  {
    path: "/storage",
    name: "usage",
    ready: (page: Page) => expect(page.locator("[data-usage-part]")).toHaveCount(4),
  },
] as const;

test.describe("accessibility", () => {
  test.beforeEach(() => mockedOnly());

  for (const { path, name, ready } of VIEWS) {
    test(`${path} has no axe violations (light scheme)`, async ({ page, origins }) => {
      await open(page, origins.port, path);
      await ready(page);
      await expect(view(page, name)).toBeVisible();
      await expectNoA11yViolations(page);
    });
  }

  test("the open confirmation and the selection bar have no axe violations", async ({ page, origins }) => {
    await open(page, origins.port, "/trash", viewsApi({ trash: trashItems(101) }));
    await expect(rows(page)).toHaveCount(101);
    await page.getByRole("button", { name: "Empty trash" }).click();
    await expect(page.getByRole("dialog", { name: "Empty the trash?" })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("the error state has no axe violations", async ({ page, origins }) => {
    await mockShell(page, origins.port);
    await page.goto("/trash");
    await expect(viewError(page, "trash")).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test.describe("mobile layout", () => {
  test.beforeEach(() => mockedOnly());

  for (const width of [390, 1023]) {
    test(`${width} px: touch rows, actions and filters in sheets, nothing overflows`, async ({
      page,
      origins,
    }) => {
      await page.setViewportSize({ width, height: 844 });
      await open(page, origins.port, "/trash");
      await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame", "mobile");
      await expect(rows(page)).toHaveCount(3);
      expect(await height(row(page, REPORT.id))).toBeGreaterThanOrEqual(TOUCH_ROW);
      const more = page.getByRole("button", { name: "More actions for report.pdf" });
      expect(await height(more)).toBeGreaterThanOrEqual(TOUCH_TARGET);
      expect(await height(page.getByRole("button", { name: "Empty trash" }))).toBeGreaterThanOrEqual(
        TOUCH_TARGET,
      );
      await expectNoOverflow(page);

      // Row actions: a bottom sheet named after the item.
      await more.click();
      const sheet = page.getByRole("dialog", { name: "report.pdf" });
      await expect(sheet).toBeVisible();
      const restore = sheet.getByRole("menuitem", { name: "Restore" });
      expect(await height(restore)).toBeGreaterThanOrEqual(TOUCH_TARGET);
      // Once it has slid in, it sits on the bottom edge.
      await expect
        .poll(async () => {
          const box = await sheet.boundingBox();
          return Math.round((box?.y ?? 0) + (box?.height ?? 0));
        })
        .toBe(844);
      await restore.click();
      await expect(row(page, REPORT.id)).toHaveCount(0);

      // Long press selects; the selection bar carries the two actions.
      await row(page, NOTES.id).dispatchEvent("pointerdown", { pointerType: "touch", bubbles: true });
      await expect(row(page, NOTES.id)).toHaveAttribute("aria-selected", "true");
      const bar = page.locator("[data-selection-bar]");
      await expect(bar.getByRole("button", { name: "Restore" })).toBeVisible();
      await expect(bar.getByRole("button", { name: "Delete forever" })).toBeVisible();
      await expectNoOverflow(page);

      // Search: the two menus live in a sheet, not in the page.
      await page.goto("/search?q=report");
      await expect(rows(page)).toHaveCount(3);
      expect(await height(row(page, nodeId(31)))).toBeGreaterThanOrEqual(TOUCH_ROW);
      await expect(view(page, "search").locator("select")).toHaveCount(0);
      const filters = page.getByRole("button", { name: "Filters" });
      expect(await height(filters)).toBeGreaterThanOrEqual(TOUCH_TARGET);
      await expectNoOverflow(page);
      await filters.click();
      const filterSheet = page.getByRole("dialog", { name: "Filters" });
      await expect(filterSheet.getByLabel("Type", { exact: true })).toBeVisible();
      await expect(filterSheet.getByLabel("Search in")).toBeVisible();
      await filterSheet.getByLabel("Type", { exact: true }).selectOption("pdf");
      await expect(rows(page)).toHaveCount(1);

      for (const path of ["/recent", "/starred", "/storage"]) {
        await page.goto(path);
        await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame", "mobile");
        await expect(page.locator("[data-view-page]")).toBeVisible();
        await expectNoOverflow(page);
      }
    });
  }

  test("1024 px is the desktop layout: inline menus, a menu for row actions", async ({ page, origins }) => {
    await page.setViewportSize({ width: 1024, height: 844 });
    await open(page, origins.port, "/search?q=report");
    await expect(page.locator("[data-frame]")).toHaveAttribute("data-frame", "desktop");
    await expect(view(page, "search").locator("select")).toHaveCount(2);
    await expect(page.getByRole("button", { name: "Filters" })).toHaveCount(0);
    await expectNoOverflow(page);
  });
});

test.describe("a page never throws on an API error", () => {
  test.beforeEach(() => mockedOnly());

  const PAGES = [
    ["/trash", "trash", "Couldn't load the trash"],
    ["/recent", "recent", "Couldn't load your recent files"],
    ["/starred", "starred", "Couldn't load your starred items"],
    ["/search?q=tax", "search", "Couldn't run this search"],
    ["/storage", "usage", "Couldn't load your storage use"],
  ] as const;
  const SHELL_PATHS = ["/api/public/config", "/api/auth/get-session", "/api/account/deletion-status"];

  for (const status of [404, 500] as const) {
    test(`every /api request answered ${status}: each view shows its own error state, no page error`, async ({
      page,
      origins,
    }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      // 404 is what plain `mockShell` answers for every request nobody names.
      await mockShell(
        page,
        origins.port,
        status === 404
          ? {}
          : {
              api: async (route, path) => {
                if (SHELL_PATHS.includes(path)) return false;
                await route.fulfill({
                  status: 500,
                  json: { error: "internal", message: "Something went wrong.", requestId: "req-e2e" },
                });
                return true;
              },
            },
      );
      for (const [path, name, title] of PAGES) {
        await page.goto(path);
        await expect(page.locator("[data-frame]")).toBeVisible();
        await expect(viewError(page, name)).toBeVisible();
        await expect(viewError(page, name).getByRole("heading", { name: title })).toBeVisible();
        await expect(viewError(page, name)).toContainText("req req-e2e");
        await expect(viewError(page, name).getByRole("button", { name: "Try again" })).toBeVisible();
        await expect(page.getByText("Something broke on this page")).toHaveCount(0);
        await expect(page.locator("[data-placeholder-page]")).toHaveCount(0);
        // The sidebar's bar is on every page of the desktop frame: a skeleton, not a crash.
        if (!isMobile(page)) {
          await expect(page.locator("[data-sidebar]").getByLabel("Loading storage use")).toBeVisible();
        }
      }
      expect(pageErrors).toEqual([]);
    });
  }
});

test.describe("against the API as built (post-integration)", () => {
  test("a new account: every view answers its own shape and shows its empty state", async ({
    page,
    clientIp,
  }) => {
    realOnly();
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    await signedInUser(page, { clientIp });
    const empty: Array<[path: string, name: string, heading: string]> = [
      ["/trash", "trash", "Trash is empty"],
      ["/recent", "recent", "Nothing opened yet"],
      ["/starred", "starred", "Nothing starred"],
      ["/search?q=report", "search", "No files match"],
    ];
    for (const [path, name, heading] of empty) {
      await page.goto(path);
      await expect(view(page, name)).toBeVisible();
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      await expect(viewError(page, name)).toHaveCount(0);
    }
    await page.goto("/storage");
    await expect(view(page, "usage").locator("[data-usage-part]")).toHaveText([
      "Files0 B",
      "Trash0 B",
      "Previous versions0 B",
      "Uploads in progress0 B",
    ]);
    await expect(viewError(page, "usage")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  });
});
