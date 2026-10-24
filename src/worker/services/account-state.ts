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
  adminDeletionMarked,
  clearAdminDeletion,
  clearSuspended,
  deleteUserSessions,
  revokeAccess,
  getAccount,
  lockActiveAdmins,
  lockUser,
  markAdminDeletion,
  purgeAuthRows as deleteAuthRows,
  setSuspended,
  setTermsAccepted,
} from "../db/queries/auth-lifecycle";
import type { Executor } from "../db/client";
import { hasAdminRole } from "../../shared/roles";
import { pauseLinks, unpauseLinks } from "../db/queries/links";
import { cancel, schedule } from "../db/queries/user-purge";
import { userState } from "../db/queries/users";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
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

// ── what the console may not do (R1 secsrv-2 / func-4, ruling Q4) ───────────────────────────
//
// An admin does not suspend, schedule the deletion of, or change the quota of their OWN account
// (`400 self_action`): a sole admin who suspended themself was locked out, with only SQL to get
// back in. And no admin is suspended or scheduled for deletion when that leaves no admin who can
// still act (`409 last_admin`) — which, the actor being one, happens when the actor is leaving
// too (their own deletion is scheduled) or when two admins act on each other at the same moment.
// Acting on ANOTHER admin stays allowed. Both apply to the console (an `admin` actor) only: the
// strikes helper and the holder's own deletion request are not the console — except that a
// strike's suspension, whoever's, honours the last-admin rule too (`lastAdminGuard`, R2 auth-2).

/** `400 self_action` when an admin aims the console at their own account. */
export function refuseSelfAction(actor: Actor, userId: string): void {
  if (actor.type === "admin" && actor.userId === userId) throw new AppError("self_action");
}

/**
 * `409 last_admin` when the target is an admin and no OTHER admin could still act after it.
 * Call it FIRST inside the transaction that makes the change (`lockActiveAdmins`' lock order).
 */
export async function refuseLastAdmin(tx: Executor, userId: string): Promise<void> {
  const [row] = await tx.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  if (!hasAdminRole(row?.role)) return;
  const active = await lockActiveAdmins(tx, now());
  // An admin who cannot act already (suspended, leaving) loses nothing more: the change is a no-op.
  if (!active.includes(userId)) return;
  if (!active.some((id) => id !== userId)) throw new AppError("last_admin");
}

/**
 * Is `userId` the LAST admin who can act — an admin, and no other admin can (R2 auth-2: a strike
 * that would suspend them is refused before it is written)? `refuseLastAdmin`'s question without
 * the throw, for a caller that decides only once it has counted. Locks every admin row first
 * (`lockActiveAdmins`, id order) when the user is an admin: call it FIRST inside the transaction.
 */
export async function isLastActiveAdmin(tx: Executor, userId: string): Promise<boolean> {
  const [row] = await tx.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1);
  if (!hasAdminRole(row?.role)) return false;
  const active = await lockActiveAdmins(tx, now());
  return active.includes(userId) && !active.some((id) => id !== userId);
}

/**
 * Ends every session of the user (deletes the rows). Returns how many there were.
 * The one way sessions are revoked from our code — suspension, bans, the admin console's
 * "Revoke sessions", an account past its deletion date.
 */
export async function revokeSessions(deps: ServiceDeps, userId: string): Promise<number> {
  return deleteUserSessions(deps.db, userId);
}

/**
 * Ends the account's sessions AND its device proofs and key marks (db/queries/auth-lifecycle.ts
 * `revokeAccess`) — for a state that locks the account outside the two transactions below: a
 * deletion date that has passed (auth/hooks.ts, the session read).
 */
