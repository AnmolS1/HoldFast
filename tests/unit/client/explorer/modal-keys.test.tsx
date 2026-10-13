// B1 — the frame's keys (Delete, Backspace, F2, Shift+N) run the explorer's commands by id. With
// a dialog, a menu or a sheet of the explorer's own open, none of them may act on the selection
// behind it. The whole app is rendered: the real document key handler, the real route tree.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COMMAND_IDS, findCommand, runCommand } from "../../../../src/client/components/CommandPalette";
import { setViewport } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode } from "./fixtures/nodes";
import { openMenu, pick, renderApp, rowOf, selectedIds, setupExplorer, waitForRows } from "./helpers";

setupExplorer();

const ALPHA = folderNode(1, { name: "Alpha" });
const NOTES = fileNode(3, { name: "notes.pdf" });
const PHOTO = fileNode(4, { name: "photo.png", mimeCategory: "image" });

interface Surface {
  name: string;
  mobile?: true;
  /** Open it; returns the element that names it (asserted to be the same afterwards). */
  open(): Promise<HTMLElement>;
  /** Ids selected behind it. */
  selected: string[];
}

const viaMenu = async (action: string) => {
  const { menu } = await openMenu(NOTES.id);
  pick(menu, action);
  return screen.findByRole("dialog");
};

const SURFACES: Surface[] = [
  {
    name: "the New folder dialog (two rows selected behind it)",
    selected: [NOTES.id, PHOTO.id],
    open: async () => {
      fireEvent.click(rowOf(NOTES.id)!);
      fireEvent.click(rowOf(PHOTO.id)!, { ctrlKey: true });
      await act(async () => {});
      act(() => void runCommand(COMMAND_IDS.newFolder));
      return screen.findByRole("dialog");
    },
  },
  { name: "the Rename dialog", selected: [NOTES.id], open: () => viaMenu("rename") },
  { name: "the Move dialog", selected: [NOTES.id], open: () => viaMenu("move") },
  {
    name: "a row's menu",
    selected: [NOTES.id],
    open: async () => (await openMenu(NOTES.id)).menu,
  },
  {
    name: "the selection bar's More menu",
    selected: [NOTES.id],
    open: async () => {
      fireEvent.click(rowOf(NOTES.id)!);
      fireEvent.click(within(await screen.findByRole("toolbar")).getByRole("button", { name: "More" }));
      return screen.findByRole("menu");
    },
  },
  {
    name: "the action sheet (mobile)",
    mobile: true,
    selected: [NOTES.id],
    open: async () => {
      fireEvent.click(rowOf(NOTES.id)!.querySelector("[data-row-menu]")!);
      return screen.findByRole("dialog");
    },
  },
  {
    name: "the details sheet (mobile)",
    mobile: true,
    selected: [NOTES.id],
    open: async () => {
      fireEvent.click(rowOf(NOTES.id)!.querySelector("[data-row-menu]")!);
      const sheet = await screen.findByRole("dialog");
      fireEvent.click(sheet.querySelector('[data-action="details"]')!);
      return screen.findByRole("dialog", { name: "notes.pdf" });
    },
  },
];

const KEYS: Array<[label: string, init: KeyboardEventInit]> = [
  ["Delete", { key: "Delete" }],
  ["Backspace", { key: "Backspace" }],
  ["F2", { key: "F2" }],
  ["Shift+N", { key: "N", shiftKey: true }],
];

describe.each(SURFACES)("with $name open", (surface) => {
  it.each(KEYS)("%s changes nothing behind it", async (_label, init) => {
    if (surface.mobile) setViewport(390, { coarse: true });
    const drive = new FakeDrive([ALPHA, NOTES, PHOTO]);
    renderApp(drive);
    await waitForRows(3);
    const opened = await surface.open();
    const title = opened.getAttribute("aria-labelledby") ?? opened.getAttribute("aria-label");
    const before = drive.calls.length;

    // From a control of the surface that is not a text field, and from the surface itself.
    const control =
      opened.querySelector<HTMLElement>('button, [role="menuitem"], [role="treeitem"]') ?? opened;
    fireEvent.keyDown(control, init);
    fireEvent.keyDown(opened, init);
    fireEvent.keyDown(document.body, init);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Nothing was sent, nothing left the folder, and the surface is still the one that was open.
    expect(drive.calls.slice(before).filter((call) => call.method !== "GET")).toEqual([]);
    expect(drive.trashed.size).toBe(0);
    expect(drive.nodes.get(NOTES.id)!.name).toBe("notes.pdf");
    expect(opened.isConnected).toBe(true);
    expect(opened.getAttribute("aria-labelledby") ?? opened.getAttribute("aria-label")).toBe(title);
    expect(screen.queryAllByRole("dialog").length + screen.queryAllByRole("menu").length).toBe(1);
    expect(selectedIds()).toEqual(surface.selected);
  });

  it("the explorer's commands are withdrawn, so the palette cannot run them either", async () => {
    if (surface.mobile) setViewport(390, { coarse: true });
    renderApp(new FakeDrive([ALPHA, NOTES, PHOTO]));
    await waitForRows(3);
    expect(findCommand(COMMAND_IDS.trash)).toBeDefined();
    await surface.open();
    await waitFor(() => expect(findCommand(COMMAND_IDS.trash)).toBeUndefined());
    expect(findCommand(COMMAND_IDS.rename)).toBeUndefined();
    expect(findCommand(COMMAND_IDS.newFolder)).toBeUndefined();
    expect(runCommand(COMMAND_IDS.trash)).toBe(false);
  });
});

describe("the keys still work where they should", () => {
  it("Backspace in the Rename text field edits the name; after the dialog closes Delete trashes again", async () => {
    const drive = new FakeDrive([ALPHA, NOTES, PHOTO]);
    renderApp(drive);
    await waitForRows(3);
    const dialog = await viaMenu("rename");
    const field = within(dialog).getByRole("textbox");
    fireEvent.keyDown(field, { key: "Backspace" });
    expect(drive.trashed.size).toBe(0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(findCommand(COMMAND_IDS.trash)).toBeDefined());
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(drive.trashed.has(NOTES.id)).toBe(true));
  });
});
