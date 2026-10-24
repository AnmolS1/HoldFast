// F02: the desktop side panels in the frame — the splitters (WAI-ARIA APG Window Splitter:
// https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/), the header toggles, the shortcuts and
// the palette commands; focus is never dropped on <body>.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openPalette } from "../../../../src/client/components/CommandPalette";
import { keyWidth } from "../../../../src/client/components/PanelSplitter";
import { DEFAULT_LAYOUT } from "../../../../src/client/lib/layout-prefs";
import { getLayout, PREFS_KEY, setLayout, setShortcutsOn } from "../../../../src/client/lib/prefs";
import { buildRoutes } from "../../../../src/client/router";
import { renderRoutes, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const initialWidth = window.innerWidth;
function setWindowWidth(width: number) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => setWindowWidth(1280));
afterEach(() => {
  setShortcutsOn(true);
  setWindowWidth(initialWidth);
});

async function open(path = "/") {
  shellFetch({ session: sessionOf({ role: "user" }) });
  const view = renderRoutes(buildRoutes(), [path]);
  await waitFor(() => expect(document.querySelector('[data-frame="desktop"]')).not.toBeNull());
  return view;
}

const splitter = (name: "Resize sidebar" | "Resize details") => screen.getByRole("separator", { name });
const aria = (el: HTMLElement) => ({
  now: Number(el.getAttribute("aria-valuenow")),
  min: Number(el.getAttribute("aria-valuemin")),
  max: Number(el.getAttribute("aria-valuemax")),
});
const press = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(el, { key, ...init });
  });
const pressDocument = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
const frameVar = (name: string) =>
  document.querySelector<HTMLElement>("[data-frame]")!.style.getPropertyValue(name);

describe("keyWidth: the splitter's keyboard map", () => {
  it("sidebar (its right edge): → wider, ← narrower, 16 px, Shift 64 px, Home/End = min/max, clamped", () => {
    expect(keyWidth("ArrowRight", false, "sidebar", 232, 200, 360)).toBe(248);
    expect(keyWidth("ArrowLeft", false, "sidebar", 232, 200, 360)).toBe(216);
    expect(keyWidth("ArrowRight", true, "sidebar", 232, 200, 360)).toBe(296);
    expect(keyWidth("ArrowLeft", true, "sidebar", 232, 200, 360)).toBe(200);
    expect(keyWidth("Home", false, "sidebar", 232, 200, 360)).toBe(200);
    expect(keyWidth("End", false, "sidebar", 232, 200, 360)).toBe(360);
    expect(keyWidth("ArrowRight", true, "sidebar", 350, 200, 360)).toBe(360);
    expect(keyWidth("Enter", false, "sidebar", 232, 200, 360)).toBeNull();
    expect(keyWidth("a", false, "sidebar", 232, 200, 360)).toBeNull();
  });

  it("details (its left edge): the splitter moves the way the arrow points — → narrower, ← wider", () => {
    expect(keyWidth("ArrowRight", false, "details", 320, 280, 520)).toBe(304);
    expect(keyWidth("ArrowLeft", false, "details", 320, 280, 520)).toBe(336);
    expect(keyWidth("ArrowLeft", true, "details", 320, 280, 520)).toBe(384);
    expect(keyWidth("ArrowRight", true, "details", 320, 280, 520)).toBe(280);
    expect(keyWidth("Home", false, "details", 320, 280, 520)).toBe(280);
    expect(keyWidth("End", false, "details", 320, 280, 520)).toBe(520);
  });
});