export async function revokeAllAccess(deps: ServiceDeps, userId: string): Promise<number> {
  return deps.db.transaction((tx) => revokeAccess(tx, userId));
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
  opts: { lastAdminGuard?: boolean } = {},
): Promise<boolean> {
  refuseSelfAction(actor, userId);
  const suspended = await deps.db.transaction(async (tx) => {
    // The console's last-admin check locks every admin row first, in id order (and with them the
    // target's, when it is one). `lastAdminGuard`: the same for a system actor — the strikes
    // helper's threshold (R2 auth-2: three strikes never lock out the last admin who can act).
    if (actor.type === "admin" || opts.lastAdminGuard === true) await refuseLastAdmin(tx, userId);
    // The UPDATE takes the user's row lock first (the estate's lock order: user, then the rest).
    if (!(await setSuspended(tx, userId, now(), reason))) return null;
    // Sessions, device proofs and key marks — one function, under the user's row lock.
    const sessions = await revokeAccess(tx, userId);
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
    // Whatever was minted for the account WHILE it was locked (a sign-in that was already past
    // its check when the suspension landed) does not come back to life with the unlock.
    await revokeAccess(tx, userId);
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
      // Sessions, device proofs and key marks — one function, under the user's row lock.
      const sessions = await revokeAccess(tx, userId);
      const paused = await pauseLinks(tx, { ownerId: userId }, "owner_suspended");
      return { sessions, links: paused.length };
    }
    // (As for a lifted suspension: nothing minted during the ban outlives it.)
    await revokeAccess(tx, userId);
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
 *
 * BY AN ADMIN (the console's "Delete user", ruling Q6): the deletion is MARKED as the admin's
 * (`markAdminDeletion`), and the holder can no longer cancel it — only an admin can. A deletion
 * the holder had already asked for becomes the admin's the same way (same date, `changed: false`).
 * The console cannot schedule its own admin's deletion, nor the last admin's (ruling Q4).
 */
export async function scheduleDeletion(
  deps: ServiceDeps,
  userId: string,
  actor: Actor = { userId, type: "user" },
): Promise<ScheduleOutcome> {
  const byAdmin = actor.type === "admin";
  if (byAdmin) refuseSelfAction(actor, userId);
  const account = await getAccount(deps.db, userId);
  if (!account) return { scheduledFor: null, changed: false };

  const scheduledFor = new Date(now().getTime() + DELETION_WINDOW_DAYS * 86_400_000);
  const outcome = await deps.db.transaction(async (tx): Promise<ScheduleOutcome> => {
    if (byAdmin) await refuseLastAdmin(tx, userId);
    // The user's row lock (as `schedule` and `cancel` take it, first): the date read here and the
    // mark written below cannot cross a cancel.
    if (!(await lockUser(tx, userId))) return { scheduledFor: null, changed: false };
    const current = await getAccount(tx, userId);
    if (current?.deleteScheduledAt) {
      if (byAdmin) await markAdminDeletion(tx, userId);
      return { scheduledFor: current.deleteScheduledAt, changed: false };
    }
    // False: a purge of this account has already begun (or the row vanished). Not an error: the
    // account is being deleted, which is what was asked for.
    if (!(await schedule(tx, userId, scheduledFor))) {
      const after = await getAccount(tx, userId);
      return { scheduledFor: after?.deleteScheduledAt ?? null, changed: false };
    }
    // A holder's own request carries no mark — and a stale one (left by a path that ended the
    // schedule without `cancelDeletion`) does not make it the admin's.
    if (byAdmin) await markAdminDeletion(tx, userId);
    else await clearAdminDeletion(tx, userId);
    return { scheduledFor, changed: true };
  });
  if (!outcome.changed) return outcome;
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
 *
 * A deletion an admin scheduled (`scheduleDeletion`) is cancelled by ANOTHER admin only: its
 * subject — an admin's own console included — gets `409 deletion_admin_scheduled` and nothing
 * changes (ruling Q6).
 */
export async function cancelDeletion(
  deps: ServiceDeps,
  userId: string,
  actor: Actor = { userId, type: "user" },
): Promise<boolean> {
  const account = await getAccount(deps.db, userId);
  if (!account) return false;
  const outcome = await deps.db.transaction(async (tx) => {
    // The user's row lock first — `cancel`'s own order — and the mark read under it.
    await lockUser(tx, userId);
    // Not by its subject — also when the subject is an admin using the console.
    const subject = actor.type !== "admin" || actor.userId === userId;
    if (subject && (await adminDeletionMarked(tx, userId))) {
      const current = await getAccount(tx, userId);
      if (current?.deleteScheduledAt) return "admin_scheduled" as const;
    }
    // `cancel` re-checks under the row locks; it is what closes the race with the purge job.
    if (!(await cancel(tx, userId))) return "started" as const;
    await clearAdminDeletion(tx, userId);
    return "cancelled" as const;
  });
  if (outcome === "admin_scheduled") throw new AppError("deletion_admin_scheduled");
  if (outcome === "started") {
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
