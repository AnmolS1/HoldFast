import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Breadcrumbs, useBreadcrumbs, type Crumb } from "../../../../src/client/components/Breadcrumbs";
import { FileList } from "../../../../src/client/components/FileList";
import type { FileListItem } from "../../../../src/client/components/types";
import { renderShell, setupShell } from "./helpers";

setupShell();

function Trail({ crumbs }: { crumbs: Crumb[] }) {
  useBreadcrumbs(crumbs);
  return <Breadcrumbs fallbackTitle="Files" />;
}

const show = (crumbs: Crumb[]) =>
  renderShell(
    <MemoryRouter>
      <Trail crumbs={crumbs} />
    </MemoryRouter>,
  );

describe("Breadcrumbs", () => {
  it("parents are links in a navigation, the current page is the h1; no trail = the fallback title", () => {
    const view = show([
      { label: "Files", to: "/" },
      { label: "Work", to: "/folder/w" },
      { label: "Invoices" },
    ]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(Array.from(nav.querySelectorAll("a"), (a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["Files", "/"],
      ["Work", "/folder/w"],
    ]);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Invoices");
    view.unmount();
    renderShell(
      <MemoryRouter>
        <Breadcrumbs fallbackTitle="Files" />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Files");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("without dropProps a link carries nothing extra", () => {
    show([{ label: "Files", to: "/" }, { label: "Invoices" }]);
    const link = screen.getByRole("link", { name: "Files" });
    expect(link.getAttribute("style")).toBeNull();
    expect(link.getAttribute("draggable")).toBeNull();
    expect(link.getAttributeNames().filter((name) => name.startsWith("data-drop"))).toEqual([]);
  });

  it("dropProps are spread onto that crumb's link only — and can change neither where it leads nor its text", () => {
    const onDrop = vi.fn();
    const onDragOver = vi.fn();
    show([
      { label: "Files", to: "/" },
      {
        label: "Work",
        to: "/folder/w",
        dropProps: {
          onDrop,
          onDragOver,
          style: { outlineStyle: "dashed" },
          // A caller cannot redirect the link through the extra attributes.
          ...({ "data-drop-target": "true", to: "/elsewhere", href: "/elsewhere" } as object),
        },
      },
      { label: "Invoices" },
    ]);
    const work = screen.getByRole("link", { name: "Work" });
    const files = screen.getByRole("link", { name: "Files" });
    fireEvent.dragOver(work);
    fireEvent.drop(work);
    fireEvent.drop(files);
    expect(onDragOver).toHaveBeenCalledTimes(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(work.getAttribute("data-drop-target")).toBe("true");
    expect(work.style.outlineStyle).toBe("dashed");
    expect(work.getAttribute("href")).toBe("/folder/w");
    expect(files.getAttribute("data-drop-target")).toBeNull();
    expect(files.style.outlineStyle).toBe("");
  });

  it("a crumb without `to` is text: its dropProps go nowhere", () => {
    const onDrop = vi.fn();
    show([{ label: "…", dropProps: { onDrop } }, { label: "Invoices" }]);
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(nav.querySelectorAll("a")).toHaveLength(0);
    fireEvent.drop(nav.querySelector("li span")!);
    expect(onDrop).not.toHaveBeenCalled();
  });

  // m20: a folder's row name and its own crumb are the two ends of the folder-enter transition, so
  // they share `hf-node-<id>`. When the row of the folder the trail is IN is drawn at the same time
  // as that crumb (going back up while the old trail is still set), React refuses the pair.
  describe("folder-enter transition names (m20)", () => {
    const DUPLICATE = /There are two <ViewTransition name=%s> components with the same name/;
    const folder = (id: string): FileListItem => ({
      id,
      kind: "folder",
      name: `Folder ${id}`,
      size: null,
      mimeCategory: "other",
      scanStatus: "clean",
      updatedAt: "2099-01-01T00:00:00.000Z",
    });
    const listOf = (items: FileListItem[]) => (
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <FileList
          items={items}
          view="list"
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
      </div>
    );
    const duplicateWarnings = (spy: ReturnType<typeof vi.spyOn>) =>
      spy.mock.calls.filter((call) => typeof call[0] === "string" && DUPLICATE.test(call[0]));

    it("the row of the folder the trail ends in carries no name while its crumb is mounted", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        // React warns once per name per module: an id of this test's own.
        const here = "m20-current";
        renderShell(
          <MemoryRouter>
            <Trail
              crumbs={[
                { label: "Files", to: "/" },
                { label: `Folder ${here}`, id: here },
              ]}
            />
            {listOf([folder(here), folder("m20-other")])}
          </MemoryRouter>,
        );
        expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(`Folder ${here}`);
        expect(duplicateWarnings(spy)).toEqual([]);
      } finally {
        spy.mockRestore();
      }
    });

    it("control: every other folder row is still named (two lists drawing the same folder collide)", () => {
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        renderShell(
          <MemoryRouter>
            <Trail
              crumbs={[
                { label: "Files", to: "/" },
                { label: "Elsewhere", id: "m20-elsewhere" },
              ]}
            />
            {listOf([folder("m20-named")])}
            {listOf([folder("m20-named")])}
          </MemoryRouter>,
        );
        expect(duplicateWarnings(spy)).toHaveLength(1);
        expect(String(duplicateWarnings(spy)[0]![1])).toContain("hf-node-m20-named");
      } finally {
        spy.mockRestore();
      }
    });
  });
});
