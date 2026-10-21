// Route coverage, the Vitest half, in the MAIN process: a reporter that writes the hits the setup
// file ./vitest-hits.ts put on each test's (and each file's) `meta` to
// coverage/routes-hit.<project>.jsonl — one file per Vitest project of the run, emptied at the start.
//
//   npx vitest run -c scripts/route-coverage/vitest.workers.config.ts \
//     --reporter=default --reporter=./scripts/route-coverage/vitest-reporter.ts
//
// A project that ran but recorded nothing still gets its (empty) file: the diff's `--require`
// then says so, instead of not knowing the project existed.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import type { Reporter, TestModule, Vitest } from "vitest/node";
import { COVERAGE_DIR, hitLine, HITS_PREFIX, type Hit } from "./routes";

const fileOf = (project: string) => `${COVERAGE_DIR}/${HITS_PREFIX}${project || "vitest"}.jsonl`;

export default class RouteCoverageReporter implements Reporter {
  onInit(vitest: Vitest): void {
    mkdirSync(COVERAGE_DIR, { recursive: true });
    for (const project of vitest.projects) writeFileSync(fileOf(project.name), "");
  }

  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    for (const module of modules) {
      const hits: Hit[] = [...(module.meta().routeHits ?? [])];
      for (const test of module.children.allTests()) hits.push(...(test.meta().routeHits ?? []));
      for (const suite of module.children.allSuites()) hits.push(...(suite.meta().routeHits ?? []));
      if (hits.length > 0) appendFileSync(fileOf(module.project.name), hits.map(hitLine).join(""));
    }
  }
}
