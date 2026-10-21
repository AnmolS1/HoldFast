// Playwright fixtures of the harness. Specs import `test` and `expect` from here.
//
//   import { expect, test } from "./fixtures";
//
// Signed-in fixtures (signedInUser, signedInAdmin2fa) are not here: they live in
// tests/setup/auth-fixtures.ts and build on these. A MOCKED signed-in session for specs of the
// SPA is `mockShell` (./mock-shell.ts); which of the two a spec uses is `REAL` (./mode.ts).
import { test as base } from "@playwright/test";
import { appOrigin, e2ePort, filesOrigin } from "../../setup/local-env";
import { remoteMode, remoteOrigins } from "./remote";
import { rolesFor, type Roles } from "./roles";
import { ROUTE_COVERAGE, watchContext, watchRequests } from "./route-hits";
import { addressFor } from "./address";
import { countApiRequests, type ApiRequests } from "./api-requests";
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
  /** Signed-in pages per role — owner, editor, viewer, admin with 2FA — made when asked for (./roles.ts). */
  roles: Roles;
  /** The `page`'s requests to the app's /api, counted from the start of the test (./api-requests.ts). */
  apiRequests: ApiRequests;
}

export interface HarnessWorkerFixtures {
  /**
   * Route coverage (./route-hits.ts): with HOLDFAST_ROUTE_COVERAGE=1, every answer the Worker gives
   * a test of this worker is recorded. Automatic; unset, it does nothing at all.
   */
  routeHits: void;
}

/** See the `page` fixture below. */
export const MAX_APP_LOADS_PER_TEST = 4;

function coverageOrigins(): { app: string; files: string } {
  const port = e2ePort();
  return { app: appOrigin(port), files: filesOrigin(port) };
}

export const test = base.extend<HarnessFixtures, HarnessWorkerFixtures>({
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
  // Route coverage (./route-hits.ts). Each only watches, and only with HOLDFAST_ROUTE_COVERAGE=1.
  context: async ({ context }, use) => {
    if (ROUTE_COVERAGE) {
      watchContext(context, coverageOrigins());
      watchRequests(context.request, coverageOrigins());
    }
    await use(context);
  },
  request: async ({ request }, use) => {
    if (ROUTE_COVERAGE) watchRequests(request, coverageOrigins());
    await use(request);
  },
  browser: [
    async ({ browser }, use) => {
      if (ROUTE_COVERAGE) {
        // Contexts a test makes for itself (a second user, a signed-out visitor).
        const newContext = browser.newContext.bind(browser);
        browser.newContext = async (...args) => {
          const context = await newContext(...args);
          watchContext(context, coverageOrigins());
          watchRequests(context.request, coverageOrigins());
          return context;
        };
      }
      await use(browser);
    },
    { scope: "worker" },
  ],
  routeHits: [
    async ({ playwright }, use) => {
      if (ROUTE_COVERAGE) {
        // API contexts a test makes for itself (`playwright.request.newContext()`).
        const factory = playwright.request;
        const newContext = factory.newContext.bind(factory);
        factory.newContext = async (...args) => {
          const api = await newContext(...args);
          watchRequests(api, coverageOrigins());
          return api;
        };
      }
      await use();
    },
    { scope: "worker", auto: true },
  ],
  roles: async ({ page, browser }, use, testInfo) => {
    const roles = rolesFor({ page, browser, testInfo, maxLoads: MAX_APP_LOADS_PER_TEST });
    await use(roles);
    await roles.close();
  },
  apiRequests: async ({ page }, use) => {
    await use(countApiRequests(page, appOrigin(e2ePort())));
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
  origins: async ({}, use) => {
    // A remote run (./remote.ts): the deploy's origins.
    const remote = remoteMode();
    if (remote !== null) return use(await remoteOrigins(remote));
    const port = e2ePort();
    await use({ app: appOrigin(port), files: filesOrigin(port), port });
  },
});

export { expect } from "@playwright/test";
export { expectNoA11yViolations } from "./axe";
export type { ApiRequest, ApiRequests } from "./api-requests";
export { testClock, TEST_NOW_HEADER, type TestClock } from "./clock";
export type { AdminPage, OwnerPage, RolePage, Roles, ShareRole } from "./roles";
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
