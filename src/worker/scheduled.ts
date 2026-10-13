// Cron entry. Everything a cron expression runs is a job of the registry (jobs/index.ts), whose
// dispatcher is this function's whole body; `index.ts` imports `scheduled` from here and never
// changes. The two expressions other modules name are exported below.
// Local trigger: curl "http://localhost:$HOLDFAST_PORT/cdn-cgi/handler/scheduled?cron=5+0+*+*+*"
// (always pass ?cron= — without it the handler runs with an empty cron, no job matches, and it
// still answers 200).

import { runScheduled } from "./jobs/index";
import type { BackgroundContext } from "./services/request-context";

/** The hourly slot (wrangler.jsonc `triggers.crons`): stale uploads, operator digests. */
export const HOURLY_CRON = "3 * * * *";
/** The once-a-day slot (wrangler.jsonc `triggers.crons`): retention, the verification sweep. */
export const NIGHTLY_CRON = "5 0 * * *";

export async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  await runScheduled(event, env, ctx, bg);
}
