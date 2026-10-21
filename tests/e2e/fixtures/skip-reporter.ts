// A remote run's skips, said out loud (tests/e2e/fixtures/remote.ts). A `@prod-safe` test may skip
// only with a reason (`test.skip(condition, "why")`), and a gate can never be carried by a skip:
//   - every skipped test is printed with its reason at the end of the run;
//   - a skip WITHOUT a reason fails the run;
//   - with HOLDFAST_E2E_FAIL_ON_SKIP=1 (verify-gate-b.sh / verify-gate-c.sh) ANY skip fails it;
//   - a run in which no test passed fails, whatever the flag.
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

export interface Skip {
  title: string;
  reason: string;
}

/** The reason a skipped test gave: the description of its `skip` annotation, or "". */
export function skipReason(
  test: Pick<TestCase, "annotations">,
  result: Pick<TestResult, "annotations">,
): string {
  const annotations = [...(result.annotations ?? []), ...test.annotations];
  const skip = annotations.find((annotation) => annotation.type === "skip" || annotation.type === "fixme");
  return skip?.description?.trim() ?? "";
}

/** What the run's verdict becomes, given its skips. */
export function verdict(
  skips: readonly Skip[],
  failOnSkip: boolean,
  passed: number,
): { failed: boolean; lines: string[] } {
  const lines = skips.map((skip) => `skipped: ${skip.title} — ${skip.reason || "(NO REASON GIVEN)"}`);
  const unexplained = skips.filter((skip) => skip.reason === "");
  if (unexplained.length > 0) lines.push(`${unexplained.length} skip(s) without a reason: the run fails`);
  if (failOnSkip && skips.length > 0)
    lines.push(`HOLDFAST_E2E_FAIL_ON_SKIP=1 and ${skips.length} skip(s): the run fails`);
  // A remote run that passed nothing checked nothing — every test skipped, with reasons or not
  // (review m1). An EMPTY selection is already red (Playwright: "No tests found").
  if (passed === 0) lines.push("no test passed: a remote run that checked nothing fails");
  return {
    failed: unexplained.length > 0 || (failOnSkip && skips.length > 0) || passed === 0,
    lines,
  };
}

export default class SkipReporter implements Reporter {
  private readonly skips: Skip[] = [];
  private passed = 0;

  printsToStdio(): boolean {
    return false;
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === "passed") this.passed += 1;
    if (result.status !== "skipped") return;
    this.skips.push({ title: test.titlePath().slice(1).join(" › "), reason: skipReason(test, result) });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | undefined> {
    const { failed, lines } = verdict(this.skips, process.env.HOLDFAST_E2E_FAIL_ON_SKIP === "1", this.passed);
    console.log(`remote run: ${this.passed} passed, ${this.skips.length} skipped`);
    for (const line of lines) console.log(`remote run: ${line}`);
    return failed && result.status === "passed" ? { status: "failed" } : undefined;
  }
}
