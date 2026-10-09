#!/usr/bin/env node
// Migration rule: a contract (destructive) migration ships ONE DEPLOY AFTER its expand migration,
// never in the same push — so the previous Worker version still runs against the migrated schema
// and `wrangler rollback` stays safe.
//
//   node scripts/check-migrations.mjs --base <sha> [--head <ref>] [--dir drizzle]
//   node scripts/check-migrations.mjs --self-test
//
// It compares the migration files of <base> (the previous deploy: the parent of the push, or a
// pull request's base) with <head> and fails when
//   1. a migration that already existed at <base> was edited, renamed or deleted (an applied
//      migration is immutable: drizzle would skip the edit and the databases would silently differ);
//   2. a migration added by the push is destructive AND an earlier migration is added by the same
//      push (the expand step it follows has not been deployed yet);
//   3. a single added migration both expands and contracts.
//   4. the drizzle journal (drizzle/meta/_journal.json) changed an entry that existed at <base>:
//      the journal is append-only — a changed tag, order or timestamp makes drizzle skip or
//      re-run a migration on a database that already recorded the old entry.
// One exemption: when <base> has no migrations at all, nothing has ever been deployed against this
// schema, so there is no previous version to roll back to and rule 2 and 3 do not apply.
//
// Fails closed: a base that cannot be resolved, a failing git command or unreadable file is an
// error, never a pass. It always prints how many files it compared.
//
// "Destructive" = a statement after which the previous Worker version can break:
//   DROP <anything> except DROP INDEX / DROP CONSTRAINT / DROP NOT NULL (those only relax),
//   RENAME, SET NOT NULL, a column type change, TRUNCATE,
//   ADD COLUMN … NOT NULL with no DEFAULT (the previous version's INSERTs do not supply it).
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ZERO_SHA = /^0{40}$/;
const SHA = /^[0-9a-f]{40}$/;

class CheckError extends Error {}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** SQL with comments and quoted text blanked, so a word inside a string or comment never counts. */
export function stripSql(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, " '' ")
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '"x"');
}

const SAFE_DROP = /^(INDEX|CONSTRAINT|NOT\s+NULL)\b/i;

/** The destructive statements of one migration file, as short labels. */
export function destructiveStatements(sql) {
  const text = stripSql(sql);
  const found = [];
  for (const m of text.matchAll(/\bDROP\s+((?:[A-Za-z]+\s+){0,2}[A-Za-z]+)/gi)) {
    if (!SAFE_DROP.test(m[1]))
      found.push(`DROP ${m[1].trim().split(/\s+/).slice(0, 2).join(" ").toUpperCase()}`);
  }
  if (/\bRENAME\s+(TO|COLUMN|CONSTRAINT)\b/i.test(text)) found.push("RENAME");
  if (/\bSET\s+NOT\s+NULL\b/i.test(text)) found.push("SET NOT NULL");
  if (/\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i.test(text)) found.push("ALTER COLUMN TYPE");
  if (/\bTRUNCATE\b/i.test(text)) found.push("TRUNCATE");
  if (addsRequiredColumn(text)) found.push("ADD COLUMN NOT NULL without DEFAULT");
  return found;
}

/**
 * True when an ALTER TABLE adds a column that is NOT NULL and has no DEFAULT (nor is generated or
 * an identity/serial column): the previous Worker version's INSERTs, which do not name the
 * column, fail from the moment the migration is applied. `text` is already stripped.
 */
function addsRequiredColumn(text) {
  for (const statement of text.split(";")) {
    if (!/\bALTER\s+TABLE\b/i.test(statement)) continue;
    // Each ADD [COLUMN] clause, up to the next top-level action or the end of the statement.
    const clauses = statement.split(/,\s*(?=(?:ADD|DROP|ALTER|RENAME)\b)/i);
    for (const clause of clauses) {
      const add =
        /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?!CONSTRAINT\b|PRIMARY\b|UNIQUE\b|FOREIGN\b|CHECK\b|VALUE\b)(\S+)\s+([\s\S]*)$/i.exec(
          clause,
        );
      if (!add) continue;
      const definition = add[2];
      if (!/\bNOT\s+NULL\b/i.test(definition)) continue;
      if (/\b(DEFAULT|GENERATED|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(definition)) continue;
      return true;
    }
  }
  return false;
}

