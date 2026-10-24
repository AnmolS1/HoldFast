// F02: the desktop side panels' stored layout (pure functions): what a stored value reads as, and
// how the panels give way when the window is too narrow for both — without ever storing a width.
import { describe, expect, it, vi } from "vitest";
import {
  clampWidth,
  DEFAULT_LAYOUT,
  giveWay,
  isDefaultLayout,
  panelBounds,
  sameLayout,
  sanitizeLayout,
  type PanelLayout,
} from "../../../../src/client/lib/layout-prefs";
import * as prefs from "../../../../src/client/lib/prefs";
import { layout, panelLimits } from "../../../../src/client/theme/tokens";

const withLayout = (patch: {
  sidebar?: Partial<PanelLayout["sidebar"]>;
  details?: Partial<PanelLayout["details"]>;
}): PanelLayout => ({
  sidebar: { ...DEFAULT_LAYOUT.sidebar, ...patch.sidebar },
  details: { ...DEFAULT_LAYOUT.details, ...patch.details },
});

describe("sizes (tokens)", () => {
  it("are the specification's: sidebar 232 (200–360, rail 56), details 320 (280–520), content ≥ 480", () => {
    expect(layout.sidebar).toBe(232);
    expect(layout.details).toBe(320);
    expect(layout.rail).toBe(56);
    expect(panelLimits).toEqual({
      sidebar: { min: 200, max: 360 },
      details: { min: 280, max: 520 },
      contentMin: 480,
    });
    expect(DEFAULT_LAYOUT).toEqual({
      sidebar: { collapsed: false, width: 232 },
      details: { open: true, width: 320 },
    });
  });
});

describe("sanitizeLayout: a stored value can't break the layout", () => {
  it("anything that isn't an object reads as the defaults", () => {
    for (const stored of [undefined, null, 0, 7, "wide", true, [], [1, 2]])
      expect(sanitizeLayout(stored), JSON.stringify(stored)).toEqual(DEFAULT_LAYOUT);
  });

  it("widths are clamped into range and rounded; negative and huge values land on the limits", () => {
    expect(sanitizeLayout({ sidebar: { width: -40 }, details: { width: 1e9 } })).toEqual(
      withLayout({ sidebar: { width: 200 }, details: { width: 520 } }),
    );
    expect(sanitizeLayout({ sidebar: { width: 9999 }, details: { width: -1 } })).toEqual(
      withLayout({ sidebar: { width: 360 }, details: { width: 280 } }),
    );
    expect(sanitizeLayout({ sidebar: { width: 250.6 }, details: { width: 300.2 } })).toEqual(
      withLayout({ sidebar: { width: 251 }, details: { width: 300 } }),
    );
  });

  it("strings, NaN and other non-numbers read as the default width; non-booleans as the default state", () => {
    expect(
      sanitizeLayout({
        sidebar: { width: "300", collapsed: "true" },
        details: { width: Number.NaN, open: 0 },
      }),
    ).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout({ sidebar: "rail", details: null })).toEqual(DEFAULT_LAYOUT);
    expect(sanitizeLayout({ sidebar: { width: Number.POSITIVE_INFINITY } })).toEqual(DEFAULT_LAYOUT);
  });

  it("valid values are kept, unknown keys dropped", () => {
    const stored = {
      sidebar: { collapsed: true, width: 300, token: "x" },
      details: { open: false, width: 400 },
      extra: 1,
    };
    expect(sanitizeLayout(stored)).toEqual({
      sidebar: { collapsed: true, width: 300 },
      details: { open: false, width: 400 },
    });
  });

  it("bad JSON in storage reads as the defaults (through prefs.ts, the only reader)", () => {
    localStorage.setItem(prefs.PREFS_KEY, "{not json");
    prefs.resetPrefsForTests();
    expect(prefs.getLayout()).toEqual(DEFAULT_LAYOUT);
    localStorage.setItem(prefs.PREFS_KEY, "null");
    prefs.resetPrefsForTests();
    expect(prefs.getLayout()).toEqual(DEFAULT_LAYOUT);
    localStorage.clear();
    prefs.resetPrefsForTests();
  });

  it("clampWidth, sameLayout, isDefaultLayout", () => {
    expect(clampWidth("sidebar", 10)).toBe(200);
    expect(clampWidth("details", 600)).toBe(520);
    expect(clampWidth("details", 333.4)).toBe(333);
    expect(isDefaultLayout(sanitizeLayout({}))).toBe(true);
    expect(isDefaultLayout(withLayout({ details: { open: false } }))).toBe(false);
    expect(sameLayout(withLayout({ sidebar: { width: 300 } }), withLayout({ sidebar: { width: 300 } }))).toBe(
      true,
    );
    expect(sameLayout(DEFAULT_LAYOUT, withLayout({ sidebar: { collapsed: true } }))).toBe(false);
  });
});

