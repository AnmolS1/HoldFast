// Syntax highlighting as DATA: the grammar's tokens become plain `{ text, token }` pieces and the
// viewer renders those as React text nodes. Nothing derived from a file's content is ever parsed
// as markup.
//
// It runs on the main thread, so it is bounded in TIME, not only in size:
//   - one line at a time, each given at most `HIGHLIGHT_LINE_TIME_MS` by the grammar (what is
//     left of a line after that stays plain);
//   - after `HIGHLIGHT_SLICE_MS` of work the run yields to the page — a click on Close is handled
//     before the next line — and looks at its signal: an aborted run ends there. A stretch of
//     work is that slice plus the line in progress (measured: see `HIGHLIGHT_SLICE_MS`);
//   - the whole run gets `HIGHLIGHT_TOTAL_MS` of work and `TEXT_MAX_PIECES` pieces; past either
//     the text simply stays plain.
// The grammar's state is carried from line to line from the tokens themselves (nothing is
// tokenised twice). No WebAssembly: the regex engine is the JavaScript one.
import {
  createCssVariablesTheme,
  createHighlighterCore,
  type HighlighterCore,
  type LanguageInput,
} from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { TEXT_MAX_PIECES } from "./text";

export interface Piece {
  text: string;
  /** The grammar's class of token ("keyword", "comment", …); absent for plain text. */
  token?: string;
}
export type Line = Piece[];

/** A line longer than this is shown without colours. */
export const HIGHLIGHT_MAX_LINE_LENGTH = 2_000;
/** The most time the grammar may spend on one line. */
export const HIGHLIGHT_LINE_TIME_MS = 8;
/** Goes at one line (each within the limit, a yield in between) before it keeps what it has. */
export const HIGHLIGHT_LINE_ATTEMPTS = 4;
/**
 * Work done before the run yields to the page (checked between lines). A stretch of work between
 * two yields is this slice plus the line in progress, and that line is not bounded by a number
 * here: the grammar checks `HIGHLIGHT_LINE_TIME_MS` only between its scans, and one scan of a
 * line cannot be interrupted. MEASURED (not a guarantee): 2,000-character Vue lines (`<a :b="{`
 * repeated) cost ~37–44 ms per stretch, other grammars 10–35 ms (jsdom, 2026-10-13); a grammar's
 * first use adds its compilation once (~100 ms). A rule that backtracks worse on a crafted line
 * could cost more.
 */
export const HIGHLIGHT_SLICE_MS = 8;
/** Work the whole run may take; past it the text stays plain. */
export const HIGHLIGHT_TOTAL_MS = 2_000;

type Grammar = LanguageInput;
const grammar = (load: () => Promise<{ default: unknown }>) => async () => (await load()).default as Grammar;

// One lazy chunk per grammar: only the one a file needs is fetched.
const GRAMMARS: Record<string, () => Promise<Grammar>> = {
  typescript: grammar(() => import("shiki/langs/typescript.mjs")),
  tsx: grammar(() => import("shiki/langs/tsx.mjs")),
  javascript: grammar(() => import("shiki/langs/javascript.mjs")),
  jsx: grammar(() => import("shiki/langs/jsx.mjs")),
  json: grammar(() => import("shiki/langs/json.mjs")),
  jsonc: grammar(() => import("shiki/langs/jsonc.mjs")),
  css: grammar(() => import("shiki/langs/css.mjs")),
  scss: grammar(() => import("shiki/langs/scss.mjs")),
  less: grammar(() => import("shiki/langs/less.mjs")),
  markdown: grammar(() => import("shiki/langs/markdown.mjs")),
  python: grammar(() => import("shiki/langs/python.mjs")),
  java: grammar(() => import("shiki/langs/java.mjs")),
  c: grammar(() => import("shiki/langs/c.mjs")),
  cpp: grammar(() => import("shiki/langs/cpp.mjs")),
  php: grammar(() => import("shiki/langs/php.mjs")),
  r: grammar(() => import("shiki/langs/r.mjs")),
  sql: grammar(() => import("shiki/langs/sql.mjs")),
  shellscript: grammar(() => import("shiki/langs/shellscript.mjs")),
  yaml: grammar(() => import("shiki/langs/yaml.mjs")),
  vue: grammar(() => import("shiki/langs/vue.mjs")),
  svelte: grammar(() => import("shiki/langs/svelte.mjs")),
  csv: grammar(() => import("shiki/langs/csv.mjs")),
};

