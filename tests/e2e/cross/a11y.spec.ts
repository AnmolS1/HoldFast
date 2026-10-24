// Accessibility across features (R1 a11y-2, a11y-4, a11y-7, a11y-14), in the real browser:
//   - phone targets are at least D01 §7's 44 px (preferences, the share dialog, the admin grid);
//   - the screens and states that had no axe test are axe-clean (light): two-factor setup, the
//     avatar's checking and retry states, the share dialog, help / storage / starred / recent /
//     search / trash, and the twelve admin pages;
//   - a text field's resting outline is ≥ 3:1 against what is around it, measured in BOTH schemes.
//
//   npm run e2e -- tests/e2e/cross/a11y.spec.ts
//
// Dark mode: axe is not the instrument here — a dark-mode `analyze()` can hang the worker
// (fixtures/axe.ts). The dark scan below is bounded by a timeout and reported, not trusted; the
// field outline is measured from computed styles instead, and the token pairs by theme-contrast.test.ts.
import type { Locator, Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { signedInUser } from "../../setup/auth-fixtures";
import { expect, expectNoA11yViolations, mockEnvelope, navigateInApp, test } from "../fixtures";

const TOUCH_TARGET = 44;

/** Every element of `locator` is at least `min` px tall — and there is at least one. */
async function expectTall(locator: Locator, min: number, what: string): Promise<void> {
  const boxes = await locator.evaluateAll((elements) =>
    elements.map((el) => ({
      text: (el.textContent ?? el.getAttribute("aria-label") ?? "").trim().slice(0, 30),
      height: el.getBoundingClientRect().height,
    })),
  );
  expect(boxes.length, `${what}: nothing matched`).toBeGreaterThan(0);
  const short = boxes.filter((box) => box.height < min - 0.5);
  expect(short, `${what} under ${min} px`).toEqual([]);
}

/** Wait for an admin page to have its data (no skeleton left). */
async function settled(page: Page): Promise<void> {
  await expect(page.locator("[data-admin-page]")).toBeVisible();
  await expect(page.locator(".MuiSkeleton-root")).toHaveCount(0);
}

const ADMIN_PAGES = [
  "/admin",
  "/admin/users",
  "/admin/reports",
  "/admin/quarantine",
  "/admin/kept-uploads",
  "/admin/lock-csam",
  "/admin/dmca",
  "/admin/links",
  "/admin/invites",
  "/admin/audit",
  "/admin/settings",
  "/admin/system",
] as const;

test.describe("phone targets", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(!isMobile, "the 44 px rule is for the phone layout");
  });

  test("preference radios and switches, the share dialog's role select and the admin grid are ≥ 44 px tall", async ({
    page,
    roles,
  }) => {
    test.slow();
    const owner = await roles.owner();
    await page.goto("/account/preferences");
    await expect(page.getByRole("heading", { name: "Appearance" })).toBeVisible();
    await expectTall(
      page.locator(
        "[data-account-page] label:has(input[type=radio]), [data-account-page] label:has(input[type=checkbox])",
      ),
      TOUCH_TARGET,
      "preference radio / switch rows",
    );

    await navigateInApp(page, "/");
    const row = page.locator("[data-item-id]").filter({ hasText: owner.folderName });
    await row.getByRole("button", { name: `More actions for ${owner.folderName}` }).click();
    // The phone's row menu is a bottom sheet of buttons.
    await page.getByRole("dialog").getByRole("button", { name: "Share or get link" }).click();
    const dialog = page.locator("[data-share-dialog]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox").first()).toBeVisible();
    await expectTall(dialog.getByRole("combobox"), TOUCH_TARGET, "share dialog role select");

    const admin = await roles.admin();
    await admin.page.goto("/admin/users");
    await settled(admin.page);
    // The grid may not have mounted yet when no skeleton is left (the skeletons come and go with
    // the users query): measure once its headers are there.
    await expect(admin.page.getByRole("columnheader").first()).toBeVisible();
    await expectTall(admin.page.getByRole("combobox"), TOUCH_TARGET, "admin selects");
    await expectTall(admin.page.getByRole("columnheader"), TOUCH_TARGET, "admin column headers");
  });
});

