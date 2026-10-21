// Fails when a route of coverage/routes.json has no hit in any coverage/routes-hit.*.jsonl.
//
//   npx tsx scripts/route-coverage/dump-routes.ts && npx tsx scripts/route-coverage/diff.ts
//   npx tsx scripts/route-coverage/diff.ts --require e2e,workers     also fail when a source is missing
//
// It prints every hit file it read (lines, age), so a run that collected nothing — or a stale file
// of an earlier run — is visible. No hit file at all is a failure, never "nothing uncovered".
import { readFileSync } from "node:fs";
import { diffReport, readHitFiles, ROUTES_FILE, type Route } from "./routes";

function requiredSources(argv: readonly string[]): string[] {
  const index = argv.indexOf("--require");
  if (index === -1) return [];
  const list = argv[index + 1];
  if (!list) throw new Error("--require needs a comma-separated list of sources (e2e, workers, …)");
  return list.split(",").filter(Boolean);
}

const routes = JSON.parse(readFileSync(ROUTES_FILE, "utf8")) as Route[];
const report = diffReport(routes, readHitFiles(), requiredSources(process.argv.slice(2)));
for (const line of report.lines) console.log(`route-coverage: ${line}`);
for (const problem of report.problems) console.error(`route-coverage: ${problem}`);
if (report.problems.length > 0) process.exit(1);
