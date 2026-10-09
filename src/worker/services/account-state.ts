// Account state changes that must also end sessions or pause links: suspension, the side
// effects of a ban, scheduled deletion and its cancellation, terms acceptance, and the final
// removal of an account's auth rows. This file is the ONLY writer of `user.suspendedAt`, of the
// ban side effects and of deletion scheduling: the strikes helper, the admin console and the
// purge job call these functions and never write those columns themselves.
//
// SIGNATURES. Each function takes a `ServiceDeps` (`{ db, env, defer }`) first, never a Hono
// context: routes pass `deps(c)`, the queue consumer and the jobs pass `bg`. Each is one
// transaction, then one audit row and (where a template exists) one email — both through
// `deps.defer`, so a caller that must have them settled before it answers drains its own `defer`.
//
// LINKS are paused, never revoked: `pauseLinks` adds a reason to a link's set and `unpauseLinks`
// removes only that reason, so lifting a suspension cannot lift a deletion pause or a report
// pause. One reason, `owner_suspended`, covers both suspension and ban; it is removed only when
// the account is neither.
//
// SESSIONS are revoked by deleting the user's rows (`revokeSessions`) — never through the admin
// plugin's revoke endpoints, which are outside the allow-list and need an admin session the
// queue consumer does not have. A revocation is effective on the browser's very next request:
// every request reads the session row (there is no cookie cache).

import {
  clearSuspended,
  deleteUserSessions,
  getAccount,
  purgeAuthRows as deleteAuthRows,
  setSuspended,
  setTermsAccepted,
} from "../db/queries/auth-lifecycle";
import type { Executor } from "../db/client";
import { pauseLinks, unpauseLinks } from "../db/queries/links";
import { cancel, schedule } from "../db/queries/user-purge";
import { userState } from "../db/queries/users";
import { record } from "../auth/observe";
import { now } from "./clock";
import { sendAccountSuspended, sendDeletionCancelled, sendDeletionScheduled } from "./email";
import { AppError } from "./errors";
import { coreFor, resolveSettings, type ServiceDeps } from "./request-context";

/** Who did it, for the audit row. `system`: a job or the queue consumer. */
export type Actor = { userId: string | null; type: "user" | "admin" | "system" };
export const SYSTEM_ACTOR: Actor = { userId: null, type: "system" };

/** How long a scheduled deletion can still be cancelled. */
export const DELETION_WINDOW_DAYS = 7;

const target = (userId: string) => ({ type: "user", id: userId });
const by = (actor: Actor) => ({ actorUserId: actor.userId, actorType: actor.type });

/**
 * Ends every session of the user (deletes the rows). Returns how many there were.
 * The one way sessions are revoked from our code — suspension, bans, the admin console's
 * "Revoke sessions", an account past its deletion date.
 */
export async function revokeSessions(deps: ServiceDeps, userId: string): Promise<number> {
  return deleteUserSessions(deps.db, userId);
}

/**
 * Suspends the account: sets `suspendedAt` / `suspendedReason`, ends every session and pauses
 * the account's links (`owner_suspended`). IDEMPOTENT: for an account that is already suspended
 * (or does not exist) nothing changes, nothing is audited and no second email is sent — returns
 * false. (The strikes helper relies on this when a queue message is redelivered.)
 */
export async function suspendUser(
  deps: ServiceDeps,
  userId: string,
  reason: string,
  actor: Actor,
): Promise<boolean> {
  const suspended = await deps.db.transaction(async (tx) => {
    // The UPDATE takes the user's row lock first (the estate's lock order: user, then the rest).
    if (!(await setSuspended(tx, userId, now(), reason))) return null;
    const sessions = await deleteUserSessions(tx, userId);
    const paused = await pauseLinks(tx, { ownerId: userId }, "owner_suspended");
    return { sessions, links: paused.length, account: await getAccount(tx, userId) };
  });
  if (!suspended) return false;
  record(
    deps,
    "account.suspended",
    target(userId),
    { reason, sessions: suspended.sessions, links: suspended.links },
    by(actor),
  );
  if (suspended.account) {
    deps.defer(sendAccountSuspended(deps, { to: suspended.account.email, name: suspended.account.name }));
  }
  return true;
}

/**
 * Lifts a suspension. The `owner_suspended` pause is removed only if the account is not also
 * banned. False — and nothing happens — when the account was not suspended.
 */
export async function unsuspendUser(deps: ServiceDeps, userId: string, actor: Actor): Promise<boolean> {
  const lifted = await deps.db.transaction(async (tx) => {
    if (!(await clearSuspended(tx, userId))) return null;
    const state = await userState(tx, userId);
    const restored = state?.banned ? [] : await unpauseLinks(tx, { ownerId: userId }, "owner_suspended");
    return { links: restored.length, stillBanned: state?.banned === true };
  });
  if (!lifted) return false;
  record(deps, "account.unsuspended", target(userId), lifted, by(actor));
  return true;
}

/**
 * The side effects of a ban, which the admin plugin does not have: a ban ends every session and
 * pauses the account's links exactly as a suspension does; lifting one removes the pause only
 * if the account is not also suspended. Called from the `user` update hook (auth/hooks.ts)
 * whenever the ban flag is written — so a ban made straight against the plugin's endpoint
 * cannot skip them.
 */
