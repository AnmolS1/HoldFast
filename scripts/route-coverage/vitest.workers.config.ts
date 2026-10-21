// The Workers config with the route-coverage setup file added (./vitest-hits.ts). For a coverage
// run until the orchestrator registers the setup file and the reporter in vitest.workers.config.ts:
//
//   npx vitest run -c scripts/route-coverage/vitest.workers.config.ts \
//     --reporter=default --reporter=./scripts/route-coverage/vitest-reporter.ts
//   HOLDFAST_TABLEWIDE=1 npx vitest run -c scripts/route-coverage/vitest.workers.config.ts …   step 3
import { mergeConfig } from "vitest/config";
import workers from "../../vitest.workers.config";

export default mergeConfig(workers, {
  test: { setupFiles: ["./scripts/route-coverage/vitest-hits.ts"] },
});
