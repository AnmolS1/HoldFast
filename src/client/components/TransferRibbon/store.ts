// The transfer ribbon's store. A feature with a long-running transfer publishes under its own
// `sourceId` ("upload", "zip:<id>", "export"); the ribbon shows the most recently updated active
// source and collapses when every source is gone or done.
import { useSyncExternalStore, type ReactNode } from "react";
import { registerUserStatePurger } from "../../lib/contracts";

export type RibbonStatus = "active" | "paused" | "error" | "done";

export interface RibbonState {
  /** 0..1. */
  progress: number;
  /** One sentence in user units: "Uploading 3 of 7 · 1.2 GB left · ~40 s". */
  sentence: string;
  status: RibbonStatus;
}

export interface RibbonSource extends RibbonState {
  sourceId: string;
}

export interface RibbonSnapshot {
  /** The source that owns the line, or null when idle. */
  current: RibbonSource | null;
  /** Expanded-panel content of every source that has some, in publish order. */
  panels: ReadonlyArray<{ sourceId: string; node: ReactNode }>;
  /** Sources that are neither absent nor done. */
  openCount: number;
}

interface Entry {
  state: RibbonState;
  updated: number;
}

const sources = new Map<string, Entry>();
const panels = new Map<string, ReactNode>();
const listeners = new Set<() => void>();
let clock = 0;
let snapshot: RibbonSnapshot = { current: null, panels: [], openCount: 0 };

function compute(): RibbonSnapshot {
  let current: RibbonSource | null = null;
  let currentRank = -1;
  let currentUpdated = -1;
  let openCount = 0;
  for (const [sourceId, entry] of sources) {
    if (entry.state.status === "done") continue;
    openCount += 1;
    // Active beats paused and error; within a rank the latest update wins.
    const rank = entry.state.status === "active" ? 1 : 0;
    if (rank > currentRank || (rank === currentRank && entry.updated > currentUpdated)) {
      current = { sourceId, ...entry.state };
      currentRank = rank;
      currentUpdated = entry.updated;
    }
  }
  return {
    current,
    openCount,
    panels: Array.from(panels, ([sourceId, node]) => ({ sourceId, node })),
  };
}

function emit(): void {
  snapshot = compute();
  for (const listener of listeners) listener();
}

/**
 * Publish a source's state, or `null` to remove it. Progress is clamped to 0..1 and, while the
 * source stays open, never moves backward.
 */
export function publish(sourceId: string, state: RibbonState | null): void {
  if (state === null) {
    if (!sources.delete(sourceId)) return;
    emit();
    return;
  }
  const previous = sources.get(sourceId);
  const bounded = Number.isFinite(state.progress) ? Math.min(1, Math.max(0, state.progress)) : 0;
  const floor = previous && previous.state.status !== "done" ? previous.state.progress : 0;
  sources.set(sourceId, { state: { ...state, progress: Math.max(floor, bounded) }, updated: ++clock });
  emit();
}

/** Set (or with `null` remove) the content a source shows in the expanded panel. */
export function setPanel(sourceId: string, node: ReactNode | null): void {
  if (node === null) {
    if (!panels.delete(sourceId)) return;
  } else {
    panels.set(sourceId, node);
  }
  emit();
}

export function getRibbonSnapshot(): RibbonSnapshot {
  return snapshot;
}

export function subscribeRibbon(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTransferRibbon(): RibbonSnapshot {
  return useSyncExternalStore(subscribeRibbon, getRibbonSnapshot, getRibbonSnapshot);
}

/** Back to empty: run by `purgeUserState()` and by tests. */
export function resetRibbonForTests(): void {
  sources.clear();
  panels.clear();
  clock = 0;
  emit();
}

// Transfers belong to the account that started them.
registerUserStatePurger(resetRibbonForTests);
