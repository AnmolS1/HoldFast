import { fireEvent, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { Breadcrumbs, useBreadcrumbs, type Crumb } from "../../../../src/client/components/Breadcrumbs";
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
});
