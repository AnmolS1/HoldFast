// Syntax highlighting as DATA: the highlighter's tree is read into plain `{ text, token }` pieces
// and the viewer renders those as React text nodes. Nothing derived from a file's content is ever
// parsed as markup.
import { codeToHast, createCssVariablesTheme } from "shiki/bundle/web";

export interface Piece {
  text: string;
  /** The grammar's class of token ("keyword", "comment", …); absent for plain text. */
  token?: string;
}
export type Line = Piece[];

/** The language to highlight a file as, from its extension. Unlisted = plain text. */
const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  php: "php",
  r: "r",
  sql: "sql",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yaml: "yaml",
  yml: "yaml",
  vue: "vue",
  svelte: "svelte",
  csv: "csv",
};

export function languageFor(ext: string): string | null {
  return LANG_BY_EXT[ext.replace(/^\./, "").toLowerCase()] ?? null;
}

/** A line longer than this is shown without colours. */
export const HIGHLIGHT_MAX_LINE_LENGTH = 2_000;
/** The most time the grammar may spend on one line. */
export const HIGHLIGHT_LINE_TIME_MS = 100;

const PREFIX = "--hf-code-";
// Colours come from the stylesheet, by token name: the theme only names the variables.
const theme = createCssVariablesTheme({
  name: "holdfast",
  variablePrefix: PREFIX,
  variableDefaults: {},
  fontStyle: false,
});

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

const TOKEN = new RegExp(`var\\(${PREFIX}token-([a-z-]+)\\)`);

function tokenOf(node: HastNode): string | undefined {
  const style = node.properties?.style;
  return typeof style === "string" ? TOKEN.exec(style)?.[1] : undefined;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function isLine(node: HastNode): boolean {
  const cls = node.properties?.class;
  return node.type === "element" && (cls === "line" || (Array.isArray(cls) && cls.includes("line")));
}

function collectLines(node: HastNode, out: Line[]): void {
  if (isLine(node)) {
    out.push(
      (node.children ?? [])
        .map((child): Piece => ({ text: textOf(child), token: tokenOf(child) }))
        .filter((piece) => piece.text.length > 0),
    );
    return;
  }
  for (const child of node.children ?? []) collectLines(child, out);
}

/** Highlight `code`; one entry per line. Rejects when the grammar cannot be loaded. */
export async function highlight(code: string, lang: string): Promise<Line[]> {
  const root = (await codeToHast(code, {
    lang,
    theme,
    // A grammar can take very long over one hostile line: a long line is left plain, and no
    // line gets more than a moment.
    tokenizeMaxLineLength: HIGHLIGHT_MAX_LINE_LENGTH,
    tokenizeTimeLimit: HIGHLIGHT_LINE_TIME_MS,
  })) as unknown as HastNode;
  const lines: Line[] = [];
  collectLines(root, lines);
  return lines;
}
