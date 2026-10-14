// Properties of the preview's source that a reviewer would otherwise check by grep.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("/src/client/features/preview/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const en = import.meta.glob<string>("/src/client/lib/en.ts", {
  query: "?raw",
  import: "default",
  eager: true,
})["/src/client/lib/en.ts"]!;

const code = (source: string) => source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
const files = Object.entries(sources);

describe("preview source", () => {
  it("the folder is found", () => {
    expect(files.length).toBeGreaterThan(10);
    expect(Object.keys(sources)).toContain("/src/client/features/preview/renderers/TextPreview.tsx");
  });

  it("nothing derived from a file is ever parsed as markup", () => {
    for (const [path, source] of files) {
      expect(source, path).not.toMatch(/dangerouslySetInnerHTML/);
      expect(code(source), path).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write)\b/);
      expect(code(source), path).not.toMatch(/\bcodeToHtml\b/);
    }
  });

  it("no PDF or other file is ever put in a frame or an object", () => {
    for (const [path, source] of files) {
      expect(code(source), path).not.toMatch(/<(iframe|embed|object)\b/);
      expect(code(source), path).not.toMatch(/createElement\(\s*["'](iframe|embed|object)["']/);
    }
  });

  it("a URL is never logged, and never kept on the device", () => {
    for (const [path, source] of files) {
      expect(code(source), path).not.toMatch(/\bconsole\.\w+/);
      expect(code(source), path).not.toMatch(/\b(localStorage|sessionStorage|indexedDB)\b/);
    }
  });

  it("module-level state exists in ONE file, which registers its purger; nowhere else", () => {
    const SCOPE = "/src/client/features/preview/scope.ts";
    for (const [path, source] of files) {
      if (path === SCOPE) continue;
      // A module-level `let`, or a module-level collection, would be state that outlives a view.
      expect(code(source), path).not.toMatch(/^(let|var)\s/m);
      expect(code(source), path).not.toMatch(
        /^(export\s+)?const\s+\w+\s*=\s*new\s+(Map|Set|WeakMap|Array)\b/m,
      );
      expect(code(source), path).not.toMatch(/registerUserStatePurger/);
    }
    // The scopes open right now and the purge count: stopped and bumped by the purger.
    expect(sources[SCOPE]).toMatch(/^registerUserStatePurger\(purgePreview\);$/m);
    expect(code(sources[SCOPE]!)).not.toMatch(/^(let|var)\s/m);
  });

  it("the account epoch is read in ONE place: every late continuation goes through the scope", () => {
    const readers = files
      .filter(([, source]) => /\b(accountEpoch|sameAccount)\b/.test(code(source)))
      .map(([path]) => path);
    expect(readers).toEqual(["/src/client/features/preview/scope.ts"]);
    // And nothing builds an abort of its own beside it.
    const aborters = files
      .filter(([, source]) => /new AbortController\(/.test(code(source)))
      .map(([path]) => path);
    expect(aborters).toEqual(["/src/client/features/preview/scope.ts"]);
  });

  it("every renderer mints `inline` or `thumb`; `download` is minted in one place, by the button", () => {
    const minters = files
      .filter(([, source]) => /mintUrl\([^)]*"download"/.test(code(source)))
      .map(([path]) => path);
    expect(minters).toEqual(["/src/client/features/preview/PreviewDialog.tsx"]);
    for (const [path, source] of files) {
      if (!path.includes("/renderers/")) continue;
      expect(code(source), path).not.toMatch(/["']download["']/);
    }
  });

  it("imports stay inside the feature, the shell's shared code, src/shared and the two slot modules", () => {
    const allowed =
      /^(\.\/|\.\.\/(?!\.\.)[\w./-]*$|(\.\.\/)+(components|lib|theme)\/|(\.\.\/)+shared\/|\.\.\/(report|share)$|react$|react-router$|@mui\/material\/|lucide-react$|shiki\/(core|engine\/javascript|langs\/[a-z]+\.mjs)$|pdfjs-dist)/;
    for (const [path, source] of files) {
      for (const match of source.matchAll(/from\s+"([^"]+)"|import\("([^"]+)"\)/g)) {
        const specifier = (match[1] ?? match[2])!;
        expect(allowed.test(specifier), `${path} imports ${specifier}`).toBe(true);
        expect(specifier, path).not.toMatch(/worker\//);
      }
    }
  });

  it("the shell's catalogue carries no preview string (they live in the feature's own file)", () => {
    expect(en).not.toMatch(/Original is HEIC|leaving Holdfast|Too large to preview/);
  });
});
