// Watching files that are still being scanned. Each pending file is asked for every 5 s for two
// minutes, then every 30 s and the row says "Still scanning". The answer is a `NodeDetailDto`:
// the status is `.node.scanStatus`.
import { useEffect, useMemo, useRef, useState } from "react";
import type { NodeDto } from "../../../shared/schemas/node";
import { ApiError } from "../../lib/api";
import { getNode } from "./api";

export const POLL_FAST_MS = 5_000;
export const POLL_FAST_FOR_MS = 120_000;
export const POLL_SLOW_MS = 30_000;
/** Files watched at once; the rest take their turn as these settle. */
export const MAX_POLLED = 25;

/** The wait before the next question, given how long the file has been watched. */
export function pollDelay(elapsedMs: number): number {
  return elapsedMs < POLL_FAST_FOR_MS ? POLL_FAST_MS : POLL_SLOW_MS;
}

interface Watch {
  since: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  stopped: boolean;
}

export interface ScanPollHandlers {
  /** The scan ended: the node as it is now. */
  onSettled(node: NodeDto): void;
  /** The node is no longer there (`404`). */
  onGone(id: string): void;
}

/** Polls the given pending ids; returns the ones that have been pending for over two minutes. */
export function useScanPolling(
  pendingIds: readonly string[],
  handlers: ScanPollHandlers,
): ReadonlySet<string> {
  const watches = useRef(new Map<string, Watch>());
  const latest = useRef(handlers);
  const [slow, setSlow] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    latest.current = handlers;
  });

  const wanted = pendingIds.slice(0, MAX_POLLED).join(",");
  useEffect(() => {
    const map = watches.current;
    const ids = new Set(wanted === "" ? [] : wanted.split(","));
    const stop = (id: string) => {
      const watch = map.get(id);
      if (!watch) return;
      watch.stopped = true;
      clearTimeout(watch.timer);
      map.delete(id);
    };
    for (const id of Array.from(map.keys())) if (!ids.has(id)) stop(id);

    const schedule = (id: string, watch: Watch) => {
      watch.timer = setTimeout(
        () => {
          if (Date.now() - watch.since >= POLL_FAST_FOR_MS)
            setSlow((current) => (current.has(id) ? current : new Set(current).add(id)));
          getNode(id).then(
            (detail) => {
              if (watch.stopped) return;
              if (detail.node.scanStatus === "pending") schedule(id, watch);
              else {
                stop(id);
                latest.current.onSettled(detail.node);
              }
            },
            (cause: unknown) => {
              if (watch.stopped) return;
              if (cause instanceof ApiError && cause.status === 404) {
                stop(id);
                latest.current.onGone(id);
              } else schedule(id, watch);
            },
          );
        },
        pollDelay(Date.now() - watch.since),
      );
    };
    for (const id of ids) {
      if (map.has(id)) continue;
      const watch: Watch = { since: Date.now(), timer: undefined, stopped: false };
      map.set(id, watch);
      schedule(id, watch);
    }
  }, [wanted]);

  useEffect(() => {
    const map = watches.current;
    return () => {
      for (const watch of map.values()) {
        watch.stopped = true;
        clearTimeout(watch.timer);
      }
      map.clear();
    };
  }, []);

  // An id that settled or left the folder is no longer "still scanning".
  return useMemo(() => {
    const pending = new Set(pendingIds);
    return new Set(Array.from(slow).filter((id) => pending.has(id)));
  }, [slow, pendingIds]);
}
