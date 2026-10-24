// R1 a11y-3 follow-up (Addendum 11): the explorer reaches the uploader — its scan verdicts and its
// upload slot — through lib/contracts only. No lint rule enforces feature boundaries
// (eslint.config.js restricts observability sinks and the Data Grid, not feature folders), so this
// test does: no explorer file imports features/upload by any path.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("../../../../src/client/features/explorer/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** Every module a source imports statically (`import … from "x"`, `export … from "x"`). */
const importsOf = (source: string) =>
  [...source.matchAll(/(?:import|export)\s+(?:type\s+)?[^"';]*?\s+from\s+"([^"]+)"/g)].map(([, from]) => ({
    from: from!,
  }));

describe("the explorer never imports the uploader", () => {
  it("no explorer file imports features/upload — not its barrel, not a module of it", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10);
    for (const [file, source] of Object.entries(sources)) {
      for (const { from } of importsOf(source)) {
        expect(from, file).not.toMatch(/(^|\/)(features\/)?upload(\/|$)/);
      }
      // Dynamic imports too.
      expect(source, file).not.toMatch(/import\(\s*["'][^"']*\/upload(\/|["'])/);
    }
  });
});
