// Strikes: one per confirmed violation, counted against the UPLOADER (`nodes.createdBy`) — an
// editor who uploads malware into someone else's folder earns the strike, not the folder's owner.
//
// THE INVARIANT: an account with `STRIKES_TO_SUSPEND` or more unlifted strikes within
// `STRIKE_WINDOW_DAYS` is suspended. Nothing here may leave a committed strike without that being
// true — and because a process can die between a commit and what follows it, the invariant can be
// re-established at any time: `enforceStrikeThreshold` for one user (a redelivered queue message
// calls it), `sweepStrikeThresholds` for everyone (a scheduled job calls it).
//
// This file suspends nobody itself: it calls `suspendUser` (services/account-state.ts), the only
// implementation of suspension — sessions ended, links paused with `owner_suspended`, one email.
// `suspendUser` is idempotent, so enforcing twice applies it once.
//
// ONE STRIKE PER VIOLATION. The same file, or the same content uploaded again as a new file,
// never strikes the same user twice for the same kind (db/queries/strikes.ts): three deliveries
// of one infected file are one strike, and so are three attempts to upload it. `addStrike` then
// returns the existing strike with `created: false` and writes no second audit row — but still
// enforces the threshold, which is what repairs a delivery that died after its commit.
// A strike with neither a node nor a hash (issued by a person against the account) is never
// de-duplicated. A strike older than the window has EXPIRED: it no longer counts, so it does not
// de-duplicate either — the new violation lifts it and is a strike of its own.
//
// NO HONO CONTEXT. Everything takes a `ServiceDeps`: routes pass `deps(c)`, the queue consumer
// and jobs pass `bg`.
//
// TRANSACTIONS. A side effect must never run before the commit it depends on:
//   addStrike(deps, input)                 writes the strike; then the audit row and, at the
//                                          threshold, the suspension.
//   addStrike(deps, input, { tx })         writes ONLY the strike row, in the caller's
//                                          transaction. No audit row, no suspension. The caller
//                                          awaits the returned `applySuspension()` AFTER ITS OWN
//                                          COMMIT; that writes the audit row and enforces the
//                                          threshold.
// The decision to suspend is always taken from a count made after the commit: two strikes that
// land together each see the other's row then, where a count inside either transaction would
// miss it. (It also keeps the user's row lock out of the caller's transaction.)
// A failing suspension is never swallowed: the caller sees the error, and its retry or the sweep
// repairs it.

import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../shared/constants";
import type { Tx } from "../db/client";
import {
  countActive,
  insert,
  lift,
  type StrikeKind,
  type ThresholdCursor,
  usersAtThreshold,
} from "../db/queries/strikes";
import { captureError } from "../sentry";
import { suspendUser, SYSTEM_ACTOR, type Actor } from "./account-state";
import { audit } from "./audit";
import { AppError } from "./errors";
import { metric } from "./metrics";
import type { ServiceDeps } from "./request-context";

export type { StrikeKind };

export type StrikeInput = {
  /** The uploader (`nodes.createdBy`). */
  userId: string;
  kind: StrikeKind;
  reportId?: string;
  nodeId?: string;
  /** SHA-256 of the content, when the caller knows it: the same content never strikes twice. */
  sha256?: string;
  note?: string;
  /** The admin who issued it; absent for the system. */
  issuedBy?: string;
};

export type StrikeResult = {
  strikeId: string;
  /** False when an unlifted strike for the same node or content already existed: that one is returned. */
  created: boolean;
  /** Unlifted strikes in the window, this one included. */
  activeStrikes: number;
  /** True when the account is suspended as a result. Always false in the `tx` form. */
  suspended: boolean;
  /** The `tx` form only: await it after the caller's commit. Null otherwise. */
  applySuspension: (() => Promise<void>) | null;
};

/** What `user.suspendedReason` says after a suspension for strikes. */
export const STRIKE_SUSPENSION_REASON = "strikes";
/** Users one sweep suspends at most, unless told otherwise. */
export const SWEEP_DEFAULT_LIMIT = 100;
/** One sweep looks at no more than this many users per user it may suspend. */
export const SWEEP_MAX_EXAMINED_FACTOR = 20;

const actorOf = (issuedBy: string | undefined): Actor =>
  issuedBy ? { userId: issuedBy, type: "admin" } : SYSTEM_ACTOR;

async function enforce(deps: ServiceDeps, userId: string, actor: Actor, counted?: number) {
  const activeStrikes = counted ?? (await countActive(deps.db, userId, STRIKE_WINDOW_DAYS));
  const suspended = activeStrikes >= STRIKES_TO_SUSPEND;
  if (suspended) await suspendUser(deps, userId, STRIKE_SUSPENSION_REASON, actor);
  return { activeStrikes, suspended };
}

/**
 * Re-establishes the invariant for one user: counts the unlifted strikes in the window and, at
 * the threshold, suspends (a no-op for an account that already is). Safe to call at any time and
 * any number of times. `suspended` says whether the user is at the threshold.
 */
