// The shared list/grid of files and folders. Features supply data and behaviour through props;
// they do not edit this component. Selected rows and tiles are styled by the theme through
// `aria-selected` inside the `data-hf-list` container — no colour token is named in this file.
import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Link2, Users } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  ViewTransition,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { t } from "../../lib/i18n";
import { isApplePlatform } from "../../lib/shortcuts";
import { TOUCH_QUERY, useIsDesktop } from "../../theme/breakpoints";
import { hf, layout } from "../../theme/tokens";
import { Bytes } from "../Bytes";
import { FileBadge, FolderGlyph } from "../FileBadge";
import { ProgressUnderline } from "../ProgressUnderline";
import { RelativeTime } from "../RelativeTime";
import { StatusDot, statusSentence } from "../StatusDot";
import type { FileListColumn, FileListItem, FileListView, SelectionCause } from "../types";
import { selectionReducer, type SelectionAction, type SelectionState } from "./selection";

export interface FileListProps<T extends FileListItem> {
  items: T[];
  view: FileListView;
  /** Default: all three. */
  columns?: FileListColumn[];
  selectionMode: "multi" | "none";
  selection: ReadonlySet<string>;
  onSelectionChange(next: ReadonlySet<string>, cause: SelectionCause): void;
  onOpen(item: T): void;
  onQuickLook?(item: T): void;
  /** The per-row "more" control (a button with its menu). */
  rowMenu?(item: T): ReactNode;
  onContextMenu?(item: T, anchor: { x: number; y: number }): void;
  /** Extra attributes for a row or tile — drag-and-drop hooks. */
  rowProps?(item: T): HTMLAttributes<HTMLElement>;
  /** Grid thumbnail; default is the file badge or the folder glyph. */
  renderThumb?(item: T): ReactNode;
  /** Consecutive items sharing a label get one header row. */
  groupLabel?(item: T): string | null;
  /** Row-status slot; default is StatusDot + ProgressUnderline from the item. */
  renderStatus?(item: T): ReactNode;
  hasMore: boolean;
  onLoadMore(): void;
  loading: boolean;
  emptyState: ReactNode;
  ariaLabel: string;
}

/** Lists longer than this are windowed. */
export const VIRTUALIZE_ABOVE = 200;
const GROUP_HEIGHT = 32;
const HEADER_HEIGHT = 32;
const TILE_MIN = 168;
const TILE_HEIGHT = 176;
const LONG_PRESS_MS = 500;
const ALL_COLUMNS: FileListColumn[] = ["share", "modified", "size"];
const COLUMN_WIDTH: Record<FileListColumn, string> = { share: "72px", modified: "140px", size: "96px" };

type Row<T> = { kind: "group"; key: string; label: string } | { kind: "items"; key: string; items: Array<{ item: T; index: number }> };

function buildRows<T extends FileListItem>(items: T[], perRow: number, groupLabel: FileListProps<T>["groupLabel"]): Row<T>[] {
  const rows: Row<T>[] = [];
  let current: Array<{ item: T; index: number }> = [];
  let lastLabel: string | null = null;
  const flush = () => {
    if (current.length) rows.push({ kind: "items", key: `i:${current[0]!.item.id}`, items: current });
    current = [];
  };
  items.forEach((item, index) => {
    const label = groupLabel ? groupLabel(item) : null;
    if (label !== lastLabel) {
      flush();
      if (label !== null) rows.push({ kind: "group", key: `g:${label}:${index}`, label });
      lastLabel = label;
    }
    current.push({ item, index });
    if (current.length >= perRow) flush();
  });
  flush();
  return rows;
}

