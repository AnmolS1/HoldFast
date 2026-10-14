// A batch Restore / Delete forever that was cut short. Kept here, not in the page: the wait the
// API named holds for the account, not for one visit to /trash — leave and come back inside it,
// and the two actions are still not offered, with the same notice. Account state: purged.
import { useSyncExternalStore } from "react";
import { registerUserStatePurger } from "../../lib/contracts";

/** What a stopped batch did, what is left, and until when the API asked for quiet. */
export interface BatchStop {
  action: "restore" | "delete";
  done: number;
  left: number;
  /** Before this time (ms) the API asked not to be called again; 0 = no wait. */
  retryAt: number;
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
