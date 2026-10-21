// History state across an account change. The browser's session history is not in any cache a
// purge reaches: back / forward (or a reload) hands a page the state an earlier page wrote, and
// that may have been written for the account signed in BEFORE this one — a folder (`from`), the
// ids of its files (`siblingIds`). The shell's rule:
//   - every page of the frame writes its history state through `stamped(…)`: it carries the id of
//     the account it was written for (a scan test holds every `navigate(…, { state })` to it);
//   - every reader in the frame reads it through `ownHistoryState(…)`: state stamped for ANOTHER
//     account is not there at all — not for one render.
// State without a stamp was not written by a page of the frame (the sign-in screens pass an
// address along before any account is known): it is nobody's account data and is read as it is.
import { getKnownUserId } from "./query";

export const ACCOUNT_STAMP = "account";

/** `state` with the signed-in account's id added (as it is when no account is known). */
export function stamped<T extends object>(state: T): T & { account?: string } {
  const account = getKnownUserId();
  return account === null ? state : { ...state, [ACCOUNT_STAMP]: account };
}

/** The history state, unless it was stamped for an account that is not the signed-in one. */
export function ownHistoryState(state: unknown): Record<string, unknown> | null {
  if (typeof state !== "object" || state === null) return null;
  const record = state as Record<string, unknown>;
  const account = record[ACCOUNT_STAMP];
  if (account === undefined) return record;
  return typeof account === "string" && account === getKnownUserId() ? record : null;
}
