// Playwright fixtures of the harness. Specs import `test` and `expect` from here.
//
//   import { expect, test } from "./fixtures";
//
// Signed-in fixtures (signedInUser, signedInAdmin2fa) are not here: they live in
// tests/setup/auth-fixtures.ts and build on these.
import { test as base } from "@playwright/test";
import { appOrigin, e2ePort, filesOrigin } from "../../setup/local-env";
import { addVirtualAuthenticator, type VirtualAuthenticator } from "./webauthn";

export interface HarnessFixtures {
  /** A virtual passkey authenticator attached to `page`, removed after the test. */
  virtualAuthenticator: VirtualAuthenticator;
  /** This checkout's two origins, e.g. http://localhost:5173 and http://files.localhost:5173. */
  origins: { app: string; files: string; port: number };
  /**
   * The client address this test's browser is seen as. Automatic: every test is its own client.
   * The Worker rate-limits by client IP (`cf-connecting-ip`, which Cloudflare sets at the edge and
   * a local server takes from the request). Without this every test would share 127.0.0.1 and
   * one bucket — and the auth limiter (20 requests a minute per IP, session reads included) runs
   * out part-way through a run, failing whichever unmocked test comes next.
   */
  clientIp: string;
}

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
    { auto: true },
  ],
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring pattern.
  origins: async ({}, use) => {
    const port = e2ePort();
    await use({ app: appOrigin(port), files: filesOrigin(port), port });
  },
});

export { expect } from "@playwright/test";
export { expectNoA11yViolations } from "./axe";
export { clearOutbox, latestMailTo, linksIn } from "./outbox";
export { stubTurnstile } from "./turnstile";
export { addVirtualAuthenticator } from "./webauthn";
