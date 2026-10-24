// The desktop side panels' layout (F02): whether each is shown and how wide. Pure functions only —
// the value is stored by prefs.ts inside `hf.prefs.v1` (it rebuilds that object on every write, so
// it must stay its only writer); nothing here touches Web Storage.
import { layout, panelLimits } from "../theme/tokens";

export type PanelId = "sidebar" | "details";

export interface PanelLayout {
  sidebar: { collapsed: boolean; width: number };
  details: { open: boolean; width: number };
}

/** What the frame draws: each panel's width in px; `details: null` = not drawn. */
export interface RenderedLayout {
  sidebar: number;
  details: number | null;
}

export const DEFAULT_LAYOUT: PanelLayout = Object.freeze({
  sidebar: Object.freeze({ collapsed: false, width: layout.sidebar }),
  details: Object.freeze({ open: true, width: layout.details }),
});

/** A width the panel may have: rounded to a pixel, inside its limits. */
export function clampWidth(panel: PanelId, width: number): number {
  const { min, max } = panelLimits[panel];
  return Math.min(max, Math.max(min, Math.round(width)));
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function widthOf(panel: PanelId, raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? clampWidth(panel, raw) : fallback;
}

/**
 * A stored (or hand-edited) value as a layout: numbers clamped into range, booleans kept, anything
 * else the default. A value that isn't an object reads as the defaults.
 */
export function sanitizeLayout(input: unknown): PanelLayout {
  const raw = isRecord(input) ? input : {};
  const sidebar = isRecord(raw.sidebar) ? raw.sidebar : {};
  const details = isRecord(raw.details) ? raw.details : {};
  return {
    sidebar: {
      collapsed:
        typeof sidebar.collapsed === "boolean" ? sidebar.collapsed : DEFAULT_LAYOUT.sidebar.collapsed,
      width: widthOf("sidebar", sidebar.width, DEFAULT_LAYOUT.sidebar.width),
    },
    details: {
      open: typeof details.open === "boolean" ? details.open : DEFAULT_LAYOUT.details.open,
      width: widthOf("details", details.width, DEFAULT_LAYOUT.details.width),
    },
  };
}

export function sameLayout(a: PanelLayout, b: PanelLayout): boolean {
  return (
    a.sidebar.collapsed === b.sidebar.collapsed &&
    a.sidebar.width === b.sidebar.width &&
    a.details.open === b.details.open &&
    a.details.width === b.details.width
  );
}

export function isDefaultLayout(value: PanelLayout): boolean {
  return sameLayout(value, DEFAULT_LAYOUT);
}

/**
 * The widths to draw in a window `windowWidth` px wide. When the panels don't leave the content
 * `contentMin`, they give way in this order: details shrinks toward its minimum, then the sidebar
 * toward its minimum, then details is hidden for the moment. Only the drawing changes — the stored
 * layout is the caller's and is never written here.
 */
export function giveWay(value: PanelLayout, windowWidth: number, detailsAvailable = true): RenderedLayout {
  const room = windowWidth - panelLimits.contentMin;
  const collapsed = value.sidebar.collapsed;
  const preferred = collapsed ? layout.rail : value.sidebar.width;
  let sidebar = preferred;
  let details = detailsAvailable && value.details.open ? value.details.width : 0;
  if (details > 0 && sidebar + details > room) details = Math.max(panelLimits.details.min, room - sidebar);
  if (!collapsed && sidebar + details > room) sidebar = Math.max(panelLimits.sidebar.min, room - details);
  if (details > 0 && sidebar + details > room) {
    details = 0;
    sidebar = collapsed ? layout.rail : Math.max(panelLimits.sidebar.min, Math.min(preferred, room));
  }
  return { sidebar, details: details > 0 ? details : null };
}

/**
 * The widths a drag or a key may give `panel` right now, so that the width stored is the width
 * drawn: the sidebar may grow while details gives way down to its minimum; details may not take
 * the sidebar's room.
 */
export function panelBounds(
  panel: PanelId,
  value: PanelLayout,
  windowWidth: number,
  detailsAvailable = true,
): { min: number; max: number } {
  const room = windowWidth - panelLimits.contentMin;
  const { min, max } = panelLimits[panel];
  if (panel === "sidebar") {
    const other = detailsAvailable && value.details.open ? panelLimits.details.min : 0;
    return { min, max: Math.max(min, Math.min(max, room - other)) };
  }
  const other = value.sidebar.collapsed ? layout.rail : value.sidebar.width;
  return { min, max: Math.max(min, Math.min(max, room - other)) };
}
