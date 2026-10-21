// Expired `verification` rows: created by requests nobody has authenticated, removed by the auth
// library only when used. Of the context this job uses the database and nothing else.

import { countFor, reportError } from "../auth/observe";
import { sweepExpiredVerifications } from "../db/queries/auth-lifecycle";
import type { Job } from "./index";

export const job: Job = {
  name: "verification-sweep",
  cron: "5 0 * * *",
  async run(bg, env) {
    try {
      // Bounded: a few batches a night are more than a day's rows; a backlog drains over nights.
      for (let batch = 0; batch < 4; batch++) {
        if ((await sweepExpiredVerifications(bg.db)) < 5000) break;
      }
    } catch (error) {
      reportError(error, { kind: "verification_sweep" });
      countFor(env, "error", { kind: "cron", reason: "verification_sweep" });
    }
  },
};
