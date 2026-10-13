// In MUI's `sx`, a bare number from 0 to 1 for `width` / `height` / `maxWidth` … is a FRACTION:
// `width: 1` is 100 %, not one pixel. A visually hidden box written that way is as wide as its
// container and can make the page scroll sideways. Sizes of one pixel are written "1px".
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("/src/client/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const FRACTION = /\b(width|height|minWidth|minHeight|maxWidth|maxHeight):\s*1\s*[,}]/;

describe("sx sizes", () => {
  it("no component sizes a box with a bare 1 (MUI reads it as 100 %)", () => {
    const found: string[] = [];
    for (const [path, text] of Object.entries(sources)) {
      text.split("\n").forEach((line, index) => {
        if (FRACTION.test(line)) found.push(`${path}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(found).toEqual([]);
  });

  it("the pattern sees what it is meant to see", () => {
    expect(FRACTION.test("          width: 1,")).toBe(true);
    expect(FRACTION.test("sx={{ height: 1 }}")).toBe(true);
    expect(FRACTION.test('          width: "1px",')).toBe(false);
    expect(FRACTION.test("          width: 10,")).toBe(false);
    expect(FRACTION.test("          lineHeight: 1,")).toBe(false);
  });
});
