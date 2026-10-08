// A virtual WebAuthn authenticator for passkey tests, through the Chrome DevTools Protocol
// (WebAuthn.enable + WebAuthn.addVirtualAuthenticator). Chromium only.
//
// With the default options it behaves like a platform passkey: it creates discoverable
// credentials, verifies the user, and answers every ceremony without a prompt.
import type { CDPSession, Page } from "@playwright/test";

export interface VirtualAuthenticatorOptions {
  protocol?: "ctap2" | "u2f";
  transport?: "internal" | "usb" | "nfc" | "ble";
  hasResidentKey?: boolean;
  hasUserVerification?: boolean;
  isUserVerified?: boolean;
  automaticPresenceSimulation?: boolean;
}

export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  userHandle?: string;
  signCount: number;
}

export interface VirtualAuthenticator {
  id: string;
  /** The credentials the authenticator holds now. */
  credentials(): Promise<VirtualCredential[]>;
  /** `false` makes the next ceremonies fail user verification (a wrong fingerprint). */
  setUserVerified(verified: boolean): Promise<void>;
  /** Forgets every credential (a passkey deleted on the device). */
  clearCredentials(): Promise<void>;
  remove(): Promise<void>;
}

export async function addVirtualAuthenticator(
  page: Page,
  options: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const session: CDPSession = await page.context().newCDPSession(page);
  await session.send("WebAuthn.enable");
  const { authenticatorId } = await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
      ...options,
    },
  });
  return {
    id: authenticatorId,
    async credentials() {
      const { credentials } = await session.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials;
    },
    async setUserVerified(isUserVerified) {
      await session.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified });
    },
    async clearCredentials() {
      await session.send("WebAuthn.clearCredentials", { authenticatorId });
    },
    async remove() {
      await session.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId });
      await session.send("WebAuthn.disable");
      await session.detach();
    },
  };
}
