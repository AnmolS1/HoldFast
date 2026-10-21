// Source scans of the console's own rules:
//  - `includeHidden` (permissions.ts's door to hidden nodes) is used ONLY by the admin console's
//    two Worker files. The scan is over CALLERS: permissions.ts itself — the definition — is left
//    out, and so are comments (a sentence that names the option is not a use of it).
//  - No admin answer is mapped by the owner/partner mapper: `toNodeDto` / `toNodeDtos` are not
//    called from routes/admin.ts or services/admin-actions.ts (they throw on hidden rows; the
//    admin variant `toAdminNodeDtos` is the one used).
//  - The admin Worker files mint no content URL: no files-host token minting, no `/t/` `/i/` `/d/` path.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const at = (suffix: string) => {
  const key = Object.keys(sources).find((path) => path.endsWith(suffix));
  if (!key) throw new Error(`no source ${suffix}`);
  return sources[key]!;
};

/**
 * The code without its comment LINES (`//`, and the lines of a doc comment), so a sentence is not
 * counted as a use. Block comments are not stripped as spans: a slash-star inside a string (a
 * glob, a cron expression) would be read as one end of one.
 */
const code = (text: string) => text.replace(/^\s*(\/\/|\/\*|\*).*$/gm, "");

const ADMIN_FILES = ["src/worker/routes/admin.ts", "src/worker/services/admin-actions.ts"];
const DEFINITION = "src/worker/services/permissions.ts";

describe("source scans", () => {
  it("the scan sees the source tree (control: the definition names includeHidden)", () => {
    expect(Object.keys(sources).length).toBeGreaterThan(100);
    expect(code(at(DEFINITION))).toContain("includeHidden");
  });

  it("includeHidden is used only in routes/admin.ts and services/admin-actions.ts (the definition excluded)", () => {
    const users = Object.entries(sources)
      .filter(([path]) => !path.endsWith(DEFINITION))
      .filter(([, text]) => /\bincludeHidden\b/.test(code(text)))
      .map(([path]) => path.replace(/^\//, ""));
    for (const path of users) expect(ADMIN_FILES, path).toContain(path);
  });

  it("no admin answer goes through toNodeDto / toNodeDtos; the admin variant is what they use", () => {
    for (const file of ADMIN_FILES) {
      const text = code(at(file));
      expect(text, file).not.toMatch(/\btoNodeDtos?\s*\(/);
    }
    expect(code(at("src/worker/routes/admin.ts"))).toMatch(/\btoAdminNodeDtos\s*\(/);
  });

  it("the admin Worker files mint no content URL and read no object's bytes", () => {
    for (const file of [...ADMIN_FILES, "src/worker/db/queries/admin.ts"]) {
      const text = code(at(file));
      expect(text, file).not.toMatch(/\bmint[A-Za-z]*\s*\(/);
      expect(text, file).not.toMatch(/FILES_ORIGIN/);
      expect(text, file).not.toMatch(/["'`]\/(t|i|d)\//);
    }
  });
});
