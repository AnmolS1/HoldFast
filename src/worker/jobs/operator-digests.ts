// Routine operator alerts that were held back go out as a digest within the hour.

import { countFor, reportError } from "../auth/observe";
import { flushOperatorDigests } from "../services/email";
import type { Job } from "./index";

export const job: Job = {
  name: "operator-digests",
  cron: "3 * * * *",
  async run(bg, env) {
    try {
      await flushOperatorDigests(bg);
    } catch (error) {
      reportError(error, { kind: "operator_digest_flush" });
      countFor(env, "error", { kind: "cron", reason: "operator_digest_flush" });
    }
  },
};