test.describe("axe (light) where there was none", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, "the light axe sweeps run once, on the desktop layout");
  });

  test("two-factor setup and codes, the avatar's checking and retry states, the share dialog", async ({
    page,
    roles,
  }) => {
    test.slow();
    const owner = await roles.owner();

    // Avatar: `complete` is held, then answered "the scanner is starting".
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/uploads/*/complete", async (route) => {
      await held;
      await route.fulfill({
        status: 503,
        headers: { "Retry-After": "30" },
        json: mockEnvelope("scanner_starting", "The virus scanner is starting up."),
      });
    });
    await page.goto("/account");
    const chooser = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload picture" }).click();
    // A made-up PNG signature; the scripted answer does not look at it.
    await (
      await chooser
    ).setFiles({
      name: "me.png",
      mimeType: "image/png",
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    });
    await expect(page.getByRole("button", { name: "Checking your picture…" })).toBeVisible();
    await expectNoA11yViolations(page);
    release();
    await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
    await expectNoA11yViolations(page);

    // Two-factor: the setup form, then (its Cancel) back; the codes need a real code, which the
    // keyboard spec and account.spec.ts drive — the form is what had no axe test.
    await navigateInApp(page, "/account/security");
    await page.getByRole("button", { name: "Turn on" }).click();
    const ask = page.getByRole("dialog", { name: "Set up two-factor authentication" });
    await expectNoA11yViolations(page);
    await ask.getByLabel("Your password").fill(owner.user.password);
    await ask.getByRole("button", { name: "Continue" }).click();
    await expect(page.locator("[data-two-factor-setup]")).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expectNoA11yViolations(page);

    // The share dialog, from the folder's menu.
    await navigateInApp(page, "/");
    await page.locator("[data-item-id]").filter({ hasText: owner.folderName }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "Share or get link" }).click();
    await expect(page.locator("[data-share-dialog]")).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("help, storage, starred, recent, search and trash", async ({ page, clientIp }) => {
    await signedInUser(page, { clientIp });
    await page.goto("/help");
    await expect(page.locator("main, [data-main]").first()).toBeVisible();
    for (const path of ["/help", "/storage", "/starred", "/recent", "/search?q=a", "/trash"]) {
      if (path !== "/help") await navigateInApp(page, path);
      await expect(page.locator("[data-main]")).toBeVisible();
      await expect(page.locator(".MuiSkeleton-root")).toHaveCount(0);
      await expectNoA11yViolations(page);
    }
  });

  test("the twelve admin pages", async ({ roles }) => {
    test.slow();
    const { page } = await roles.admin();
    await page.goto(ADMIN_PAGES[0]);
    for (const path of ADMIN_PAGES) {
      if (path !== ADMIN_PAGES[0]) await navigateInApp(page, path);
      await settled(page);
      await expectNoA11yViolations(page);
    }
  });
});

test.describe("text-field outlines, both schemes", () => {
  test.beforeEach(({ isMobile }) => {
    test.skip(isMobile, "colours do not depend on the layout");
  });

  /** In the page: each visible outlined field's resting outline against its fill and its surroundings. */
  const outlineRatios = (page: Page) =>
    page.evaluate(() => {
      const rgb = (value: string) => (value.match(/[\d.]+/g) ?? []).map(Number);
      const channel = (v: number) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      };
      const lum = ([r, g, b]: number[]) => 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
      const ratio = (a: number[], b: number[]) => {
        const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
        return (hi + 0.05) / (lo + 0.05);
      };
      /** The first opaque background at or above `el`. */
      const ground = (el: Element | null): number[] => {
        for (let node = el; node; node = node.parentElement) {
          const value = rgb(getComputedStyle(node).backgroundColor);
          if (value.length >= 3 && (value[3] === undefined || value[3] === 1)) return value.slice(0, 3);
        }
        return [255, 255, 255];
      };
      return [...document.querySelectorAll(".MuiOutlinedInput-root")]
        .filter((root) => root.getBoundingClientRect().height > 0)
        .map((root) => {
          const outline = rgb(
            getComputedStyle(root.querySelector(".MuiOutlinedInput-notchedOutline")!).borderTopColor,
          );
          return {
            fill: ratio(outline, ground(root)),
            outside: ratio(outline, ground(root.parentElement)),
          };
        });
    });

  for (const scheme of ["light", "dark"] as const) {
    test(`${scheme}: the sign-in fields' outlines are ≥ 3:1 (and a dark axe scan, bounded)`, async ({
      page,
    }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto("/login");
      await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute(`data-${scheme}`);
      const ratios = await outlineRatios(page);
      expect(ratios.length).toBeGreaterThan(0);
      for (const { fill, outside } of ratios) {
        expect(fill).toBeGreaterThanOrEqual(3);
        expect(outside).toBeGreaterThanOrEqual(3);
      }
      if (scheme === "dark") {
        // Bounded: a hang is reported as a note, never as a pass of the scan.
        const scan = new AxeBuilder({ page }).withTags(["wcag2aa", "wcag21aa"]).analyze();
        const result = await Promise.race([
          scan,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (result === null)
          test.info().annotations.push({ type: "dark axe", description: "timed out after 20 s" });
        else expect(result.violations.map((v) => v.id)).toEqual([]);
      }
    });
  }
});
