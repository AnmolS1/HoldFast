// A batch Restore / Delete forever that was cut short. Kept here, not in the page: the notice and
// the wait the API named (in the views' one registry of waits, under `BATCH_WAIT`) hold for the
// account, not for one visit to /trash — leave and come back inside it, and the two actions are
// still not offered, with the same notice. Account state: purged.
import { useSyncExternalStore } from "react";
import { registerUserStatePurger } from "../../lib/contracts";
import { VIEWS_KEY } from "../starred/view-queries";
import { waitKey } from "../starred/waits";

/** Where the batches' wait is kept in the registry (waits.ts): a key of its own, not a query's. */
export const BATCH_WAIT = waitKey([VIEWS_KEY, "trash", "batch"]);

/** What a stopped batch did, what is left, and until when the API asked for quiet. */
export interface BatchStop {
  action: "restore" | "delete";
  done: number;
  left: number;
  requestId: string | undefined;
  /** The API client has announced the failure already (a toast): the notice is not a live region. */
  announced: boolean;
}

let current: BatchStop | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const read = () => current;

export function useBatchStop(): BatchStop | null {
  return useSyncExternalStore(subscribe, read, read);
}

export function setBatchStop(stop: BatchStop | null): void {
  if (current === stop) return;
  current = stop;
  for (const listener of listeners) listener();
}

// "Restoring stopped: 3 restored, 17 left" is the previous account's.
registerUserStatePurger(() => setBatchStop(null));
