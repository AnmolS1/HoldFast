// T23 review M1: the session answer carries no `usedBytes` (auth/fields.ts `returned: false`). So
// no code may read it from a session user: every reader outside the database layer reads the
// usage route's answer (`usage`, `data` of the usage query) or the export's own account row.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["/src/**/*.{ts,tsx}"], {
  query: "?raw",
  import: "default",
  eager: true,
});

const READERS = new Set(["usage", "data", "account"]);

describe("who reads usedBytes", () => {
  it("nothing outside the database layer reads it from anything but the usage answer or the export's row", () => {
    const strays: string[] = [];
    for (const [path, code] of Object.entries(sources)) {
      if (path.startsWith("/src/worker/db/") || path.startsWith("/src/shared/")) continue;
      for (const match of code.matchAll(/\b([A-Za-z_$][\w$]*)\??\.usedBytes\b/g)) {
        if (!READERS.has(match[1]!)) strays.push(`${path}: ${match[0]}`);
      }
    }
    expect(strays).toEqual([]);
  });
});
