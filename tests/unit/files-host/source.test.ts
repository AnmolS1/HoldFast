// Properties of this task's source that are rules, not behaviour of one request: read as text.
import { describe, expect, it } from "vitest";

const SOURCES = {
  ...import.meta.glob("../../../src/worker/files-host.ts", { query: "?raw", import: "default", eager: true }),
  ...import.meta.glob("../../../src/worker/services/{ledger,thumbnails}.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
  ...import.meta.glob("../../../src/worker/db/queries/files-host.ts", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
} as Record<string, string>;

const short = (file: string) => file.replace(/^.*\/src\/worker\//, "");
/** The code of a file: line comments and the lines of block comments removed. */
const codeOf = (text: string) =>
  text
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, "").replace(/^\s*(\/\*\*?|\*\/?).*$/, ""))
    .join("\n");

const files = Object.fromEntries(Object.entries(SOURCES).map(([file, text]) => [short(file), text]));

describe("the files host's source", () => {
  it("the four files are the ones read", () => {
    expect(Object.keys(files).sort()).toEqual([
      "db/queries/files-host.ts",
      "files-host.ts",
      "services/ledger.ts",
      "services/thumbnails.ts",
    ]);
  });

  it("thumbnails.ts names no other output format, asks for one still frame, and passes no `metadata` option", () => {
    const text = files["services/thumbnails.ts"]!;
    expect(text).not.toMatch(/\bmetadata\s*:/);
    expect(text).not.toContain("image/jpeg");
    expect(text).toContain('THUMB_TYPE = "image/webp"');
    expect(codeOf(text)).toMatch(/\.output\(\{ format: THUMB_TYPE, quality: QUALITY, anim: false \}\)/);
    // The control: the scan finds what it looks for.
    expect("  .output({ format: 'image/webp', metadata: 'none' })").toMatch(/\bmetadata\s*:/);
  });

  it("no ceiling is checked and then recorded: neither call exists in this task's code", () => {
    for (const [file, text] of Object.entries(files)) {
      const code = codeOf(text);
      expect(code, file).not.toMatch(/\bcheckCeiling\s*\(/);
      expect(code, file).not.toMatch(/\brecordUsage\s*\(/);
      expect(code, file).not.toMatch(/\baddUsage\s*\(/);
    }
  });

  it("every tryConsumeCeiling result is bound to a name whose refusal is tested on the next statement", () => {
    let calls = 0;
    for (const [file, text] of Object.entries(files)) {
      const code = codeOf(text);
      const all = [...code.matchAll(/\btryConsumeCeiling\s*\(/g)];
      const bound = [...code.matchAll(/const (\w+) = await tryConsumeCeiling\s*\(/g)];
      expect(bound.length, file).toBe(all.length);
      for (const match of bound) {
        calls += 1;
        const after = code.slice(match.index);
        const end = after.indexOf(";");
        const next = after.slice(end + 1).trimStart();
        expect(next.startsWith(`if (!${match[1]}.ok)`), `${file}: ${match[1]}`).toBe(true);
      }
    }
    // download_owner, download_link, transform_user.
    expect(calls).toBe(3);
  });

  it("`downloadCount` is never read or written here, and nothing writes an audit row", () => {
    for (const [file, text] of Object.entries(files)) {
      const code = codeOf(text);
      expect(code, file).not.toMatch(/downloadCount|download_count|consumeDownload/);
      expect(code, file).not.toMatch(/\baudit\s*\(|insertAudit|auditLog/);
    }
  });

  it("nothing logs a URL, a Referer or a Location, and the Images `info()` call decides nothing", () => {
    for (const [file, text] of Object.entries(files)) {
      const code = codeOf(text);
      for (const line of code.split("\n").filter((candidate) => /console\./.test(candidate))) {
        expect(line, file).not.toMatch(/url|referer|location|token|path/i);
        expect(line, file).not.toMatch(/\$\{(?!kind\})/);
      }
      expect(code, file).not.toMatch(/IMAGES\.info\s*\(|\.info\(/);
      expect(code, file).not.toMatch(/includeHidden/);
    }
  });

  it("nothing is written under u/: the only key this task builds for a write is the thumbnail's", () => {
    for (const [file, text] of Object.entries(files)) {
      const code = codeOf(text);
      expect(code, file).not.toMatch(/\bkeyFor\s*\(/);
      const puts = [...code.matchAll(/\.put\((\w+\([^)]*\)|[^,]+),/g)].map((match) => match[1]!.trim());
      if (file === "services/thumbnails.ts") {
        expect(puts).toEqual(["key"]);
        expect(code).toMatch(/\bconst key = thumbKey\(node\.id, node\.versionId, size\);/);
      } else expect(puts, file).toEqual([]);
    }
  });
});
