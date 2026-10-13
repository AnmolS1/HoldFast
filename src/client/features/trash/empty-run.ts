// The one "Empty trash" run of the signed-in account. It lives here, not in a component: the
// user confirmed an irreversible act, so the `202` loop goes on to its `204` whichever page they
// move to, and every page that shows the button shows the same progress. Being account state, it
// is stopped and forgotten on sign-out or an account switch.
import { useSyncExternalStore } from "react";
import { toast } from "../../components/Toaster";
import { emitNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, queryClient, sameAccount } from "../../lib/query";
import { retryNotBefore } from "../starred/view-state";
import { viewKeys } from "../starred/view-queries";
import { emptyTrash, isAbort } from "./queries";
import { t } from "./strings";

export type EmptyRun =
  | { state: "idle" }
  | { state: "running"; remaining: number | null }
  /** `retryAt`: before this time (ms) the API asked not to be called again; 0 = no wait. */
  | { state: "stopped"; remaining: number | null; retryAt: number };

const IDLE: EmptyRun = { state: "idle" };
let run: EmptyRun = IDLE;
const listeners = new Set<() => void>();

function setRun(next: EmptyRun): void {
  run = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const current = () => run;

export function useEmptyRun(): EmptyRun {
  return useSyncExternalStore(subscribe, current, current);
}

export function getEmptyRun(): EmptyRun {
  return run;
}

/** What the server has now: the trash list and the storage numbers, read again. */
function refresh(): void {
  void queryClient.invalidateQueries({ queryKey: viewKeys.trash });
  void queryClient.invalidateQueries({ queryKey: viewKeys.usage });
}

/** Start emptying the trash. A run already under way is left alone. */
export function startEmptyTrash(): void {
  if (run.state === "running") return;
  setRun({ state: "running", remaining: null });
  let remaining: number | null = null;
  // The purge aborts the loop; this is the second lock: whatever of this run still comes back
  // after the account's state was purged changes nothing and says nothing.
  const account = accountEpoch();
  emptyTrash((left) => {
    if (!sameAccount(account)) return;
    remaining = left;
    setRun({ state: "running", remaining: left });
    // A batch is gone: the list on screen should not show it.
    refresh();
  }).then(
    () => {
      if (!sameAccount(account)) return;
      setRun(IDLE);
      toast({ message: t("trash.emptyTrash.done"), key: "empty-trash" });
      // No live listing changed; this feature's own trash and storage numbers did.
      emitNodesChanged([]);
    },
    (error: unknown) => {
      // Stopped by the purge below: the account is gone, there is nobody to tell.
      if (isAbort(error) || !sameAccount(account)) return;
      setRun({ state: "stopped", remaining, retryAt: retryNotBefore(error, Date.now()) });
      toast({ message: stoppedMessage(remaining), key: "empty-trash" });
      // Part of it may be gone.
      emitNodesChanged([]);
    },
  );
}

export function stoppedMessage(remaining: number | null): string {
  return remaining === null
    ? t("trash.emptyTrash.stopped")
    : t("trash.emptyTrash.stoppedLeft", { remaining });
}

/** Back to idle. Run by `purgeUserState()` (after the loop itself was aborted) and by tests. */
export function resetEmptyRun(): void {
  setRun(IDLE);
}

// "Deleting… 240 left" is the previous account's.
registerUserStatePurger(resetEmptyRun);
