// The public /dmca page (T29 §B.2), signed out, against the real server. Every test is `@prod-safe`
// (ruling 2026-10-08): it creates nothing and signs in nowhere, so T28's remote read-only mode runs
// it against a deploy. The agent-details test SKIPS, with its reason, while agent.ts still carries
// the TODO_ sentinel — a HUMAN item of unknown date must not turn the suite red — and the gate runs
// (HOLDFAST_E2E_FAIL_ON_SKIP=1, tests/e2e/fixtures/skip-reporter.ts) fail on that skip, so it can
// never carry Gate B.
import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../src/shared/constants";
import { AGENT, AGENT_FIELDS, agentHasSentinel, SENTINEL } from "../../src/client/features/dmca/agent";
import { expect, expectNoA11yViolations, test } from "./fixtures";

async function openDmca(page: import("@playwright/test").Page) {
  await page.goto("/dmca");
  await expect(page.getByRole("heading", { level: 1, name: "Copyright and DMCA" })).toBeVisible();
}

test.describe("/dmca", () => {
  test("@prod-safe reachable signed out, outside the app frame, with its landmarks", async ({ page }) => {
    await openDmca(page);
    await expect(page).toHaveURL(/\/dmca$/);
    await expect(page.locator("[data-frame]")).toHaveCount(0);
    await expect(page.getByRole("main")).toHaveCount(1);
    await expect(page.getByRole("banner")).toHaveCount(1);
    await expect(page.getByRole("contentinfo")).toHaveCount(1);
    await expect(
      page.getByRole("navigation", { name: "Legal" }).getByRole("link", { name: "DMCA" }),
    ).toHaveAttribute("href", "/dmca");
    await expect(page.getByRole("heading", { level: 2 })).toHaveText([
      "Designated agent",
      "Sending a notice",
      "Counter-notice",
      "Repeat infringers",
      "False claims",
    ]);
    await expectNoA11yViolations(page);
  });

  test("@prod-safe the elements of a notice (§512(c)(3)) and the repeat-infringer policy", async ({
    page,
  }) => {
    await openDmca(page);
    const notice = page.getByRole("region", { name: "Sending a notice" });
    await expect(notice.getByRole("listitem")).toHaveCount(6);
    await expect(notice).toContainText(/signature/i);
    await expect(notice).toContainText(/good-faith belief/);
    await expect(notice).toContainText(/penalty of perjury/);
    const repeat = page.getByRole("region", { name: "Repeat infringers" });
    await expect(repeat).toContainText(`${STRIKES_TO_SUSPEND} strikes within ${STRIKE_WINDOW_DAYS} days`);
  });

  test("@prod-safe the counter-notice process and its 10–14 business-day window (§512(g))", async ({
    page,
  }) => {
    await openDmca(page);
    const counter = page.getByRole("region", { name: "Counter-notice" });
    await expect(counter.getByRole("listitem")).toHaveCount(4);
    await expect(counter).toContainText(/consent to the jurisdiction/);
    await expect(counter).toContainText("not less than 10 and not more than 14 business days");
  });

  // Never skips, in either state (a skip fails the gate run): while the sentinel is in agent.ts the
  // page says the registration is pending; at all times no sentinel reaches the served page —
  // text or attribute (DEMONOTICE, 2026-10-22).
  test("@prod-safe no sentinel on the page; registration pending while agent.ts has one", async ({ page }) => {
    await openDmca(page);
    const agent = page.getByRole("region", { name: "Designated agent" });
    const pending = agent.getByText("Designated agent registration pending");
    if (agentHasSentinel) {
      await expect(pending).toBeVisible();
      await expect(agent.getByRole("link")).toHaveCount(0);
    } else {
      await expect(pending).toHaveCount(0);
    }
    expect(await page.content()).not.toContain(SENTINEL);
  });

  test("@prod-safe the designated agent's details, exactly as registered", async ({ page }) => {
    test.skip(agentHasSentinel, "DMCA agent details not supplied yet (HUMAN, T29 §B.1)");
    await openDmca(page);
    const agent = page.getByRole("region", { name: "Designated agent" });
    for (const field of AGENT_FIELDS) {
      for (const line of AGENT[field].split("\n")) await expect(agent, field).toContainText(line);
    }
    await expect(agent.getByRole("link", { name: AGENT.email })).toHaveAttribute(
      "href",
      `mailto:${AGENT.email}`,
    );
    // No sentinel anywhere on the page — the page as served, not only agent.ts.
    await expect(page.locator("body")).not.toContainText(SENTINEL);
  });
});
