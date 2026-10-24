// The keyboard map: one table, used by the global handler, by every menu item (which shows its
// shortcut) and by the `?` overlay.
import { useEffect, useRef } from "react";
import type { MessageKey } from "./i18n";
import { getShortcutsOn } from "./prefs";

export type ShortcutId =
  | "search"
  | "palette"
  | "next"
  | "previous"
  | "open"
  | "quickLook"
  | "selectAll"
  | "trash"
  | "escape"
  | "help"
  | "newFolder"
  | "rename"
  | "restore"
  | "upload"
  | "uploadFolder"
  | "theme"
  | "sidebar"
  | "details";

interface Combo {
  /** `KeyboardEvent.key`, compared case-insensitively for letters. */
  key: string;
  /** ⌘ on Apple platforms, Ctrl elsewhere. */
  mod?: boolean;
  shift?: boolean;
}

export interface ShortcutDef {
  id: ShortcutId;
  combos: Combo[];
  description: MessageKey;
  /** Fires even while the caret is in a text field. */
  global?: boolean;
  /** Handled by the focused list (roving tabindex), not by the document listener. */
  listOnly?: boolean;
}

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "search", combos: [{ key: "/" }], description: "shortcuts.search" },
  { id: "palette", combos: [{ key: "k", mod: true }], description: "shortcuts.palette", global: true },
  { id: "next", combos: [{ key: "ArrowDown" }, { key: "j" }], description: "shortcuts.move", listOnly: true },
  {
    id: "previous",
    combos: [{ key: "ArrowUp" }, { key: "k" }],
    description: "shortcuts.move",
    listOnly: true,
  },
  { id: "open", combos: [{ key: "Enter" }], description: "shortcuts.open", listOnly: true },
  { id: "quickLook", combos: [{ key: " " }], description: "shortcuts.quickLook", listOnly: true },
  { id: "selectAll", combos: [{ key: "a", mod: true }], description: "shortcuts.selectAll", listOnly: true },
  { id: "trash", combos: [{ key: "Delete" }, { key: "Backspace" }], description: "shortcuts.trash" },
  { id: "escape", combos: [{ key: "Escape" }], description: "shortcuts.escape", global: true },
  { id: "help", combos: [{ key: "?", shift: true }], description: "shortcuts.help" },
  { id: "newFolder", combos: [{ key: "N", shift: true }], description: "shortcuts.newFolder" },
  { id: "rename", combos: [{ key: "F2" }], description: "shortcuts.rename" },
  { id: "restore", combos: [{ key: "r", shift: true }], description: "shortcuts.restore" },
  { id: "upload", combos: [{ key: "u", mod: true }], description: "shortcuts.upload", global: true },
  {
    id: "uploadFolder",
    combos: [{ key: "u", mod: true, shift: true }],
    description: "shortcuts.uploadFolder",
    global: true,
  },
  {
    id: "theme",
    combos: [{ key: "l", mod: true, shift: true }],
    description: "shortcuts.theme",
    global: true,
  },
  // F02: the desktop side panels. `i` is a character shortcut (the Preferences switch turns it off).
  { id: "sidebar", combos: [{ key: "\\", mod: true }], description: "shortcuts.sidebar" },
  { id: "details", combos: [{ key: "i" }], description: "shortcuts.details" },
];

export function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
  return /mac|iphone|ipad|ipod/i.test(data?.platform ?? navigator.platform ?? "");
}

const KEY_LABEL: Record<string, string> = {
  ArrowDown: "↓",
  ArrowUp: "↑",
  Enter: "↵",
  " ": "Space",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
};

function comboLabel(combo: Combo, apple: boolean): string {
  const key = KEY_LABEL[combo.key] ?? (combo.key.length === 1 ? combo.key.toUpperCase() : combo.key);
  // "?" already implies Shift.
  const shift = combo.shift && combo.key !== "?";
  if (apple) return `${combo.mod ? "⌘" : ""}${shift ? "⇧" : ""}${key}`;
  return [combo.mod ? "Ctrl" : "", shift ? "Shift" : "", key].filter(Boolean).join("+");
}

