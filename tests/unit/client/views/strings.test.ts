// The voice of the five catalogues, checked the way the shell checks its own (lib.test.ts,
// "voice: …"): plain and exact — no exclamation mark, no emoji, no all-caps label.
import { describe, expect, it } from "vitest";
import { messages as recent } from "../../../../src/client/features/recent/strings";
import { messages as search } from "../../../../src/client/features/search/strings";
import { messages as starred } from "../../../../src/client/features/starred/strings";
import { messages as trash } from "../../../../src/client/features/trash/strings";
import { messages as usage } from "../../../../src/client/features/usage/strings";
import { en } from "../../../../src/client/lib/en";

const CATALOGUES: Record<string, Record<string, string>> = { recent, search, starred, trash, usage };

describe.each(Object.entries(CATALOGUES))("voice: %s/strings.ts", (_name, catalogue) => {
  const entries = Object.entries(catalogue);

  it("has strings", () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it("no exclamation marks", () => {
    for (const [key, text] of entries) expect(text, key).not.toContain("!");
  });

  it("no emoji", () => {
    for (const [key, text] of entries) expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
  });

  it("no all-caps labels (more than four letters, all upper case)", () => {
    for (const [key, text] of entries) {
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
    }
  });
});

describe("the catalogues", () => {
  it("the exact sentences the specification quotes", () => {
    expect(trash["trash.restore.conflict"]).toBe("Restore the folder this was in first");
    expect(usage["usage.note"]).toBe(
      "Items in the trash and earlier versions of replaced files count toward your storage until they're deleted for good.",
    );
    expect(trash["trash.emptyTrash.progress"]).toBe("Deleting… {remaining} left");
    expect(trash["trash.delete.consequence"]).toBe("This can't be undone. {count} items.");
  });

  it("no key of a feature shadows a key of the shell's catalogue", () => {
    for (const [name, catalogue] of Object.entries(CATALOGUES)) {
      for (const key of Object.keys(catalogue)) expect(Object.hasOwn(en, key), `${name}: ${key}`).toBe(false);
    }
  });
});
