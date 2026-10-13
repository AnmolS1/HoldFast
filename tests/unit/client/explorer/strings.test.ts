import { describe, expect, it } from "vitest";
import { messages, t } from "../../../../src/client/features/explorer/strings";

// The three checks of tests/unit/client/shell/lib.test.ts ("voice: …"), over this feature's catalogue.
describe("voice of the explorer's strings", () => {
  const entries = Object.entries(messages);

  it("the catalogue is not empty and every value is text", () => {
    expect(entries.length).toBeGreaterThan(50);
    for (const [key, text] of entries) expect(text.trim(), key).not.toBe("");
  });

  it("no exclamation marks", () => {
    for (const [key, text] of entries) expect(text, key).not.toContain("!");
  });

  it("no emoji", () => {
    for (const [key, text] of entries) expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
  });

  it("no all-caps labels", () => {
    for (const [key, text] of entries) {
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
    }
  });

  it("the exact sentences the task quotes", () => {
    expect(messages["explorer.zip.tooLarge"]).toBe(
      "Too large to zip in this browser — download the items individually.",
    );
    expect(messages["explorer.status.stillScanning"]).toBe("Still scanning");
    expect(t("explorer.zip.count", { done: 3, total: 12 })).toBe("Zipping 3 of 12");
  });
});
