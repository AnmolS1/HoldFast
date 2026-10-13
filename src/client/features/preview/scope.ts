// The ONE gate every piece of late work in the preview goes through.
//
// A scope is opened where work starts (an effect, a click) and closed when its view ends (the
// preview closes, moves to another file, unmounts). Whatever runs later — after an `await`, a
// timer, an event, a chunk of a stream — asks `scope.alive()` first and hands `scope.signal` to
// whatever can be aborted. A scope ends in two ways:
//   - its view ends (`close()`);
//   - the signed-in account's state is purged (sign-out, another identity): the purger registered
//     below aborts EVERY open scope at once — transfers stop, pdf.js documents are destroyed,
//     timers find nothing alive — and the dialog, which subscribes to the purge count, drops what
//     it was showing and starts again for whoever is signed in now.
// `alive()` also compares the account epoch itself, so work that wakes between the purge starting
// and this module's purger running is stopped too.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { registerUserStatePurger } from "../../lib/contracts";
import { accountEpoch, sameAccount } from "../../lib/query";

export interface ViewScope {
  /** Aborted when the view ends or the account is purged. */
  readonly signal: AbortSignal;
  /** Whether work started under this scope may still ask, write or show anything. */
  alive(): boolean;
  close(): void;
}

// Module state, and so it has its purger (below): the scopes open right now, and how many purges
// there have been. Neither holds anything of an account — only the means to stop its work.
const openScopes = new Set<AbortController>();
const listeners = new Set<() => void>();
const purges = { count: 0 };

export function openScope(): ViewScope {
  const controller = new AbortController();
  const account = accountEpoch();
  openScopes.add(controller);
  return {
    signal: controller.signal,
    alive: () => {
      if (controller.signal.aborted) return false;
      if (sameAccount(account)) return true;
      controller.abort();
      openScopes.delete(controller);
      return false;
    },
    close: () => {
      controller.abort();
      openScopes.delete(controller);
    },
  };
}

/** Stop everything the preview has under way and tell the dialog to start over. */
export function purgePreview(): void {
  purges.count += 1;
  for (const controller of Array.from(openScopes)) controller.abort();
  openScopes.clear();
  for (const listener of Array.from(listeners)) listener();
}

registerUserStatePurger(purgePreview);

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Changes at every purge: the dialog keys what it shows on it. */
export function usePurgeCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => purges.count,
    () => purges.count,
  );
}

/** For tests: how many scopes are open. */
export function openScopeCount(): number {
  return openScopes.size;
}

/**
 * A scope that lives as long as the component, for its EVENT handlers (an element's `load`,
 * `error`, a click): `alive()` is false before mount, after unmount and after a purge.
 */
export function useViewScope(): { alive(): boolean; signal(): AbortSignal | undefined } {
  const scope = useRef<ViewScope | null>(null);
  useEffect(() => {
    const own = openScope();
    scope.current = own;
    return () => {
      own.close();
      if (scope.current === own) scope.current = null;
    };
  }, []);
  // The handlers read the ref when they RUN, never while rendering.
  const [handle] = useState(() => ({
    alive: () => scope.current?.alive() ?? false,
    signal: () => scope.current?.signal,
  }));
  return handle;
}
