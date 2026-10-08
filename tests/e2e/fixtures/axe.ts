// Accessibility check with axe-core.
//
// Run it in LIGHT mode only. A dark-mode `analyze()` can hang the Playwright worker and then
// shows up as a timeout in a neighbouring test; dark contrast is asserted as a unit test over the
// theme tokens instead.
import { AxeBuilder } from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";

export interface A11yOptions {
  /** CSS selectors to leave out (third-party widgets such as the Turnstile iframe). */
  exclude?: string[];
  /** Rule ids to switch off, each with a reason in the calling test. */
  disableRules?: string[];
}

export async function expectNoA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  await page.emulateMedia({ colorScheme: "light" });
  let builder = new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]);
  for (const selector of options.exclude ?? []) builder = builder.exclude(selector);
  if (options.disableRules?.length) builder = builder.disableRules(options.disableRules);
  const { violations } = await builder.analyze();
  const summary = violations.map(
    (v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`,
  );
  expect(summary, "accessibility violations").toEqual([]);
}
