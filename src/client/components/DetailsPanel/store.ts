// The details slot's store. A feature supplies the content with `useDetailsPanel().setContent(node)`.
import { useMemo, useSyncExternalStore, type ReactNode } from "react";

interface DetailsState {
  content: ReactNode | null;
  /** Mobile only: whether the sheet is showing. */
  open: boolean;
  title: string | null;
}

let state: DetailsState = { content: null, open: false, title: null };
const listeners = new Set<() => void>();

function set(patch: Partial<DetailsState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener();
}

export const subscribeDetails = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
export const getDetails = () => state;

export interface DetailsPanelApi {
  /** Set the panel content; `null` returns the panel to its empty state and closes the sheet. */
  setContent(node: ReactNode | null, options?: { title?: string }): void;
  /** Mobile: show the sheet (desktop shows the panel all the time). */
  open(): void;
  close(): void;
  isOpen: boolean;
  hasContent: boolean;
}

export const detailsApi = {
  setContent(node: ReactNode | null, options?: { title?: string }) {
    set(node === null ? { content: null, open: false, title: null } : { content: node, title: options?.title ?? state.title });
  },
  open() {
    if (state.content !== null) set({ open: true });
  },
  close() {
    set({ open: false });
  },
};

export function useDetailsPanel(): DetailsPanelApi {
  const current = useSyncExternalStore(subscribeDetails, getDetails, getDetails);
  return useMemo(() => ({ ...detailsApi, isOpen: current.open, hasContent: current.content !== null }), [current.open, current.content]);
}

/** Tests only. */
export function resetDetailsPanelForTests(): void {
  set({ content: null, open: false, title: null });
}
