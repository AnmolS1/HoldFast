// Every var and secret the Worker reads, with the explicit value the Workers test project gives it.
//
// The Vitest plugin loads the checkout's `.dev.vars` on its own. These values are layered on top
// (`miniflare.bindings`), so a test never sees a value from `.dev.vars`, and tests behave the same
// in every checkout and in CI. Nothing here is a real credential: the Turnstile pair is
// Cloudflare's published always-pass test pair, the rest are fixed placeholders.
//
// This module has no imports, so both the config (Node) and test files (workerd) can load it.

export const TEST_APP_ORIGIN = "http://localhost";
export const TEST_FILES_ORIGIN = "http://files.localhost";

export const testVars = {
  APP_ORIGIN: TEST_APP_ORIGIN,
  FILES_ORIGIN: TEST_FILES_ORIGIN,
  EMAIL_TRANSPORT: "memory",
  SCAN_STUB: "1",
  SENTRY_ENVIRONMENT: "test",
  SENTRY_DSN: "",
  SENTRY_DSN_WEB: "",
  TURNSTILE_SITEKEY: "1x00000000000000000000AA",
  TURNSTILE_SECRET: "1x0000000000000000000000000000000AA",
  // Placeholders with the shape of the real values (length, base64) and no entropy.
  BETTER_AUTH_SECRET: "test-better-auth-secret-000000000000000000000000",
  FILES_TOKEN_SECRET: "test-files-token-secret-000000000000000000000000",
  // base64 of the 32 bytes "test-ip-enc-key-0000000000000000"
  IP_ENC_KEY: "dGVzdC1pcC1lbmMta2V5LTAwMDAwMDAwMDAwMDAwMDA=",
  GOOGLE_CLIENT_ID: "test-google-client-id",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  RESEND_API_KEY: "test-resend-api-key",
  ADMIN_EMAILS: "admin@example.test",
  PHOTODNA_SUBSCRIPTION_KEY: "",
  CF_ANALYTICS_TOKEN: "",
} as const satisfies Record<string, string>;

export type TestVarName = keyof typeof testVars;

// ── the end-to-end run (vite dev) ────────────────────────────────────────────────────────────
// The e2e server reads the checkout's `.dev.vars`, whose ADMIN_EMAILS may be an operator's real
// address. No test uses that: Playwright hands the server this list instead (E2E_ADMIN_EMAILS,
// honoured in test mode only and only for reserved test domains). `*@domain` is every address
// at that domain, so each test makes an admin of its own — its own password, its own
// authenticator secret — and no two tests share an account.
export const E2E_ADMIN_DOMAIN = "admins.holdfast-e2e.example";
export const E2E_ADMIN_EMAILS = `*@${E2E_ADMIN_DOMAIN}`;
