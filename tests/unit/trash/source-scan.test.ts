// Two rules about this task's own sources, checked on the files themselves.
import { describe, expect, it } from "vitest";

const jobSources = import.meta.glob("/src/worker/jobs/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});
const queriesSource = Object.values(
  import.meta.glob("/src/worker/db/queries/trash-jobs.ts", { query: "?raw", import: "default", eager: true }),
)[0]!;
const tests = import.meta.glob("/tests/unit/**/*.test.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

// Without whole-line `//` comments (a comment may name what the code must not do). Block
// comments are NOT stripped: the slash-star in a glob and the star-slash in a cron expression,
// both inside strings, would be read as the two ends of one.
const code = (source: string) => source.replace(/^\s*\/\/.*$/gm, "");

describe("the jobs' sources", () => {
  it("no job sets or releases a legal hold: no file under jobs/ names a hold column or its setters", () => {
    const names = Object.keys(jobSources).map((path) => path.split("/").pop());
    expect(names).toEqual(
      expect.arrayContaining(["index.ts", "purge.ts", "retention.ts", "user-purge.ts", "reconcile.ts"]),
    );
    expect(names.length).toBeGreaterThanOrEqual(11);
    // Not even in a comment: the word has no business in these files.
    const HOLD = /legalHold|legal_hold|LegalHold\(/;
    for (const [path, source] of Object.entries(jobSources)) expect(source, path).not.toMatch(HOLD);
    // Control: the scan does see such a line when there is one.
    expect("await tx.update(user).set({ legalHold: false });").toMatch(HOLD);
    expect("await setUserLegalHold(db, id, false);").toMatch(HOLD);
  });

  it("nor does the jobs' query module: it reads hold columns and writes none", () => {
    // All of the jobs' SQL is in queries/trash-jobs.ts. It READS `user.legalHold` (to leave a
    // held account alone), so the word may appear — never in a write.
    const WRITES_HOLD = new RegExp(
      [
        String.raw`\.set\(\s*\{[^}]*\blegalHold\b`, // drizzle: .set({ … legalHold … })
        String.raw`\.values\(\s*\{[^}]*\blegalHold\b`, // drizzle: .values({ … legalHold … })
        String.raw`\bSET\b[^;\x60]*\blegal_hold\s*=`, // raw SQL: UPDATE … SET … legal_hold =
        String.raw`\bset(Node|User)LegalHold\b|\breleaseForNode\b`, // T05's setters
      ].join("|"),
      "s",
    );
    expect(queriesSource).toMatch(/legalHold/);
    expect(code(queriesSource)).not.toMatch(WRITES_HOLD);
    // Controls: each form of a write is seen.
    for (const write of [
      "await tx.update(user).set({ legalHold: false }).where(eq(user.id, id));",
      "await tx.update(uploadIps)\n  .set({\n    at: now,\n    legalHold: true,\n  })",
      "await tx.insert(uploadIps).values({ nodeId, legalHold: true });",
      "await tx.execute(sql`UPDATE nodes SET updated_at = now(), legal_hold = false WHERE id = ${id}`);",
      "await setUserLegalHold(tx, id, false);",
      "await releaseForNode(tx, nodeId);",
    ]) {
      expect(write, write).toMatch(WRITES_HOLD);
    }
    // …and a read is not taken for one.
    expect(".select({ deleteScheduledAt: user.deleteScheduledAt, legalHold: user.legalHold })").not.toMatch(
      WRITES_HOLD,
    );
    expect("return subject.legalHold ? 'held' : 'ok';").not.toMatch(WRITES_HOLD);
  });

  it("no retention delete acts on a list of ids: the job never calls upload-ips' expired()", () => {
    const retention = code(jobSources["/src/worker/jobs/retention.ts"]!);
    expect(retention).toMatch(/deleteExpired\(/);
    expect(retention).not.toMatch(/\bexpired\(/);
  });
});

describe("the other test files", () => {
  const LISTENED = ["17 */6 * * *", "3 * * * *", "5 0 * * *", "0 2 * * *"];
  // The cron entry and the dispatcher, imported by name from their modules.
  const IMPORTS_ENTRY =
    /import\s*(?:type\s*)?\{[^}]*\b(?:scheduled|runScheduled)\b[^}]*\}\s*from\s*"[^"]*(?:worker\/scheduled|worker\/jobs\/index|worker\/jobs)"/;
  // The Worker's own export, called with a controller built just above the call.
  const CALLS_EXPORT = /worker\.scheduled\?*\.?\(/g;
  const namesSlot = (text: string) =>
    LISTENED.some((cron) => text.includes(`"${cron}"`)) || /\b(?:HOURLY_CRON|NIGHTLY_CRON)\b/.test(text);

  /** Why a test file would run a slot's jobs, or null. */
  function offence(source: string): string | null {
    const text = code(source);
    if (IMPORTS_ENTRY.test(text)) return "imports the cron entry";
    for (const call of text.matchAll(CALLS_EXPORT)) {
      if (namesSlot(text.slice(Math.max(0, call.index - 300), call.index + 200))) {
        return "calls the Worker's scheduled export with a listened expression";
      }
    }
    return null;
  }

  it("only a table-wide file calls scheduled() or runScheduled with an expression a job listens to", () => {
    expect(Object.keys(tests).length).toBeGreaterThan(100);
    const offenders = Object.entries(tests)
      // (This file holds the forbidden forms as the control strings below.)
      .filter(([path]) => !path.includes(".tablewide.test.") && !path.endsWith("/trash/source-scan.test.ts"))
      .flatMap(([path, source]) => {
        const why = offence(source);
        return why ? [`${path}: ${why}`] : [];
      });
    expect(offenders).toEqual([]);

    // Controls: the scan sees each form it is looking for, and not the two it must allow.
    expect(offence('import { NIGHTLY_CRON, scheduled } from "../../../src/worker/scheduled";')).toMatch(
      /imports/,
    );
    expect(offence('import { runScheduled } from "../../../src/worker/jobs/index";')).toMatch(/imports/);
    expect(
      offence(
        'const c = createScheduledController({ cron: "3 * * * *" });\nawait worker.scheduled?.(c, env, ctx);',
      ),
    ).toMatch(/listened/);
    expect(offence('import { NIGHTLY_CRON } from "../../../src/worker/scheduled";')).toBeNull();
    expect(
      offence(
        'const c = createScheduledController({ cron: "59 23 31 12 *" });\nawait worker.scheduled?.(c, env, ctx);',
      ),
    ).toBeNull();
  });
});
