import { act, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { FileList, VIRTUALIZE_ABOVE, type FileListProps } from "../../../../src/client/components/FileList";
import type { FileListItem, SelectionCause } from "../../../../src/client/components/types";
import { lightTokens, tokenVarName } from "../../../../src/client/theme/tokens";
import { intersect, renderShell, resolveVar, setupShell, setViewport, stubLayout } from "./helpers";

setupShell();

function makeItems(count: number): FileListItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    kind: i < 2 ? ("folder" as const) : ("file" as const),
    name: i < 2 ? `Folder ${i}` : `file-${i}.pdf`,
    size: i < 2 ? null : 1024 * (i + 1),
    mimeCategory: "pdf" as const,
    scanStatus: "clean" as const,
    updatedAt: "2026-10-02T12:00:00.000Z",
  }));
}

interface HarnessProps extends Partial<FileListProps<FileListItem>> {
  items: FileListItem[];
  onCause?: (cause: SelectionCause, ids: string[]) => void;
}

function Harness({ items, onCause, ...rest }: HarnessProps) {
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  return (
    <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <FileList
        items={items}
        view="list"
        selectionMode="multi"
        selection={selection}
        onSelectionChange={(next, cause) => {
          setSelection(next);
          onCause?.(cause, Array.from(next));
        }}
        onOpen={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        loading={false}
        emptyState={<div>empty here</div>}
        ariaLabel="Test files"
        {...rest}
      />
    </div>
  );
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>("[data-item-index]"));
const row = (index: number) => document.querySelector<HTMLElement>(`[data-item-index="${index}"]`)!;
const selectedIds = () => rows().filter((r) => r.getAttribute("aria-selected") === "true").map((r) => r.getAttribute("data-item-id"));
const key = (element: HTMLElement, k: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(element, { key: k, ...init });

describe("FileList: structure", () => {
  it("is a labelled grid with the D01 columns by default", () => {
    renderShell(<Harness items={makeItems(3)} />);
    const grid = screen.getByRole("grid", { name: "Test files" });
    expect(grid.getAttribute("aria-multiselectable")).toBe("true");
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent || h.getAttribute("aria-label") || "")).toEqual(["Name", "Sharing", "Modified", "Size"]);
    expect(getComputedStyle(row(0)).gridTemplateColumns).toBe("32px minmax(0, 1fr) 72px 140px 96px 36px");
    // No owner column and no scan column.
    expect(document.body.textContent).not.toMatch(/Owner|Scan status/);
  });

  it("the column set follows `columns`", () => {
    renderShell(<Harness items={makeItems(3)} columns={["size"]} />);
    expect(getComputedStyle(row(0)).gridTemplateColumns).toBe("32px minmax(0, 1fr) 96px 36px");
    expect(screen.queryByText("Modified")).toBeNull();
    expect(screen.getByText("Size")).toBeTruthy();
  });

  it("selectionMode none: no checkboxes, no aria-selected, a click opens", () => {
    const onOpen = vi.fn();
    renderShell(<Harness items={makeItems(3)} selectionMode="none" onOpen={onOpen} />);
    expect(screen.queryAllByRole("checkbox")).toEqual([]);
    expect(row(0).hasAttribute("aria-selected")).toBe(false);
    fireEvent.click(row(1));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
  });

  it("shows the empty state only when there is nothing and nothing is loading", () => {
    const view = renderShell(<Harness items={[]} />);
    expect(screen.getByText("empty here")).toBeTruthy();
    view.rerender(<Harness items={[]} loading />);
    expect(screen.queryByText("empty here")).toBeNull();
    expect(document.querySelector("[data-skeleton-rows]")).not.toBeNull();
  });

  it("consecutive items sharing a group label get one header", () => {
    const items = makeItems(5);
    renderShell(<Harness items={items} groupLabel={(item) => (Number(item.id.slice(1)) < 2 ? "Today" : "Earlier")} />);
    expect(Array.from(document.querySelectorAll("[data-group-label]")).map((n) => n.textContent)).toEqual(["Today", "Earlier"]);
  });

  it("shows `secondary`, the default status sentence and the progress underline from the item", () => {
    const items = makeItems(4);
    items[2] = { ...items[2]!, scanStatus: "infected", secondary: "Owned by Grace" };
    items[3] = { ...items[3]!, scanStatus: "pending" };
    renderShell(<Harness items={items} />);
    expect(row(2).textContent).toContain("Owned by Grace");
    expect(row(2).textContent).toContain("Blocked — flagged by the malware scan");
    expect(row(3).querySelector('[role="progressbar"]')?.getAttribute("data-progress")).toBe("indeterminate");
    expect(row(0).querySelector('[role="progressbar"]')).toBeNull();
  });

  it("renderStatus and rowMenu are slots", () => {
    renderShell(<Harness items={makeItems(3)} renderStatus={(item) => <i>status-{item.id}</i>} rowMenu={(item) => <button aria-label={`More actions for ${item.name}`}>⋮</button>} />);
    expect(screen.getByText("status-n2")).toBeTruthy();
    expect(screen.getByRole("button", { name: "More actions for file-2.pdf" })).toBeTruthy();
  });

  it("asks for more when the sentinel comes into view, and not while loading", () => {
    const onLoadMore = vi.fn();
    const view = renderShell(<Harness items={makeItems(3)} hasMore onLoadMore={onLoadMore} />);
    act(() => intersect((element) => element.hasAttribute("data-load-more-sentinel")));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    view.rerender(<Harness items={makeItems(3)} hasMore loading onLoadMore={onLoadMore} />);
    act(() => intersect((element) => element.hasAttribute("data-load-more-sentinel")));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });
});

