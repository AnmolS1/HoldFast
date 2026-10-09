// Toast queue as a tiny external store, so non-React code (the API client) can raise a toast.
import type { ReactNode } from "react";

export interface ToastInput {
  message: string;
  /** Shown in mono after the message — the request id of a failed call. */
  requestId?: string;
  /** One action, e.g. Undo. */
  action?: { label: string; onClick: () => void };
  /** ms; default 6000. Undo toasts use 5000–8000. */
  duration?: number;
  /** Replaces a visible toast with the same key instead of stacking. */
  key?: string;
  icon?: ReactNode;
}

export interface ToastEntry extends ToastInput {
  id: number;
}

let entries: ToastEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function toast(input: ToastInput | string): number {
  const entry: ToastEntry = { ...(typeof input === "string" ? { message: input } : input), id: nextId++ };
  entries = [...entries.filter((e) => !entry.key || e.key !== entry.key), entry];
  emit();
  return entry.id;
}

export function dismissToast(id: number): void {
  const next = entries.filter((e) => e.id !== id);
  if (next.length !== entries.length) {
    entries = next;
    emit();
  }
}

export function clearToasts(): void {
  entries = [];
  emit();
}

export function getToasts(): ToastEntry[] {
  return entries;
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