/** The language to highlight a file as, from its extension. Unlisted = plain text. */
const LANG_BY_EXT: Record<string, keyof typeof GRAMMARS> = {
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

const THEME = "holdfast";
const PREFIX = "--hf-code-";
// Colours come from the stylesheet, by token name: the theme only names the variables.
const theme = createCssVariablesTheme({
  name: THEME,
  variablePrefix: PREFIX,
  variableDefaults: {},
  fontStyle: false,
});
const TOKEN = new RegExp(`var\\(${PREFIX}token-([a-z-]+)\\)`);

/** A highlighter that knows `lang` (and what it embeds). Code only — nothing of any file is kept. */
async function highlighterFor(lang: string): Promise<HighlighterCore> {
  const load = GRAMMARS[lang];
  if (!load) throw new Error("no grammar");
  return createHighlighterCore({
    themes: [theme],
    langs: [await load()],
    engine: createJavaScriptRegexEngine(),
  });
}

export interface HighlightOptions {
  /** Aborted when the preview closes, moves on, or the account is purged. */
  signal?: AbortSignal;
  /** The clock (a test's, to make time pass as it likes). */
  now?: () => number;
  /** Told each time the run yields, with the work done since the last yield (ms). */
  onSlice?: (workMs: number) => void;
}

const yieldToPage = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * Highlight `code`; one entry per line. Resolves with null when the run was aborted, ran out of
 * its time, or the result would be too many pieces to draw — the caller keeps the plain text.
 * Rejects when the grammar cannot be loaded. The caller decides beforehand whether the text is
 * small enough to try (`canHighlight`).
 */
export async function highlight(
  code: string,
  lang: string,
  options: HighlightOptions = {},
): Promise<Line[] | null> {
  const { signal, onSlice } = options;
  const now = options.now ?? (() => performance.now());
  if (signal?.aborted) return null;
  const highlighter = await highlighterFor(lang);
  if (signal?.aborted) return null;

  const source = code.split(/\r\n|\r|\n/);
  const lines: Line[] = [];
  let pieces = 0;
  let total = 0;
  let sliceStart = now();
  let state: ReturnType<HighlighterCore["getLastGrammarState"]> | undefined;
  const tokenise = (text: string) =>
    highlighter.codeToTokensBase(text, {
      lang,
      theme: THEME,
      grammarState: state,
      tokenizeMaxLineLength: HIGHLIGHT_MAX_LINE_LENGTH,
      tokenizeTimeLimit: HIGHLIGHT_LINE_TIME_MS,
    });
  /** Yield to the page when a slice's worth of work is done. False = the run is over. */
  const breathe = async (): Promise<boolean> => {
    const worked = now() - sliceStart;
    if (worked < HIGHLIGHT_SLICE_MS) return true;
    total += worked;
    onSlice?.(worked);
    if (total > HIGHLIGHT_TOTAL_MS) return false;
    await yieldToPage();
    if (signal?.aborted) return false;
    sliceStart = now();
    return true;
  };
  for (const text of source) {
    let tokens = null as ReturnType<typeof tokenise> | null;
    for (let attempt = 0; attempt < HIGHLIGHT_LINE_ATTEMPTS; attempt += 1) {
      // A line that ran into its limit was cut short. The first use of a rule pays for building
      // it, so another go — after a breath, with the same limit — usually finishes; a line that
      // is slow in itself is cut short every time and keeps what it got.
      if (attempt > 0 && !(await breathe())) return null;
      const before = now();
      tokens = tokenise(text);
      if (now() - before < HIGHLIGHT_LINE_TIME_MS) break;
    }
    if (tokens === null) return null;
    state = highlighter.getLastGrammarState(tokens);
    const line: Line = [];
    for (const token of tokens[0] ?? []) {
      if (token.content.length === 0) continue;
      const name = token.color ? TOKEN.exec(token.color)?.[1] : undefined;
      line.push(name ? { text: token.content, token: name } : { text: token.content });
    }
    lines.push(line);
    pieces += line.length;
    // More pieces than will be drawn: stop here rather than cut the whole file up for nothing.
    if (pieces > TEXT_MAX_PIECES) return null;
    if (!(await breathe())) return null;
  }
  return lines;
}
