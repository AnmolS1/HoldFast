// The time zone lives on `user` and nowhere else (R2.54): `user_prefs` has no such column in the
// schema or in any migration, and no statement of the source that names the preferences table
// names a time zone. (The route test proves a profile write lands on `user.timezone`:
// tests/unit/account/profile-prefs.test.ts.)
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});
const migrations = import.meta.glob<string>(["/drizzle/*.sql"], {
  query: "?raw",
  import: "default",
  eager: true,
});

describe("where the time zone lives", () => {
  it("the user_prefs table has no time zone column, in the schema and in every migration", () => {
    const schema = sources["/src/worker/db/schema.ts"]!;
    const table = schema.slice(schema.indexOf('pgTable("user_prefs"'));
    const block = table.slice(0, table.indexOf("});"));
    expect(block).toContain("viewMode");
    expect(block.toLowerCase()).not.toContain("timezone");
    expect(block.toLowerCase()).not.toContain("time_zone");
    expect(sources["/src/worker/db/auth-schema.ts"]).toContain('timezone: text("timezone")');
    expect(Object.keys(migrations).length).toBeGreaterThan(0);
    for (const [path, sql] of Object.entries(migrations)) {
      for (const match of sql.matchAll(/"user_prefs"[^;]*;/g))
        expect(match[0].toLowerCase(), path).not.toContain("timezone");
    }
  });

  it("no statement that names the preferences table names a time zone", () => {
    const offenders: string[] = [];
    for (const [path, code] of Object.entries(sources)) {
      for (const match of code.matchAll(/\b(?:userPrefs|user_prefs)\b[^;]*;/g)) {
        if (/time_?zone/i.test(match[0])) offenders.push(`${path}: ${match[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
