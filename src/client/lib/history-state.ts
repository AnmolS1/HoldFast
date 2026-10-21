// History state across an account change. The browser's session history is not in any cache a
// purge reaches: back / forward (or a reload) hands a page the state an earlier page wrote, and
// that may have been written for the account signed in BEFORE this one — a folder (`from`), the
// ids of its files (`siblingIds`). The shell's rule:
//   - every page of the frame writes its history state through `stamped(…)`: it carries the id of
//     the account it was written for (a scan test holds every `navigate(…, { state })` to it);
//   - every reader in the frame reads it through `ownHistoryState(…)`: state stamped for ANOTHER
//     account is not there at all — not for one render.
// A page of the frame that writes while NO account is known (a late write after a sign-out purge)
// stamps it `account: null`: nobody's — refused by every reader, never taken for the account
// signed in later. State with no stamp at all was not written by a page of the frame (the sign-in
// screens pass an address along before any account exists) and is read as it is.
import { getKnownUserId } from "./query";

export const ACCOUNT_STAMP = "account";

/** `state` with the signed-in account's id added; `null` when no account is known (nobody's). */
export function stamped<T extends object>(state: T): T & { account: string | null } {
  return { ...state, [ACCOUNT_STAMP]: getKnownUserId() };
}

/** Does this state carry a stamp at all (an account's, or nobody's)? */
export function isStamped(state: unknown): boolean {
  return typeof state === "object" && state !== null && ACCOUNT_STAMP in state;
}

/**
 * The history state, unless it was stamped for an account that is not the signed-in one. State
 * stamped for nobody (`null`) is read only while nobody is signed in: once an account is, it is
 * never taken for that account's.
 */
export function ownHistoryState(state: unknown): Record<string, unknown> | null {
  if (typeof state !== "object" || state === null) return null;
  const record = state as Record<string, unknown>;
  const account = record[ACCOUNT_STAMP];
  if (account === undefined) return record;
  const known = getKnownUserId();
  if (account === null) return known === null ? record : null;
  return typeof account === "string" && account === known ? record : null;
}
