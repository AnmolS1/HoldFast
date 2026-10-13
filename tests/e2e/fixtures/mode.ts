// The two ways an SPA spec runs.
//
//   MOCKED (the default)       no API behind the page: the spec answers `/api/*` itself, on top of
//                              `mockShell` (./mock-shell.ts), from its own fixture files. It proves
//                              the SPA against the CONTRACT, in a worktree where the API tasks are
//                              still placeholders.
//   REAL (HOLDFAST_E2E_REAL=1) nothing under `/api` is mocked: a real signed-in session
//                              (tests/setup/auth-fixtures.ts) against the Worker and this
//                              checkout's database, with rows the spec seeds. It proves the SPA
//                              against the API as built, on the integrated branch.
//
// One spec serves both: what differs is how it arranges its data, so that part branches on
// `REAL`; a test that only makes sense in one mode says so with `mockedOnly()` / `realOnly()`.
import { test } from "@playwright/test";

export const REAL = process.env.HOLDFAST_E2E_REAL === "1";

/** First line of a test or a describe block that needs the mocked API: skipped in REAL mode. */
export function mockedOnly(reason = "mocked mode only: the test scripts the API's answers"): void {
  test.skip(REAL, reason);
}

/** First line of a test or a describe block that needs the real API: skipped unless REAL. */
export function realOnly(reason = "real mode only: set HOLDFAST_E2E_REAL=1 (needs the API as built)"): void {
  test.skip(!REAL, reason);
}
