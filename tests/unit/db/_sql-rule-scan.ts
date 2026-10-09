// A small source scanner for two rules about time zones (see the header of db/client.ts):
//
// 1. A statement that names one of Better Auth's zone-less `timestamp` columns may not compare
//    it with a bare `now()` / `CURRENT_TIMESTAMP`; it must be `now() AT TIME ZONE 'UTC'`.
// 2. Nothing sets a session time zone.
//
// A "statement" is one `sql` tagged template, or one Drizzle comparison call. The scan works on
// source text, so it also covers query modules that later tasks add.
//
// Limits: it is a tokenizer, not a parser. A regular-expression literal that contains a quote or
// a backtick can confuse it, and a column and a `now()` that meet only at run time (two
// fragments built in different functions) are not seen as one statement.

import { getTableConfig, PgTable, type PgColumn } from "drizzle-orm/pg-core";

export type AuthColumn = {
  /** `user.deleteScheduledAt` */
  property: string;
  /** Matches `"user"."delete_scheduled_at"`, `"user".delete_scheduled_at`, `user.delete_scheduled_at`. */
  sqlPattern: RegExp;
  propertyPattern: RegExp;
};

/** Every `timestamp` WITHOUT time zone column of the tables exported by a schema module. */
export function zonelessTimestampColumns(schemaModule: Record<string, unknown>): AuthColumn[] {
  const out: AuthColumn[] = [];
  for (const [exportName, value] of Object.entries(schemaModule)) {
    if (!(value instanceof PgTable)) continue;
    const table = getTableConfig(value);
    const byProperty = value as unknown as Record<string, PgColumn>;
    for (const [property, column] of Object.entries(byProperty)) {
      if (!column || typeof column !== "object" || typeof column.getSQLType !== "function") continue;
      const type = column.getSQLType();
      if (!type.startsWith("timestamp") || type.includes("with time zone")) continue;
      out.push({
        property: `${exportName}.${property}`,
        sqlPattern: new RegExp(`(?<![\\w."])"?${table.name}"?\\s*\\.\\s*"?${column.name}"?(?![\\w"])`, "i"),
        propertyPattern: new RegExp(`(?<![\\w.])${exportName}\\.${property}(?!\\w)`),
      });
    }
  }
  return out;
}

/** Replaces comments by spaces (offsets and line numbers are preserved). */
export function stripComments(source: string): string {
  const out = source.split("");
  type Mode = "code" | "single" | "double" | "template" | "line" | "block";
  const stack: Mode[] = ["code"];
  // For each open template: how many `{` are open inside its current `${ … }`.
  const braces: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const mode = stack[stack.length - 1]!;
    const ch = source[i]!;
    const next = source[i + 1];
    if (mode === "line") {
      if (ch === "\n") stack.pop();
      else out[i] = " ";
    } else if (mode === "block") {
      if (ch === "*" && next === "/") {
        out[i] = out[i + 1] = " ";
        i++;
        stack.pop();
      } else if (ch !== "\n") out[i] = " ";
    } else if (mode === "single" || mode === "double") {
      if (ch === "\\") i++;
      else if ((mode === "single" && ch === "'") || (mode === "double" && ch === '"')) stack.pop();
    } else if (mode === "template") {
      if (ch === "\\") i++;
      else if (ch === "`") stack.pop();
      else if (ch === "$" && next === "{") {
        braces.push(0);
        stack.push("code");
        i++;
      }
    } else {
      if (ch === "/" && next === "/") {
        out[i] = out[i + 1] = " ";
        i++;
        stack.push("line");
      } else if (ch === "/" && next === "*") {
        out[i] = out[i + 1] = " ";
        i++;
        stack.push("block");
      } else if (ch === "'") stack.push("single");
      else if (ch === '"') stack.push("double");
      else if (ch === "`") stack.push("template");
      else if (ch === "{" && braces.length > 0 && stack.length > 1) braces[braces.length - 1]!++;
      else if (ch === "}" && braces.length > 0 && stack.length > 1) {
        if (braces[braces.length - 1] === 0) {
          braces.pop();
          stack.pop();
        } else braces[braces.length - 1]!--;
      }
    }
  }
  return out.join("");
}

export type Statement = { text: string; line: number };

