import { useSyncExternalStore } from "react";

let open = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const get = () => open;

function set(next: boolean): void {
  if (open === next) return;
  open = next;
  for (const listener of listeners) listener();
}

export const openShortcuts = () => set(true);
export const closeShortcuts = () => set(false);
export const useShortcutsOpen = () => useSyncExternalStore(subscribe, get, get);
