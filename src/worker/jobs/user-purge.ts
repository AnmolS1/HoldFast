// The hard delete of an account whose deletion date has passed (queries/user-purge.ts keeps the
// lifecycle; T06 schedules and cancels — this job never creates a pending row).
//
// A user on legal hold is never listed as due: no error, no mail, the request stays "scheduled".
//
// THE LIST IS ADVICE. Between the moment `due` listed an account and the moment something of it
// is deleted, its owner may have cancelled and a hold may have been placed. So every decision is
// re-made where the writers of those facts also lock:
//   - the START is claimed under the `user` row's lock (`claimAccountPurge`): cancelled, held or
//     not due → nothing happens. Once claimed, a cancel is refused.
//   - every ROOT goes through `purgeRoot`, whose gate reads the owner's hold and every hold in
//     the subtree under the tree lock and the owner's row lock: a hold placed mid-run stops the
//     roots that are left.
//   - the ACCOUNT ROW goes in a transaction that first locks it and re-reads the hold.
//
// Per account, every step safe to repeat (a run that died, or a second run beside it, resumes
// from the top):
//   1. claim (above).
//   2. its upload sessions go (owner OR uploader) — except one a hold protects: a session in a
//      HELD owner's folder, or a held uploader's in this account's, stays as a record.
//   3. every root it owns is purged through `purgeRoot`, avatars included. A held root (an open
//      report or notice) stays, whole.
//   4. something is left — a held root, or a kept session that still names the account — →
//      DEFER seven days: the account row and its sign-in rows stay, nothing is disclosed, and the
//      job does not fail every night. What was purged stays purged.
//   5. nothing is left → the sign-in rows and the `user` row go, with the audit row, in ONE
//      transaction: no account is deleted without its record. What the account created inside
//      other owners' trees stays there, its author anonymised by the foreign key.
//   6. only then, rows first: whatever is left under the account's avatar prefix in the store.

import { pgError } from "../db/errors";
import { accountHeld, claimAccountPurge, lockAccountForDelete } from "../db/queries/trash-jobs";
import { ownedRoots } from "../db/queries/tree";
import { deleteForUser, remainingForUser } from "../db/queries/uploads";
import { defer, due, markFailed, markFinished } from "../db/queries/user-purge";
import { captureError } from "../sentry";
import { purgeAuthRows } from "../services/account-state";
import { auditInTx } from "../services/audit";
import type { BackgroundContext } from "../services/request-context";
import { AVATAR_PREFIX, storage } from "../services/storage";
import type { Job } from "./index";
import { mayDestroy, readPauseSwitch } from "./reconcile";
import { purgeRoot } from "./purge";

/** Accounts taken from the queue at once. */
export const USER_PURGE_BATCH = 20;
/** How far a purge that must wait for a hold is pushed out. */
export const USER_PURGE_DEFER_DAYS = 7;
const DEFAULT_SOFT_DEADLINE_MS = 120_000;

/**
 * `purged` — the account is gone; `deferred` — something a hold protects is left, seven days;
 * `held` — the account itself is on hold: left as it is, silently; `skipped` — nothing to do
 * (cancelled, finished by another run, not due); `retry` — a root Postgres would not let go.
 */
export type AccountPurge = "purged" | "deferred" | "held" | "skipped" | "retry";

