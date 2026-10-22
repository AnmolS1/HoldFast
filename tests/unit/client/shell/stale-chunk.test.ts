// A chunk the deploy no longer has (`vite:preloadError`): one reload to the same address, never a
// loop, and never while a transfer would be lost — then a prompt instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { publish } from "../../../../src/client/components/TransferRibbon";
import {
  installStaleChunkReload,
  NEW_VERSION_TOAST,
  RELOAD_STAMP,
  RELOAD_WINDOW_MS,
  type StaleChunkDeps,
} from "../../../../src/client/lib/stale-chunk";
import { setupShell } from "./helpers";

setupShell();

let now = 0;
let reloads = 0;
let uninstall: () => void = () => {};
// Time and the reload are stood in for; "busy" is the real one (the transfer ribbon).
const deps: Partial<StaleChunkDeps> = {
  now: () => now,
  reload: () => {
    reloads += 1;
  },
};

const chunkFails = () => window.dispatchEvent(new Event("vite:preloadError"));

beforeEach(() => {
  now = 1_000_000;
  reloads = 0;
  window.history.replaceState({ usr: null, key: "default", idx: 0 }, "", "/folder/abc?sort=name");
  uninstall = installStaleChunkReload(deps);
});

afterEach(() => {
  uninstall();
  vi.restoreAllMocks();
});

describe("vite:preloadError", () => {
  it("reloads once, at the same address, keeping the router's entry state", () => {
    chunkFails();
    expect(reloads).toBe(1);
    expect(window.location.pathname + window.location.search).toBe("/folder/abc?sort=name");
    expect(window.history.state).toEqual({ usr: null, key: "default", idx: 0, [RELOAD_STAMP]: now });
    expect(getToasts()).toEqual([]);
  });

  it("a second failure on the same entry inside the window does not reload again", () => {
    chunkFails();
    now += RELOAD_WINDOW_MS - 1;
    chunkFails();
    chunkFails();
    expect(reloads).toBe(1);
  });

  it("after the window has passed it reloads again (the guard is a window, not a ban)", () => {
    chunkFails();
    now += RELOAD_WINDOW_MS;
    chunkFails();
    expect(reloads).toBe(2);
  });

  it("another entry (a navigation since) has no stamp: it reloads", () => {
    chunkFails();
    window.history.pushState({ usr: null, key: "next", idx: 1 }, "", "/trash");
    chunkFails();
    expect(reloads).toBe(2);
  });

  it("with an upload in progress it does not reload: it asks, and the prompt's Reload reloads", () => {
    publish("upload", { progress: 0.4, sentence: "Uploading 1 of 2", status: "active" });
    chunkFails();
    expect(reloads).toBe(0);
    const [prompt, ...others] = getToasts();
    expect(others).toEqual([]);
    expect(prompt).toMatchObject({
      key: NEW_VERSION_TOAST,
      message: "A new version of Holdfast is available.",
      action: { label: "Reload" },
    });
    // A second failure replaces the prompt rather than stacking another.
    chunkFails();
    expect(getToasts()).toHaveLength(1);
    prompt!.action!.onClick();
    expect(reloads).toBe(1);
  });

  it("a paused or failed upload counts too (the queue would be lost); a finished one does not", () => {
    publish("upload", { progress: 0.4, sentence: "Paused", status: "paused" });
    chunkFails();
    expect(reloads).toBe(0);
    publish("upload", { progress: 1, sentence: "Uploaded 2", status: "done" });
    chunkFails();
    expect(reloads).toBe(1);
  });

  it("when the entry cannot be stamped there is no reload (no loop guard, no reload)", () => {
    vi.spyOn(window.history, "replaceState").mockImplementation(() => {
      throw new DOMException("too many calls", "SecurityError");
    });
    chunkFails();
    expect(reloads).toBe(0);
  });

  it("stops listening when uninstalled", () => {
    uninstall();
    chunkFails();
    expect(reloads).toBe(0);
  });
});
