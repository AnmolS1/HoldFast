// Watching files that are still being scanned. A pending file is asked for every 5 s for two
// minutes, then every 30 s and the row says "Still scanning". The answer is a `NodeDetailDto`:
// the status is `.node.scanStatus`.
//
// ONE loop for the whole listing, and it is bounded every way round:
//  - at most POLL_PER_TICK requests a tick, one after another (the files take turns, the one
//    asked longest ago first) — 48 requests a minute at most, however many files are pending;
//  - `404` ends the watch of that file (it is gone), `403` too (it is no longer ours to read);
//  - `429` makes the whole loop wait `Retry-After`; `5xx` and a dead network back it off,
//    doubling up to a minute — never the same rate against a server that is refusing;
//  - nothing is asked while the tab is hidden or the page is not the one in front;
//  - each file is watched for POLL_MAX_MS of time the loop could ASK — from the moment it became
//    pending in this listing, not counting any time the loop was paused (tab hidden, page covered)
//    — and then no longer asked for; its row says "Still scanning" from then on (opening the folder
//    again starts a new watch). A file that becomes pending later — a new upload, a Re-check — gets
//    its own full span: the bound is per file, never per visit;
//  - an answer that arrives after the account changed is dropped.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeDto } from "../../../shared/schemas/node";
import { ApiError } from "../../lib/api";
import { accountEpoch, sameAccount } from "../../lib/query";
import { getNode } from "./api";

export const POLL_FAST_MS = 5_000;
export const POLL_FAST_FOR_MS = 120_000;
export const POLL_SLOW_MS = 30_000;
/** Files asked for in one tick. */
export const POLL_PER_TICK = 4;
/** How long one file is watched, from the moment it became pending in the listing. */
export const POLL_MAX_MS = 30 * 60_000;
/** The longest back-off after repeated `5xx` / network failures. */
export const POLL_BACKOFF_MAX_MS = 60_000;
/** The longest a `Retry-After` is honoured for; the wait when a `429` names none. */
export const POLL_RETRY_AFTER_MAX_MS = 5 * 60_000;
export const POLL_RETRY_AFTER_DEFAULT_MS = 30_000;

