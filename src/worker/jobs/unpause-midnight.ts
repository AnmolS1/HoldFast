// Placeholder: a no-op in its slot. T22 replaces this file's body at the same path (the midnight lift of ceiling pauses);
// the registry (jobs/index.ts) already imports and orders it. Keep the name and the cron.

import type { Job } from "./index";

export const job: Job = {
  name: "unpause-midnight",
  cron: "5 0 * * *",
  async run() {},
};