/** Index just past the template that opens at `open` (a backtick), nested templates included. */
function templateEnd(code: string, open: number): number {
  let depth = 0;
  const inTemplate: boolean[] = [true];
  for (let i = open + 1; i < code.length; i++) {
    const ch = code[i]!;
    if (inTemplate[inTemplate.length - 1]) {
      if (ch === "\\") i++;
      else if (ch === "`") {
        inTemplate.pop();
        if (inTemplate.length === 0) return i + 1;
      } else if (ch === "$" && code[i + 1] === "{") {
        inTemplate.push(false);
        depth++;
        i++;
      }
    } else if (ch === "`") inTemplate.push(true);
    else if (ch === "{") {
      inTemplate.push(false);
      depth++;
    } else if (ch === "}") {
      inTemplate.pop();
      depth--;
    }
  }
  void depth;
  return code.length;
}

/** Index just past the `)` that closes the `(` at `open`. Templates inside are skipped whole. */
function callEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === "`") i = templateEnd(code, i) - 1;
    else if (ch === "'" || ch === '"') {
      for (i++; i < code.length && code[i] !== ch; i++) if (code[i] === "\\") i++;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

/** Every `sql` template and every Drizzle comparison call of a source file. */
export function statements(source: string): Statement[] {
  const code = stripComments(source);
  const lineOf = (index: number) => code.slice(0, index).split("\n").length;
  const out: Statement[] = [];
  for (const match of code.matchAll(/\bsql(?:<[^`]*?>)?`/g)) {
    const open = match.index + match[0].length - 1;
    out.push({ text: code.slice(match.index, templateEnd(code, open)), line: lineOf(match.index) });
  }
  for (const match of code.matchAll(/(?<![\w.])(lt|gt|lte|gte|eq|ne|between|notBetween)\(/g)) {
    const open = match.index + match[0].length - 1;
    out.push({ text: code.slice(match.index, callEnd(code, open)), line: lineOf(match.index) });
  }
  return out;
}

const BARE_NOW = /\bnow\s*\(\s*\)(?!\s*AT\s+TIME\s+ZONE\s+'UTC')/i;
const BARE_CURRENT_TIMESTAMP = /\bCURRENT_TIMESTAMP\b(?!\s*AT\s+TIME\s+ZONE\s+'UTC')/i;

export type Violation = { line: number; column: string; text: string };

/** Statements that name an auth timestamp column together with a bare `now()`. */
export function bareNowViolations(source: string, columns: AuthColumn[]): Violation[] {
  const out: Violation[] = [];
  for (const statement of statements(source)) {
    if (!BARE_NOW.test(statement.text) && !BARE_CURRENT_TIMESTAMP.test(statement.text)) continue;
    const column = columns.find(
      (c) => c.sqlPattern.test(statement.text) || c.propertyPattern.test(statement.text),
    );
    if (column)
      out.push({ line: statement.line, column: column.property, text: statement.text.slice(0, 160) });
  }
  return out;
}

const SESSION_ZONE: RegExp[] = [
  // SET TIME ZONE …, SET SESSION TIME ZONE …, SET LOCAL TIME ZONE …, SET timezone = …
  /\bSET\s+(?:SESSION\s+|LOCAL\s+)?(?:TIME\s+ZONE|time_?zone)\b/i,
  // SET SESSION … followed by a zone setting
  /\bSET\s+SESSION\b[^;`'"]*\btime\s*_?zone\b/i,
  // set_config('timezone', …)
  /\bset_config\s*\(\s*'time_?zone'/i,
  // a connection option: options=-c timezone=…, ?timezone=…, -c timezone=…
  /-c\s*(?:%20)?time_?zone\s*(?:=|%3D)/i,
  /[?&]time_?zone=/i,
];

/**
 * Lines (1-based) of a source file that set a session time zone. `raw` scans the text as it is
 * (for shell scripts, whose comments are not JavaScript's).
 */
export function sessionZoneLines(source: string, opts: { raw?: boolean } = {}): number[] {
  const code = opts.raw ? source : stripComments(source);
  const out: number[] = [];
  code.split("\n").forEach((line, index) => {
    if (SESSION_ZONE.some((pattern) => pattern.test(line))) out.push(index + 1);
  });
  return out;
}
