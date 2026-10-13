// The one "Empty trash" run of the signed-in account. It lives here, not in a component: the
// user confirmed an irreversible act, so the `202` loop goes on to its `204` whichever page they
// move to, and every page that shows the button shows the same progress. Being account state, it
// is stopped and forgotten on sign-out or an account switch.
import { useSyncExternalStore } from "react";
import { toast } from "../../components/Toaster";
import { ApiError } from "../../lib/api";
import { emitNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, getKnownUserId, refreshSession, sameAccount } from "../../lib/query";
import { refreshQueries, viewKeys } from "../starred/view-queries";
import { retryNotBefore } from "../starred/view-state";
import { emptyTrash, isAbort } from "./queries";
import { t } from "./strings";

export type EmptyRun =
  | { state: "idle" }
  | { state: "running"; remaining: number | null }
  /**
   * `retryAt`: before this time (ms) the API asked not to be called again; 0 = no wait.
   * `dismissed`: the user closed the notice (the wait, if any, still holds).
   */
  | { state: "stopped"; remaining: number | null; retryAt: number; dismissed: boolean };

/**
 * What the module holds: the run, and whether the read that precedes its confirmation is out
 * (`checking`) — while it is, nothing else destructive may start on the page.
 */
interface Snapshot {
  run: EmptyRun;
  checking: boolean;
}

const IDLE: EmptyRun = { state: "idle" };
let snapshot: Snapshot = { run: IDLE, checking: false };
const listeners = new Set<() => void>();

function set(patch: Partial<Snapshot>): void {
  snapshot = { ...snapshot, ...patch };
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const currentRun = () => snapshot.run;
const currentChecking = () => snapshot.checking;

export function useEmptyRun(): EmptyRun {
  return useSyncExternalStore(subscribe, currentRun, currentRun);
}

export function getEmptyRun(): EmptyRun {
  return snapshot.run;
}

/** Is the read before "Empty the trash?" out? */
export function usePreConfirmRead(): boolean {
  return useSyncExternalStore(subscribe, currentChecking, currentChecking);
}

export function setPreConfirmRead(checking: boolean): void {
  if (snapshot.checking !== checking) set({ checking });
}

/** What the server has now: the trash list and the storage numbers, read again. */
function refresh(): void {
  void refreshQueries(viewKeys.trash);
  void refreshQueries(viewKeys.usage);
}

/** The run is not this account's any more: it ends without a word. */
class NotThisAccount extends Error {
  constructor() {
    super("the signed-in account changed");
    this.name = "AbortError";
  }
}

/** Start emptying the trash. A run already under way is left alone. */
export function startEmptyTrash(): void {
  if (snapshot.run.state === "running") return;
  set({ run: { state: "running", remaining: null } });
  let remaining: number | null = null;
  // Whose trash this is. `DELETE /api/trash` means "the caller's", and the caller is whoever the
  // cookie names when the request LEAVES — so the account is checked before every request, not
  // only when an answer arrives: against what this tab knows, and (from the second request on,
  // each of which may follow up to twenty seconds of server work) against the session read
  // again, because another tab may have signed somebody else in meanwhile.
  const owner = getKnownUserId();
  const account = accountEpoch();
  const beforeBatch = async (round: number) => {
    if (round > 0) {
      const session = await refreshSession();
      if ((session?.user.id ?? null) !== owner) throw new NotThisAccount();
    }
    if (!sameAccount(account) || getKnownUserId() !== owner) throw new NotThisAccount();
  };
  emptyTrash(
    (left) => {
      // The purge aborts the loop; this is the second lock: whatever of this run still comes
      // back after the account's state was purged changes nothing and says nothing.
      if (!sameAccount(account)) return;
      remaining = left;
      set({ run: { state: "running", remaining: left } });
      // A batch is gone: the list on screen should not show it.
      refresh();
    },
    undefined,
    beforeBatch,
  ).then(
    () => {
      if (!sameAccount(account)) return;
      set({ run: IDLE });
      toast({ message: t("trash.emptyTrash.done"), key: "empty-trash" });
      // No live listing changed; this feature's own trash and storage numbers did.
      emitNodesChanged([]);
    },
    (error: unknown) => {
      if (!sameAccount(account)) return;
      // Stopped because the account changed: there is nobody to tell.
      if (isAbort(error)) {
        set({ run: IDLE });
        return;
      }
      set({
        run: {
          state: "stopped",
          remaining,
          retryAt: retryNotBefore(error, Date.now()),
          dismissed: false,
        },
      });
      // Said ONCE: the API client has already announced a `429` and a `503` itself; anything
      // else gets this toast. The line next to the button is not a live region.
      if (!(error instanceof ApiError && (error.status === 429 || error.status === 503))) {
        toast({ message: stoppedMessage(remaining), key: "empty-trash" });
      }
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

/** Close the "couldn't finish" line. A wait the API named still holds. */
export function dismissStopped(): void {
  if (snapshot.run.state === "stopped") set({ run: { ...snapshot.run, dismissed: true } });
}

/** Back to idle. Run by `purgeUserState()` (after the loop itself was aborted) and by tests. */
export function resetEmptyRun(): void {
  set({ run: IDLE, checking: false });
}

// "Deleting… 240 left" is the previous account's.
registerUserStatePurger(resetEmptyRun);