/** What a menu item or the palette shows: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcutLabel(id: ShortcutId, apple: boolean = isApplePlatform()): string {
  const def = SHORTCUTS.find((s) => s.id === id);
  const first = def?.combos[0];
  return first ? comboLabel(first, apple) : "";
}

/** Every combination of a shortcut, for the `?` overlay ("↓ / J"). */
export function shortcutLabels(id: ShortcutId, apple: boolean = isApplePlatform()): string[] {
  return SHORTCUTS.find((s) => s.id === id)?.combos.map((c) => comboLabel(c, apple)) ?? [];
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["checkbox", "radio", "button", "submit", "reset", "range", "file"].includes(type);
}

/**
 * Whether a modal dialog is in the way: the key was pressed inside a dialog, or one is open
 * anywhere in the document (focus can sit on the body while a dialog is up).
 */
export function modalOpen(target: EventTarget | null): boolean {
  if (target instanceof Element && target.closest('[role="dialog"], [role="alertdialog"]')) return true;
  return document.querySelector('[role="dialog"][aria-modal="true"], [role="alertdialog"]') !== null;
}

type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">;

function matches(combo: Combo, event: KeyLike, apple: boolean): boolean {
  const mod = apple ? event.metaKey : event.ctrlKey;
  const otherMod = apple ? event.ctrlKey : event.metaKey;
  if (Boolean(combo.mod) !== mod || otherMod || event.altKey) return false;
  const letter = combo.key.length === 1 && /[a-z]/i.test(combo.key);
  if (letter) {
    if (event.key.toLowerCase() !== combo.key.toLowerCase()) return false;
    return Boolean(combo.shift) === event.shiftKey;
  }
  if (event.key !== combo.key) return false;
  // Symbols such as "?" and "/" carry their own shift state in `key`.
  return combo.key.length === 1 ? true : Boolean(combo.shift) === event.shiftKey;
}

/**
 * A shortcut typed with a character key and no ⌘/Ctrl (`/`, `?`, Shift+N, Shift+R, `i`): the kind a
 * speech-input user can set off by saying a word. They can be turned off in Preferences (WCAG
 * 2.1.4, R1 a11y-6); list-only keys act only on the focused list, so they stay.
 */
export function isCharacterShortcut(def: ShortcutDef): boolean {
  return (
    !def.listOnly && def.combos.some((combo) => !combo.mod && combo.key.length === 1 && combo.key !== " ")
  );
}

/** The shortcut an event stands for, or null. Pure. */
export function matchShortcut(event: KeyLike, apple: boolean = isApplePlatform()): ShortcutId | null {
  for (const def of SHORTCUTS) {
    if (def.combos.some((combo) => matches(combo, event, apple))) return def.id;
  }
  return null;
}

/**
 * Run `handler` when the shortcut is pressed anywhere in the document. Shortcuts typed into a
 * text field are ignored unless the shortcut is `global`; list-only shortcuts are not bound here.
 */
export function useShortcut(id: ShortcutId, handler: (event: KeyboardEvent) => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  useEffect(() => {
    if (!enabled) return;
    const def = SHORTCUTS.find((s) => s.id === id);
    if (!def) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (!def.combos.some((combo) => matches(combo, event, isApplePlatform()))) return;
      if (isCharacterShortcut(def) && !getShortcutsOn()) return;
      if (!def.global && isEditableTarget(event.target)) return;
      // A page's shortcut never acts through a modal dialog: with a Move / Rename / confirm
      // dialog open, Backspace or F2 would otherwise act on the selection underneath it.
      if (!def.global && modalOpen(event.target)) return;
      latest.current(event);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [id, enabled]);
}