export async function applyBanChange(
  deps: ServiceDeps,
  userId: string,
  banned: boolean,
  actor: Actor,
): Promise<void> {
  const outcome = await deps.db.transaction(async (tx) => {
    if (banned) {
      const sessions = await deleteUserSessions(tx, userId);
      const paused = await pauseLinks(tx, { ownerId: userId }, "owner_suspended");
      return { sessions, links: paused.length };
    }
    const state = await userState(tx, userId);
    // An expired ban reads as "not banned" too; either way a suspension keeps the pause.
    if (!state || state.banned || state.suspendedAt !== null) return { sessions: 0, links: 0 };
    const restored = await unpauseLinks(tx, { ownerId: userId }, "owner_suspended");
    return { sessions: 0, links: restored.length };
  });
  record(deps, banned ? "account.banned" : "account.unbanned", target(userId), outcome, by(actor));
}

export type ScheduleOutcome = {
  /** When the account will be deleted; null when there is no such account. */
  scheduledFor: Date | null;
  /** False when a deletion was already scheduled (or has begun): nothing was changed or sent. */
  changed: boolean;
};

/**
 * Schedules the account's deletion for seven days from now: `deleteScheduledAt`, the
 * `pending_user_purges` row and the `owner_deletion` pause on its links, in one transaction.
 * Links are PAUSED, not revoked, so cancelling restores them. Sessions are left alone — the
 * owner must be able to see the banner and cancel.
 *
 * IDEMPOTENT: a second request while one is scheduled (or once the purge has begun) keeps the
 * first date and sends nothing.
 *
 * An account on legal hold is treated exactly like any other here — same row, same email, same
 * answer. The purge job is what skips it, silently.
 */
export async function scheduleDeletion(
  deps: ServiceDeps,
  userId: string,
  actor: Actor = { userId, type: "user" },
): Promise<ScheduleOutcome> {
  const account = await getAccount(deps.db, userId);
  if (!account) return { scheduledFor: null, changed: false };
  if (account.deleteScheduledAt) return { scheduledFor: account.deleteScheduledAt, changed: false };

  const scheduledFor = new Date(now().getTime() + DELETION_WINDOW_DAYS * 86_400_000);
  // False: a purge of this account has already begun (or the row vanished). Not an error: the
  // account is being deleted, which is what was asked for.
  if (!(await schedule(deps.db, userId, scheduledFor))) {
    const current = await getAccount(deps.db, userId);
    return { scheduledFor: current?.deleteScheduledAt ?? null, changed: false };
  }
  record(
    deps,
    "account.deletion_scheduled",
    target(userId),
    { scheduledFor: scheduledFor.toISOString() },
    by(actor),
  );
  deps.defer(sendDeletionScheduled(deps, { to: account.email, name: account.name, scheduledFor }));
  return { scheduledFor, changed: true };
}

/**
 * Cancels a scheduled deletion — the only way one is ever cancelled. Clears the date, deletes
 * the pending row and removes the `owner_deletion` pause (a link that carries another reason
 * stays paused). `409 conflict` once the purge has begun. False when nothing was scheduled.
 */
export async function cancelDeletion(
  deps: ServiceDeps,
  userId: string,
  actor: Actor = { userId, type: "user" },
): Promise<boolean> {
  const account = await getAccount(deps.db, userId);
  if (!account) return false;
  // `cancel` re-checks under the row locks; it is what closes the race with the purge job.
  if (!(await cancel(deps.db, userId))) {
    throw new AppError("conflict", "The deletion has already started and can no longer be cancelled.");
  }
  if (!account.deleteScheduledAt) return false;
  record(deps, "account.deletion_cancelled", target(userId), null, by(actor));
  deps.defer(sendDeletionCancelled(deps, { to: account.email, name: account.name }));
  return true;
}

/**
 * Records that the user accepted the CURRENT terms. `version` must equal the current
 * `settings.termsVersion` (read fresh, not from the 60 s cache) — `400 validation` otherwise.
 */
export async function acceptTerms(deps: ServiceDeps, userId: string, version: string): Promise<void> {
  // The injected reader (the same one the terms gate uses), fresh from the table.
  const stored = await coreFor(deps).getSettings(deps.db, { fresh: true });
  const current = resolveSettings(deps.env, stored).termsVersion;
  if (version !== current) {
    throw new AppError("validation", "That is not the current version of the Terms.", {
      reason: "terms_version",
    });
  }
  if (!(await setTermsAccepted(deps.db, userId, version, now()))) throw new AppError("not_found");
  record(
    deps,
    "account.terms_accepted",
    target(userId),
    { version },
    { actorUserId: userId, actorType: "user" },
  );
}

/**
 * Deletes the user's Better Auth rows (sessions, accounts, passkeys, two-factor, verifications,
 * then the user) — for the purge job, which calls it LAST, after the account's files and links
 * are gone. The only hard delete of an account; never Better Auth's own delete endpoint.
 */
export async function purgeAuthRows(db: Executor, userId: string): Promise<boolean> {
  return deleteAuthRows(db, userId);
}
