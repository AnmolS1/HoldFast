import { describe, expect, it, vi } from "vitest";
import { DEFAULT_LAYOUT, type PanelLayout } from "../../../../src/client/lib/layout-prefs";
import {
  getLayout,
  getPrefs,
  getShortcutsOn,
  MODE_KEY,
  PREFS_KEY,
  registerPrefsSync,
  resetPrefsForTests,
  sanitizePrefs,
  setLayout,
  setPrefs,
  setShortcutsOn,
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

  it("the single-key shortcuts flag (R1 a11y-6): local only, in hf.prefs.v1, anything but false reads as on", () => {
    for (const stored of ['"no"', "0", "null", '"false"', "{}"]) {
      localStorage.setItem(PREFS_KEY, `{"density":"compact","viewMode":"list","shortcuts":${stored}}`);
      resetPrefsForTests();
      expect(getShortcutsOn(), stored).toBe(true);
    }
    localStorage.setItem(PREFS_KEY, '{"shortcuts":false}');
    resetPrefsForTests();
    expect(getShortcutsOn()).toBe(false);
    expect(getPrefs()).not.toHaveProperty("shortcuts");
    setShortcutsOn(true);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).not.toHaveProperty("shortcuts");
    expect(Object.keys(localStorage).sort()).toEqual([PREFS_KEY, MODE_KEY].sort());
  });

  it("an account switch keeps the shortcuts flag, like density and view: device settings, not account state", async () => {
    setPrefs({ viewMode: "grid" });
    setShortcutsOn(false);
    await purgeUserState();
    expect(getPrefs().viewMode).toBe("grid");
    expect(getShortcutsOn()).toBe(false);
    setShortcutsOn(true);
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

// F02 (R-104): the panel layout rides in hf.prefs.v1 beside the shortcuts flag; prefs.ts rebuilds
// that object on every write, so it must be the one writer of both.
describe("prefs: the panel layout (F02, this device only)", () => {
  const custom: PanelLayout = {
    sidebar: { collapsed: true, width: 300 },
    details: { open: false, width: 400 },
  };
  const stored = () => JSON.parse(localStorage.getItem(PREFS_KEY)!) as Record<string, unknown>;

  it("defaults, and is not written while it is the default", () => {
    expect(getLayout()).toEqual(DEFAULT_LAYOUT);
    setPrefs({ viewMode: "grid" });
    expect(stored()).toEqual({ density: "compact", viewMode: "grid" });
  });

  it("setLayout then setShortcutsOn(false) keeps both in storage, and the reverse", () => {
    setLayout(custom);
    setShortcutsOn(false);
    expect(stored()).toEqual({ density: "compact", viewMode: "list", shortcuts: false, layout: custom });
    setShortcutsOn(true);
    setLayout(DEFAULT_LAYOUT);
    expect(stored()).toEqual({ density: "compact", viewMode: "list" });
    setShortcutsOn(false);
    setLayout(custom);
    expect(stored()).toEqual({ density: "compact", viewMode: "list", shortcuts: false, layout: custom });
    setShortcutsOn(true);
  });

  it("setPrefs({ density }) keeps both", () => {
    setShortcutsOn(false);
    setLayout(custom);
    setPrefs({ density: "comfortable" });
    expect(stored()).toEqual({ density: "comfortable", viewMode: "list", shortcuts: false, layout: custom });
    setShortcutsOn(true);
  });

  it("storage keys unchanged: still only hf.prefs.v1 and the theme's key", () => {
    setLayout(custom);
    setPrefs({ theme: "dark" });
    expect(Object.keys(localStorage).sort()).toEqual([PREFS_KEY, MODE_KEY].sort());
    expect(Object.keys(sessionStorage)).toEqual([]);
  });

  it("resetPrefsForTests re-reads the layout (a reload), sanitised", () => {
    setLayout(custom);
    resetPrefsForTests();
    expect(getLayout()).toEqual(custom);
    localStorage.setItem(PREFS_KEY, JSON.stringify({ layout: { sidebar: { width: -5 }, details: "x" } }));
    resetPrefsForTests();
    expect(getLayout()).toEqual({ ...DEFAULT_LAYOUT, sidebar: { collapsed: false, width: 200 } });
  });

  it("setLayout sanitises, and an equal layout is no change (the same object back, nothing written)", () => {
    setLayout({ sidebar: { collapsed: false, width: 9999 }, details: { open: true, width: 1 } });
    expect(getLayout()).toEqual({
      sidebar: { collapsed: false, width: 360 },
      details: { open: true, width: 280 },
    });
    const before = getLayout();
    const writes = vi.spyOn(Storage.prototype, "setItem");
    setLayout(structuredClone(before));
    expect(getLayout()).toBe(before);
    expect(writes).not.toHaveBeenCalled();
  });

  it("an account switch keeps it: a device setting, not account state", async () => {
    setLayout(custom);
    await purgeUserState();
    expect(getLayout()).toEqual(custom);
  });

  it("the server payload is exactly theme/density/viewMode — never the layout", async () => {
    vi.useFakeTimers();
    const saved: unknown[] = [];
    await registerPrefsSync({ load: async () => null, save: async (prefs) => void saved.push({ ...prefs }) });
    setLayout(custom);
    setShortcutsOn(false);
    setPrefs({ viewMode: "grid" });
    vi.advanceTimersByTime(SYNC_DEBOUNCE_MS + 1);
    expect(saved).toHaveLength(1);
    expect(Object.keys(saved[0] as object).sort()).toEqual(["density", "theme", "viewMode"]);
    // A layout change alone is never sent.
    setLayout(DEFAULT_LAYOUT);
    vi.advanceTimersByTime(SYNC_DEBOUNCE_MS + 1);
    expect(saved).toHaveLength(1);
    setShortcutsOn(true);
    vi.useRealTimers();
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
