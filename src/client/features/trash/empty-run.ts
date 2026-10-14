// The one "Empty trash" run of the signed-in account. It lives here, not in a component: the
// user confirmed an irreversible act, so the `202` loop goes on to its `204` whichever page they
// move to, and every page that shows the button shows the same progress. Being account state, it
// is stopped and forgotten on sign-out or an account switch.
import { useSyncExternalStore } from "react";
import { toast } from "../../components/Toaster";
import { api } from "../../lib/api";
import { emitNodesChanged, registerUserStatePurger, SessionShape } from "../../lib/contracts";
import { accountEpoch, getKnownUserId, queryClient, refreshSession, sameAccount } from "../../lib/query";
import { refreshQueries, viewKeys, VIEWS_KEY } from "../starred/view-queries";
import { retryNotBefore } from "../starred/view-state";
import { holdUntil, waitKey } from "../starred/waits";
import { announcedByClient, emptyTrash, EMPTY_TRASH, isAbort } from "./queries";
import { t } from "./strings";

export type EmptyRun =
  | { state: "idle" }
  | { state: "running"; remaining: number | null }
  /**
   * `dismissed`: the user closed the notice. A wait the API named, if any, still holds: it is in
   * the views' one registry of waits (waits.ts), under `EMPTY_WAIT`.
   */
  | { state: "stopped"; remaining: number | null; dismissed: boolean };

/** Where a stopped run's wait is kept in the registry (waits.ts): a key of its own. */
export const EMPTY_WAIT = waitKey([VIEWS_KEY, "trash", "empty"]);

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
  // cookie names when the request LEAVES — so the account is checked before every request, the
  // first included, not only when an answer arrives: against what this tab knows, and against
  // the session as the server has it now, because another tab may have signed somebody else in
  // meanwhile (the click may come long after the page loaded; each later batch follows up to
  // twenty seconds of server work). ANOTHER account ends the run without a word. NO session
  // (it expired) is not another account: the batch goes, draws its `401`, and the API client
  // opens re-auth — signed in again as the same account, the request is replayed and the run
  // goes on; cancelled, the run stops and says so; another account, the shell starts afresh.
  // (The session is read without writing it to the cache: a `null` there would tell the API
  // client there never was a session, and the `401` would open nothing.)
  const owner = getKnownUserId();
  const account = accountEpoch();
  const beforeBatch = async () => {
    const session = await api("/api/auth/get-session", { schema: SessionShape });
    const now = session?.user.id ?? null;
    if (now !== null && now !== owner) {
      // The cookie names somebody else: this tab is handed to them (the shell adopts the session
      // and purges A's state, the frame starts again as B) — and A's run ends with it, unseen.
      await refreshSession().catch(() => undefined);
      throw new NotThisAccount();
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
    async () => {
      if (!sameAccount(account)) return;
      // `204`: the trash is empty, and that is known without asking. A read still out (each
      // batch asked for one) would bring the purged rows back after this, so it is called off
      // first; then the list is written as the server has it — whatever a failed page or a wait
      // the API named left on it.
      await queryClient.cancelQueries({ queryKey: viewKeys.trash });
      if (!sameAccount(account)) return;
      queryClient.setQueryData(viewKeys.trash, EMPTY_TRASH);
      void refreshQueries(viewKeys.usage);
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
      holdUntil(EMPTY_WAIT, retryNotBefore(error, Date.now()));
      set({
        run: {
          state: "stopped",
          remaining,
          dismissed: false,
        },
      });
      // Said ONCE: what the API client has already announced itself (a `429`, a `503` read-only
      // or paused) gets no second word; anything else gets this toast. The line next to the
      // button is not a live region.
      if (!announcedByClient(error)) toast({ message: stoppedMessage(remaining), key: "empty-trash" });
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
