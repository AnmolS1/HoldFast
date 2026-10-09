// Command registry of the ⌘K palette. Features register their commands under a source id; the
// shell registers navigation and its own actions. The "New" menu and the FAB run the same
// commands by id, so there is one implementation of each action.
import { useSyncExternalStore, type ReactNode } from "react";
import type { ShortcutId } from "../../lib/shortcuts";

export type CommandSection = "selection" | "goto" | "actions";

export interface Command {
  /** Stable id, namespaced by feature: "explorer.new-folder". */
  id: string;
  label: string;
  section: CommandSection;
  run(): void;
  /** Shows the key in the palette and in menus. */
  shortcut?: ShortcutId;
  icon?: ReactNode;
  /** Extra words the filter matches. */
  keywords?: string[];
  /** Muted text at the row's end ("folder", a path). */
  hint?: string;
  disabled?: boolean;
}

/** Ids the shell's own controls (New menu, FAB, shortcuts) look up. */
export const COMMAND_IDS = {
  newFolder: "explorer.new-folder",
  upload: "upload.request",
  rename: "explorer.rename",
  trash: "explorer.trash",
} as const;

const sources = new Map<string, Command[]>();
const listeners = new Set<() => void>();
let all: Command[] = [];
let open = false;

function emit(): void {
  all = Array.from(sources.values()).flat();
  for (const listener of listeners) listener();
}

/**
 * Register (replace) the commands of one source. Returns the function that removes them — call it
 * from an effect cleanup. Selection-aware commands are re-registered as the selection changes.
 */
export function registerCommands(sourceId: string, commands: Command[]): () => void {
  sources.set(sourceId, commands);
  emit();
  return () => {
    if (sources.get(sourceId) === commands) {
      sources.delete(sourceId);
      emit();
    }
  };
}

export function getCommands(): Command[] {
  return all;
}

export function findCommand(id: string): Command | undefined {
  return all.find((command) => command.id === id);
}

/** Run a command by id. False when it is not registered or disabled. */
export function runCommand(id: string): boolean {
  const command = findCommand(id);
  if (!command || command.disabled) return false;
  command.run();
  return true;
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useCommands(): Command[] {
  return useSyncExternalStore(subscribe, getCommands, getCommands);
}

export function useCommand(id: string): Command | undefined {
  return useCommands().find((command) => command.id === id);
}

export function openPalette(): void {
  if (!open) {
    open = true;
    emit();
  }
}

export function closePalette(): void {
  if (open) {
    open = false;
    emit();
  }
}

export function togglePalette(): void {
  open = !open;
  emit();
}

const getOpen = () => open;

export function usePaletteOpen(): boolean {
  return useSyncExternalStore(subscribe, getOpen, getOpen);
}

/** Tests only. */
export function resetCommandsForTests(): void {
  sources.clear();
  open = false;
  emit();
}
