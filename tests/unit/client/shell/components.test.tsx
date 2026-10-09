// The smaller shared components.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { BottomSheet } from "../../../../src/client/components/BottomSheet";
import { ConfirmDialog } from "../../../../src/client/components/ConfirmDialog";
import { EmptyState } from "../../../../src/client/components/EmptyState";
import { ErrorBoundary } from "../../../../src/client/components/ErrorBoundary";
import { badgeText, FileBadge, FolderGlyph } from "../../../../src/client/components/FileBadge";
import { FrameBanner } from "../../../../src/client/components/FrameBanner";
import { PlaceholderPage } from "../../../../src/client/components/PlaceholderPage";
import { SelectionBar, SelectionBarAction } from "../../../../src/client/components/SelectionBar";
import { StorageBar } from "../../../../src/client/components/StorageBar";
import { getToasts, toast, Toaster } from "../../../../src/client/components/Toaster";
import { clampUndoDuration, undoToast } from "../../../../src/client/components/UndoToast";
import { lightTokens } from "../../../../src/client/theme/tokens";
import { renderShell, resolveVar, setupShell } from "./helpers";

setupShell();

describe("EmptyState and PlaceholderPage", () => {
  it.each(["first-use", "cleared", "no-results", "unavailable"] as const)("%s: a monochrome inline drawing, a title, a body", (type) => {
    const { container } = renderShell(<EmptyState type={type} title="Title" body="Body text" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("stroke")).toBe("currentColor");
    // One colour only: no element of the drawing sets its own.
    expect(Array.from(svg.querySelectorAll("*")).some((node) => node.hasAttribute("stroke") || (node.hasAttribute("fill") && node.getAttribute("fill") !== "none"))).toBe(false);
    expect(container.querySelector("img, image")).toBeNull();
    expect(screen.getByRole("heading", { name: "Title" })).toBeTruthy();
    expect(container.textContent).toContain("Body text");
  });

  it("unavailable shows the request id", () => {
    const { container } = renderShell(<EmptyState type="unavailable" title="Couldn't load this folder" body="The connection dropped." requestId="7f3a-19c2" />);
    expect(container.textContent).toContain("req 7f3a-19c2");
  });

  it("PlaceholderPage: the destination's title, 'Coming soon', and the optional note", () => {
    const { container } = renderShell(<PlaceholderPage name="Shared with me" note="Shared files appear here once sharing is switched on." />);
    expect(container.querySelector('[data-placeholder-page="Shared with me"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Shared with me" })).toBeTruthy();
    expect(container.textContent).toContain("Coming soon");
    expect(container.textContent).toContain("Shared files appear here once sharing is switched on.");
  });
});

describe("FileBadge", () => {
  it.each([
    ["Lease agreement.pdf", "pdf", "PDF"],
    ["notes.md", "document", "MD"],
    ["photo.jpeg", "image", "IMG"],
    ["archive.tar.gz", "archive", "GZ"],
    ["README", "other", ""],
    [".gitignore", "other", ""],
    ["clip.mp4", "video", "MP4"],
  ] as const)("%s → %s", (name, category, text) => {
    expect(badgeText(name, category)).toBe(text);
  });

  it("the file glyph is outlined, the folder glyph is the only filled one, and both are graphite", () => {
    const file = renderShell(<FileBadge name="a.pdf" mimeCategory="pdf" />).container.querySelector("svg")!;
    const folder = renderShell(<FolderGlyph />).container;
    expect(file.getAttribute("fill")).toBe("none");
    expect(folder.querySelector("svg")!.getAttribute("fill")).toBe("currentColor");
    expect(resolveVar(getComputedStyle(folder.firstElementChild!).color)).toBe(lightTokens.text);
  });
});

describe("StorageBar", () => {
  it("shows used of quota in user units, as text and as a named image", () => {
    const { container } = renderShell(<StorageBar usage={{ usedBytes: 1_503_238_553, quotaBytes: 5_368_709_120 }} />);
    expect(container.textContent).toContain("1.4 GB of 5 GB");
    expect(screen.getByRole("img", { name: "1.4 GB of 5 GB used" })).toBeTruthy();
    expect(parseFloat(getComputedStyle(container.querySelector("[data-storage-fill]")!).width)).toBeCloseTo(28, 3);
    expect(container.textContent).not.toContain("Almost full");
  });

  it("says 'Almost full' in the attention colour from 90 %, and never colours the bar", () => {
    const { container } = renderShell(<StorageBar usage={{ usedBytes: 95, quotaBytes: 100 }} />);
    const warning = screen.getByText("Almost full");
    expect(resolveVar(getComputedStyle(warning).color)).toBe(lightTokens.attention);
    expect(resolveVar(getComputedStyle(container.querySelector("[data-storage-fill]")!).backgroundColor)).toBe(lightTokens.textSecondary);
  });

  it("null usage is a skeleton", () => {
    renderShell(<StorageBar usage={null} />);
    expect(screen.getByLabelText("Loading storage use").getAttribute("aria-busy")).toBe("true");
  });
});

describe("SelectionBar", () => {
  it("renders nothing at zero, and a named toolbar with the live count otherwise", () => {
    const onClear = vi.fn();
    const view = renderShell(<SelectionBar count={0} onClear={onClear} />);
    expect(screen.queryByRole("toolbar")).toBeNull();
    view.rerender(<SelectionBar count={3} onClear={onClear} actions={<SelectionBarAction label="Trash" shortcut="trash" destructive onClick={() => {}} />} />);
    expect(screen.getByRole("toolbar", { name: "3 selected" })).toBeTruthy();
    expect(document.querySelector("[data-selection-live]")!.textContent).toBe("3 selected");
    expect(document.querySelector("[data-selection-live]")!.getAttribute("aria-live")).toBe("polite");
    expect(resolveVar(getComputedStyle(screen.getByRole("toolbar")).backgroundColor)).toBe(lightTokens.accentWash);
    const trash = screen.getByRole("button", { name: /Trash/ });
    expect(trash.querySelector("kbd")).not.toBeNull();
    expect(resolveVar(getComputedStyle(trash).color)).toBe(lightTokens.danger);
    fireEvent.click(screen.getByRole("button", { name: /Clear/ }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});

describe("ConfirmDialog", () => {
  function Host(props: { typeToConfirm?: string; onConfirm(): void; onCancel(): void }) {
    return <ConfirmDialog open title="Delete 3 items forever?" consequence="3 people lose access. This can't be undone." confirmLabel="Delete forever" destructive {...props} />;
  }

  it("states the blast radius and is labelled and described by it", async () => {
    renderShell(<Host onConfirm={() => {}} onCancel={() => {}} />);
    const dialog = await screen.findByRole("dialog", { name: "Delete 3 items forever?" });
    expect(document.getElementById(dialog.getAttribute("aria-describedby")!)!.textContent).toBe("3 people lose access. This can't be undone.");
  });

  it("focus starts on Cancel, so Enter never destroys by reflex; Escape cancels", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    renderShell(<Host onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" })));
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("type-to-confirm keeps the destructive button disabled until the text matches", async () => {
    const onConfirm = vi.fn();
    renderShell(<Host typeToConfirm="delete 101 items" onConfirm={onConfirm} onCancel={() => {}} />);
    const confirm = (await screen.findByRole("button", { name: "Delete forever" })) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "delete 100 items" } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "delete 101 items" } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("toasts", () => {
  it("an undo toast lasts 5–8 s, runs Undo, and dismisses", () => {
    expect(clampUndoDuration(undefined)).toBe(6000);
    expect(clampUndoDuration(100)).toBe(5000);
    expect(clampUndoDuration(60_000)).toBe(8000);
    vi.useFakeTimers();
    const onUndo = vi.fn();
    renderShell(<Toaster />);
    act(() => void undoToast({ message: "3 items moved to trash", onUndo, duration: 100 }));
    expect(screen.getByText("3 items moved to trash")).toBeTruthy();
    act(() => vi.advanceTimersByTime(4900));
    expect(getToasts().length).toBe(1);
    act(() => vi.advanceTimersByTime(200));
    expect(getToasts().length).toBe(0);

    act(() => void undoToast({ message: "1 item moved to trash", onUndo }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(getToasts().length).toBe(0);
  });

  it("the toaster is one polite live region; an error toast shows the request id; a keyed toast replaces itself", () => {
    const { container } = renderShell(<Toaster />);
    const region = container.querySelector("[data-toaster]")!;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    act(() => void toast({ message: "Couldn't rename the file.", requestId: "7f3a-19c2" }));
    expect(region.textContent).toContain("Couldn't rename the file. req 7f3a-19c2");
    act(() => void toast({ message: "one", key: "k" }));
    act(() => void toast({ message: "two", key: "k" }));
    expect(getToasts().map((entry) => entry.message)).toEqual(["Couldn't rename the file.", "two"]);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(getToasts().map((entry) => entry.message)).toEqual(["two"]);
  });
});

describe("BottomSheet", () => {
  it("is a modal dialog named by its title; focus moves in and Close / Escape dismiss it", async () => {
    function Host() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>open sheet</button>
          <BottomSheet open={open} onClose={() => setOpen(false)} title="Lease agreement.pdf" subtitle="PDF · 2.4 MB">
            <button>Download</button>
          </BottomSheet>
        </>
      );
    }
    renderShell(<Host />);
    const opener = screen.getByText("open sheet");
    opener.focus();
    fireEvent.click(opener);
    const sheet = await screen.findByRole("dialog", { name: "Lease agreement.pdf" });
    expect(sheet.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(sheet.parentElement!.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).not.toBe(opener);
    fireEvent.keyDown(sheet, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
    fireEvent.click(opener);
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("FrameBanner and ErrorBoundary", () => {
  it("a banner is a status region that never uses the activity colour", () => {
    const { container } = renderShell(<FrameBanner name="x" tone="danger" action={<button>Act</button>}>Something</FrameBanner>);
    const banner = container.querySelector('[data-banner="x"]')!;
    expect(banner.getAttribute("role")).toBe("status");
    const style = getComputedStyle(banner);
    expect(`${style.backgroundColor} ${style.boxShadow} ${style.color}`).not.toMatch(/--hf-accent/);
    expect(resolveVar(style.backgroundColor)).toBe(lightTokens.surface2);
  });

  it("the boundary catches a render error, reports it, and shows the unavailable state", () => {
    const onError = vi.fn();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    function Boom(): never {
      throw new Error("kaboom");
    }
    const { container } = renderShell(
      <ErrorBoundary onError={onError}>
        <Boom />
      </ErrorBoundary>,
    );
    expect(container.querySelector('[data-empty-state="unavailable"]')).not.toBeNull();
    expect(screen.getByRole("heading", { name: "Something broke on this page" })).toBeTruthy();
    expect(onError).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
