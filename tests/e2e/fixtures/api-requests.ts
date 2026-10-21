// Counts a page's requests to the app's /api — the "count requests over time" check (Wave-3
// standing check (c)): a quiet minute on an idle page, a folder upload while scans are pending,
// nothing before a Retry-After.
//
//   test("…", async ({ page, apiRequests }) => {
//     const mark = apiRequests.mark();
//     await clock.advance(60_000);
//     expect(apiRequests.since(mark).length).toBeLessThanOrEqual(2);
//   });
//
// Every request the page STARTS (its frames and its workers — Playwright's `page.on("request")`) is
// counted, answered or not, mocked or not: what is measured is what the client asks for.
import type { Page, Request } from "@playwright/test";

export interface ApiRequest {
  method: string;
  /** Path and search, e.g. /api/nodes/root?limit=50 */
  path: string;
  /** When it started (Date.now() of the test process). */
  at: number;
}

export interface ApiRequests {
  /** Everything counted so far, oldest first. */
  all(): readonly ApiRequest[];
  /** A position to count from. */
  mark(): number;
  /** What was asked for after `mark`, optionally only what `filter` keeps. */
  since(mark: number, filter?: (request: ApiRequest) => boolean): ApiRequest[];
}

export function countApiRequests(page: Page, appOrigin: string): ApiRequests {
  const seen: ApiRequest[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    if (url.origin !== appOrigin || !url.pathname.startsWith("/api/")) return;
    seen.push({ method: request.method(), path: url.pathname + url.search, at: Date.now() });
  });
  return {
    all: () => seen,
    mark: () => seen.length,
    since: (mark, filter) => seen.slice(mark).filter((request) => (filter ? filter(request) : true)),
  };
}
