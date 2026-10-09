// Proves the e2e harness itself: Playwright's own dev server answers on this checkout's port, the
// Worker's host dispatch agrees with .dev.vars, and the fixtures later specs build on work.
import { expect, expectNoA11yViolations, test } from "./fixtures";

test.describe("dev server", () => {
  test("serves the SPA at / with 200, not 421", async ({ page }) => {
    // 421 here means the server's port and .dev.vars' APP_ORIGIN disagree.
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["content-type"]).toMatch(/^text\/html/);
    // The shell alone is not proof: wait for React to render.
    await expect(page.getByRole("heading", { level: 1, name: "Holdfast" })).toBeVisible();
  });

  test("answers /__meta from the Worker", async ({ request }) => {
    // /__meta, not /api/health: health depends on the database and has its own tests.
    const meta = await request.get("/__meta");
    expect(meta.status()).toBe(200);
    expect(meta.headers()["content-type"]).toMatch(/^application\/json/);
    expect(await meta.json()).toMatchObject({
      project: "holdfast",
      commit: expect.any(String),
      branch: expect.any(String),
      builtAt: expect.any(String),
      version: expect.any(String),
    });
  });

  test("answers the files host with 404 text/plain and no cookie", async ({ page, origins }) => {
    // In the browser: Chromium resolves *.localhost to loopback, Node's resolver may not.
    const response = await page.goto(`${origins.files}/`);
    expect(response?.status()).toBe(404);
    expect(response?.headers()["content-type"]).toMatch(/^text\/plain/);
    expect(response?.headers()["set-cookie"]).toBeUndefined();
    // The body tells the files host's 404 apart from the 421 of an unknown host (also text/plain).
    expect(await response?.text()).toBe("Not found\n");

    // Never the SPA shell, on any path.
    const shell = await page.goto(`${origins.files}/index.html`);
    expect(shell?.status()).toBe(404);
    expect(shell?.headers()["content-type"]).toMatch(/^text\/plain/);
  });

  test("refuses a host that is neither origin with 421", async ({ request, origins }) => {
    const response = await request.get(`http://127.0.0.1:${origins.port}/`);
    expect(response.status()).toBe(421);
  });

  test("runs the scheduled handler through the local trigger path", async ({ request }) => {
    // The documented local trigger (every cron job's wiring check):
    //   curl "http://localhost:$HOLDFAST_PORT/cdn-cgi/handler/scheduled?cron=<url-encoded cron>"
    const response = await request.get("/cdn-cgi/handler/scheduled", { params: { cron: "3 * * * *" } });
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});

test.describe("fixtures", () => {
  test("virtual authenticator creates a passkey without a prompt", async ({ page, virtualAuthenticator }) => {
    await page.goto("/");
    const created = await page.evaluate(async () => {
      const credential = (await navigator.credentials.create({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rp: { id: "localhost", name: "Holdfast harness" },
          user: {
            id: crypto.getRandomValues(new Uint8Array(16)),
            name: "harness@example.test",
            displayName: "Harness",
          },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          authenticatorSelection: { residentKey: "required", userVerification: "required" },
        },
      })) as PublicKeyCredential | null;
      return credential ? { id: credential.id, type: credential.type } : null;
    });
    expect(created?.type).toBe("public-key");

    const credentials = await virtualAuthenticator.credentials();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ isResidentCredential: true, rpId: "localhost" });
  });

  test("axe finds no violations on the shell", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: "Holdfast" })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test("mobile project is below the 1024 px breakpoint", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile-chrome", "mobile project only");
    expect(page.viewportSize()!.width).toBeLessThan(1024);
  });
});
