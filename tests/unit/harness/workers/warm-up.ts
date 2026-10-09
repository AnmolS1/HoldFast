// The first request to the Worker's own entry in a test file is slow, and not because of the
// request.
//
// `exports.default.fetch(...)` reaches src/worker/index.ts, which the test file itself does not
// import. The first call therefore makes the Workers pool load the entry and everything under it
// — the auth library, the database driver, the vendored domain list — one module at a time, in
// the calling test's time. Measured on this project: 4.1 s for the first request and 1–3 ms for
// the ones after it on an idle 14-core machine; 24 s with every core busy, 46 s at twice that.
// A test that happened to make the first call was being timed on the module load: 4.2 s of a
// 5 s limit on a good day, a timeout on a loaded one.
//
// So a file that calls the entry loads it first, here, under a limit of its own that fits a
// module load on a busy machine — and its tests keep the default limit, which then measures the
// request. (Raising a test's own timeout instead would hide a request that really is slow.)
import { exports } from "cloudflare:workers";
import { TEST_APP_ORIGIN } from "../../../setup/test-vars";

/** For `beforeAll(warmWorker, WARM_UP_TIMEOUT_MS)`: generous, and still a bound. */
export const WARM_UP_TIMEOUT_MS = 120_000;

/** Loads the Worker entry. `/__meta` touches no database and no binding. */
export async function warmWorker(): Promise<void> {
  const response = await exports.default.fetch(`${TEST_APP_ORIGIN}/__meta`);
  await response.arrayBuffer();
}
