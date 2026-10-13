// Syntax highlighting as DATA: the highlighter's tree is read into plain `{ text, token }` pieces
// and the viewer renders those as React text nodes. Nothing derived from a file's content is ever
// parsed as markup.
import {
  codeToHast,
  createCssVariablesTheme,
  getLastGrammarState,
  type GrammarState,
} from "shiki/bundle/web";

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

/** Lines handed to the grammar at a time; between two slices the page gets to breathe. */
export const HIGHLIGHT_SLICE_LINES = 200;

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Highlight `code`; one entry per line. Works through the text in slices of
 * `HIGHLIGHT_SLICE_LINES`, carrying the grammar's state from one to the next, and looks at
 * `signal` before each: an aborted run stops there and resolves with null. Rejects when the
 * grammar cannot be loaded. The caller decides beforehand whether the text is small enough.
 */
export async function highlight(code: string, lang: string, signal?: AbortSignal): Promise<Line[] | null> {
  const source = code.split(/\r\n|\r|\n/);
  const lines: Line[] = [];
  let grammarState: GrammarState | undefined;
  for (let start = 0; start < source.length; start += HIGHLIGHT_SLICE_LINES) {
    if (signal?.aborted) return null;
    if (start > 0) {
      await pause();
      if (signal?.aborted) return null;
    }
    const slice = source.slice(start, start + HIGHLIGHT_SLICE_LINES).join("\n");
    const options = {
      lang,
      theme,
      grammarState,
      // A grammar can take very long over one hostile line: a long line is left plain, and no
      // line gets more than a moment.
      tokenizeMaxLineLength: HIGHLIGHT_MAX_LINE_LENGTH,
      tokenizeTimeLimit: HIGHLIGHT_LINE_TIME_MS,
    };
    collectLines((await codeToHast(slice, options)) as unknown as HastNode, lines);
    if (start + HIGHLIGHT_SLICE_LINES < source.length) {
      // The state the grammar is in after this slice (inside a comment, a string, …).
      grammarState = await (getLastGrammarState as (code: string, options: unknown) => Promise<GrammarState>)(
        slice,
        options,
      );
    }
  }
  return lines;
}
