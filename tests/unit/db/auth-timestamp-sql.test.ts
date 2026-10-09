// The SQL rule for Better Auth's zone-less timestamps, as a source scan (no database):
// no query module compares one with a bare `now()`, and nothing sets a session time zone.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import * as authSchema from "../../../src/worker/db/auth-schema";
import {
  bareNowViolations,
  sessionZoneLines,
  statements,
  stripComments,
  zonelessTimestampColumns,
} from "./_sql-rule-scan";

const ROOT = join(import.meta.dirname, "../../..");

function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // scripts/spikes is git-ignored scratch.
    if (entry === "node_modules" || entry === "spikes") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) filesUnder(path, out);
    else if (/\.(ts|tsx|mts|mjs|js|sh)$/.test(entry)) out.push(path);
  }
  return out;
}

const columns = zonelessTimestampColumns(authSchema);

describe("the column list comes from the generated auth schema", () => {
  it("finds the zone-less timestamp columns of all generated tables", () => {
    const names = columns.map((c) => c.property);
    for (const expected of [
      "user.createdAt",
      "user.updatedAt",
      "user.banExpires",
      "user.ageVerifiedAt",
      "user.termsAcceptedAt",
      "user.suspendedAt",
      "user.deleteScheduledAt",
      "session.expiresAt",
      "session.createdAt",
      "session.updatedAt",
      "account.accessTokenExpiresAt",
      "account.refreshTokenExpiresAt",
      "verification.expiresAt",
      "passkey.createdAt",
      "twoFactor.lockedUntil",
    ]) {
      expect(names).toContain(expected);
    }
    // Not a timestamp: must not be in the list.
    expect(names).not.toContain("user.email");
    expect(names).not.toContain("rateLimit.lastRequest");
  });
});

describe("controls: what the scan flags", () => {
  const flagged = (source: string) => bareNowViolations(source, columns).length > 0;

  it("flags a bare now() against a table-qualified auth column", () => {
    expect(flagged('const q = sql`SELECT 1 FROM "user" WHERE "user"."delete_scheduled_at" < now()`;')).toBe(
      true,
    );
  });

  it("flags a Drizzle comparison of an auth column with now()", () => {
    expect(flagged("const c = lt(session.expiresAt, sql`now()`);")).toBe(true);
  });

  it("does not flag the UTC form", () => {
    expect(
      flagged(
        `const q = sql\`SELECT 1 FROM "user" WHERE "user"."delete_scheduled_at" < (now() AT TIME ZONE 'UTC')\`;`,
      ),
    ).toBe(false);
  });

  it("does not flag a timestamptz column of ours that merely shares a name", () => {
    expect(flagged("const q = sql`SELECT 1 FROM invites WHERE invites.expires_at > now()`;")).toBe(false);
    expect(flagged("const c = gt(invites.expiresAt, sql`now()`);")).toBe(false);
    expect(flagged("const q = sql`SELECT 1 FROM share_links WHERE expires_at > now()`;")).toBe(false);
  });

  it("flags the other spellings too", () => {
    expect(flagged("const q = sql`DELETE FROM session WHERE session.expires_at < now()`;")).toBe(true);
    expect(flagged('const q = sql`SELECT 1 FROM "user" WHERE "user".ban_expires > CURRENT_TIMESTAMP`;')).toBe(
      true,
    );
    expect(flagged("const c = gte(user.banExpires, sql`NOW ( )`);")).toBe(true);
    expect(flagged("const q = sql`UPDATE x SET y = 1 WHERE ${user.deleteScheduledAt} <= now()`;")).toBe(true);
    // A nested template is part of the outer statement.
    expect(flagged('const q = sql`SELECT 1 FROM "user" WHERE "user".suspended_at < ${sql`now()`}`;')).toBe(
      true,
    );
  });

  it("ignores comments", () => {
    expect(flagged('// "user"."delete_scheduled_at" < now()\nconst x = 1;')).toBe(false);
    expect(flagged('/* sql`"user".ban_expires < now()` */\nconst x = 1;')).toBe(false);
    expect(stripComments("a // b\nc /* d */ e")).toBe("a     \nc         e");
  });

  it("reports the line of the statement", () => {
    const source =
      'const a = 1;\n\nconst q = sql`\n  SELECT 1 FROM "user"\n  WHERE "user".ban_expires < now()`;';
    expect(bareNowViolations(source, columns).map((v) => v.line)).toEqual([3]);
  });

  it("flags session time zone settings, and not SET LOCAL of something else", () => {
    const hit = (source: string) => sessionZoneLines(source).length > 0;
    expect(hit("await db.execute(sql`SET TIME ZONE 'UTC'`);")).toBe(true);
    expect(hit("client.query(\"SET timezone = 'UTC'\");")).toBe(true);
    expect(hit("await db.execute(sql`set session time zone 'UTC'`);")).toBe(true);
    expect(
      hit("await db.execute(sql`SET SESSION statement_timeout = 5; SET SESSION timezone TO 'UTC'`);"),
    ).toBe(true);
    expect(hit("await tx.execute(sql`SET LOCAL TIME ZONE 'UTC'`);")).toBe(true);
    expect(hit('const url = base + "?options=-c%20timezone%3DUTC";')).toBe(true);
    expect(hit('const url = base + "?options=-c timezone=UTC";')).toBe(true);
    expect(hit('const url = base + "&timezone=UTC";')).toBe(true);
    expect(hit("await tx.execute(sql`SELECT set_config('timezone', 'UTC', false)`);")).toBe(true);

    expect(hit("await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);")).toBe(false);
    expect(hit("await tx.execute(sql`SET LOCAL enable_seqscan = off`);")).toBe(false);
    expect(hit("const timezone = body.timezone; user.timezone = timezone;")).toBe(false);
    expect(hit("// SET TIME ZONE 'UTC' is never used")).toBe(false);
    expect(hit("sql`now() AT TIME ZONE 'UTC'`")).toBe(false);
  });
});

