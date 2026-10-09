// Cron entry. Until the jobs registry exists this file runs the one job the auth layer owns; it is
// then pointed at the registry's dispatcher, which must accept the same four arguments and take
// these jobs over (`sweepExpiredVerifications`, nightly; `flushOperatorDigests`, hourly). `index.ts` never changes.
// Local trigger: curl "http://localhost:$HOLDFAST_PORT/cdn-cgi/handler/scheduled?cron=5+0+*+*+*"
// (always pass ?cron= — without it the handler runs with an empty cron and still answers 200).

import { countFor, reportError } from "./auth/observe";
import { sweepExpiredVerifications } from "./db/queries/auth-lifecycle";
import { flushOperatorDigests } from "./services/email";
import type { BackgroundContext } from "./services/request-context";

/** The hourly slot (wrangler.jsonc `triggers.crons`): `flushOperatorDigests` (services/email.ts). */
export const HOURLY_CRON = "3 * * * *";
/** The once-a-day slot (wrangler.jsonc `triggers.crons`). */
export const NIGHTLY_CRON = "5 0 * * *";

export async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  void ctx;
  if (event.cron === HOURLY_CRON) {
    // Routine operator alerts that were held back go out as a digest within the hour.
    try {
      await flushOperatorDigests(bg);
    } catch (error) {
      reportError(error, { kind: "operator_digest_flush" });
      countFor(env, "error", { kind: "cron", reason: "operator_digest_flush" });
    }
    return;
  }
  if (event.cron !== NIGHTLY_CRON) return;
  try {
    // Bounded: a few batches a night are more than a day's rows; a backlog drains over nights.
    for (let batch = 0; batch < 4; batch++) {
      if ((await sweepExpiredVerifications(bg.db)) < 5000) break;
    }
  } catch (error) {
    reportError(error, { kind: "verification_sweep" });
    countFor(env, "error", { kind: "cron", reason: "verification_sweep" });
  }
}