describe("FileList: selection by pointer", () => {
  it("click, ⌘/Ctrl-click, shift-click and the checkbox report their cause", () => {
    const causes: Array<[SelectionCause, string[]]> = [];
    renderShell(<Harness items={makeItems(6)} onCause={(cause, ids) => causes.push([cause, ids])} />);
    fireEvent.click(row(1));
    fireEvent.click(row(3), { ctrlKey: true });
    fireEvent.click(row(5), { shiftKey: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select Folder 0" }));
    expect(causes).toEqual([
      ["click", ["n1"]],
      ["toggle", ["n1", "n3"]],
      ["range", ["n3", "n4", "n5"]],
      ["toggle", ["n3", "n4", "n5", "n0"]],
    ]);
  });

  it("double-click opens", () => {
    const onOpen = vi.fn();
    renderShell(<Harness items={makeItems(3)} onOpen={onOpen} />);
    fireEvent.doubleClick(row(2));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "n2" }));
  });

  it("long-press on touch selects; a quick tap does not", () => {
    vi.useFakeTimers();
    const causes: SelectionCause[] = [];
    renderShell(<Harness items={makeItems(3)} onCause={(cause) => causes.push(cause)} />);
    fireEvent.pointerDown(row(1), { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(200));
    fireEvent.pointerUp(row(1), { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(1000));
    expect(causes).toEqual([]);
    fireEvent.pointerDown(row(1), { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(600));
    expect(causes).toEqual(["longpress"]);
    expect(selectedIds()).toEqual(["n1"]);
  });

  it("context menu reports the item and the pointer position", () => {
    const onContextMenu = vi.fn();
    renderShell(<Harness items={makeItems(3)} onContextMenu={onContextMenu} />);
    fireEvent.contextMenu(row(2), { clientX: 40, clientY: 50 });
    expect(onContextMenu).toHaveBeenCalledWith(expect.objectContaining({ id: "n2" }), { x: 40, y: 50 });
  });
});

describe("FileList: keyboard", () => {
  it("has a roving tabindex: exactly one row is in the tab order", () => {
    renderShell(<Harness items={makeItems(5)} />);
    expect(rows().filter((r) => r.tabIndex === 0).length).toBe(1);
    expect(row(0).tabIndex).toBe(0);
  });

  it("↓ / j and ↑ / k move focus; Home and End jump", () => {
    renderShell(<Harness items={makeItems(5)} />);
    row(0).focus();
    key(row(0), "ArrowDown");
    expect(document.activeElement).toBe(row(1));
    key(row(1), "j");
    expect(document.activeElement).toBe(row(2));
    key(row(2), "ArrowUp");
    expect(document.activeElement).toBe(row(1));
    key(row(1), "k");
    expect(document.activeElement).toBe(row(0));
    key(row(0), "ArrowUp");
    expect(document.activeElement).toBe(row(0));
    key(row(0), "End");
    expect(document.activeElement).toBe(row(4));
    key(row(4), "Home");
    expect(document.activeElement).toBe(row(0));
    expect(rows().filter((r) => r.tabIndex === 0)).toEqual([row(0)]);
  });

  it("Enter opens, Space is quick look", () => {
    const onOpen = vi.fn();
    const onQuickLook = vi.fn();
    renderShell(<Harness items={makeItems(3)} onOpen={onOpen} onQuickLook={onQuickLook} />);
    row(1).focus();
    key(row(1), "Enter");
    key(row(1), " ");
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
    expect(onQuickLook).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
  });

  it("Space toggles the selection when there is no quick look", () => {
    renderShell(<Harness items={makeItems(3)} />);
    row(1).focus();
    key(row(1), " ");
    expect(selectedIds()).toEqual(["n1"]);
  });

  it("⌘A / Ctrl+A selects all, Esc clears, Shift+↓ extends a range", () => {
    const causes: SelectionCause[] = [];
    renderShell(<Harness items={makeItems(4)} onCause={(cause) => causes.push(cause)} />);
    row(0).focus();
    key(row(0), "a", { ctrlKey: true });
    expect(selectedIds()).toEqual(["n0", "n1", "n2", "n3"]);
    key(row(0), "Escape");
    expect(selectedIds()).toEqual([]);
    fireEvent.click(row(1));
    key(row(1), "ArrowDown", { shiftKey: true });
    expect(selectedIds()).toEqual(["n1", "n2"]);
    expect(causes).toEqual(["all", "clear", "click", "range"]);
  });

  it("a key pressed inside a row's own control is left to that control", () => {
    const onOpen = vi.fn();
    renderShell(<Harness items={makeItems(3)} onOpen={onOpen} rowMenu={() => <button>menu</button>} />);
    key(screen.getAllByRole("button", { name: "menu" })[0]!, "Enter");
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe("FileList: virtualisation", () => {
  it(`2,000 items render fewer than 150 rows, starting with the first`, () => {
    const restore = stubLayout(1000, 600);
    try {
      renderShell(<Harness items={makeItems(2000)} />);
      const count = rows().length;
      expect(count).toBeGreaterThan(5);
      expect(count).toBeLessThan(150);
      expect(row(0)).not.toBeNull();
      expect(document.querySelector('[data-item-index="1999"]')).toBeNull();
      expect(screen.getByRole("grid").getAttribute("aria-rowcount")).toBe("2000");
    } finally {
      restore();
    }
  });

  it("control: at or below the threshold every row renders", () => {
    const restore = stubLayout(1000, 600);
    try {
      expect(VIRTUALIZE_ABOVE).toBe(200);
      renderShell(<Harness items={makeItems(150)} />);
      expect(rows().length).toBe(150);
    } finally {
      restore();
    }
  });

  it("keyboard focus still works inside a windowed list", () => {
    const restore = stubLayout(1000, 600);
    try {
      renderShell(<Harness items={makeItems(2000)} />);
      row(0).focus();
      key(row(0), "ArrowDown");
      expect(document.activeElement).toBe(row(1));
    } finally {
      restore();
    }
  });
});

describe("FileList: grid view and mobile", () => {
  it("grid view renders tiles that carry aria-selected", () => {
    const restore = stubLayout(800, 600);
    try {
      renderShell(<Harness items={makeItems(5)} view="grid" renderThumb={(item) => <i>thumb-{item.id}</i>} />);
      expect(document.querySelector("[data-view]")?.getAttribute("data-view")).toBe("grid");
      expect(rows().every((r) => r.getAttribute("role") === "gridcell")).toBe(true);
      expect(screen.getByText("thumb-n3")).toBeTruthy();
      fireEvent.click(row(2));
      expect(selectedIds()).toEqual(["n2"]);
    } finally {
      restore();
    }
  });

  it("below 1024 px rows are two-line with a 44 px menu column; a tap opens, long-press selects", () => {
    setViewport(390, { coarse: true });
    const onOpen = vi.fn();
    renderShell(<Harness items={makeItems(3)} onOpen={onOpen} />);
    expect(getComputedStyle(row(0)).gridTemplateColumns).toBe("minmax(0, 1fr) 44px");
    expect(getComputedStyle(row(0)).minHeight).toBe("48px");
    expect(screen.queryAllByRole("columnheader")).toEqual([]);
    fireEvent.click(row(1));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "n1" }));
  });
});

describe("FileList: selection styling is theme-owned", () => {
  const source = import.meta.glob<string>("/src/client/components/FileList/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

  it("the component's source names no activity-colour token", () => {
    expect(Object.keys(source).sort()).toEqual(["/src/client/components/FileList/FileList.tsx", "/src/client/components/FileList/index.ts", "/src/client/components/FileList/selection.ts"]);
    for (const [path, code] of Object.entries(source)) expect(/accent|palette\.primary/i.test(code), path).toBe(false);
  });

  it("a selected row still computes to the tint and the 2 px inset, through the theme's global rule", () => {
    renderShell(<Harness items={makeItems(3)} />);
    const before = getComputedStyle(row(1));
    expect(resolveVar(before.backgroundColor)).not.toBe(lightTokens.accentTint);
    fireEvent.click(row(1));
    const style = getComputedStyle(row(1));
    // jsdom leaves `var(--…)` unresolved; resolve it against the scheme's stylesheet, then
    // compare with the token VALUE (not with the variable name, which would match itself).
    expect(style.backgroundColor).toBe(`var(${tokenVarName("accentTint")})`);
    expect(resolveVar(style.backgroundColor)).toBe(lightTokens.accentTint);
    expect(style.boxShadow).toBe(`inset 2px 0 0 var(${tokenVarName("accent")})`);
    expect(resolveVar(`var(${tokenVarName("accent")})`)).toBe(lightTokens.accent);
    // An unselected neighbour is untouched.
    expect(resolveVar(getComputedStyle(row(0)).backgroundColor)).not.toBe(lightTokens.accentTint);
  });

  it("control: outside a data-hf-list container, aria-selected gets no tint", () => {
    const { container } = renderShell(
      <div>
        <div aria-selected="true" data-testid="stray">
          x
        </div>
      </div>,
    );
    const stray = container.querySelector<HTMLElement>('[data-testid="stray"]')!;
    expect(getComputedStyle(stray).backgroundColor).not.toContain("--hf-");
  });
});