describe("giveWay: content keeps 480 px; details shrinks, then the sidebar, then details hides", () => {
  const max = withLayout({ sidebar: { width: 360 }, details: { width: 520 } });

  it.each([
    // width, layout, sidebar, details
    [1920, DEFAULT_LAYOUT, 232, 320],
    [1280, DEFAULT_LAYOUT, 232, 320],
    [1100, DEFAULT_LAYOUT, 232, 320],
    [1024, DEFAULT_LAYOUT, 232, 312],
    [1920, max, 360, 520],
    [1280, max, 360, 440],
    [1100, max, 340, 280],
    [1024, max, 264, 280],
  ] as const)("%i px → sidebar %i, details %i (content ≥ 480)", (width, stored, sidebar, details) => {
    const out = giveWay(stored, width);
    expect(out).toEqual({ sidebar, details });
    expect(width - out.sidebar - (out.details ?? 0)).toBeGreaterThanOrEqual(panelLimits.contentMin);
  });

  it("every desktop width from 1024 to 2560 leaves the content ≥ 480 px, both panels at max", () => {
    for (let width = 1024; width <= 2560; width += 1) {
      const out = giveWay(max, width);
      expect(width - out.sidebar - (out.details ?? 0)).toBeGreaterThanOrEqual(480);
      expect(out.details).not.toBeNull();
    }
  });

  it("details is hidden for the moment only when both are at their minimum and it still doesn't fit", () => {
    // Below the desktop breakpoint — the frame never asks there, but the order is the order:
    // 200 + 280 + 480 = 960.
    expect(giveWay(max, 960)).toEqual({ sidebar: 200, details: 280 });
    expect(giveWay(max, 959)).toEqual({ sidebar: 360, details: null });
    // Shown again when the window widens.
    expect(giveWay(max, 1024).details).toBe(280);
  });

  it("the rail does not shrink; a closed or unavailable details panel takes no room", () => {
    expect(giveWay(withLayout({ sidebar: { collapsed: true }, details: { width: 520 } }), 1024)).toEqual({
      sidebar: 56,
      details: 488,
    });
    expect(giveWay(withLayout({ sidebar: { width: 360 }, details: { open: false } }), 1024)).toEqual({
      sidebar: 360,
      details: null,
    });
    expect(giveWay(max, 1024, false)).toEqual({ sidebar: 360, details: null });
  });

  it("never stores a width: give-way at 1024/1100/1280/1920 writes nothing and leaves the input as it was", () => {
    prefs.setLayout(max);
    const before = localStorage.getItem(prefs.PREFS_KEY);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const stored = structuredClone(max);
    for (const width of [1024, 1100, 1280, 1920]) giveWay(stored, width);
    expect(stored).toEqual(max);
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(prefs.PREFS_KEY)).toBe(before);
    expect(prefs.getLayout()).toEqual(max);
    setItem.mockRestore();
    localStorage.clear();
    prefs.resetPrefsForTests();
  });
});

describe("panelBounds: the range a drag or a key may set, so what is stored is what is shown", () => {
  it("roomy window: the panel's own limits", () => {
    expect(panelBounds("sidebar", DEFAULT_LAYOUT, 1920)).toEqual({ min: 200, max: 360 });
    expect(panelBounds("details", DEFAULT_LAYOUT, 1920)).toEqual({ min: 280, max: 520 });
  });

  it("narrow window: the sidebar may grow while details gives way down to its minimum; details may not take the sidebar's room", () => {
    // 1024 − 480 = 544 for both panels.
    expect(panelBounds("sidebar", DEFAULT_LAYOUT, 1024)).toEqual({ min: 200, max: 264 });
    expect(panelBounds("details", DEFAULT_LAYOUT, 1024)).toEqual({ min: 280, max: 312 });
    expect(panelBounds("details", withLayout({ sidebar: { collapsed: true } }), 1024)).toEqual({
      min: 280,
      max: 488,
    });
    expect(panelBounds("sidebar", withLayout({ details: { open: false } }), 1024)).toEqual({
      min: 200,
      max: 360,
    });
  });

  it("any width inside the bounds renders as exactly that width", () => {
    for (const width of [1024, 1100, 1280])
      for (const panel of ["sidebar", "details"] as const) {
        const { min, max: top } = panelBounds(panel, DEFAULT_LAYOUT, width);
        for (let w = min; w <= top; w += 8) {
          const next =
            panel === "sidebar"
              ? withLayout({ sidebar: { width: w } })
              : withLayout({ details: { width: w } });
          expect(giveWay(next, width)[panel], `${panel} ${w} @ ${width}`).toBe(w);
        }
      }
  });
});