/** The wait before a file is asked for again, given how long it has been watched. */
export function pollDelay(elapsedMs: number): number {
  return elapsedMs < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

/** How long the loop stays quiet after a failed request. `failures` counts them in a row. */
export function penaltyAfter(cause: unknown, failures: number): number {
  if (cause instanceof ApiError && cause.status === 429) {
    const asked = cause.retryAfter === undefined ? POLL_RETRY_AFTER_DEFAULT_MS : cause.retryAfter * 1000;
    return Math.min(POLL_RETRY_AFTER_MAX_MS, Math.max(POLL_FAST_MS, asked));
  }
  return Math.min(POLL_BACKOFF_MAX_MS, POLL_FAST_MS * 2 ** Math.max(0, failures - 1));
}

export interface ScanPollHandlers {
  /** The scan ended: the node as it is now. */
  onSettled(node: NodeDto): void;
  /** The node is no longer there (`404`). */
  onGone(id: string): void;
}

interface LoopState {
  /**
   * When each pending file was first seen, moved forward by every pause since: `now - since` is
   * the time the loop could ask about it. Kept while it is listed, even once its watch is over.
   */
  since: Map<string, number>;
  /** When each was last asked for. */
  asked: Map<string, number>;
  /** Files the server refused to show (`403`): not asked again. */
  refused: Set<string>;
  lastTick: number;
  /** Since when the loop has been paused (hidden, or not the page in front); null while it runs. */
  pausedSince: number | null;
  /** Failures in a row, and the time before which nothing is asked. */
  failures: number;
  notBefore: number;
}

const subscribeVisibility = (set: (visible: boolean) => void) => {
  const listener = () => set(!document.hidden);
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
};

/**
 * Polls the given pending ids while `active`; returns the ones that have been pending for over
 * two minutes.
 */
export function useScanPolling(
  pendingIds: readonly string[],
  handlers: ScanPollHandlers,
  active = true,
): ReadonlySet<string> {
  const loop = useRef<LoopState>({
    since: new Map(),
    asked: new Map(),
    refused: new Set(),
    lastTick: 0,
    pausedSince: null,
    failures: 0,
    notBefore: 0,
  });
  const latest = useRef(handlers);
  const [slow, setSlow] = useState<ReadonlySet<string>>(new Set());
  const [visible, setVisible] = useState(() => !document.hidden);
  useEffect(() => {
    latest.current = handlers;
  });
  useEffect(() => subscribeVisibility(setVisible), []);

  const key = pendingIds.join(",");
  useEffect(() => {
    const state = loop.current;
    const ids = key === "" ? [] : key.split(",");
    const listed = new Set(ids);
    const now = Date.now();
    const paused = !active || !visible;
    if (paused) state.pausedSince ??= now;
    // A file first seen during a pause starts its watch when the pause ends.
    for (const id of ids) if (!state.since.has(id)) state.since.set(id, state.pausedSince ?? now);
    for (const id of Array.from(state.since.keys())) {
      if (listed.has(id)) continue;
      state.since.delete(id);
      state.asked.delete(id);
      state.refused.delete(id);
    }
    if (paused) return;
    if (state.pausedSince !== null) {
      // Paused time does not count against any file's watch. (It does count as time since a file
      // was last asked: one that was due meanwhile is asked as soon as the page is back.)
      const pause = now - state.pausedSince;
      for (const [id, at] of state.since) state.since.set(id, at + pause);
      state.pausedSince = null;
    }
    if (ids.length === 0) return;
    if (state.lastTick === 0) state.lastTick = now;

    const then = accountEpoch();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const live = () => !stopped && sameAccount(then);
    // A file is asked for while its own watch lasts; one past it stays in `since` (so that it is
    // not taken for a new one) but is not asked for again.
    const watched = () =>
      ids.filter(
        (id) =>
          state.since.has(id) && !state.refused.has(id) && Date.now() - state.since.get(id)! < POLL_MAX_MS,
      );
    const last = (id: string) => state.asked.get(id) ?? state.since.get(id)!;
    // The wait after a question is decided by how long the file had been watched when it was asked.
    const waitOf = (id: string) => pollDelay(last(id) - state.since.get(id)!);
    const forget = (id: string) => {
      state.since.delete(id);
      state.asked.delete(id);
    };

    // "Still scanning": every listed file watched for over two minutes — one whose watch has run
    // out included, so a file is never left without it once it is no longer asked about.
    const markSlow = (at: number) => {
      const overdue = ids.filter(
        (id) =>
          state.since.has(id) && !state.refused.has(id) && at - state.since.get(id)! >= POLL_FAST_FOR_MS,
      );
      if (overdue.length === 0) return;
      setSlow((current) =>
        overdue.every((id) => current.has(id)) ? current : new Set([...current, ...overdue]),
      );
    };

    const plan = () => {
      if (!live()) return;
      markSlow(Date.now());
      const files = watched();
      if (files.length === 0) return;
      const wait = Math.min(...files.map(waitOf));
      const at = Math.max(state.lastTick + wait, state.notBefore);
      timer = setTimeout(() => void tick(), Math.max(0, at - Date.now()));
    };

    const tick = async () => {
      if (!live()) return;
      const at = Date.now();
      state.lastTick = at;
      const files = watched();
      markSlow(at);
      const due = files
        // 50 ms of grace: a timer may fire a little early or late against the file's own clock.
        .filter((id) => at - last(id) >= waitOf(id) - 50)
        .sort((a, b) => last(a) - last(b))
        .slice(0, POLL_PER_TICK);
      for (const id of due) {
        state.asked.set(id, at);
        try {
          const detail = await getNode(id);
          if (!live()) return;
          state.failures = 0;
          if (detail.node.scanStatus !== "pending") {
            forget(id);
            latest.current.onSettled(detail.node);
          }
        } catch (cause) {
          if (!live()) return;
          if (cause instanceof ApiError && cause.status === 404) {
            forget(id);
            latest.current.onGone(id);
            continue;
          }
          if (cause instanceof ApiError && cause.status === 403) {
            state.refused.add(id);
            continue;
          }
          // Too many requests, a failing server, no network: the whole loop goes quiet for a while.
          state.failures += 1;
          state.notBefore = Date.now() + penaltyAfter(cause, state.failures);
          break;
        }
      }
      plan();
    };

    plan();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [key, active, visible]);

  // An id that settled or left the folder is no longer "still scanning".
  return useMemo(() => {
    const pending = new Set(pendingIds);
    return new Set(Array.from(slow).filter((id) => pending.has(id)));
  }, [slow, pendingIds]);
}
