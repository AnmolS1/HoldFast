// Lighthouse CI's puppeteerScript: before each URL, the browser is signed in as the seeded user
// (scripts/lhci/seed-user.ts wrote the made-up credentials to $LHCI_CREDENTIALS), so `/` is
// measured as a signed-in user sees it. `/login` is measured signed OUT: the session is ended
// first. The sign-in is the SPA's own request (same origin, the Turnstile test token the local
// server accepts) — no cookie is copied in from outside, nothing secret is printed.
/* global require, module, process, URL, fetch -- CommonJS for Lighthouse CI; eslint.config's Node block names .js/.mjs/.ts only */
// eslint-disable-next-line @typescript-eslint/no-require-imports -- LHCI loads this file with require()
const { readFileSync } = require("node:fs");

/** @param {import("puppeteer-core").Browser} browser @param {{ url: string }} context */
module.exports = async (browser, context) => {
  const target = new URL(context.url);
  const credentialsFile = process.env.LHCI_CREDENTIALS;
  if (!credentialsFile) throw new Error("sign-in.cjs: LHCI_CREDENTIALS (the seeded user's file) is not set");
  const { email, password } = JSON.parse(readFileSync(credentialsFile, "utf8"));
  const page = await browser.newPage();
  try {
    // A same-origin document with no Content-Security-Policy of its own (an API answer's
    // `default-src 'none'` would refuse the fetch below): the web manifest, a static file.
    await page.goto(`${target.origin}/manifest.webmanifest`);
    const status = await page.evaluate(
      async ({ email, password, signOut }) => {
        const post = (path, body, headers = {}) =>
          fetch(path, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json", ...headers },
            body: JSON.stringify(body),
          });
        if (signOut) return (await post("/api/auth/sign-out", {})).status;
        // The Turnstile test token: accepted by the local server's test secret only.
        return (
          await post(
            "/api/auth/sign-in/email",
            { email, password },
            { "x-captcha-response": "XXXX.DUMMY.TOKEN.XXXX" },
          )
        ).status;
      },
      { email, password, signOut: target.pathname === "/login" },
    );
    if (status !== 200)
      throw new Error(
        `sign-in.cjs: ${target.pathname === "/login" ? "sign-out" : "sign-in"} answered ${status}`,
      );
  } finally {
    await page.close();
  }
};
