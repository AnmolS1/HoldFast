// Cron entry. A no-op until the jobs registry exists; this one file is then pointed at its
// dispatcher, which must accept the same four arguments. `index.ts` never changes.
// Local trigger: curl "http://localhost:$HOLDFAST_PORT/cdn-cgi/handler/scheduled?cron=3+*+*+*+*"
// (always pass ?cron= — without it the handler runs with an empty cron and still answers 200).

import type { BackgroundContext } from "./services/request-context";

export async function scheduled(
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  void event;
  void env;
  void ctx;
  void bg;
}
