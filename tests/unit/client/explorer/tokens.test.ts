// D01's tokens only: no size of the explorer's own. A breakpoint comes from the theme, a spacing
// from the theme's spacing unit, a size from `layout`. ("1px" is the hairline the shell's sx-units
// scan asks for.)
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob<string>("/src/client/features/explorer/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

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
    const found = Object.entries(SOURCES).flatMap(([file, text]) =>
      text
        .split("\n")
        .flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
    );
    expect(found).toEqual([]);
  });
});
