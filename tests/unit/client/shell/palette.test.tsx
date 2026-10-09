import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  COMMAND_IDS,
  CommandPalette,
  openPalette,
  paletteFilter,
  registerCommands,
  runCommand,
  usePaletteOpen,
  type Command,
} from "../../../../src/client/components/CommandPalette";
import { buildRoutes } from "../../../../src/client/router";
import { renderRoutes, renderShell, sessionOf, setupShell, shellFetch } from "./helpers";

setupShell();

const items = () =>
  Array.from(document.querySelectorAll<HTMLElement>("[cmdk-item]")).map((node) =>
    node.getAttribute("data-command-id"),
  );
const headings = () =>
  Array.from(document.querySelectorAll("[cmdk-group-heading]")).map((node) => node.textContent);

function command(
  id: string,
  label: string,
  section: Command["section"],
  extra: Partial<Command> = {},
): Command {
  return { id, label, section, run: vi.fn(), ...extra };
}

describe("command registry", () => {
  it("registers per source, replaces on re-register, and removes on cleanup", () => {
    const off = registerCommands("explorer", [command("a", "A", "actions")]);
    registerCommands("explorer", [command("b", "B", "actions")]);
    expect(runCommand("a")).toBe(false);
    expect(runCommand("b")).toBe(true);
    off(); // stale cleanup of the first registration must not remove the second
    expect(runCommand("b")).toBe(true);
  });

  it("runCommand refuses a disabled or unknown command", () => {
    const run = vi.fn();
    registerCommands("x", [command(COMMAND_IDS.newFolder, "New folder", "actions", { run, disabled: true })]);
    expect(runCommand(COMMAND_IDS.newFolder)).toBe(false);
    expect(runCommand("nope")).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("paletteFilter", () => {
  it.each([
    ["Trash 3 items", "trash", 1],
    ["Move to trash", "trash", 0.5],
    ["Trash 3 items", "theme", 0],
    ["Switch to dark mode theme dark light", "starred", 0],
    ["Switch to dark mode theme", "dark switch", 0.5],
    ["New folder", "", 1],
    ["New folder", "NEW", 1],
  ])("%j / %j → %s", (value, search, score) => {
    expect(paletteFilter(value, search)).toBe(score);
  });
});

describe("CommandPalette", () => {
  function setup() {
    const commands = [
      command("sel.move", "Move 3 items to…", "selection"),
      command("sel.trash", "Trash 3 items", "selection", { shortcut: "trash" }),
      command("go.trash", "Trash", "goto"),
      command("go.recent", "Recent", "goto"),
      command("act.folder", "New folder", "actions", { shortcut: "newFolder" }),
      command("act.theme", "Switch to dark mode", "actions", { keywords: ["theme"] }),
    ];
    registerCommands("test", commands);
    renderShell(<CommandPalette />);
    act(() => openPalette());
    return commands;
  }

  it("lists selection-aware commands first, then Go to, then Actions; the footer teaches the keys", async () => {
    setup();
    await screen.findByRole("dialog", { name: "Command palette" });
    expect(headings()).toEqual(["Selection", "Go to", "Actions"]);
    expect(items()).toEqual(["sel.move", "sel.trash", "go.trash", "go.recent", "act.folder", "act.theme"]);
    const dialog = screen.getByRole("dialog");
    for (const word of ["move", "run", "toggle", "Keyboard shortcuts"])
      expect(dialog.textContent).toContain(word);
    // Every command with a shortcut shows it.
    expect(document.querySelector('[data-command-id="act.folder"] kbd')?.textContent).toMatch(/N/);
  });

  it("filters as you type", async () => {
    setup();
    const input = await screen.findByPlaceholderText("Type a command or search");
    fireEvent.change(input, { target: { value: "trash" } });
    await waitFor(() => expect(items().sort()).toEqual(["go.trash", "sel.trash"]));
    fireEvent.change(input, { target: { value: "theme" } });
    await waitFor(() => expect(items()).toEqual(["act.theme"]));
    fireEvent.change(input, { target: { value: "zzzz" } });
    await waitFor(() => expect(items()).toEqual([]));
    expect(screen.getByText("No commands match")).toBeTruthy();
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(items().length).toBe(6));
  });

  it("Enter runs the highlighted command and closes the palette", async () => {
    const commands = setup();
    const input = await screen.findByPlaceholderText("Type a command or search");
    fireEvent.change(input, { target: { value: "recent" } });
    await waitFor(() => expect(items()).toEqual(["go.recent"]));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(commands[3]!.run).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("Escape closes it and returns focus (it is a modal dialog)", async () => {
    function Probe() {
      return <output data-testid="open">{String(usePaletteOpen())}</output>;
    }
    registerCommands("test", [command("a", "A", "actions")]);
    renderShell(
      <>
        <Probe />
        <CommandPalette />
      </>,
    );
    act(() => openPalette());
    const dialog = await screen.findByRole("dialog", { name: "Command palette" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("open").textContent).toBe("false"));
  });
});

describe("the shell's own commands", () => {
  it("every sidebar destination is in Go to, and ⌘K / Ctrl+K opens the palette", async () => {
    shellFetch({ session: sessionOf() });
    const { router } = renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    for (const id of ["go.files", "go.shared", "go.shared-by-me", "go.recent", "go.starred", "go.trash"])
      expect(items()).toContain(id);
    expect(items()).toEqual(expect.arrayContaining(["upload.request", "shell.theme", "shell.shortcuts"]));
    expect(items()).not.toContain("go.admin");
    const input = screen.getByPlaceholderText("Type a command or search");
    fireEvent.change(input, { target: { value: "starred" } });
    await waitFor(() => expect(items()).toEqual(["go.starred"]));
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe("/starred"));
  });

  it("? opens the shortcuts overlay, which lists every shortcut", async () => {
    shellFetch({ session: sessionOf() });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    for (const text of [
      "Search",
      "Command palette",
      "Quick look",
      "Select all",
      "Move to trash",
      "New folder",
      "Rename",
    ])
      expect(dialog.textContent).toContain(text);
  });

  it("a shortcut typed into a text field is ignored (except the global ones)", async () => {
    shellFetch({ session: sessionOf() });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    const search = screen.getByRole("searchbox", { name: "Search files" });
    search.focus();
    fireEvent.keyDown(search, { key: "?", shiftKey: true });
    expect(screen.queryByRole("dialog", { name: "Keyboard shortcuts" })).toBeNull();
    fireEvent.keyDown(search, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Command palette" })).toBeTruthy();
  });

  it("/ focuses search", async () => {
    shellFetch({ session: sessionOf() });
    renderRoutes(buildRoutes(), ["/"]);
    await waitFor(() => expect(document.querySelector("[data-frame]")).not.toBeNull());
    fireEvent.keyDown(document.body, { key: "/" });
    expect(document.activeElement).toBe(screen.getByRole("searchbox", { name: "Search files" }));
  });
});