describe("the query modules", () => {
  const dir = join(ROOT, "src/worker/db/queries");
  const files = filesUnder(dir);

  it("the scan reads real statements (a scan that saw nothing must not pass)", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
    const total = files.reduce((n, file) => n + statements(readFileSync(file, "utf8")).length, 0);
    expect(total).toBeGreaterThan(100);
    // The one place that compares an auth timestamp in SQL is seen, and it uses the UTC form.
    const users = readFileSync(join(dir, "users.ts"), "utf8");
    const seen = statements(users).filter((s) => columns.some((c) => c.sqlPattern.test(s.text)));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => /now\(\) AT TIME ZONE 'UTC'/.test(s.text))).toBe(true);
  });

  it("no statement compares an auth timestamp column with a bare now()", () => {
    const violations = files.flatMap((file) =>
      bareNowViolations(readFileSync(file, "utf8"), columns).map(
        (v) => `${relative(ROOT, file)}:${v.line} ${v.column} — ${v.text.replace(/\s+/g, " ")}`,
      ),
    );
    expect(violations).toEqual([]);
  });
});

describe("no session time zone anywhere", () => {
  it("nothing under src/worker or scripts sets one", () => {
    const files = [...filesUnder(join(ROOT, "src/worker")), ...filesUnder(join(ROOT, "scripts"))];
    expect(files.length).toBeGreaterThan(25);
    const hits = files.flatMap((file) =>
      sessionZoneLines(readFileSync(file, "utf8"), { raw: file.endsWith(".sh") }).map(
        (line) => `${relative(ROOT, file)}:${line}`,
      ),
    );
    expect(hits).toEqual([]);
  });

  it("drizzle.config.ts and the database client pass no zone option", () => {
    for (const file of ["drizzle.config.ts", "src/worker/db/client.ts"]) {
      expect(sessionZoneLines(readFileSync(join(ROOT, file), "utf8"))).toEqual([]);
    }
    expect(readFileSync(join(ROOT, "src/worker/db/client.ts"), "utf8")).not.toMatch(
      /\.on\(\s*["']connect["']/,
    );
  });
});
