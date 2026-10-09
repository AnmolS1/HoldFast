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
}

export const test = base.extend<HarnessFixtures>({
  virtualAuthenticator: async ({ page }, use) => {
    const authenticator = await addVirtualAuthenticator(page);
    await use(authenticator);
    await authenticator.remove().catch(() => {
      // The page may already be closed.
    });
  },
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
