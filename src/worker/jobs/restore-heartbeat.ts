// The restore heartbeat: every hour, first in its slot, it counts the rollback detector's
// generation up — the database by compare-and-set, then the object (reconcile.ts, "the rollback
// detector"). A restore of the database to any point before the last heartbeat then reads as a
// rollback, and every job that destroys stops; the window left is under an hour.
// Cheap: one compare-and-set and one small put, under the generation lock. On a rollback (or a
// reading that failed) it counts nothing — counting would make the restored database look current.

import type { Job } from "./index";
import { advanceGeneration, GENERATION_LOCK, GENERATION_LOCK_HOLD_MS } from "./reconcile";
import { withJobLock } from "../db/queries/trash-jobs";

export const job: Job = {
  name: "restore-heartbeat",
  cron: "3 * * * *",
  guarded: true,
  async run(bg, _env, _event, opts) {
    const locked = await withJobLock(bg.db, GENERATION_LOCK, GENERATION_LOCK_HOLD_MS, async () => {
      // The slot's reading says whether to try; the count reads again, under the lock.
      const slot = opts?.detection;
      const counted =
        slot && slot.state !== "ok" && slot.state !== "first" ? false : await advanceGeneration(bg);
      bg.metric("job", { kind: "restore-heartbeat", outcome: counted ? "counted" : "not_counted" });
    });
    if (!locked.held) bg.metric("job", { kind: "restore-heartbeat", outcome: "overlap" });
  },
};
