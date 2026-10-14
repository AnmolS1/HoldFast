// D01's tokens only: no size of the explorer's own. A breakpoint comes from the theme, a spacing
// from the theme's spacing unit, a size from `layout`. ("1px" is the hairline the shell's sx-units
// scan asks for.)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "../../../../src/client/features/explorer");
const SOURCES = readdirSync(DIR).filter((file) => /\.tsx?$/.test(file));

const LITERALS: Array<[string, RegExp]> = [
  ["a media-query width", /\((?:max|min)-width:\s*\d/],
  ["a px string", /"(?!1px")\d+(?:\.\d+)?px/],
  [
    "a numeric size or offset",
    /\b(?:width|height|minWidth|maxWidth|minHeight|maxHeight|top|left|right|bottom|fontSize)\s*:\s*[1-9]\d*\b/,
  ],
];

describe("no size literal in the explorer", () => {
  it.each(LITERALS)("no %s", (_what, pattern) => {
    const found = SOURCES.flatMap((file) =>
      readFileSync(join(DIR, file), "utf8")
        .split("\n")
        .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
