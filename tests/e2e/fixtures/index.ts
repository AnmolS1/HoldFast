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
export { clearOutbox, latestMailTo, linksIn } from "./outbox";
export { stubTurnstile } from "./turnstile";
export { addVirtualAuthenticator } from "./webauthn";
