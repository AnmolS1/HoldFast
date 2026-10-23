// The closed-test notice on the sign-up screen (DEMONOTICE, 2026-10-22), in a real browser: the
// public config is mocked (`demoMode` on / off) — the settings table is shared by every e2e worker,
// so no test writes it. The server's refusal without the assent is tests/unit/auth/demo-notice.test.ts.
import { expect, expectNoA11yViolations, mockShell, stubTurnstile, test } from "./fixtures";

const NOTICE =
  "Holdfast is in a closed test. Don't store anything important — files may be deleted when the test ends. Report problems to support@holdfast.ponderance.dev.";

test.describe("sign-up: the closed-test notice", () => {
  test("demo mode on: the notice and its checkbox, reachable and operable by keyboard, with an error tied to it; no a11y violations", async ({
    page,
    origins,
  }) => {
    await stubTurnstile(page);
    await mockShell(page, origins.port, { user: null, config: { demoMode: true } });
    await page.goto("/signup");
    await expect(page.getByRole("heading", { level: 1, name: "Create your account" })).toBeVisible();
    await expect(page.locator("[data-demo-notice]")).toHaveText(NOTICE);
    const box = page.getByRole("checkbox", { name: "I understand" });
    await expect(box).not.toBeChecked();
    await expect(box).toHaveAccessibleDescription(NOTICE);
    await expectNoA11yViolations(page);

    // Submitting without it: the error is announced and describes the checkbox.
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Accept the closed-test notice to continue.")).toBeVisible();
    await expect(box).toHaveAttribute("aria-invalid", "true");
    await expect(box).toHaveAccessibleDescription(`${NOTICE} Accept the closed-test notice to continue.`);

    // Keyboard: Tab from the terms checkbox reaches it (past the two links in the terms line), and
    // Space ticks it.
    await page.locator('input[name="acceptTerms"]').focus();
    for (const stop of ["Terms", "Privacy Policy"]) {
      await page.keyboard.press("Tab");
      await expect(page.locator(":focus")).toHaveText(stop);
    }
    await page.keyboard.press("Tab");
    await expect(box).toBeFocused();
    await page.keyboard.press("Space");
    await expect(box).toBeChecked();
    await expectNoA11yViolations(page);
  });

  test("demo mode off: no notice, no checkbox", async ({ page, origins }) => {
    await stubTurnstile(page);
    await mockShell(page, origins.port, { user: null, config: { demoMode: false } });
    await page.goto("/signup");
    await expect(page.getByLabel("Invite code")).toBeVisible();
    await expect(page.locator("[data-demo-notice]")).toHaveCount(0);
    await expect(page.locator('input[name="acceptDemo"]')).toHaveCount(0);
  });
});
