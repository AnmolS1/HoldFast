// Playwright fixtures of the harness. Specs import `test` and `expect` from here.
//
//   import { expect, test } from "./fixtures";
//
// Signed-in fixtures (signedInUser, signedInAdmin2fa) are not here: they live in
// tests/setup/auth-fixtures.ts and build on these. A MOCKED signed-in session for specs of the
// SPA is `mockShell` (./mock-shell.ts); which of the two a spec uses is `REAL` (./mode.ts).
import { test as base } from "@playwright/test";
import { appOrigin, e2ePort, filesOrigin } from "../../setup/local-env";
import { addVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn";

export interface HarnessFixtures {
  /** A virtual passkey authenticator attached to `page`, removed after the test. */
  virtualAuthenticator: VirtualAuthenticator;
  /** This checkout's two origins, e.g. http://localhost:5173 and http://files.localhost:5173. */
  origins: { app: string; files: string; port: number };
  /**
   * A client address of this test's own, for the browser's requests to the app origin. NOT
   * automatic: a test (or a fixture built on this one) asks for it by naming `clientIp`.
   * The Worker rate-limits by client address (`cf-connecting-ip`, which Cloudflare sets at the
   * edge and a local server takes from the request); without this a test is 127.0.0.1 like every
   * other. That shared address is the default on purpose — the suite then exercises the limits
   * the way one busy network would, and it is how the session read spending the sign-in limit
   * was found. Ask for an address only where a test must not share a bucket: one that signs in
   * (20 auth writes a minute per address) or that exhausts a limit deliberately.
   */
  clientIp: string;
}

/** See the `page` fixture below. */
export const MAX_APP_LOADS_PER_TEST = 4;

/** A stable private address per test and attempt: 10.x.y.z from a hash of the test's id. */
function addressFor(seed: string): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const bytes = hash >>> 0;
  return `10.${(bytes >>> 16) & 255}.${(bytes >>> 8) & 255}.${bytes & 255}`;
}

export const test = base.extend<HarnessFixtures>({
  // Every test is held to a few loads of the app document: each is cold (see ./navigate.ts) and
  // costs 2.3–3.3 s on a CI runner, so more than this many put a test near its 30 s on a slow
  // machine. Plain-text answers (a 404 of the files host) are not counted.
  page: async ({ page }, use, testInfo) => {
    // HOLDFAST_E2E_CPU_THROTTLE=<n>: the browser runs n times slower (Chromium), to see locally
    // what a slow CI runner does to a test.
    const throttle = Number(process.env.HOLDFAST_E2E_CPU_THROTTLE ?? "");
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    const loads: string[] = [];
    page.on("response", (response) => {
      const request = response.request();
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      if (!(response.headers()["content-type"] ?? "").includes("text/html")) return;
      loads.push(new URL(response.url()).pathname);
    });
    await use(page);
    if (loads.length > MAX_APP_LOADS_PER_TEST && testInfo.status === testInfo.expectedStatus) {
      throw new Error(
        `${loads.length} loads of the app in one test (at most ${MAX_APP_LOADS_PER_TEST}): ${loads.join(", ")}. ` +
          "Reach pages that are not the subject with navigateInApp (tests/e2e/fixtures/navigate.ts).",
      );
    }
  },
  virtualAuthenticator: async ({ page }, use) => {
    const authenticator = await addVirtualAuthenticator(page);
    await use(authenticator);
    await authenticator.remove().catch(() => {
      // The page may already be closed.
    });
  },
  clientIp: [
    async ({ context }, use, testInfo) => {
      const ip = addressFor(`${testInfo.project.name}|${testInfo.testId}|${testInfo.retry}`);
      const app = appOrigin(e2ePort());
      // Browser requests to the app origin only. A spec's own page.route() mocks run first and
      // are untouched; what they pass on, and everything unmocked, carries the address.
      await context.route(`${app}/**`, (route) =>
        route.continue({ headers: { ...route.request().headers(), "cf-connecting-ip": ip } }),
      );
      await use(ip);
    },
    { auto: false },
  ],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
  origins: async ({}, use) => {
    const port = e2ePort();
    await use({ app: appOrigin(port), files: filesOrigin(port), port });
  },
});

export { expect } from "@playwright/test";
export { expectNoA11yViolations } from "./axe";
export { navigateInApp } from "./navigate";
export {
  E2E_DIST,
  MOCK_USER,
  mockEnvelope,
  mockShell,
  serveBuild,
  type MockShellOptions,
  type MockUser,
} from "./mock-shell";
export { mockedOnly, REAL, realOnly } from "./mode";
export { clearOutbox, latestMailTo, linksIn } from "./outbox";
export { stubTurnstile } from "./turnstile";
export { addVirtualAuthenticator } from "./webauthn";
