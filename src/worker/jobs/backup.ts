// Placeholder: a no-op in its slot. T27 replaces this file's body at the same path (the nightly export);
// the registry (jobs/index.ts) already imports and orders it. Keep the name and the cron.

import type { Job } from "./index";

export const job: Job = {
  name: "backup",
  cron: "0 2 * * *",
  async run() {},
};
