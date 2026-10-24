// R1 a11y-6 (WCAG 2.1.4): the single-key shortcuts — `/`, `?`, Shift+N, Shift+R, `i` — can be turned off
// in Preferences, on this device. Off, they do nothing; shortcuts with Ctrl/⌘ and keys that are
// not characters (Delete, F2) keep working, and the setting survives a reload without a new key.
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PreferencesSection } from "../../../../src/client/features/account/PreferencesSection";
import {
  getShortcutsOn,
  MODE_KEY,
  PREFS_KEY,
  resetPrefsForTests,
  setPrefs,
  setShortcutsOn,
} from "../../../../src/client/lib/prefs";
import {
  isCharacterShortcut,
  SHORTCUTS,
  useShortcut,
  type ShortcutId,
} from "../../../../src/client/lib/shortcuts";
import { Providers, setupShell } from "./helpers";

setupShell();

function Probe({ id, onFire }: { id: ShortcutId; onFire: () => void }) {
  useShortcut(id, onFire);
  return null;
}

const press = (key: string, init: KeyboardEventInit = {}) =>
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
  );

beforeEach(() => resetPrefsForTests());
afterEach(() => {
  cleanup();
  setShortcutsOn(true);
});

describe("single-key shortcuts can be turned off", () => {
  it("the character shortcuts are exactly / ? Shift+N Shift+R i", () => {
    expect(SHORTCUTS.filter(isCharacterShortcut).map((def) => def.id)).toEqual([
      "search",
      "help",
      "newFolder",
      "restore",
      "details",
    ]);
  });

  it("F02 off: i (show or hide details) does nothing; ⌘\\ / Ctrl+\\ still toggles the sidebar", () => {
    const fired = vi.fn();
    render(
      <>
        <Probe id="details" onFire={() => fired("details")} />
        <Probe id="sidebar" onFire={() => fired("sidebar")} />
      </>,
    );
    const both = () => {
      press("i");
      press("\\", { ctrlKey: true });
      press("\\", { metaKey: true });
    };
    both();
    expect(fired.mock.calls.map(([id]) => id)).toEqual(["details", "sidebar"]);
    fired.mockClear();
    setShortcutsOn(false);
    both();
    expect(fired.mock.calls.map(([id]) => id)).toEqual(["sidebar"]);
  });

  it("off: / ? Shift+N Shift+R do nothing; Ctrl/⌘+K and Delete still act", () => {
    const fired = vi.fn();
    const ids: ShortcutId[] = ["search", "help", "newFolder", "restore", "palette", "trash"];
    render(
      <>
        {ids.map((id) => (
          <Probe key={id} id={id} onFire={() => fired(id)} />
        ))}
      </>,
    );
    const all = () => {
      press("/");
      press("?", { shiftKey: true });
      press("N", { shiftKey: true });
      press("R", { shiftKey: true });
      press("k", { ctrlKey: true });
      press("k", { metaKey: true });
      press("Delete");
    };
    all();
    expect(fired.mock.calls.map(([id]) => id)).toEqual([
      "search",
      "help",
      "newFolder",
      "restore",
      "palette",
      "trash",
    ]);
    fired.mockClear();
    setShortcutsOn(false);
    all();
    expect(fired.mock.calls.map(([id]) => id)).toEqual(["palette", "trash"]);
  });

  it("stored inside hf.prefs.v1 only when off, survives a reload, and no new storage key appears", () => {
    setPrefs({ viewMode: "grid" });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({ density: "compact", viewMode: "grid" });
    setShortcutsOn(false);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toEqual({
      density: "compact",
      viewMode: "grid",
      shortcuts: false,
    });
    setPrefs({ density: "comfortable" });
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ shortcuts: false });
    resetPrefsForTests();
    expect(getShortcutsOn()).toBe(false);
    expect(Object.keys(localStorage).sort()).toEqual([PREFS_KEY, MODE_KEY].sort());
  });

  it("the Preferences switch turns them off and on", () => {
    render(
      <Providers>
        <PreferencesSection />
      </Providers>,
    );
    const toggle = screen.getByRole("switch", { name: "Single-key shortcuts" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(getShortcutsOn()).toBe(false);
    expect(toggle.checked).toBe(false);
    expect(toggle.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(toggle);
    expect(getShortcutsOn()).toBe(true);
  });
});
