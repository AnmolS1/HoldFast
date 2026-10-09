import { describe, expect, it, vi } from "vitest";
import {
  getPrefs,
  MODE_KEY,
  PREFS_KEY,
  registerPrefsSync,
  resetPrefsForTests,
  sanitizePrefs,
  setPrefs,
  SYNC_DEBOUNCE_MS,
  type Prefs,
} from "../../../../src/client/lib/prefs";
import { purgeUserState } from "../../../../src/client/lib/query";
import { flush, mockFetch, setupShell } from "./helpers";

setupShell();

describe("prefs: local only", () => {
  it("defaults", () => {
    expect(getPrefs()).toEqual({ theme: "system", density: "compact", viewMode: "list" });
  });

  it("a change is written to localStorage at once and makes no request", () => {
    const calls = mockFetch(() => undefined);
    setPrefs({ viewMode: "grid", density: "comfortable" });
    expect(getPrefs()).toMatchObject({ viewMode: "grid", density: "comfortable" });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      density: "comfortable",
      viewMode: "grid",
    });
    expect(document.documentElement.getAttribute("data-density")).toBe("comfortable");
    expect(calls).toEqual([]);
  });

  it("the theme lives under the UI library's mode key — the one the first-paint script reads", () => {
    setPrefs({ theme: "dark" });
    expect(localStorage.getItem(MODE_KEY)).toBe("dark");
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).not.toHaveProperty("theme");
    resetPrefsForTests();
    expect(getPrefs().theme).toBe("dark");
  });

  it("survives a reload (re-read from storage)", () => {
    setPrefs({ viewMode: "grid" });
    resetPrefsForTests();
    expect(getPrefs().viewMode).toBe("grid");
  });

  it("ignores junk in storage and unknown values", () => {
    localStorage.setItem(PREFS_KEY, '{"viewMode":"cinema","density":7,"token":"secret"}');
    localStorage.setItem(MODE_KEY, "sepia");
    resetPrefsForTests();
    expect(getPrefs()).toEqual({ theme: "system", density: "compact", viewMode: "list" });
    localStorage.setItem(PREFS_KEY, "not json");
    resetPrefsForTests();
    expect(getPrefs().viewMode).toBe("list");
    expect(sanitizePrefs({ theme: "dark", extra: 1 })).toEqual({ theme: "dark" });
  });

  it("only the two known keys are ever written", () => {
    setPrefs({ theme: "light", viewMode: "grid", density: "comfortable" });
    expect(Object.keys(localStorage).sort()).toEqual([PREFS_KEY, MODE_KEY].sort());
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it("works when storage throws", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => setPrefs({ viewMode: "grid" })).not.toThrow();
    expect(getPrefs().viewMode).toBe("grid");
    spy.mockRestore();
  });
});

describe("prefs: with a registered sync", () => {
  it("on registration the server copy wins and overwrites local", async () => {
    setPrefs({ viewMode: "grid", theme: "dark" });
    const save = vi.fn(async () => {});
    await registerPrefsSync({
      load: async () => ({ viewMode: "list", theme: "light", density: "comfortable" }),
      save,
    });
    expect(getPrefs()).toEqual({ viewMode: "list", theme: "light", density: "comfortable" });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      density: "comfortable",
      viewMode: "list",
    });
    expect(localStorage.getItem(MODE_KEY)).toBe("light");
    // Adopting the server copy is not a change to push back.
    await flush(SYNC_DEBOUNCE_MS + 50);
    expect(save).not.toHaveBeenCalled();
  });

  it("each change writes local immediately and the server debounced (one save for a burst)", async () => {
    vi.useFakeTimers();
    const saved: Prefs[] = [];
    await registerPrefsSync({ load: async () => null, save: async (prefs) => void saved.push(prefs) });
    setPrefs({ viewMode: "grid" });
    setPrefs({ density: "comfortable" });
    expect(getPrefs()).toMatchObject({ viewMode: "grid", density: "comfortable" });
    expect(saved).toEqual([]);
    vi.advanceTimersByTime(SYNC_DEBOUNCE_MS + 1);
    expect(saved).toEqual([{ theme: "system", viewMode: "grid", density: "comfortable" }]);
  });

  it("a failing load keeps the local copy; a failing save does not throw", async () => {
    setPrefs({ viewMode: "grid" });
    await registerPrefsSync({
      load: async () => Promise.reject(new Error("offline")),
      save: async () => Promise.reject(new Error("offline")),
    });
    expect(getPrefs().viewMode).toBe("grid");
    setPrefs({ viewMode: "list" });
    await flush(SYNC_DEBOUNCE_MS + 50);
    expect(getPrefs().viewMode).toBe("list");
  });

  it("control: without a sync nothing is saved anywhere but locally", async () => {
    const save = vi.fn(async () => {});
    const unregister = await registerPrefsSync({ load: async () => null, save });
    unregister();
    setPrefs({ viewMode: "grid" });
    await flush(SYNC_DEBOUNCE_MS + 50);
    expect(save).not.toHaveBeenCalled();
  });

  it("an identity change drops the previous account's sync (and its pending save)", async () => {
    const save = vi.fn(async () => {});
    await registerPrefsSync({ load: async () => null, save });
    setPrefs({ viewMode: "grid" });
    await purgeUserState();
    await flush(SYNC_DEBOUNCE_MS + 50);
    setPrefs({ viewMode: "list" });
    await flush(SYNC_DEBOUNCE_MS + 50);
    expect(save).not.toHaveBeenCalled();
  });
});
