// Every record with a period is deleted once it is past it — so every IP-derived field has one.
//
//   download_ledger          90 days        link_password_attempts   idle for 24 hours
//   link_access_log         180 days        email_ledger             48 hours
//   audit_log               180 days        finished upload sessions 7 days
//   upload_ips               90 days
//
// NOTHING THAT CONCERNS A HELD ACCOUNT OR A PROTECTED NODE IS DELETED. What that means is one
// definition (queries/holds.ts), applied inside each deleting statement: this job never deletes
// by ids it listed earlier — a list goes stale, and a hold placed in between would be missed.
// `upload-ips.expired()` in particular is for reporting; the delete is `deleteExpired`.
// Mail-cap windows and ledger rows keyed by an IP hash, a sign-up counter or a marker cannot be
// tied to an account, and go with their age. A hold lifted later makes its rows eligible again
// at the next run: there is no backlog flag, the age test simply applies.
//
// No DMCA notice is closed here (auto-close is off in v1), no session row is trimmed, and no
// hold is set or released: nothing in jobs/ writes a hold flag.

import type { Executor } from "../db/client";
import {
  deleteIdlePasswordAttempts,
  deleteOldAudit,
  deleteOldEmailWindows,
  deleteOldLedger,
  deleteOldLinkAccess,
} from "../db/queries/trash-jobs";
import { deleteExpired, UPLOAD_IP_RETENTION_DAYS } from "../db/queries/upload-ips";
import { trimFinished } from "../db/queries/uploads";
import { captureError } from "../sentry";
import type { Job } from "./index";

/** Rows per statement. */
export const RETENTION_BATCH = 5_000;
export const FINISHED_UPLOAD_RETENTION_DAYS = 7;
const DEFAULT_SOFT_DEADLINE_MS = 60_000;

/** Each deletes at most `limit` rows that are past their period and kept by nothing. */
export const RETENTION_STEPS: ReadonlyArray<{
  table: string;
  delete: (db: Executor, limit: number) => Promise<number>;
}> = [
  { table: "download_ledger", delete: (db, limit) => deleteOldLedger(db, limit) },
  { table: "link_access_log", delete: (db, limit) => deleteOldLinkAccess(db, limit) },
  { table: "audit_log", delete: (db, limit) => deleteOldAudit(db, limit) },
  { table: "upload_ips", delete: (db, limit) => deleteExpired(db, limit, UPLOAD_IP_RETENTION_DAYS) },
  { table: "link_password_attempts", delete: (db, limit) => deleteIdlePasswordAttempts(db, limit) },
  { table: "email_ledger", delete: (db, limit) => deleteOldEmailWindows(db, limit) },
  { table: "uploads", delete: (db, limit) => trimFinished(db, FINISHED_UPLOAD_RETENTION_DAYS, limit) },
];

export const job: Job = {
  name: "retention",
  cron: "5 0 * * *",
  async run(bg, _env, _event, opts) {
    const stopAt = Date.now() + (opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS);
    let done = true;
    for (const step of RETENTION_STEPS) {
      if (Date.now() >= stopAt) return { done: false };
      let deleted = 0;
      try {
        for (;;) {
          const batch = await step.delete(bg.db, RETENTION_BATCH);
          deleted += batch;
          if (batch < RETENTION_BATCH) break;
          if (Date.now() >= stopAt) {
            done = false;
            break;
          }
        }
        bg.metric("job", { kind: "retention", outcome: "deleted", reason: step.table }, deleted);
      } catch (error) {
        // One table's failure must not keep the others past their period.
        captureError(error, { kind: "job", job: "retention" });
        bg.metric("job", { kind: "retention", outcome: "error", reason: step.table });
      }
    }
    return { done };
  },
};
