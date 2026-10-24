// W2S4, the identity pin, through the real dev server: one browser, two tabs' worth of sign-ins.
// The session cookie belongs to the browser, so when another tab signs in as B, THIS tab — still
// showing A's files — would make its next request as B: "New folder" in A's top level would land
// in B's. The tab names A on every request; the Worker refuses the mismatch (403 identity_mismatch),
// nothing is created anywhere, and the tab starts again as B.
import { localDb, signedInUser } from "../setup/auth-fixtures";
import { expect, test } from "./fixtures";

test.describe("the identity pin", () => {
  test("a tab of A after the browser signed in as B: A's write is refused, nothing is created, the tab is B's", async ({
    page,
    clientIp,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "chromium", "one browser is enough; the sidebar names the account");
    const a = await signedInUser(page, { clientIp, name: "Ada Pinned" });
    await page.goto("/");
    // New folder (button and Shift+N) is offered once the listing is in, not when the frame shows.
    await expect(page.locator("[data-new-folder]")).toBeVisible();
    await expect(page.locator("[data-sidebar]")).toContainText("Ada Pinned");

    // Another tab of this browser signs in as B: the cookie jar is the context's, shared.
    const b = await signedInUser(page, { clientIp, name: "Bea Other" });
    expect(b.id).not.toBe(a.id);

    const name = `pinned-${Date.now()}`;
    const answered = page.waitForResponse(
      (response) => response.url().endsWith("/api/nodes/folder") && response.request().method() === "POST",
    );
    await page.keyboard.press("Shift+N");
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("textbox", { name: "Name" }).fill(name);
    await dialog.getByRole("button", { name: "Create", exact: true }).click();

    const response = await answered;
    expect(response.request().headers()["x-holdfast-user"]).toBe(a.id);
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({
      error: "forbidden",
      details: { reason: "identity_mismatch" },
    });

    // The tab adopted the browser's account: B's top level, B named, no toast about A's request.
    await expect(page.locator("[data-sidebar]")).toContainText("Bea Other");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator("[data-explorer]")).toBeVisible();
    await expect(page.locator("[data-item-id]").filter({ hasText: name })).toHaveCount(0);
    // Nothing was created, in either account.
    const created = await localDb((db) =>
      db.query<{ owner_id: string }>("SELECT owner_id FROM nodes WHERE name = $1", [name]),
    );
    expect(created.rows).toEqual([]);
  });
});