const JOURNAL = "meta/_journal.json";

/** The journal's entries at a commit, or null when there is no journal there. */
function journalAt(cwd, commit, dir) {
  let raw;
  try {
    raw = git(cwd, ["show", `${commit}:${dir}/${JOURNAL}`]);
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CheckError(`${dir}/${JOURNAL} at ${commit} is not JSON`);
  }
  if (!parsed || !Array.isArray(parsed.entries))
    throw new CheckError(`${dir}/${JOURNAL} at ${commit} has no entries`);
  return parsed.entries;
}

/** Problems with how the journal changed: it may only grow at its end. */
export function journalProblems(before, after, dir = "drizzle") {
  if (before === null) return [];
  const file = `${dir}/${JOURNAL}`;
  if (after === null) return [`${file}: existed at the base and is gone — the journal is append-only`];
  const problems = [];
  if (after.length < before.length)
    problems.push(
      `${file}: ${before.length - after.length} entr(y/ies) removed — the journal is append-only`,
    );
  before.forEach((entry, index) => {
    const now = after[index];
    if (now === undefined) return;
    if (JSON.stringify(entry) !== JSON.stringify(now))
      problems.push(
        `${file}: entry ${index} (${entry.tag}) changed after it was pushed — the journal is append-only; add a new migration instead`,
      );
  });
  return problems;
}

/** True when the file adds schema that new code depends on (an expand step). */
export function expands(sql) {
  const text = stripSql(sql);
  return (
    /\bCREATE\s+(TABLE|TYPE|SCHEMA|(UNIQUE\s+)?INDEX|VIEW|SEQUENCE)\b/i.test(text) ||
    /\bADD\s+(COLUMN|CONSTRAINT|VALUE)\b/i.test(text)
  );
}

function resolveCommit(cwd, ref, label) {
  if (!ref) throw new CheckError(`${label} is empty`);
  if (ZERO_SHA.test(ref)) {
    throw new CheckError(
      `${label} is the all-zero sha (a new branch has no previous deploy to compare with); pass the commit it was cut from`,
    );
  }
  if (!SHA.test(ref) && !/^[A-Za-z0-9._/~^-]+$/.test(ref))
    throw new CheckError(`${label} is not a commit sha or ref name`);
  try {
    return git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]).trim();
  } catch {
    throw new CheckError(
      `${label} '${ref}' is not a commit in this checkout (shallow clone, or a force-push removed it) — cannot compare`,
    );
  }
}

function migrationFilesAt(cwd, commit, dir) {
  const out = git(cwd, ["ls-tree", "-r", "--name-only", commit, "--", dir]);
  return out
    .split("\n")
    .filter((p) => p.endsWith(".sql"))
    .sort();
}

/**
 * Compare the migrations of two commits.
 * @returns {{ ok: boolean, problems: string[], notes: string[], added: string[], baseCount: number }}
 */
