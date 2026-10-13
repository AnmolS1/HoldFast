// The shared MIME policy as the SPA sees it: it loads in a browser-like environment, and it
// reaches for nothing outside `src/shared`.
import { describe, expect, it } from "vitest";
import { PREVIEW_TEXT_MAX_BYTES } from "../../../src/shared/constants";
import {
  categoryOf,
  inlineAllowed,
  inlineKindAllowed,
  isActiveType,
  previewFetchAllowed,
  serveType,
} from "../../../src/shared/mime";

const sources = import.meta.glob<string>("/src/shared/{mime,constants}.ts", {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("src/shared/mime.ts", () => {
  it("imports nothing outside src/shared — and neither does what it imports", () => {
    expect(Object.keys(sources).sort()).toEqual(["/src/shared/constants.ts", "/src/shared/mime.ts"]);
    const specifiers = (code: string) =>
      [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g)].map(
        (m) => m[1]!,
      );
    expect(specifiers(sources["/src/shared/mime.ts"]!)).toEqual(["./constants"]);
    expect(specifiers(sources["/src/shared/constants.ts"]!)).toEqual([]);
  });

  it("answers in the SPA what the Worker answers", () => {
    expect(categoryOf("text/plain", "ts")).toBe("code");
    expect(categoryOf("application/octet-stream", "png")).toBe("image");
    expect(categoryOf("application/x-msdownload", "jpg")).toBe("other");
    expect(isActiveType("image/svg+xml")).toBe(true);
    expect(serveType("image/svg+xml", "a.svg")).toBe("application/octet-stream");
    expect(inlineAllowed("image/png")).toBe(true);
    expect(inlineAllowed("text/html")).toBe(false);
    const file = (mimeSniffed: string, name: string, size: number) => ({
      mimeSniffed,
      name,
      ext: name.split(".").pop()!,
      size,
    });
    expect(previewFetchAllowed(file("application/pdf", "a.pdf", 10))).toBe(true);
    expect(previewFetchAllowed(file("text/plain", "a.txt", PREVIEW_TEXT_MAX_BYTES + 1))).toBe(false);
    expect(inlineKindAllowed(file("text/html", "a.html", 10))).toBe(false);
    expect(inlineKindAllowed(file("video/mp4", "a.mp4", 10))).toBe(true);
  });
});
