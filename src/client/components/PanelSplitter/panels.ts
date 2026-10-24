// The desktop side panels' actions (F02), shared by the header buttons, the shortcuts, the palette
// and the splitters: one path, so focus is handled the same way whichever of them hid a panel.
import { DEFAULT_LAYOUT, type PanelId, type PanelLayout } from "../../lib/layout-prefs";
import { getLayout, setLayout } from "../../lib/prefs";

export const STEP = 16;
export const BIG_STEP = 64;

/** The CSS variable each panel's width is read from. */
export const WIDTH_VAR: Record<PanelId, string> = { sidebar: "--hf-sidebar-w", details: "--hf-details-w" };

/**
 * Next width for a key, or null for a key the splitter doesn't handle. The sidebar's splitter is
 * its right edge (→ widens), the details panel's its left edge (→ narrows).
 */
export function keyWidth(
  key: string,
  shift: boolean,
  panel: PanelId,
  value: number,
  min: number,
  max: number,
): number | null {
  const step = shift ? BIG_STEP : STEP;
  const toward = panel === "sidebar" ? 1 : -1;
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  if (key === "ArrowRight") return clamp(value + toward * step);
  if (key === "ArrowLeft") return clamp(value - toward * step);
  if (key === "Home") return min;
  if (key === "End") return max;
  return null;
}

/** Element ids: the panels (the splitters' and toggles' `aria-controls`) and their header toggles. */
export const PANEL_IDS = { sidebar: "hf-sidebar", details: "hf-details" } as const;
export const TOGGLE_IDS = { sidebar: "hf-toggle-sidebar", details: "hf-toggle-details" } as const;

export function isPanelShown(panel: PanelId, value: PanelLayout = getLayout()): boolean {
  return panel === "sidebar" ? !value.sidebar.collapsed : value.details.open;
}

/**
 * The element that had focus before a dialog took it (the palette): a command run from the
 * palette hides a panel while focus is in the palette, and on closing the palette hands focus
 * back to this element — which may be inside the panel just hidden.
 */
let focusBeforeDialog: Element | null = null;
if (typeof document !== "undefined")
  document.addEventListener("focusin", (event) => {
    if (event.target instanceof Element && !event.target.closest('[role="dialog"], [role="alertdialog"]'))
      focusBeforeDialog = event.target;
  });

const dialogOpen = () => document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;

/** Whether `element` sits in `panel` (or, for details, on its splitter, which goes with it). */
function holds(panel: PanelId, element: Element | null): boolean {
  if (!element) return false;
  return (
    document.getElementById(PANEL_IDS[panel])?.contains(element) === true ||
    (panel === "details" && element.closest('[data-splitter="details"]') !== null)
  );
}

/**
 * Show or hide a panel (the sidebar hides to its icon rail). When the panel being hidden — or its
 * splitter, which goes with the details panel — holds focus, focus moves to the panel's toggle
 * first: once the panel is `display: none` the browser would drop focus on <body>. Run from a
 * dialog (the palette) whose return target is in that panel, the toggle takes focus once the
 * dialog has closed and found its target gone.
 */
export function setPanelShown(panel: PanelId, shown: boolean): void {
  const current = getLayout();
  if (isPanelShown(panel, current) === shown) return;
  if (!shown) {
    const active = document.activeElement;
    const toggle = () => document.getElementById(TOGGLE_IDS[panel])?.focus();
    if (holds(panel, active)) toggle();
    else if (active?.closest('[role="dialog"], [role="alertdialog"]') && holds(panel, focusBeforeDialog)) {
      // Bounded: about a second of frames for the dialog to close; only <body> is taken over.
      let frames = 60;
      const check = () => {
        if (dialogOpen() && frames-- > 0) return void requestAnimationFrame(check);
        if (document.activeElement === document.body || document.activeElement === null) toggle();
      };
      requestAnimationFrame(check);
    }
  }
  setLayout(
    panel === "sidebar"
      ? { ...current, sidebar: { ...current.sidebar, collapsed: !shown } }
      : { ...current, details: { ...current.details, open: shown } },
  );
}

export function togglePanel(panel: PanelId): void {
  setPanelShown(panel, !isPanelShown(panel));
}

/** Store a width the user chose (a drag or a key). Resizing a collapsed sidebar opens it. */
export function setPanelWidth(panel: PanelId, width: number): void {
  const current = getLayout();
  setLayout(
    panel === "sidebar"
      ? { ...current, sidebar: { collapsed: false, width } }
      : { ...current, details: { ...current.details, width } },
  );
}

/** Double-click on a splitter: the default width. */
export function resetPanelWidth(panel: PanelId): void {
  setPanelWidth(panel, DEFAULT_LAYOUT[panel].width);
}