function ShareCell({ item }: { item: FileListItem }) {
  const sharing = item.sharing;
  if (!sharing) return null;
  const parts: ReactNode[] = [];
  if (sharing.people > 0) {
    const label = sharing.people === 1 ? t("list.shared.person") : t("list.shared.people", { count: sharing.people });
    parts.push(
      <Box key="people" component="span" role="img" aria-label={label} title={label} sx={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
        <Users size={14} aria-hidden="true" />
        <span className="num" aria-hidden="true">
          {sharing.people}
        </span>
      </Box>,
    );
  }
  if (sharing.link !== "none") {
    const label = t(sharing.link === "active" ? "list.link.active" : sharing.link === "paused" ? "list.link.paused" : "list.link.expired");
    parts.push(
      <Box key="link" component="span" role="img" aria-label={label} title={label} sx={{ display: "inline-flex", opacity: sharing.link === "active" ? 1 : 0.6 }}>
        <Link2 size={14} aria-hidden="true" />
      </Box>,
    );
  }
  return <>{parts}</>;
}

function DefaultStatus({ item }: { item: FileListItem }) {
  return <StatusDot status={item.scanStatus} reason={item.scanReason} variant="sentence" />;
}

/** The underline a row shows: explicit progress wins; a pending scan is indeterminate. */
function progressOf(item: FileListItem): number | null | undefined {
  if (item.progress !== undefined) return item.progress;
  return item.scanStatus === "pending" ? null : undefined;
}

export function FileList<T extends FileListItem>(props: FileListProps<T>) {
  const { items, view, selectionMode, selection, onSelectionChange, onOpen, onQuickLook, rowMenu, onContextMenu, rowProps, renderThumb, groupLabel, renderStatus, hasMore, onLoadMore, loading, emptyState, ariaLabel } = props;
  const columns = props.columns ?? ALL_COLUMNS;
  const desktop = useIsDesktop();
  const touchRows = useMediaQuery(TOUCH_QUERY, { noSsr: true });
  const multi = selectionMode === "multi";
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const anchor = useRef<string | null>(null);
  const focusPending = useRef(false);
  const longPress = useRef<{ timer: ReturnType<typeof setTimeout>; fired: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const [perRow, setPerRow] = useState(1);

  const grid = view === "grid";
  const rowHeight = touchRows ? layout.touchRowHeight : layout.rowHeight;
  const order = useMemo(() => items.map((item) => item.id), [items]);
  const rows = useMemo(() => buildRows(items, grid ? perRow : 1, groupLabel), [items, grid, perRow, groupLabel]);
  const virtual = items.length > VIRTUALIZE_ABOVE;
  const activeIndex = Math.min(active, Math.max(0, items.length - 1));

  // Tiles per row follow the container width (grid view only).
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!grid || !element) return;
    const measure = () => setPerRow(Math.max(1, Math.floor(element.clientWidth / TILE_MIN) || 1));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [grid]);

  // The virtualizer returns functions that cannot be memoised; this project does not use the
  // React Compiler, so the notice is not actionable.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (rows[index]?.kind === "group" ? GROUP_HEIGHT : grid ? TILE_HEIGHT : rowHeight),
    overscan: 8,
    enabled: virtual,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight, grid, perRow]);

  // Infinite scroll: ask for the next page when the sentinel comes into view.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore || loading || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loading, onLoadMore, items.length]);

  // Roving tabindex: after a keyboard move, focus follows once the target row exists.
  useLayoutEffect(() => {
    if (!focusPending.current) return;
    const target = scrollRef.current?.querySelector<HTMLElement>(`[data-item-index="${activeIndex}"]`);
    if (target) {
      focusPending.current = false;
      target.focus();
    }
  });

  const dispatch = useCallback(
    (action: SelectionAction, cause: SelectionCause) => {
      if (!multi) return;
      const state: SelectionState = { selected: selection, anchor: anchor.current };
      const next = selectionReducer(state, action);
      anchor.current = next.anchor;
      if (next !== state) onSelectionChange(next.selected, cause);
    },
    [multi, selection, onSelectionChange],
  );

  const moveTo = useCallback(
    (index: number, extend: boolean) => {
      const next = Math.min(items.length - 1, Math.max(0, index));
      if (next === activeIndex && !extend) return;
      focusPending.current = true;
      setActive(next);
      if (virtual) {
        const rowIndex = rows.findIndex((row) => row.kind === "items" && row.items.some((entry) => entry.index === next));
        if (rowIndex >= 0) virtualizer.scrollToIndex(rowIndex);
      }
      const id = items[next]?.id;
      if (extend && id) dispatch({ type: "range", id, order }, "range");
    },
    [items, activeIndex, virtual, rows, virtualizer, dispatch, order],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLElement>, item: T, index: number) => {
    // Keys typed into a control inside the row (the checkbox, the menu button) belong to it.
    if (event.target !== event.currentTarget) return;
    const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
    const step = grid ? perRow : 1;
    switch (event.key) {
      case "ArrowDown":
      case "j":
        event.preventDefault();
        moveTo(index + step, event.shiftKey);
        return;
      case "ArrowUp":
      case "k":
        event.preventDefault();
        moveTo(index - step, event.shiftKey);
        return;
      case "ArrowRight":
        if (!grid) return;
        event.preventDefault();
        moveTo(index + 1, event.shiftKey);
        return;
      case "ArrowLeft":
        if (!grid) return;
        event.preventDefault();
        moveTo(index - 1, event.shiftKey);
        return;
      case "Home":
        event.preventDefault();
        moveTo(0, event.shiftKey);
        return;
      case "End":
        event.preventDefault();
        moveTo(items.length - 1, event.shiftKey);
        return;
      case "Enter":
        event.preventDefault();
        onOpen(item);
        return;
      case " ":
        event.preventDefault();
        if (onQuickLook) onQuickLook(item);
        else dispatch({ type: "toggle", id: item.id }, "toggle");
        return;
      case "a":
      case "A":
        if (!mod || !multi) return;
        event.preventDefault();
        dispatch({ type: "all", order }, "all");
        return;
      case "Escape":
        if (selection.size === 0) return;
        event.preventDefault();
        dispatch({ type: "clear" }, "clear");
        return;
    }
  };

  const onClick = (event: MouseEvent<HTMLElement>, item: T, index: number) => {
    // A click on a control inside the row is that control's.
    if ((event.target as HTMLElement).closest("button, a, input, [data-no-row-click]")) return;
    setActive(index);
    if (longPress.current?.fired) {
      longPress.current = null;
      return;
    }
    const mod = isApplePlatform() ? event.metaKey : event.ctrlKey;
    if (!multi) {
      onOpen(item);
      return;
    }
    if (event.shiftKey) dispatch({ type: "range", id: item.id, order }, "range");
    else if (mod) dispatch({ type: "toggle", id: item.id }, "toggle");
    else if (!desktop) {
      // Touch layout: a tap opens; once a selection exists, taps add to or remove from it.
      if (selection.size > 0) dispatch({ type: "toggle", id: item.id }, "toggle");
      else onOpen(item);
    } else dispatch({ type: "click", id: item.id }, "click");
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>, item: T) => {
    if (!multi || event.pointerType !== "touch") return;
    const state = {
      fired: false,
      timer: setTimeout(() => {
        state.fired = true;
        dispatch({ type: "longpress", id: item.id }, "longpress");
      }, LONG_PRESS_MS),
    };
    longPress.current = state;
  };
  const cancelLongPress = () => {
    if (longPress.current && !longPress.current.fired) {
      clearTimeout(longPress.current.timer);
      longPress.current = null;
    }
  };
  useEffect(() => () => {
    if (longPress.current) clearTimeout(longPress.current.timer);
  }, []);

  const template = desktop
    ? `32px minmax(0, 1fr) ${columns.map((column) => COLUMN_WIDTH[column]).join(" ")} 36px`.replace(/\s+/g, " ")
    : `minmax(0, 1fr) ${layout.touchTarget}px`;

  const itemHandlers = (item: T, index: number) => {
    const extra = rowProps ? rowProps(item) : {};
    return {
      ...extra,
      tabIndex: index === activeIndex ? 0 : -1,
      "data-item-index": index,
      "data-item-id": item.id,
      "aria-selected": multi ? selection.has(item.id) : undefined,
      onFocus: () => setActive(index),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => onKeyDown(event, item, index),
      onClick: (event: MouseEvent<HTMLElement>) => onClick(event, item, index),
      onDoubleClick: () => {
        if (multi && desktop) onOpen(item);
      },
      onPointerDown: (event: PointerEvent<HTMLElement>) => onPointerDown(event, item),
      onPointerUp: cancelLongPress,
      onPointerLeave: cancelLongPress,
      onPointerCancel: cancelLongPress,
      onContextMenu: onContextMenu
        ? (event: MouseEvent<HTMLElement>) => {
            event.preventDefault();
            setActive(index);
            onContextMenu(item, { x: event.clientX, y: event.clientY });
          }
        : undefined,
    };
  };

  const checkbox = (item: T) =>
    multi ? (
      <Box
        component="input"
        type="checkbox"
        tabIndex={-1}
        checked={selection.has(item.id)}
        aria-label={t("list.select", { name: item.name })}
        onChange={() => dispatch({ type: "toggle", id: item.id }, "toggle")}
        sx={{ width: 14, height: 14, margin: 0, cursor: "pointer" }}
      />
    ) : null;

  const nameOf = (item: T) => {
    const name = (
      <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: item.kind === "folder" ? 500 : 400 }}>
        {item.name}
      </Box>
    );
    // Folder names are the shared element of the folder-enter transition (name → breadcrumb).
    return item.kind === "folder" ? <ViewTransition name={`hf-node-${item.id}`}>{name}</ViewTransition> : name;
  };

  const underline = (item: T) => {
    const progress = progressOf(item);
    if (progress === undefined) return null;
    return <ProgressUnderline value={progress} label={`${statusSentence("pending") ?? ""} ${item.name}`.trim()} />;
  };

  const listRow = (item: T, index: number) => {
    const status = renderStatus ? renderStatus(item) : <DefaultStatus item={item} />;
    const glyph = item.kind === "folder" ? <FolderGlyph size={desktop ? 16 : 20} /> : <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={desktop ? 16 : 20} />;
    if (!desktop) {
      return (
        <Box
          key={item.id}
          role="row"
          {...itemHandlers(item, index)}
          sx={{ position: "relative", display: "grid", gridTemplateColumns: template, alignItems: "center", minHeight: rowHeight, padding: "0 0 0 8px", borderRadius: "8px", outlineOffset: -2, cursor: "default", userSelect: "none", WebkitTouchCallout: "none" }}
        >
          <Box role="gridcell" sx={{ display: "flex", alignItems: "center", gap: 3, minWidth: 0 }}>
            {glyph}
            <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: "18px" }}>
              {nameOf(item)}
              <Box component="span" sx={{ display: "flex", alignItems: "center", gap: "6px", color: hf.textSecondary, fontSize: 12, minWidth: 0 }}>
                {status}
                {item.secondary ? <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.secondary}</Box> : null}
                {item.kind === "file" && columns.includes("size") ? <Bytes value={item.size} /> : null}
                {columns.includes("modified") ? <RelativeTime value={item.updatedAt} variant="date" /> : null}
                {columns.includes("share") ? <ShareCell item={item} /> : null}
              </Box>
            </Box>
          </Box>
          <Box role="gridcell" sx={{ display: "flex", justifyContent: "center" }}>
            {rowMenu ? rowMenu(item) : null}
          </Box>
          {underline(item)}
        </Box>
      );
    }
    return (
      <Box
        key={item.id}
        role="row"
        {...itemHandlers(item, index)}
        sx={{ position: "relative", display: "grid", gridTemplateColumns: template, alignItems: "center", height: rowHeight, padding: "0 12px", borderRadius: `${layout.radius.control}px`, outlineOffset: -2, cursor: "default", userSelect: "none", "&:hover": { backgroundColor: hf.surface2 } }}
      >
        <Box role="gridcell" sx={{ display: "flex", alignItems: "center" }}>
          {checkbox(item)}
        </Box>
        <Box role="gridcell" sx={{ display: "flex", alignItems: "center", gap: "10px", minWidth: 0 }}>
          {glyph}
          {nameOf(item)}
          {item.secondary ? (
            <Box component="span" sx={{ color: hf.textSecondary, fontSize: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: "0 1 auto" }}>
              {item.secondary}
            </Box>
          ) : null}
          {status}
        </Box>
        {columns.includes("share") ? (
          <Box role="gridcell" sx={{ display: "inline-flex", alignItems: "center", gap: 2, color: hf.textSecondary, fontSize: 12 }}>
            <ShareCell item={item} />
          </Box>
        ) : null}
        {columns.includes("modified") ? (
          <Box role="gridcell" sx={{ color: hf.textSecondary }}>
            <RelativeTime value={item.updatedAt} variant="date" />
          </Box>
        ) : null}
        {columns.includes("size") ? (
          <Box role="gridcell" sx={{ color: hf.textSecondary, textAlign: "right" }}>
            {item.kind === "folder" ? <span className="mono">—</span> : <Bytes value={item.size} />}
          </Box>
        ) : null}
        <Box role="gridcell" sx={{ display: "flex", justifyContent: "center" }}>
          {rowMenu ? rowMenu(item) : null}
        </Box>
        {underline(item)}
      </Box>
    );
  };

  const tile = (item: T, index: number) => {
    const uploading = item.progress !== undefined;
    return (
      <Box
        key={item.id}
        role="gridcell"
        {...itemHandlers(item, index)}
        sx={{
          position: "relative",
          display: "flex",
          flexDirection: "column",
          gap: 2,
          padding: 2,
          minWidth: 0,
          height: TILE_HEIGHT - 8,
          border: `1px ${uploading ? "dashed" : "solid"} ${hf.hairline}`,
          borderRadius: `${layout.radius.card}px`,
          opacity: uploading ? 0.75 : 1,
          outlineOffset: -2,
          cursor: "default",
          userSelect: "none",
          overflow: "hidden",
          "&:hover": { backgroundColor: hf.surface2 },
        }}
      >
        <Box sx={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: `${layout.radius.control}px`, overflow: "hidden" }}>
          {renderThumb ? renderThumb(item) : item.kind === "folder" ? <FolderGlyph size={40} /> : <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={48} />}
          {multi ? <Box sx={{ position: "absolute", top: 4, left: 4, display: "flex" }}>{checkbox(item)}</Box> : null}
          {rowMenu ? <Box sx={{ position: "absolute", top: 0, right: 0 }}>{rowMenu(item)}</Box> : null}
        </Box>
        <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0, lineHeight: "18px" }}>
          {nameOf(item)}
          <Box component="span" sx={{ display: "flex", alignItems: "center", gap: "6px", color: hf.textSecondary, fontSize: 12, minWidth: 0, minHeight: 16 }}>
            {renderStatus ? renderStatus(item) : <DefaultStatus item={item} />}
            {item.secondary ? <Box component="span" sx={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.secondary}</Box> : null}
            {item.kind === "file" ? <Bytes value={item.size} /> : null}
          </Box>
        </Box>
        {underline(item)}
      </Box>
    );
  };

  const renderRow = (row: Row<T>) => {
    if (row.kind === "group") {
      return (
        <Box key={row.key} role="row" sx={{ display: "flex", alignItems: "flex-end", height: GROUP_HEIGHT, padding: "0 12px 6px", color: hf.textSecondary, fontSize: 12, fontWeight: 500 }}>
          <Box role="columnheader" data-group-label>
            {row.label}
          </Box>
        </Box>
      );
    }
    if (!grid) {
      const entry = row.items[0]!;
      return listRow(entry.item, entry.index);
    }
    return (
      <Box key={row.key} role="row" sx={{ display: "grid", gridTemplateColumns: `repeat(${perRow}, minmax(0, 1fr))`, gap: 2, height: TILE_HEIGHT, paddingBottom: 2, boxSizing: "border-box" }}>
        {row.items.map((entry) => tile(entry.item, entry.index))}
      </Box>
    );
  };

  const skeletonCount = items.length === 0 ? 8 : 3;
  const skeletons = loading ? (
    <Box aria-hidden="true" data-skeleton-rows>
      {Array.from({ length: skeletonCount }, (_, i) => (
        <Box key={i} sx={{ display: "flex", alignItems: "center", gap: 3, height: rowHeight, padding: "0 12px" }}>
          <Skeleton variant="rounded" width={16} height={16} />
          <Skeleton variant="text" width={`${40 + ((i * 17) % 35)}%`} />
        </Box>
      ))}
    </Box>
  ) : null;

  const showEmpty = items.length === 0 && !loading;
  const virtualItems = virtual ? virtualizer.getVirtualItems() : [];

  return (
    <Box
      ref={scrollRef}
      data-hf-list
      data-view={view}
      sx={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", padding: desktop ? "0 8px 24px" : "0 8px 96px", position: "relative" }}
    >
      {showEmpty ? (
        emptyState
      ) : (
        <Box role="grid" aria-label={ariaLabel} aria-multiselectable={multi || undefined} aria-rowcount={items.length} aria-busy={loading || undefined}>
          {desktop && !grid ? (
            <Box role="row" sx={{ display: "grid", gridTemplateColumns: template, alignItems: "center", height: HEADER_HEIGHT, padding: "0 12px", color: hf.textSecondary, fontSize: 12, borderBottom: `1px solid ${hf.hairline}`, position: "sticky", top: 0, backgroundColor: hf.surface, zIndex: 1 }}>
              <Box role="presentation" />
              <Box role="columnheader">{t("list.name")}</Box>
              {columns.includes("share") ? <Box role="columnheader" aria-label={t("list.sharing")} /> : null}
              {columns.includes("modified") ? <Box role="columnheader">{t("list.modified")}</Box> : null}
              {columns.includes("size") ? (
                <Box role="columnheader" sx={{ textAlign: "right" }}>
                  {t("list.size")}
                </Box>
              ) : null}
              <Box role="presentation" />
            </Box>
          ) : null}
          {virtual ? (
            <Box role="rowgroup" sx={{ position: "relative", height: virtualizer.getTotalSize() }}>
              {virtualItems.map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                return (
                  <Box key={row.key} role="presentation" sx={{ position: "absolute", top: 0, left: 0, right: 0, transform: `translateY(${virtualRow.start}px)` }}>
                    {renderRow(row)}
                  </Box>
                );
              })}
            </Box>
          ) : (
            <Box role="rowgroup" sx={{ paddingTop: grid ? 2 : 0 }}>
              {rows.map(renderRow)}
            </Box>
          )}
        </Box>
      )}
      {skeletons}
      {hasMore ? <Box ref={sentinelRef} data-load-more-sentinel aria-hidden="true" sx={{ height: 1 }} /> : null}
    </Box>
  );
}