describe("splitters in the frame", () => {
  it("ARIA: separator, vertical, focusable, values in px, controls its panel", async () => {
    await open();
    const sidebar = splitter("Resize sidebar");
    expect(sidebar.getAttribute("aria-orientation")).toBe("vertical");
    expect(sidebar.tabIndex).toBe(0);
    expect(aria(sidebar)).toEqual({ now: 232, min: 200, max: 360 });
    expect(document.getElementById(sidebar.getAttribute("aria-controls")!)).toBe(
      document.querySelector("[data-sidebar]"),
    );
    const details = splitter("Resize details");
    expect(aria(details)).toEqual({ now: 320, min: 280, max: 520 });
    expect(document.getElementById(details.getAttribute("aria-controls")!)).toBe(
      document.querySelector("[data-details-panel]"),
    );
    expect(frameVar("--hf-sidebar-w")).toBe("232px");
    expect(frameVar("--hf-details-w")).toBe("320px");
  });

  it("keyboard resize is stored and drawn; Shift steps 64; Home/End", async () => {
    await open();
    const sidebar = splitter("Resize sidebar");
    press(sidebar, "ArrowRight");
    expect(getLayout().sidebar.width).toBe(248);
    expect(aria(sidebar).now).toBe(248);
    expect(frameVar("--hf-sidebar-w")).toBe("248px");
    press(sidebar, "ArrowRight", { shiftKey: true });
    expect(getLayout().sidebar.width).toBe(312);
    press(sidebar, "End");
    expect(getLayout().sidebar.width).toBe(360);
    press(sidebar, "Home");
    expect(getLayout().sidebar.width).toBe(200);
    const details = splitter("Resize details");
    press(details, "ArrowLeft");
    expect(getLayout().details.width).toBe(336);
    press(details, "ArrowRight", { shiftKey: true });
    expect(getLayout().details.width).toBe(280);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!).layout).toEqual({
      sidebar: { collapsed: false, width: 200 },
      details: { open: true, width: 280 },
    });
  });

  it("Enter collapses the sidebar to its rail and restores it; focus stays on the splitter", async () => {
    await open();
    const sidebar = splitter("Resize sidebar");
    sidebar.focus();
    press(sidebar, "Enter");
    expect(getLayout().sidebar.collapsed).toBe(true);
    expect(document.querySelector("[data-sidebar]")!.hasAttribute("data-rail")).toBe(true);
    expect(frameVar("--hf-sidebar-w")).toBe("56px");
    // APG: a collapsed pane's splitter sits at its minimum.
    expect(aria(splitter("Resize sidebar"))).toMatchObject({ now: 56, min: 56 });
    expect(document.activeElement).toBe(splitter("Resize sidebar"));
    press(splitter("Resize sidebar"), "Enter");
    expect(getLayout().sidebar).toEqual({ collapsed: false, width: 232 });
    expect(document.activeElement).toBe(splitter("Resize sidebar"));
  });

  it("Enter on the details splitter hides details; focus goes to the details toggle, not <body>", async () => {
    await open();
    const details = splitter("Resize details");
    details.focus();
    press(details, "Enter");
    expect(getLayout().details.open).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Details panel" }));
    expect(screen.queryByRole("separator", { name: "Resize details" })).toBeNull();
  });

  it("double-click resets to the default width", async () => {
    setLayout({ ...DEFAULT_LAYOUT, sidebar: { collapsed: false, width: 340 } });
    await open();
    fireEvent.doubleClick(splitter("Resize sidebar"));
    expect(getLayout().sidebar.width).toBe(232);
  });

  it("a narrow window draws the panels narrower without storing anything", async () => {
    setLayout({ sidebar: { collapsed: false, width: 360 }, details: { open: true, width: 520 } });
    const before = localStorage.getItem(PREFS_KEY);
    await open();
    act(() => setWindowWidth(1024));
    expect(frameVar("--hf-sidebar-w")).toBe("264px");
    expect(frameVar("--hf-details-w")).toBe("280px");
    expect(aria(splitter("Resize sidebar"))).toEqual({ now: 264, min: 200, max: 264 });
    expect(localStorage.getItem(PREFS_KEY)).toBe(before);
    act(() => setWindowWidth(1920));
    expect(frameVar("--hf-sidebar-w")).toBe("360px");
    expect(frameVar("--hf-details-w")).toBe("520px");
  });
});