export function checkMigrations({ cwd, base, head = "HEAD", dir = "drizzle" }) {
  const baseCommit = resolveCommit(cwd, base, "--base");
  const headCommit = resolveCommit(cwd, head, "--head");
  const atBase = migrationFilesAt(cwd, baseCommit, dir);
  const atHead = migrationFilesAt(cwd, headCommit, dir);
  const baseSet = new Set(atBase);
  const headSet = new Set(atHead);
  const problems = [];
  const notes = [];

  // Rule 1: applied migrations are immutable.
  for (const file of atBase) {
    if (!headSet.has(file)) {
      problems.push(
        `${file}: existed at the base and is gone (deleted or renamed) — an applied migration is immutable`,
      );
      continue;
    }
    const before = git(cwd, ["rev-parse", `${baseCommit}:${file}`]).trim();
    const after = git(cwd, ["rev-parse", `${headCommit}:${file}`]).trim();
    if (before !== after)
      problems.push(
        `${file}: edited after it was pushed — an applied migration is immutable; add a new migration instead`,
      );
  }

  // Rule 4: the journal only grows.
  problems.push(...journalProblems(journalAt(cwd, baseCommit, dir), journalAt(cwd, headCommit, dir), dir));

  const added = atHead.filter((f) => !baseSet.has(f));
  const firstEver = atBase.length === 0;
  if (firstEver && added.length > 0) {
    notes.push(
      `the base has no migrations: this is the first schema deploy, so the expand/contract rule does not apply to these ${added.length} file(s)`,
    );
  }

  if (!firstEver) {
    const earlierAdded = [];
    for (const file of added) {
      const sql = git(cwd, ["show", `${headCommit}:${file}`]);
      const destructive = destructiveStatements(sql);
      if (destructive.length > 0) {
        const what = [...new Set(destructive)].join(", ");
        if (expands(sql)) {
          problems.push(
            `${file}: expands and contracts in one migration (${what}) — split it and ship the contract part one deploy later`,
          );
        } else if (earlierAdded.length > 0) {
          problems.push(
            `${file}: destructive (${what}) and pushed together with ${earlierAdded.join(", ")} — the contract migration ships one deploy after its expand migration`,
          );
        } else {
          notes.push(
            `${file}: destructive (${what}), added alone on top of already-deployed migrations — allowed`,
          );
        }
      }
      earlierAdded.push(file);
    }
  }

  return { ok: problems.length === 0, problems, notes, added, baseCount: atBase.length };
}

function report(result, base, head) {
  console.log(
    `check-migrations: base ${base} → head ${head}: ${result.baseCount} migration(s) at the base, ${result.added.length} added`,
  );
  for (const file of result.added) console.log(`  added: ${file}`);
  for (const note of result.notes) console.log(`  note: ${note}`);
  for (const problem of result.problems) console.error(`  FAIL: ${problem}`);
  console.log(result.ok ? "check-migrations: OK" : `check-migrations: ${result.problems.length} problem(s)`);
}

