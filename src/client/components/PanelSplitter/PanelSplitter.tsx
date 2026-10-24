// A desktop side panel's resize handle (F02), per the WAI-ARIA APG Window Splitter pattern
// (https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/): a focusable `separator` with its
// value in px, ←/→ 16 px (Shift 64), Home/End = smallest/largest, Enter = collapse/restore.
//
// It takes no width in the row: a zero-width slot with an 8 px hit area centred on the panel's
// 1 px border. A drag writes the width to the panel's CSS variable once a frame (no React render
// per pointer move) and is stored on pointer up.
import Box from "@mui/material/Box";
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { PanelId } from "../../lib/layout-prefs";
import { t } from "../../lib/i18n";
import { hf, layout } from "../../theme/tokens";
import { keyWidth, PANEL_IDS, WIDTH_VAR } from "./panels";

export interface PanelSplitterProps {
  panel: PanelId;
  /** The width drawn now (px). */
  value: number;
  /** The widths a drag or a key may set now. */
  min: number;
  max: number;
  /** The sidebar is its icon rail: Enter / → / End restore it; it isn't dragged. */
  collapsed?: boolean;
  onResize(width: number): void;
  onReset(): void;
  /** Enter: collapse (the sidebar to its rail; details hides) or restore. */
  onToggle(): void;
}

interface Drag {
  pointerId: number;
  startX: number;
  startWidth: number;
  width: number;
  frame: number;
  shield: HTMLElement;
  userSelect: string;
}

export function PanelSplitter({
  panel,
  value,
  min,
  max,
  collapsed = false,
  onResize,
  onReset,
  onToggle,
}: PanelSplitterProps) {
  const handle = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const toward = panel === "sidebar" ? 1 : -1;

  const target = () => document.getElementById(PANEL_IDS[panel]);

  // A drag the component didn't see end (unmounted mid-drag): leave nothing behind.
  useEffect(() => () => finish(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  function finish(commit: boolean): void {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    cancelAnimationFrame(current.frame);
    current.shield.remove();
    delete document.body.dataset.panelDrag;
    document.body.style.userSelect = current.userSelect;
    if (commit && current.width !== current.startWidth) onResize(current.width);
    // The stored width (drawn from the frame's variable) takes over from the drag's own value.
    target()?.style.removeProperty(WIDTH_VAR[panel]);
    handle.current?.setAttribute("aria-valuenow", String(value));
  }

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || collapsed || drag.current) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    // Over an iframe or a PDF canvas the pointer would otherwise be eaten: a sheet above
    // everything keeps the column-resize cursor and the events while the drag lasts.
    const shield = document.createElement("div");
    shield.setAttribute("data-panel-drag-shield", "");
    shield.style.cssText = "position:fixed;inset:0;z-index:2147483647;cursor:col-resize";
    document.body.appendChild(shield);
    document.body.dataset.panelDrag = panel;
    const userSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: value,
      width: value,
      frame: 0,
      shield,
      userSelect,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || event.pointerId !== current.pointerId) return;
    const width = Math.round(
      Math.min(max, Math.max(min, current.startWidth + toward * (event.clientX - current.startX))),
    );
    if (width === current.width) return;
    current.width = width;
    cancelAnimationFrame(current.frame);
    current.frame = requestAnimationFrame(() => {
      target()?.style.setProperty(WIDTH_VAR[panel], `${width}px`);
      handle.current?.setAttribute("aria-valuenow", String(width));
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      onToggle();
      return;
    }
    if (collapsed) {
      // The rail: → and End restore it at its width; ← and Home have nowhere to go.
      if (event.key === "ArrowRight" || event.key === "End") {
        event.preventDefault();
        onToggle();
      } else if (event.key === "ArrowLeft" || event.key === "Home") event.preventDefault();
      return;
    }
    const next = keyWidth(event.key, event.shiftKey, panel, value, min, max);
    if (next === null) return;
    event.preventDefault();
    if (next !== value) onResize(next);
  };

  // Collapsed, the rail is the smallest the sidebar gets: the value sits at the minimum (APG:
  // a collapsed pane's splitter has the minimum value).
  const valueMin = collapsed ? layout.rail : min;
  return (
    <Box sx={{ position: "relative", width: 0, flex: "none", zIndex: 4 }}>
      <Box
        ref={handle}
        role="separator"
        tabIndex={0}
        aria-orientation="vertical"
        aria-label={t(panel === "sidebar" ? "panels.sidebar.resize" : "panels.details.resize")}
        aria-controls={PANEL_IDS[panel]}
        aria-valuenow={collapsed ? layout.rail : value}
        aria-valuemin={valueMin}
        aria-valuemax={Math.max(max, valueMin)}
        data-splitter={panel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => finish(true)}
        onPointerCancel={() => finish(false)}
        onLostPointerCapture={() => finish(true)}
        onDoubleClick={collapsed ? undefined : onReset}
        onKeyDown={onKeyDown}
        sx={{
          position: "absolute",
          top: 0,
          bottom: 0,
          // Centred on the panel's border: the sidebar's is its right edge (just left of this
          // slot), the details panel's its left edge (just right of it).
          left: panel === "sidebar" ? "-4.5px" : "-3.5px",
          width: "8px",
          cursor: collapsed ? "default" : "col-resize",
          touchAction: "none",
          outlineOffset: "-2px",
          "&::after": {
            content: '""',
            position: "absolute",
            top: 0,
            bottom: 0,
            left: "3px",
            width: "2px",
            backgroundColor: "transparent",
          },
          "&:hover::after, &:focus-visible::after": { backgroundColor: hf.textSecondary },
          [`body[data-panel-drag="${panel}"] &::after`]: { backgroundColor: hf.text },
        }}
      />
    </Box>
  );
}
