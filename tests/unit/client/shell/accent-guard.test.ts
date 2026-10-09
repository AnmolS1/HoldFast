// The accent guard: the rule fires on a violation, stays quiet inside the allow-list, and the
// whole of src/client passes it. The rule is not wired into eslint.config.js yet (a seam), so
// this test is what enforces it until it is.
import { Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import accentGuard, { ALLOWED } from "../../../../src/client/theme/eslint-accent-guard.mjs";

const linter = new Linter({ configType: "flat" });
const config: Linter.Config[] = [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tseslint.parser as Linter.Parser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { holdfast: accentGuard },
    rules: { "holdfast/accent-guard": "error" },
  },
];

function lint(code: string, filename: string): string[] {
  const messages = linter.verify(code, config, { filename });
  const fatal = messages.filter((message) => message.fatal);
  if (fatal.length) throw new Error(`${filename}: ${fatal[0]!.message}`);
  return messages.filter((message) => message.ruleId === "holdfast/accent-guard").map((message) => message.messageId ?? "");
}

const OUTSIDE = "src/client/components/FileList/FileList.tsx";
const FEATURE = "src/client/features/explorer/routes.tsx";

describe("accent guard: fixture violations", () => {
  const violations: Array<[string, string]> = [
    ["an imported token object", `import { hfAccent } from "../../theme/tokens"; export const c = hfAccent.main;`],
    ["a token property", `export const c = tokens.accentTint;`],
    ["the CSS variable in a string", `export const c = "var(--hf-accent)";`],
    ["the variable in a template string", "export const c = `1px solid var(--hf-accent-track)`;"],
    ["the CSS property", `export const sx = { accentColor: "red" };`],
    ["the word in a comment", `// uses the accent here\nexport const c = 1;`],
    ["palette.primary by member access", `export const c = theme.palette.primary.main;`],
    ["palette.primary through vars", `export const c = theme.vars.palette.primary.main;`],
    ["palette.primary by computed access", `export const c = theme.palette["primary"].main;`],
    ["a primary.main sx string", `export const sx = { color: "primary.main" };`],
    ["the library's primary variable", `export const c = "var(--mui-palette-primary-main)";`],
    ["a JSX attribute value", `export const X = () => <div style={{ color: "var(--hf-accent-text)" }} />;`],
  ];

  it.each(violations)("fires on %s", (_name, code) => {
    expect(lint(code, OUTSIDE).length).toBeGreaterThan(0);
    expect(lint(code, FEATURE).length).toBeGreaterThan(0);
  });

  it.each(violations)("is silent for the same code inside the allow-list: %s", (_name, code) => {
    for (const file of [
      "src/client/theme/Provider.tsx",
      "src/client/components/TransferRibbon/TransferRibbon.tsx",
      "src/client/components/SelectionBar/index.tsx",
      "src/client/components/StatusDot/StatusDot.tsx",
      "src/client/components/ProgressUnderline/ProgressUnderline.tsx",
    ]) {
      expect(lint(code, file)).toEqual([]);
    }
  });

  it("does not fire on neutral code", () => {
    const code = `import { hf } from "../../theme/tokens"; export const sx = { color: hf.textSecondary, backgroundColor: hf.surface2 }; export const b = <button color="primary" aria-selected="true" />;`;
    expect(lint(code, OUTSIDE)).toEqual([]);
  });

  it("only looks at src/client", () => {
    expect(lint(`export const accent = 1;`, "src/worker/app.ts")).toEqual([]);
  });

  it("the allow-list is exactly the specification's", () => {
    const allowed = ["theme/x.ts", "components/TransferRibbon/a.ts", "components/SelectionBar/a.tsx", "components/StatusDot/a.tsx", "components/ProgressUnderline/a.tsx"];
    const denied = ["components/FileList/a.tsx", "components/CommandPalette/a.tsx", "components/EmptyState/a.tsx", "routes/frame/a.tsx", "lib/a.ts", "features/explorer/a.tsx", "components/StatusDotExtra/a.tsx", "themes/a.ts"];
    for (const path of allowed) expect(ALLOWED.test(`src/client/${path}`), path).toBe(true);
    for (const path of denied) expect(ALLOWED.test(`src/client/${path}`), path).toBe(false);
  });
});

describe("accent guard: the tree", () => {
  const sources = import.meta.glob<string>("/src/client/**/*.{ts,tsx}", { query: "?raw", import: "default", eager: true });

  it("covers the client source", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(80);
    expect(Object.keys(sources)).toContain("/src/client/components/FileList/FileList.tsx");
  });

  it("every file under src/client passes the rule", () => {
    const failures: string[] = [];
    for (const [path, code] of Object.entries(sources)) {
      const found = lint(code, path.slice(1));
      if (found.length) failures.push(`${path}: ${found.length}`);
    }
    expect(failures).toEqual([]);
  });

  it("agrees with the plain-text grep of the verification block", () => {
    const hits = Object.entries(sources)
      .filter(([path]) => !ALLOWED.test(path.slice(1)))
      .filter(([, code]) => /accent|palette\.primary/.test(code))
      .map(([path]) => path);
    expect(hits).toEqual([]);
  });
});
