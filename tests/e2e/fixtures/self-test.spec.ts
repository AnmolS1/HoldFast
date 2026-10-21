// The harness's own fixtures against the real Worker: the role pages, the moved clock, the /api
// request counter. (The specs of every task build on them; a fixture that quietly did nothing
// would turn their checks into nothing.)
import type { Page } from "@playwright/test";
import { signedInUser } from "../../setup/auth-fixtures";
import { expect, mockShell, navigateInApp, test, testClock } from "./index";

/** The session the browser of `page` holds, read by the page itself (through its routes). */
async function sessionOf(page: Page): Promise<{ id: string; role: string | null } | null> {
  return page.evaluate(async () => {
    const response = await fetch("/api/auth/get-session");
    const body = (await response.json()) as { user?: { id: string; role?: string | null } } | null;
    return body?.user ? { id: body.user.id, role: body.user.role ?? null } : null;
  });
}

/** The ids of the sessions GET /api/account/sessions lists — it leaves out those expired at the Worker's `now`. */
async function listedSessions(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const response = await fetch("/api/account/sessions");
    if (!response.ok) throw new Error(`GET /api/account/sessions answered ${response.status}`);
    return ((await response.json()) as unknown[]).length;
  });
}

test.describe("harness fixtures (the real Worker)", () => {
  test("roles: owner, editor and viewer are three accounts, each signed in in its own browser; the shares carry the roles", async ({
    roles,
  }) => {
    const owner = await roles.owner();
    const [editor, viewer] = [await roles.editor(), await roles.viewer()];
    // Asked twice: the same role, not a new account.
    expect((await roles.editor()).user.id).toBe(editor.user.id);
    expect(new Set([owner, editor, viewer].map((role) => role.user.id)).size).toBe(3);

    // A grantee's own browser, at the app, is signed in as the grantee (its context's routes and cookie).
    await editor.page.goto("/");
    await expect(editor.page.locator("[data-frame]")).toBeVisible();
    expect((await sessionOf(editor.page))?.id).toBe(editor.user.id);
    // Each context holds its own role's session.
    for (const role of [owner, editor, viewer]) {
      const session = await role.page.request.get("/api/auth/get-session");
      expect(((await session.json()) as { user: { id: string } }).user.id).toBe(role.user.id);
    }

    // The owner's folder, shared once as editor and once as viewer.
    const sharing = await owner.page.request.get(`/api/nodes/${owner.folderId}/sharing`);
    expect(sharing.status()).toBe(200);
    const shares = ((await sharing.json()) as { shares: Array<{ role: string }> }).shares;
    expect(shares.map((share) => share.role).sort()).toEqual(["editor", "viewer"]);
    for (const [role, expected] of [
      [editor, "editor"],
      [viewer, "viewer"],
    ] as const) {
      const listed = await role.page.request.get("/api/shared-with-me");
      const items = (await listed.json()) as Array<{ node: { id: string }; role: string }>;
      expect(items.filter((item) => item.node.id === owner.folderId).map((item) => item.role)).toEqual([
        expected,
      ]);
    }
  });

  test("roles: the admin is signed in with the admin role and a passed second factor, in a browser of its own", async ({
    roles,
    page,
  }) => {
    const admin = await roles.admin();
    expect(admin.page).not.toBe(page);
    await admin.page.goto("/");
    await expect(admin.page.locator("[data-frame]")).toBeVisible();
    expect(await sessionOf(admin.page)).toEqual({ id: admin.user.id, role: "admin" });
    // The test's own page is nobody's.
    const own = await page.request.get("/api/auth/get-session");
    expect(await own.json()).toBeNull();
  });

  test("the clock: the Worker and the browser both read the moved time, through the clientIp route in front of it", async ({
    page,
    clientIp,
  }) => {
    await signedInUser(page, { clientIp });
    await page.goto("/");
    await expect(page.locator("[data-frame]")).toBeVisible();
    // Today: the current session is listed (it expires days from now).
    expect(await listedSessions(page)).toBeGreaterThan(0);

    const far = new Date(Date.UTC(2099, 0, 1));
    const clock = await testClock(page, far);
    // The Worker's now is 2099: every session has expired by then.
    expect(await listedSessions(page)).toBe(0);
    expect(await page.evaluate(() => new Date().getUTCFullYear())).toBe(2099);
    await clock.advance(60_000);
    expect(clock.now().getTime()).toBe(far.getTime() + 60_000);
    expect(await page.evaluate(() => Date.now())).toBeGreaterThanOrEqual(far.getTime() + 60_000);
    // A request outside the page passes the header itself.
    const outside = await page.request.get("/api/account/sessions", { headers: clock.headers() });
    expect(((await outside.json()) as unknown[]).length).toBe(0);
    const today = await page.request.get("/api/account/sessions");
    expect(((await today.json()) as unknown[]).length).toBeGreaterThan(0);
  });

  test("apiRequests: what the page asks of /api is counted, mocked or not; page.request is not the page", async ({
    page,
    origins,
    apiRequests,
  }) => {
    await mockShell(page, origins.port);
    await page.goto("/");
    await expect(page.locator("[data-frame]")).toBeVisible();
    expect(apiRequests.all().map((request) => request.path)).toContain("/api/public/config");
    const mark = apiRequests.mark();
    await navigateInApp(page, "/recent");
    await expect
      .poll(() => apiRequests.since(mark, (request) => request.path.startsWith("/api/recent")).length)
      .toBeGreaterThan(0);
    await page.request.get("/api/public/config");
    expect(apiRequests.since(mark).filter((request) => request.path === "/api/public/config")).toEqual([]);
  });
});
