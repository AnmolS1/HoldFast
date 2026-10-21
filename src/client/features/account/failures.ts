// The words for a failure and for a wait, and the wait itself: a `Retry-After` is recorded in the
// shell's registry (lib/query.ts — account-scoped, emptied on purge) and counted down from there.
import { useEffect, useState } from "react";
import { holdUntil, useWaitUntil } from "../../lib/query";
import type { AuthFailure } from "./auth-calls";
import { t } from "./strings";

/** "45 s", "3 min": how long a wait still is. */
export function waitText(seconds: number): string {
  if (seconds < 60) return t("wait.seconds", { count: Math.max(1, seconds) });
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return t("wait.minutes", { count: minutes });
  return t("wait.hours", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/**
 * Records the wait a failure named (`Retry-After`) under `hash` in the shell's registry
 * (account-scoped, emptied on purge). Nothing is retried.
 */
export function holdFor(hash: string, failure: AuthFailure): void {
  if (failure.retryAfter !== undefined) holdUntil(hash, Date.now() + failure.retryAfter * 1000);
}

/** Seconds left of the wait under `hash`; 0 when there is none. Re-renders each second while waiting. */
export function useSecondsLeft(hash: string): number {
  const until = useWaitUntil(hash);
  // The clock, read at most a second late: what the countdown is drawn from.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return until === 0 ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/** The sentence for a failure no screen words itself. */
export function failureText(failure: AuthFailure): string {
  if (failure.status === 0) return t("account.offline");
  if (failure.status === 429) {
    return failure.retryAfter !== undefined
      ? t("account.wait", { wait: waitText(failure.retryAfter) })
      : t("account.failed");
  }
  if (failure.message && failure.status >= 400 && failure.status < 500) return failure.message;
  return t("account.failed");
}
