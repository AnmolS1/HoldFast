// Upload sessions nobody will finish.
//
//   `open` past `expiresAt`          → `aborted`: part rows deleted, the reservation given back,
//                                      the multipart upload aborted in the store.
//   `completing` for over an hour    → its request died between the claim and the commit.
//       a node or a kept version references the session's key  → the upload DID commit: `done`.
//       nothing does                                           → `aborted`, as above, and the
//                                                                object a multipart `complete`
//                                                                may have left is deleted.
//
// Rows first, the store second: once the row says `aborted` nobody completes the session, so
// what is then removed from the store is referenced by nothing.
//
// A SINGLE-PUT session (`r2UploadId` null) has no multipart upload, and this job deletes no
// object for it: one its PUT left at the key is an orphan like any other, and the reconcile
// job's orphan sweep removes it under its own guards.

import { keyReference } from "../db/queries/nodes";
import { release } from "../db/queries/quota";
import { lockStaleUpload } from "../db/queries/trash-jobs";
import { expired, markAborted, markDone } from "../db/queries/uploads";
import { lockUser } from "../db/queries/users";
import type { Upload } from "../db/schema";
import { captureError } from "../sentry";
import type { BackgroundContext } from "../services/request-context";
import { storage } from "../services/storage";
import type { Job } from "./index";

export const STALE_UPLOAD_BATCH = 200;
const DEFAULT_SOFT_DEADLINE_MS = 60_000;

type Settled = "aborted" | "done" | "skipped";

/** One session. The row decides under its lock; the list it came from is advice. */
async function settle(bg: BackgroundContext, listed: Upload): Promise<Settled> {
  const ended = await bg.db.transaction(async (tx) => {
    // The owner's row before the session's (lock order), and before the reservation is released.
    await lockUser(tx, listed.ownerId);
    const session = await lockStaleUpload(tx, listed.id);
    if (!session) return null;
    if (session.status === "completing") {
      // The session's own row is a reference of kind `upload`: only a node or a version counts.
      const reference = await keyReference(tx, session.r2Key);
      if (reference && reference.kind !== "upload") {
        return (await markDone(tx, session.id)) ? { session, as: "done" as const } : null;
      }
    }
    if (!(await markAborted(tx, session.id))) return null;
    if (session.purpose === "file") await release(tx, session.ownerId, session.size);
    return { session, as: "aborted" as const };
  });
  if (!ended) return "skipped";
  if (ended.as === "done") return "done";

  const { session } = ended;
  const uploadId = session.r2UploadId;
  if (uploadId === null) return "aborted";
  const store = storage(bg.env);
  await store.abort(store.resumeMultipart(session.r2Key, uploadId));
  // A multipart upload that was being completed may have become an object before its request died.
  if (session.status === "completing") await store.delete([session.r2Key]);
  return "aborted";
}

export const job: Job = {
  name: "stale-uploads",
  cron: "3 * * * *",
  async run(bg, _env, _event, opts) {
    const stopAt = Date.now() + (opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS);
    const seen = new Set<string>();
    for (;;) {
      const sessions = (await expired(bg.db, STALE_UPLOAD_BATCH)).filter((s) => !seen.has(s.id));
      if (sessions.length === 0) return { done: true };
      for (const session of sessions) {
        seen.add(session.id);
        try {
          bg.metric("job", { kind: "stale-uploads", outcome: await settle(bg, session) });
        } catch (error) {
          // One session that cannot be settled must not stop the ones behind it.
          captureError(error, { kind: "job", job: "stale-uploads" });
          bg.metric("job", { kind: "stale-uploads", outcome: "error" });
        }
        if (Date.now() >= stopAt) return { done: false };
      }
    }
  },
};
