// The storage quota as the upload routes use it: reserve at init, then commit (the upload became
// a node) or release (it was abandoned). The arithmetic and its rules are db/queries/quota.ts —
// trash and kept old versions count until they are purged, avatars never do.
//
// Each call takes the owner's `user` row: make it the first write of the caller's transaction
// (after `enforceUploadCeilings`, which takes the same rows in the one safe order).

import type { Executor } from "../db/client";
import * as quota from "../db/queries/quota";
import { AppError } from "./errors";
import { metric } from "./metrics";

/** What an editor is told when the tree they upload into is full: it is not their own storage. */
export const OWNER_FULL_MESSAGE = "The owner's storage is full.";

/** Reserves `bytes` on the owner, or throws `413 quota_exceeded`. */
export async function reserve(
  tx: Executor,
  ownerId: string,
  bytes: number,
  opts: { forEditor: boolean },
): Promise<void> {
  if (await quota.reserve(tx, ownerId, bytes)) return;
  // Refused past the kept-bytes backstop (db/queries/quota.ts): the answer is a full account's, nothing
  // else; the operator learns it from the metric (T23 brief Addendum 4).
  if (await quota.keptBackstopReached(tx, ownerId)) metric("upload", { outcome: "hold_backstop" });
  throw new AppError("quota_exceeded", opts.forEditor ? OWNER_FULL_MESSAGE : undefined);
}

/** The reservation becomes the node: the bytes keep counting through its row. */
export const commit = quota.commit;

/** Gives a reservation back. */
export const release = quota.release;
