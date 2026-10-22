// S-B1 (T27B, authorised seam): browser error reporting starts on EVERY entry page — a cold
// /s/<token> included, where the public routes have no loader and read no session — from the
// app's own bootstrap (`main.tsx`), exactly once. Each test boots the real entry module in a
// fresh module graph at its own address; `initSentry` is spied (no SDK is loaded), and CSP and
// redaction are not touched here (lib/sentry.ts is unchanged).
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONFIG, sessionOf, setupShell, shellFetch } from "./helpers";

vi.mock("../../../../src/client/lib/sentry", async (original) => {
  const real = await original<typeof import("../../../../src/client/lib/sentry")>();
  return { ...real, initSentry: vi.fn(async () => false) };
});

setupShell();

const DSN = "https://made-up-key@o0.ingest.sentry.io/0"; // made up

async function boot(path: string) {
  window.history.replaceState(null, "", path);
  document.body.innerHTML = '<div id="root"></div>';
  vi.resetModules();
  // The mocked module (and its spy) outlives resetModules: count this boot's calls only.
  const sentry = await import("../../../../src/client/lib/sentry");
  vi.mocked(sentry.initSentry).mockClear();
  await import("../../../../src/client/main");
  return vi.mocked(sentry.initSentry);
}

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("browser Sentry starts from the bootstrap on every entry page", () => {
  it("a cold /s/<token> entry calls initSentry exactly once, with the public config", async () => {
    shellFetch({ session: null, config: { sentryDsnWeb: DSN } });
    const initSentry = await boot("/s/abc123");
    await waitFor(() => expect(document.querySelector("[data-public-link-page]")).not.toBeNull());
    await waitFor(() => expect(initSentry).toHaveBeenCalledTimes(1));
    expect(initSentry.mock.calls[0]![0]).toMatchObject({ sentryDsnWeb: DSN, release: CONFIG.release });
  });

  it("CONTROL: a signed-in entry on a guarded page (the router's config loader runs too) still calls it exactly once", async () => {
    shellFetch({ session: sessionOf(), config: { sentryDsnWeb: DSN } });
    const initSentry = await boot("/recent");
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    await waitFor(() => expect(initSentry).toHaveBeenCalled());
    // Give a second caller every chance to show up before counting.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(initSentry).toHaveBeenCalledTimes(1);
  });
});