describe("toggles: header button, shortcut, palette", () => {
  it("header buttons are toggle buttons with a fixed name; hidden details is display:none", async () => {
    await open();
    const left = screen.getByRole("button", { name: "Sidebar" });
    const right = screen.getByRole("button", { name: "Details panel" });
    expect(left.getAttribute("aria-pressed")).toBe("true");
    expect(right.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(left);
    expect(getLayout().sidebar.collapsed).toBe(true);
    expect(screen.getByRole("button", { name: "Sidebar" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(right);
    expect(getLayout().details.open).toBe(false);
    const panel = document.querySelector<HTMLElement>("[data-details-panel]")!;
    expect(panel.style.display === "none" || getComputedStyle(panel).display === "none").toBe(true);
    expect(screen.queryByRole("complementary", { name: "Details" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details panel" }));
    expect(screen.getByRole("complementary", { name: "Details" })).toBeTruthy();
  });

  it("the rail: the same landmark, six links each named, the current one marked, storage as a sliver", async () => {
    setLayout({ ...DEFAULT_LAYOUT, sidebar: { collapsed: true, width: 232 } });
    await open("/recent");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const links = within(nav)
      .getAllByRole("link")
      .filter((link) => link.hasAttribute("data-nav"));
    expect(links.map((link) => link.getAttribute("aria-label"))).toEqual([
      "Files",
      "Shared with me",
      "Shared by me",
      "Recent",
      "Starred",
      "Trash",
    ]);
    expect(links.find((link) => link.getAttribute("aria-current") === "page")?.getAttribute("data-nav")).toBe(
      "recent",
    );
    expect(within(nav).getByRole("button", { name: "Account menu" })).toBeTruthy();
  });

  it("⌘\\ / Ctrl+\\ toggles the sidebar; i toggles details; collapsing moves focus out of the panel to its toggle", async () => {
    await open();
    const filesLink = document.querySelector<HTMLElement>('[data-nav="files"]')!;
    filesLink.focus();
    pressDocument("\\", { ctrlKey: true });
    expect(getLayout().sidebar.collapsed).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Sidebar" }));
    pressDocument("\\", { ctrlKey: true });
    expect(getLayout().sidebar.collapsed).toBe(false);
    pressDocument("i");
    expect(getLayout().details.open).toBe(false);
    pressDocument("i");
    expect(getLayout().details.open).toBe(true);
  });

  it("with single-key shortcuts off, i does nothing; ⌘\\ still toggles; the button still works", async () => {
    await open();
    setShortcutsOn(false);
    pressDocument("i");
    expect(getLayout().details.open).toBe(true);
    pressDocument("\\", { ctrlKey: true });
    expect(getLayout().sidebar.collapsed).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Details panel" }));
    expect(getLayout().details.open).toBe(false);
  });

  it("the palette: Hide sidebar / Show details, with their shortcuts", async () => {
    await open();
    act(() => openPalette());
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("option", { name: /Hide sidebar/ }));
    expect(getLayout().sidebar.collapsed).toBe(true);
    act(() => openPalette());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: /Show sidebar/ }));
    expect(getLayout().sidebar.collapsed).toBe(false);
    act(() => openPalette());
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("option", { name: /Hide details/ }));
    expect(getLayout().details.open).toBe(false);
    act(() => openPalette());
    expect(within(screen.getByRole("dialog")).getByRole("option", { name: /Show details/ })).toBeTruthy();
  });

  it("routes with details: false are unaffected — no panel, no button, no command; i changes nothing", async () => {
    await open("/storage");
    expect(document.querySelector("[data-details-panel]")).toBeNull();
    expect(screen.queryByRole("separator", { name: "Resize details" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Details panel" })).toBeNull();
    pressDocument("i");
    expect(getLayout().details.open).toBe(true);
    // The sidebar still toggles there.
    expect(screen.getByRole("button", { name: "Sidebar" })).toBeTruthy();
    act(() => openPalette());
    expect(within(screen.getByRole("dialog")).queryByRole("option", { name: /details/i })).toBeNull();
  });
});
