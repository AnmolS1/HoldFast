// Client (jsdom) and plain-Node tests. Worker tests are in vitest.workers.config.ts: they need the
// Workers runtime, and that plugin does not support custom environments such as jsdom.
//
//   npm test                                   both configs
//   npx vitest run tests/unit/client/<area>    jsdom project
//   npx vitest run tests/unit/db               node project
//
// This file deliberately does not load vite.config.ts: that would start the Cloudflare plugin.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { forbidDotEnvFallback } from "./tests/setup/local-env.ts";

forbidDotEnvFallback();

export default defineConfig({
  // Per checkout, not in the node_modules that worktrees share (see vite.config.ts).
  cacheDir: ".wrangler/vitest",
  plugins: [react()],
  test: {
    coverage: {
      provider: "istanbul",
      include: ["src/client/**", "src/shared/**"],
      reportsDirectory: "coverage/unit",
    },
    projects: [
      {
        extends: true,
        test: {
          name: "jsdom",
          environment: "jsdom",
          include: ["tests/unit/client/**/*.test.{ts,tsx}", "tests/unit/harness/client/**/*.test.{ts,tsx}"],
          setupFiles: ["tests/setup/jsdom.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "tests/unit/db/**/*.test.ts",
            "tests/unit/harness/node/**/*.test.ts",
            "tests/unit/e2e-harness/**/*.test.ts",
          ],
        },
      },
    ],
  },
});
