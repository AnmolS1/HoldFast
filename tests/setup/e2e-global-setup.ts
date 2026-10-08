// Playwright globalSetup: recreate this checkout's local database (HOLDFAST_DB) and apply the
// migrations. A fresh checkout has no schema, and a missing schema surfaces as a 500 that looks
// like a missing env var. Runs after Playwright has started its dev server, which is fine: the
// Worker opens its database connection per request.
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localDbName } from "./local-env";

export default function globalSetup(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  execFileSync(resolve(root, "scripts/db-reset.sh"), {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, HOLDFAST_DB: localDbName() },
  });
}
