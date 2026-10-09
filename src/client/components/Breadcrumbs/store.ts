// The breadcrumb trail store. A feature sets the trail for its page with `useBreadcrumbs([...])`.
import { useEffect, useSyncExternalStore } from "react";
import { registerUserStatePurger } from "../../lib/contracts";

export interface Crumb {
  label: string;
  /** Where the crumb leads; the last crumb (the current page) needs none. */
  to?: string;
  /** Node id of a folder: ties the crumb to its list row for the folder-enter transition. */
  id?: string;
}

let trail: Crumb[] | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const get = () => trail;

function setTrail(next: Crumb[] | null): void {
  trail = next;
  for (const listener of listeners) listener();
}

/** Set the trail while the calling page is mounted. Pass a memoised array. */
export function useBreadcrumbs(crumbs: Crumb[] | null): void {
  useEffect(() => {
    setTrail(crumbs);
    return () => {
      // Only clear a trail this page set; the next page may already have set its own.
      if (trail === crumbs) setTrail(null);
    };
  }, [crumbs]);
}

export function useTrail(): Crumb[] | null {
  return useSyncExternalStore(subscribe, get, get);
}

/** Back to empty: run by `purgeUserState()` and by tests. */
export function resetBreadcrumbsForTests(): void {
  setTrail(null);
}

// Folder names are account data.
registerUserStatePurger(resetBreadcrumbsForTests);
