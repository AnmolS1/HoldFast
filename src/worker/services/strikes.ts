// Strikes: one per confirmed violation, counted against the UPLOADER (`nodes.createdBy`) — an
// editor who uploads malware into someone else's folder earns the strike, not the folder's owner.
// At `STRIKES_TO_SUSPEND` unlifted strikes within `STRIKE_WINDOW_DAYS` the account is suspended.
//
// This file suspends nobody itself: it calls `suspendUser` (services/account-state.ts), the only
// implementation of suspension — sessions ended, links paused with `owner_suspended`, one email.
// `suspendUser` is idempotent, so a redelivered queue message cannot apply it twice.
//
// NO HONO CONTEXT. Both functions take a `ServiceDeps`: routes pass `deps(c)`, the queue consumer
// and jobs pass `bg`.
//
// TRANSACTIONS. A side effect must never run before the commit it depends on:
//   addStrike(deps, input)                 inserts in its own transaction; AFTER it commits writes
//                                          the audit row and, at the threshold, suspends.
//   addStrike(deps, input, { tx })         writes ONLY the strike row, in the caller's
//                                          transaction. No audit row, no suspension. The caller
//                                          awaits the returned `applySuspension()` AFTER ITS OWN
//                                          COMMIT; that writes the audit row and, at the
//                                          threshold, suspends.
// The decision to suspend is always taken from a count made after the commit: two strikes that
// land together each see the other's row then, where a count inside either transaction would
// miss it. (It also keeps the user's row lock out of the caller's transaction.)

import { STRIKE_WINDOW_DAYS, STRIKES_TO_SUSPEND } from "../../shared/constants";
import type { Tx } from "../db/client";
import { countActive, insert, lift, type StrikeKind } from "../db/queries/strikes";
import { suspendUser, SYSTEM_ACTOR, type Actor } from "./account-state";
import { audit } from "./audit";
import { AppError } from "./errors";
import type { ServiceDeps } from "./request-context";

export type { StrikeKind };

export type StrikeInput = {
  /** The uploader (`nodes.createdBy`). */
  userId: string;
  kind: StrikeKind;
  reportId?: string;
  nodeId?: string;
  note?: string;
  /** The admin who issued it; absent for the system. */
  issuedBy?: string;
};

export type StrikeResult = {
  strikeId: string;
  /** Unlifted strikes in the window, this one included. */
  activeStrikes: number;
  /** True when the account is suspended as a result. Always false in the `tx` form. */
  suspended: boolean;
  /** The `tx` form only: await it after the caller's commit. Null otherwise. */
  applySuspension: (() => Promise<void>) | null;
};

/** What `user.suspendedReason` says after a suspension for strikes. */
export const STRIKE_SUSPENSION_REASON = "strikes";

const actorOf = (issuedBy: string | undefined): Actor =>
  issuedBy ? { userId: issuedBy, type: "admin" } : SYSTEM_ACTOR;

/** The audit row, then the suspension when the count — read now, after the commit — is at the threshold. */
async function afterCommit(deps: ServiceDeps, input: StrikeInput, strikeId: string) {
  const activeStrikes = await countActive(deps.db, input.userId, STRIKE_WINDOW_DAYS);
  const actor = actorOf(input.issuedBy);
  audit(
    deps,
    "strike.added",
    { type: "user", id: input.userId },
    {
      strikeId,
      kind: input.kind,
      nodeId: input.nodeId ?? null,
      reportId: input.reportId ?? null,
      activeStrikes,
    },
    { actorUserId: actor.userId, actorType: actor.type },
  );
  const suspended = activeStrikes >= STRIKES_TO_SUSPEND;
  if (suspended) await suspendUser(deps, input.userId, STRIKE_SUSPENSION_REASON, actor);
  return { activeStrikes, suspended };
}

export async function addStrike(
  deps: ServiceDeps,
  input: StrikeInput,
  opts: { tx?: Tx } = {},
): Promise<StrikeResult> {
  if (opts.tx) {
    const strikeId = await insert(opts.tx, input);
    // As this transaction sees it; the decision is taken again after the commit.
    const activeStrikes = await countActive(opts.tx, input.userId, STRIKE_WINDOW_DAYS);
    let applied: Promise<unknown> | null = null;
    return {
      strikeId,
      activeStrikes,
      suspended: false,
      // Once, however often it is awaited.
      applySuspension: async () => {
        applied ??= afterCommit(deps, input, strikeId);
        await applied;
      },
    };
  }
  const strikeId = await deps.db.transaction((tx) => insert(tx, input));
  const { activeStrikes, suspended } = await afterCommit(deps, input, strikeId);
  return { strikeId, activeStrikes, suspended, applySuspension: null };
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