/** One account. Throws on a failure the next run should retry (the caller records it). */
export async function purgeAccount(bg: BackgroundContext, userId: string): Promise<AccountPurge> {
  const claim = await bg.db.transaction((tx) => claimAccountPurge(tx, userId));
  if (claim === "held") return "held";
  if (claim !== "claimed") return "skipped";
  const store = storage(bg.env);

  for (const upload of await deleteForUser(bg.db, userId)) {
    // A single-PUT session has no multipart upload: nothing to abort, and no object is deleted
    // for it here (an object at its key is the orphan sweep's).
    const uploadId = upload.r2UploadId;
    if (uploadId === null) continue;
    try {
      await store.abort(store.resumeMultipart(upload.r2Key, uploadId));
    } catch (error) {
      // The session row is gone either way; the store expires what was never completed.
      captureError(error, { kind: "purge_objects" });
    }
  }

  let roots = 0;
  let bytes = 0;
  let held = false;
  let unfinished = false;
  for (const root of await ownedRoots(bg.db, userId, { includeSystem: true })) {
    const result = await purgeRoot(bg, root.id, "account");
    if (result.outcome === "held") held = true;
    if (result.outcome === "retry") unfinished = true;
    if (result.outcome === "purged") {
      roots += 1;
      bytes += result.freedBytes;
    }
  }

  // A root Postgres would not let go this time: the row stays due, and the next run retries.
  if (unfinished) return "retry";
  if (held || (await remainingForUser(bg.db, userId)) > 0) {
    // A hold on the ACCOUNT, placed since the claim, is what refused the roots: such an account
    // is not deferred — it is simply not due while it is held.
    if (await accountHeld(bg.db, userId)) return "held";
    await defer(bg.db, userId, USER_PURGE_DEFER_DAYS);
    return "deferred";
  }

  const ended = await bg.db.transaction(async (tx) => {
    // The row's lock first, and the hold read under it: a hold placed in this instant either is
    // seen here or waits for this delete to be over.
    const state = await lockAccountForDelete(tx, userId);
    if (state !== "ok") return state;
    await purgeAuthRows(tx, userId);
    await markFinished(tx, userId);
    // Counts only: nothing here says who the account was.
    await auditInTx(tx, bg, "system.user_purge", { type: "user", id: userId }, { roots, bytes });
    return "purged" as const;
  });
  if (ended === "held") return "held";
  if (ended === "gone") return "skipped";

  // Rows first, objects second: the avatar nodes went with their objects above; what is left
  // under the prefix is referenced by nothing. A failure here leaves it to the orphan sweep.
  try {
    await store.deletePrefix(`${AVATAR_PREFIX}${userId}/`);
  } catch (error) {
    captureError(error, { kind: "purge_objects" });
  }
  return "purged";
}

/** What may be stored about a failure: its kind, never its text (which can quote a row). */
function failureNote(error: unknown): string {
  const pg = pgError(error);
  if (pg) return `postgres ${pg.code}${pg.constraint ? ` ${pg.constraint}` : ""}`;
  return error instanceof Error ? error.name : "error";
}

export const job: Job = {
  name: "user-purge",
  cron: "0 2 * * *",
  guarded: true,
  async run(bg, _env, _event, opts) {
    // A database that has gone back in time destroys nothing (reconcile.ts, the detector).
    if (!(await mayDestroy(bg, opts?.detection, "user-purge"))) return { done: false };
    const stopAt = Date.now() + (opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS);
    // A row that failed or must be retried stays due: it is not taken twice in one run.
    const seen = new Set<string>();
    for (;;) {
      const rows = (await due(bg.db, USER_PURGE_BATCH)).filter((row) => !seen.has(row.userId));
      if (rows.length === 0) return { done: true };
      for (const row of rows) {
        // The slot read the detector ONCE, minutes ago perhaps: the operator's pause switch is
        // read again before every account (R1 func-n3), and on — or unreadable — stops the run.
        // What is left stays due, untouched, for the next run that may destroy.
        if ((await readPauseSwitch(bg.env)) !== "off") {
          bg.metric("job", { kind: "user-purge", outcome: "paused_stopped" });
          return { done: false };
        }
        seen.add(row.userId);
        try {
          bg.metric("job", { kind: "user-purge", outcome: await purgeAccount(bg, row.userId) });
        } catch (error) {
          captureError(error, { kind: "job", job: "user-purge" });
          bg.metric("job", { kind: "user-purge", outcome: "error" });
          await markFailed(bg.db, row.userId, failureNote(error));
        }
        if (Date.now() >= stopAt) return { done: false };
      }
    }
  },
};
