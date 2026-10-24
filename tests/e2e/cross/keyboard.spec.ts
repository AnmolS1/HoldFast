// Keyboard focus across features (R1 a11y-1, a11y-5, a11y-13), in the real browser: when the
// control that has focus is swapped out or disabled, focus goes to what replaced it — never to
// <body>, from where the next Tab starts again at the top of the page.
//
//   npm run e2e -- tests/e2e/cross/keyboard.spec.ts
//
// Desktop project only: these are keyboard journeys. Real API, this checkout's database; the one
// scripted answer is the avatar's `complete` (a scanner that is still starting).
import type { Page } from "@playwright/test";
import { nextTotpCode, signedInUser } from "../../setup/auth-fixtures";
import { expect, mockEnvelope, test } from "../fixtures";

test.beforeEach(({ isMobile }) => {
  test.skip(isMobile, "keyboard journeys run on the desktop layout");
});

/** What has focus: a short description, so a failure says where it went. */
const focusedOf = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return "BODY";
    return `${el.tagName}:${(el.textContent ?? "").trim().slice(0, 40)}`;
  });

/** Tab presses until `name` is focused (at most `limit`). */
async function tabTo(page: Page, target: ReturnType<Page["getByRole"]>, limit = 40): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) return;
    await page.keyboard.press("Tab");
  }
  await expect(target).toBeFocused();
}

test("two-factor setup by keyboard: the prompt opens on its field, each new block takes focus, Tab goes on from there", async ({
  page,
  clientIp,
}) => {
  test.slow();
  const user = await signedInUser(page, { clientIp });
  await page.goto("/account/security");
  const turnOn = page.getByRole("button", { name: "Turn on" });
  await tabTo(page, turnOn);
  await page.keyboard.press("Enter");

  // a11y-13: typing goes straight into the password field.
  const ask = page.getByRole("dialog", { name: "Set up two-factor authentication" });
  await expect(ask.getByLabel("Your password")).toBeFocused();
  await page.keyboard.type(user.password);
  await page.keyboard.press("Enter");

  // The setup form: its heading has focus, and the next Tab is the form's first control — not
  // "Skip to content" at the top of the page (V3's measurement before the fix).
  const setup = page.locator("[data-two-factor-setup]");
  await expect(setup.getByRole("heading", { name: "Set up two-factor authentication" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(setup.getByRole("link", { name: "Open in authenticator app" })).toBeFocused();

  const secret = (await page.locator("[data-totp-secret]").textContent())!.trim();
  await tabTo(page, setup.getByLabel("6-digit code"));
  await page.keyboard.type(await nextTotpCode(secret));
  await page.keyboard.press("Enter");

  const codes = page.locator("[data-backup-codes]");
  await expect(codes.getByRole("heading", { name: "Backup codes" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(codes.getByRole("button", { name: "Download codes" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(codes.getByRole("button", { name: "I've saved my codes" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "New backup codes" })).toBeFocused();
  expect(await focusedOf(page)).not.toBe("BODY");
});

test("avatar on a starting scanner: focus stays on the button while it checks, moves to Try again, and back", async ({
  page,
  clientIp,
}) => {
  test.slow();
  await signedInUser(page, { clientIp });
  let completes = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/uploads/*/complete", async (route) => {
    completes += 1;
    if (completes === 1) {
      await held;
      await route.fulfill({
        status: 503,
        headers: { "Retry-After": "30" },
        json: mockEnvelope("scanner_starting", "The virus scanner is starting up."),
      });
    } else await route.fallback();
  });
  await page.goto("/account");
  const upload = page.getByRole("button", { name: "Upload picture" });
  await tabTo(page, upload);
  const chooser = page.waitForEvent("filechooser");
  await page.keyboard.press("Enter");
  // A tiny made-up PNG signature (not a real picture: the scripted 503 answers it either way).
  await (
    await chooser
  ).setFiles({
    name: "me.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  });

  // Checking: the button says so, is unavailable, and still has focus.
  const checking = page.getByRole("button", { name: "Checking your picture…" });
  await expect(checking).toBeFocused();
  await expect(checking).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Space");
  await expect(checking).toBeFocused();
  release();

  // The scanner was starting: Try again appears and takes focus (it is where the person was).
  const tryAgain = page.getByRole("button", { name: "Try again" });
  await expect(tryAgain).toBeFocused();
  expect(completes).toBe(1);
  await page.keyboard.press("Enter");
  // Try again goes away; focus is back on the picture's button.
  await expect(tryAgain).toHaveCount(0);
  await expect(page.locator("[data-avatar-change]")).toBeFocused();
  expect(await focusedOf(page)).not.toBe("BODY");
});

test("an Undo toast holds while it has focus; once focus leaves, its time runs out and focus stays put", async ({
  page,
  clientIp,
}) => {
  test.slow();
  await signedInUser(page, { clientIp });
  await page.goto("/");
  // The page frame shows before the folder's listing answers, and until it does there is nothing
  // to add to: New folder (its button and Shift+N) waits for it. The button is the signal.
  await expect(page.locator("[data-new-folder]")).toBeVisible();
  await page.keyboard.press("Shift+N");
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Hold me");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("[data-item-id]:focus")).toContainText("Hold me");

  await page.keyboard.press("Delete");
  const toast = page.locator("[data-toaster] [data-toast]");
  const undo = toast.getByRole("button", { name: "Undo" });
  await tabTo(page, undo);
  // The passing of time IS the subject: longer than any undo toast's time (5–8 s), focused, it
  // is still there.
  await page.waitForTimeout(9000);
  await expect(undo).toBeFocused();
  await expect(toast).toHaveCount(1);

  // Focus leaves: the rest of its time runs out, and focus is where it went, not <body>.
  await page.locator("[data-user-menu]").focus();
  await expect(toast).toHaveCount(0, { timeout: 9000 });
  expect(await focusedOf(page)).not.toBe("BODY");
});
