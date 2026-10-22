// scripts/verify-gate-b.sh's own checks, in `npm test`: its --self-test (every evaluator — the
// legal-file parsers, the rule listing, the header comparison, the report readers — gives the right
// verdict on made-up passing AND failing input), and --local-only never exits 0 (it is not a gate
// result) and fails, by name, on a plan directory with nothing in it.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = join(__dirname, "../../../../scripts/verify-gate-b.sh");

function run(...args: string[]) {
  const result = spawnSync("bash", [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

describe("verify-gate-b.sh", () => {
  it("--self-test: every evaluator gives the right verdict", () => {
    const { status, out } = run("--self-test");
    expect(out).not.toContain("WRONG");
    expect(out).toContain("verify-gate-b --self-test: OK");
    expect(status).toBe(0);
  }, 60_000);

  it("--local-only on an empty plan directory: every legal check fails by name, never exit 0", () => {
    const plan = mkdtempSync(join(tmpdir(), "gate-b-plan-"));
    try {
      const { status, out } = run("--local-only", "--plan", plan);
      expect(status).toBe(1);
      for (const id of [
        "legal-files",
        "dmca-registered",
        "dmca-procedure",
        "csam-procedure",
        "ncmec-requested",
        "residual-risks",
      ]) {
        expect(out).toMatch(new RegExp(`^FAIL  ${id} `, "m"));
      }
    } finally {
      rmSync(plan, { recursive: true, force: true });
    }
  }, 60_000);
});