export async function enforceStrikeThreshold(
  deps: ServiceDeps,
  userId: string,
): Promise<{ activeStrikes: number; suspended: boolean }> {
  return enforce(deps, userId, SYSTEM_ACTOR);
}

/**
 * Re-establishes the invariant for everyone: walks the users at the threshold whose account is
 * not suspended, oldest first, and enforces each, until `limit` of them have been suspended.
 *
 * IT CANNOT STARVE ON USERS IT CANNOT CHANGE. A user whose suspension fails is reported, counted
 * in `failed` and PASSED: the walk goes on behind them in the same run (a keyset cursor), and
 * they do not use up the budget — `limit` counts suspensions, not attempts. So a failing user at
 * the head of the list never keeps the sweep from the users behind. What bounds one run instead
 * is `SWEEP_MAX_EXAMINED_FACTOR × limit` users looked at; only that many users failing in a row
 * could hold up whoever is behind them, and each of those failures is reported.
 * (No account state makes suspension a no-op for a user this walk finds: see `usersAtThreshold`.)
 */
export async function sweepStrikeThresholds(
  deps: ServiceDeps,
  opts: { limit?: number } = {},
): Promise<{ checked: number; suspended: number; failed: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? SWEEP_DEFAULT_LIMIT, 1_000));
  const maxExamined = limit * SWEEP_MAX_EXAMINED_FACTOR;
  let cursor: ThresholdCursor | undefined;
  let checked = 0;
  let suspended = 0;
  let failed = 0;
  while (suspended < limit && checked < maxExamined) {
    const want = Math.min(limit - suspended, maxExamined - checked);
    const page = await usersAtThreshold(deps.db, STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND, want, cursor);
    if (page.length === 0) break;
    for (const found of page) {
      checked += 1;
      try {
        if ((await enforce(deps, found.userId, SYSTEM_ACTOR)).suspended) suspended += 1;
      } catch (error) {
        failed += 1;
        captureError(error, { kind: "strike_sweep" });
        metric("error", { kind: "strike_sweep" });
      }
    }
    cursor = page.at(-1);
  }
  return { checked, suspended, failed };
}

/**
 * After the commit: the audit row of a NEW strike — once, also when this is run again after a
 * failed suspension (`strike.audited`) — then the threshold.
 */
async function afterCommit(
  deps: ServiceDeps,
  input: StrikeInput,
  strike: { id: string; created: boolean; audited?: boolean },
) {
  const activeStrikes = await countActive(deps.db, input.userId, STRIKE_WINDOW_DAYS);
  const actor = actorOf(input.issuedBy);
  if (strike.created && !strike.audited) {
    strike.audited = true;
    audit(
      deps,
      "strike.added",
      { type: "user", id: input.userId },
      {
        strikeId: strike.id,
        kind: input.kind,
        nodeId: input.nodeId ?? null,
        reportId: input.reportId ?? null,
        activeStrikes,
      },
      { actorUserId: actor.userId, actorType: actor.type },
    );
  }
  // Not caught: a strike whose suspension failed must be seen to have failed.
  return enforce(deps, input.userId, actor, activeStrikes);
}

export async function addStrike(
  deps: ServiceDeps,
  input: StrikeInput,
  opts: { tx?: Tx } = {},
): Promise<StrikeResult> {
  if (opts.tx) {
    const strike = await insert(opts.tx, input, STRIKE_WINDOW_DAYS);
    // As this transaction sees it; the decision is taken again after the commit.
    const activeStrikes = await countActive(opts.tx, input.userId, STRIKE_WINDOW_DAYS);
    let applied: Promise<unknown> | null = null;
    return {
      strikeId: strike.id,
      created: strike.created,
      activeStrikes,
      suspended: false,
      // Once per success, however often it is awaited; a failed attempt can be made again.
      applySuspension: async () => {
        applied ??= afterCommit(deps, input, strike);
        try {
          await applied;
        } catch (error) {
          applied = null;
          throw error;
        }
      },
    };
  }
  // No transaction of its own: a new strike is one statement. When it meets an EXPIRED strike for
  // the same file or content it lifts that one first, and a lift that outlives a failed insert
  // only lifts a strike that had stopped counting anyway.
  const strike = await insert(deps.db, input, STRIKE_WINDOW_DAYS);
  const { activeStrikes, suspended } = await afterCommit(deps, input, strike);
  return { strikeId: strike.id, created: strike.created, activeStrikes, suspended, applySuspension: null };
}

/**
 * Lifts one strike. `404 not_found` when there is no such strike or it is already lifted.
 * It does not lift a suspension: that is `unsuspendUser`, a separate decision.
 */
export async function liftStrike(
  deps: ServiceDeps,
  strikeId: string,
  by: string,
): Promise<{ activeStrikes: number }> {
  const lifted = await lift(deps.db, strikeId, by);
  if (!lifted) throw new AppError("not_found");
  const activeStrikes = await countActive(deps.db, lifted.userId, STRIKE_WINDOW_DAYS);
  audit(
    deps,
    "strike.lifted",
    { type: "user", id: lifted.userId },
    { strikeId, activeStrikes },
    { actorUserId: by, actorType: "admin" },
  );
  return { activeStrikes };
}
