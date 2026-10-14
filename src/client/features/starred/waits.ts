// Every wait the API named (`Retry-After`), in ONE place, per query key: until when that list —
// or that batch — must not be asked again. Not in the query cache: any write to the cache (an
// emptied trash, a row taken out after a restore) clears a query's error, and a wait read from
// the error would go with it. A wait goes only when its time has passed, or with the account:
// purged on sign-out and on an account change.
import { hashKey, type QueryKey } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { registerUserStatePurger } from "../../lib/contracts";

const waits = new Map<string, number>();
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function emit(): void {
  for (const listener of listeners) listener();
}

/** Record a wait for this hash (a query's `queryHash`) ending at `until` (ms). A longer one stays. */
export function holdUntil(hash: string, until: number): void {
  if (until <= Date.now() || (waits.get(hash) ?? 0) >= until) return;
  waits.set(hash, until);
  emit();
}

/** Until when (ms) this hash must wait; 0 when it need not (a wait that has passed is dropped). */
export function waitUntil(hash: string): number {
  const until = waits.get(hash) ?? 0;
  if (until === 0) return 0;
  if (until > Date.now()) return until;
  waits.delete(hash);
  return 0;
}

export const waitKey = (key: QueryKey): string => hashKey(key);

/** The end of this hash's wait, re-read when a wait is recorded (pair with `useBlockedUntil`). */
export function useWaitUntil(hash: string): number {
  return useSyncExternalStore(
    subscribe,
    () => waitUntil(hash),
    () => 0,
  );
}

/** Forget every wait. Run by `purgeUserState()` and by tests. */
export function clearWaits(): void {
  waits.clear();
  emit();
}

registerUserStatePurger(clearWaits);
