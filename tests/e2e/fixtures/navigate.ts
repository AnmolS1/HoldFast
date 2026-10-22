// Moving between pages of the app WITHOUT loading the document again.
//
// A page load from the dev server is ~320 module requests, and the browser's HTTP cache is off for
// any page with a `page.route()` mock (Playwright's rule) — so every load is a cold one: ~0.6 s
// here, 2.3–3.3 s on a CI runner (run 38552276163's trace). A test that only needs to BE on a page
// (to look at storage, overflow, an error state) gets there through the app's own router instead,
// as a click on a link would; a test whose subject is the deep link or the reload itself keeps
// `page.goto` / `page.reload`.
import type { Page } from "@playwright/test";

/** Navigate the app's router to `path` (path + search), the way a link inside the app does. */
export async function navigateInApp(page: Page, path: string): Promise<void> {
  await page.evaluate((to) => {
    // The router's own history-entry shape: { usr: state, key, idx }.
    const index = ((history.state as { idx?: number } | null)?.idx ?? 0) + 1;
    const key = Math.random().toString(36).slice(2, 10);
    history.pushState({ usr: null, key, idx: index }, "", to);
    window.dispatchEvent(new PopStateEvent("popstate", { state: history.state }));
  }, path);
  await page.waitForURL((url) => url.pathname + url.search === path);
}

/**
 * The budget for the FIRST thing a test asserts after a document load (`goto`, `reload`). That
 * assertion waits for the whole load — ~320 uncached module requests to ONE single-threaded dev
 * server, then the page's lazy chunk and its first API read — and with three browsers loading at
 * once it stalled past Playwright's default 5 s on a run at load 10–19 (a /signup load that takes
 * 2–3 s settled took 6.5 s; two runs, five tests: avseam's e2e3 and t27b's e2e). Not reproducible by
 * CPU load alone, so the budget is a measured margin (3× the slowest settled load seen), not a cure.
 */
export const DOCUMENT_LOAD = { timeout: 15_000 } as const;
