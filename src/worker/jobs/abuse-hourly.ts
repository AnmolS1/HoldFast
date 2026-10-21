// Placeholder: a no-op in its slot. T22 replaces this file's body at the same path (the hourly abuse checks);
// the registry (jobs/index.ts) already imports and orders it. Keep the name and the cron.

import type { Job } from "./index";

export const job: Job = {
  name: "abuse-hourly",
  cron: "3 * * * *",
  async run() {},
};
