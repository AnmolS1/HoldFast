// R1 a11y-3 follow-up (team-lead): the explorer reaches the uploader's scan verdicts through
// lib/contracts only. No lint rule enforces feature boundaries (eslint.config.js restricts sinks
// and the Data Grid, not feature folders), so this test does: no explorer file imports the
// uploader's modules, and from the uploader's barrel only the shell's pre-wired slot
// (`requestUpload`).
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../../../src/client/features/explorer/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const importsOf = (source: string) =>
  [...source.matchAll(/import\s+(?:type\s+)?(\{[^}]*\}|[\w*\s,]+)\s+from\s+"([^"]+)"/g)].map(
    ([, names, from]) => ({
      names: names!
        .replace(/[{}\s]/g, "")
        .split(",")
        .filter(Boolean),
      from: from!,
    }),
  );

describe("the explorer never imports the uploader", () => {
  it("no explorer file imports features/upload/*; from the barrel only requestUpload", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, source] of Object.entries(sources)) {
      for (const { names, from } of importsOf(source)) {
        expect(from, file).not.toMatch(/(^|\/)upload\/./);
        if (/(^|\/)upload$/.test(from)) expect(names, file).toEqual(["requestUpload"]);
      }
    }
  });
});