// ── self-test: real git repositories, the real code path ───────────────────────────────────────
function selfTest() {
  const root = mkdtempSync(join(tmpdir(), "holdfast-check-migrations-"));
  let failures = 0;
  let n = 0;

  const repo = () => {
    const cwd = join(root, `repo-${++n}`);
    mkdirSync(join(cwd, "drizzle"), { recursive: true });
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.email", "selftest@example.invalid"]);
    git(cwd, ["config", "user.name", "self-test"]);
    git(cwd, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(cwd, "README"), "fixture\n");
    return cwd;
  };
  const commit = (cwd, files) => {
    for (const [name, body] of Object.entries(files)) {
      if (body === null) rmSync(join(cwd, name));
      else writeFileSync(join(cwd, name), body);
    }
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "--allow-empty", "-m", "fixture"]);
    return git(cwd, ["rev-parse", "HEAD"]).trim();
  };
  const expectResult = (label, want, run) => {
    let got;
    let detail = "";
    try {
      const result = run();
      got = result.ok ? "pass" : "fail";
      detail = result.problems.join(" | ");
    } catch (error) {
      if (!(error instanceof CheckError)) throw error;
      got = "error";
      detail = error.message;
    }
    const ok = got === want;
    if (!ok) failures++;
    console.log(
      `  ${ok ? "ok   " : "WRONG"} ${label} → ${got}${ok ? "" : `, expected ${want}`}${detail ? `\n          ${detail}` : ""}`,
    );
  };

  const CREATE = "CREATE TABLE notes (id text PRIMARY KEY, body text);\n";
  const ADD = "ALTER TABLE notes ADD COLUMN title text;\n";
  const DROP = "ALTER TABLE notes DROP COLUMN body;\n";

  try {
    {
      // The forbidden form: expand and contract arrive in one push.
      const cwd = repo();
      const base = commit(cwd, { "drizzle/0000_init.sql": CREATE });
      const head = commit(cwd, { "drizzle/0001_add_title.sql": ADD, "drizzle/0002_drop_body.sql": DROP });
      expectResult("DROP COLUMN in the same push as its expand step", "fail", () =>
        checkMigrations({ cwd, base, head }),
      );
    }
    {
      // The required form: two pushes.
      const cwd = repo();
      commit(cwd, { "drizzle/0000_init.sql": CREATE });
      const afterExpand = commit(cwd, { "drizzle/0001_add_title.sql": ADD });
      const afterContract = commit(cwd, { "drizzle/0002_drop_body.sql": DROP });
      const first = git(cwd, ["rev-parse", `${afterExpand}~1`]).trim();
      expectResult("two-push form, push 1 (expand only)", "pass", () =>
        checkMigrations({ cwd, base: first, head: afterExpand }),
      );
      expectResult("two-push form, push 2 (contract only)", "pass", () =>
        checkMigrations({ cwd, base: afterExpand, head: afterContract }),
      );
      expectResult("the same two commits pushed as one", "fail", () =>
        checkMigrations({ cwd, base: first, head: afterContract }),
      );
    }
    {
      const cwd = repo();
      const base = commit(cwd, { "drizzle/0000_init.sql": CREATE });
      const head = commit(cwd, { "drizzle/0001_swap.sql": ADD + DROP });
      expectResult("one migration that adds and drops", "fail", () => checkMigrations({ cwd, base, head }));
    }
    {
      const cwd = repo();
      const base = commit(cwd, { "drizzle/0000_init.sql": CREATE });
      const edited = commit(cwd, { "drizzle/0000_init.sql": CREATE + "-- edited\n" });
      expectResult("an already-pushed migration edited", "fail", () =>
        checkMigrations({ cwd, base, head: edited }),
      );
      const deleted = commit(cwd, { "drizzle/0000_init.sql": null });
      expectResult("an already-pushed migration deleted", "fail", () =>
        checkMigrations({ cwd, base, head: deleted }),
      );
    }
    {
      const cwd = repo();
      const base = commit(cwd, { "drizzle/0000_init.sql": CREATE });
      const head = commit(cwd, { README: "changed\n" });
      expectResult("no migration added", "pass", () => checkMigrations({ cwd, base, head }));
      const relax = commit(cwd, {
        "drizzle/0001_idx.sql": "CREATE INDEX notes_body ON notes (body);\n",
        "drizzle/0002_relax.sql":
          "DROP INDEX notes_body;\nALTER TABLE notes ALTER COLUMN body DROP NOT NULL;\n-- DROP TABLE notes\nUPDATE notes SET body = 'DROP TABLE x';\n",
      });
      expectResult("DROP INDEX / DROP NOT NULL, and DROP inside a comment or a string", "pass", () =>
        checkMigrations({ cwd, base: head, head: relax }),
      );
      const rename = commit(cwd, {
        "drizzle/0003_more.sql": ADD,
        "drizzle/0004_rename.sql": "ALTER TABLE notes RENAME COLUMN body TO text;\n",
      });
      expectResult("RENAME COLUMN in the same push as an expand step", "fail", () =>
        checkMigrations({ cwd, base: relax, head: rename }),
      );
    }
    {
      // A required column with no default breaks the previous version's INSERTs at once.
      const cwd = repo();
      const base = commit(cwd, { "drizzle/0000_init.sql": CREATE });
      const required = commit(cwd, {
        "drizzle/0001_required.sql": "ALTER TABLE notes ADD COLUMN owner text NOT NULL;\n",
      });
      expectResult("ADD COLUMN … NOT NULL with no DEFAULT", "fail", () =>
        checkMigrations({ cwd, base, head: required }),
      );
      const cwd2 = repo();
      const base2 = commit(cwd2, { "drizzle/0000_init.sql": CREATE });
      const fine = commit(cwd2, {
        "drizzle/0001_fine.sql":
          'ALTER TABLE notes ADD COLUMN "owner" text DEFAULT \'x\' NOT NULL;\nALTER TABLE "notes" ADD COLUMN "seen_at" timestamp with time zone;\nALTER TABLE notes ADD CONSTRAINT notes_title_nn CHECK (title IS NOT NULL) NOT VALID;\n',
      });
      expectResult("ADD COLUMN … NOT NULL with a DEFAULT, a nullable column, a constraint", "pass", () =>
        checkMigrations({ cwd: cwd2, base: base2, head: fine }),
      );
      const cwd3 = repo();
      const base3 = commit(cwd3, { "drizzle/0000_init.sql": CREATE });
      const second = commit(cwd3, {
        "drizzle/0001_two.sql": "ALTER TABLE notes ADD COLUMN a text, ADD COLUMN b integer NOT NULL;\n",
      });
      expectResult("the second ADD of one ALTER is the required one", "fail", () =>
        checkMigrations({ cwd: cwd3, base: base3, head: second }),
      );
    }
    {
      // The journal is append-only.
      const entry = (idx, tag, when = 1000 + idx) => ({ idx, version: "7", when, tag, breakpoints: true });
      const journal = (...entries) => JSON.stringify({ version: "7", dialect: "postgresql", entries }) + "\n";
      const cwd = repo();
      mkdirSync(join(cwd, "drizzle/meta"), { recursive: true });
      const base = commit(cwd, {
        "drizzle/0000_init.sql": CREATE,
        "drizzle/meta/_journal.json": journal(entry(0, "0000_init")),
      });
      const appended = commit(cwd, {
        "drizzle/0001_add_title.sql": ADD,
        "drizzle/meta/_journal.json": journal(entry(0, "0000_init"), entry(1, "0001_add_title")),
      });
      expectResult("journal: an entry appended", "pass", () =>
        checkMigrations({ cwd, base, head: appended }),
      );
      const retimed = commit(cwd, {
        "drizzle/meta/_journal.json": journal(entry(0, "0000_init", 999999), entry(1, "0001_add_title")),
      });
      expectResult("journal: an existing entry's timestamp changed", "fail", () =>
        checkMigrations({ cwd, base: appended, head: retimed }),
      );
      const retagged = commit(cwd, {
        "drizzle/meta/_journal.json": journal(entry(0, "0000_first"), entry(1, "0001_add_title")),
      });
      expectResult("journal: an existing entry renamed", "fail", () =>
        checkMigrations({ cwd, base: appended, head: retagged }),
      );
      const dropped = commit(cwd, { "drizzle/meta/_journal.json": journal(entry(0, "0000_init")) });
      expectResult("journal: an entry removed", "fail", () =>
        checkMigrations({ cwd, base: appended, head: dropped }),
      );
      const gone = commit(cwd, { "drizzle/meta/_journal.json": null });
      expectResult("journal: the file deleted", "fail", () =>
        checkMigrations({ cwd, base: appended, head: gone }),
      );
    }
    {
      // First schema deploy: nothing older exists to roll back to.
      const cwd = repo();
      const base = commit(cwd, { README: "no migrations yet\n" });
      const head = commit(cwd, { "drizzle/0000_init.sql": CREATE, "drizzle/0001_drop.sql": DROP });
      expectResult("first schema deploy (the base has no migrations)", "pass", () =>
        checkMigrations({ cwd, base, head }),
      );
    }
    {
      const cwd = repo();
      const head = commit(cwd, { "drizzle/0000_init.sql": CREATE });
      expectResult("base that is not in the checkout", "error", () =>
        checkMigrations({ cwd, base: "1".repeat(40), head }),
      );
      expectResult("all-zero base (new branch)", "error", () =>
        checkMigrations({ cwd, base: "0".repeat(40), head }),
      );
      expectResult("empty base", "error", () => checkMigrations({ cwd, base: "", head }));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  if (failures > 0) {
    console.error(`check-migrations --self-test: ${failures} case(s) gave the wrong verdict`);
    process.exit(1);
  }
  console.log("check-migrations --self-test: OK");
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  const base = arg("--base") ?? process.env.MIGRATIONS_BASE_SHA ?? "";
  const head = arg("--head") ?? "HEAD";
  const dir = arg("--dir") ?? "drizzle";
  try {
    const result = checkMigrations({ cwd: process.cwd(), base, head, dir });
    report(result, base, head);
    process.exit(result.ok ? 0 : 1);
  } catch (error) {
    if (!(error instanceof CheckError)) throw error;
    console.error(`check-migrations: cannot run the check: ${error.message}`);
    process.exit(1);
  }
}

main(process.argv.slice(2));
