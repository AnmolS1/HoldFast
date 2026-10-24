// R1 a11y-8 / a11y-9: state in the file list is never carried by dimming. An uploading tile keeps its
// meta text at full strength (the dashed edge and the progress show the state), and a paused or
// expired link has a glyph of its own, not the active link's icon at a lower opacity.
import { describe, expect, it } from "vitest";
import { FileList } from "../../../../src/client/components/FileList";
import type { FileListItem } from "../../../../src/client/components/types";
import { renderShell, setupShell, stubLayout } from "./helpers";

setupShell();

const item = (id: string, extra: Partial<FileListItem>): FileListItem => ({
  id,
  kind: "file",
  name: `${id}.pdf`,
  size: 2048,
  mimeCategory: "pdf",
  scanStatus: "clean",
  updatedAt: "2099-01-02T12:00:00.000Z",
  ...extra,
});

function list(items: FileListItem[], view: "list" | "grid") {
  return renderShell(
    <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
      <FileList
        items={items}
        view={view}
        selectionMode="multi"
        selection={new Set()}
        onSelectionChange={() => {}}
        onOpen={() => {}}
        hasMore={false}
        onLoadMore={() => {}}
        loading={false}
        emptyState={<div>empty</div>}
        ariaLabel="Test files"
      />
    </div>,
  );
}

/** The product of every opacity from the element up to the document. */
function effectiveOpacity(element: Element): number {
  let value = 1;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const own = getComputedStyle(node).opacity;
    if (own !== "") value *= Number(own);
  }
  return value;
}

describe("FileList: no state by opacity alone", () => {
  it("an uploading grid tile is not dimmed (its meta line stays at full contrast)", () => {
    const restore = stubLayout(800, 600);
    try {
      list([item("up", { progress: 0.4 }), item("done", {})], "grid");
      const tiles = Array.from(document.querySelectorAll<HTMLElement>("[data-item-index]"));
      expect(tiles).toHaveLength(2);
      for (const tile of tiles) expect(effectiveOpacity(tile), tile.dataset.itemId).toBe(1);
    } finally {
      restore();
    }
  });

  it("paused and expired links have the 'link off' glyph at full opacity; an active link keeps its own", () => {
    const restore = stubLayout(1200, 600);
    try {
      list(
        [
          item("a", { sharing: { people: 0, link: "active" } }),
          item("p", { sharing: { people: 0, link: "paused" } }),
          item("e", { sharing: { people: 0, link: "expired" } }),
        ],
        "list",
      );
      const glyph = (label: string) => {
        const holder = document.querySelector(`[role="img"][aria-label="${label}"]`);
        expect(holder, label).not.toBeNull();
        return holder!;
      };
      for (const label of ["Link paused", "Link expired"]) {
        expect(glyph(label).querySelector("svg.lucide-link-2-off"), label).not.toBeNull();
        expect(effectiveOpacity(glyph(label)), label).toBe(1);
      }
      expect(glyph("Link on").querySelector("svg.lucide-link-2-off")).toBeNull();
      expect(glyph("Link on").querySelector("svg.lucide-link-2")).not.toBeNull();
    } finally {
      restore();
    }
  });
});
