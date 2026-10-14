// The preview's own catalogue, held to the product's voice (the three checks of the shell's
// "voice: …" test, over every value here), and the exact sentences the task quotes.
import { describe, expect, it } from "vitest";
import { messages, t } from "../../../../src/client/features/preview/strings";

describe("preview strings", () => {
  it("voice: no exclamation marks, no all-caps labels, no emoji", () => {
    const entries = Object.entries(messages);
    expect(entries.length).toBeGreaterThan(30);
    for (const [key, text] of entries) {
      expect(text, key).not.toContain("!");
      expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
    }
  });

  it("control: the three checks do catch what they are for", () => {
    const bad = { a: "Done!", b: "PREVIEW", c: "Nice \u{1F600}" };
    expect(bad.a.includes("!")).toBe(true);
    const letters = bad.b.replace(/[^A-Za-z]/g, "");
    expect(letters.length > 4 && letters === letters.toUpperCase()).toBe(true);
    expect(/\p{Extended_Pictographic}/u.test(bad.c)).toBe(true);
  });

  it("the sentences the task quotes", () => {
    expect(messages["image.heic"]).toBe("Original is HEIC — download for full quality");
    expect(messages["none.tooLarge"]).toBe("Too large to preview — download");
    expect(messages["media.unsupported"]).toBe("Your browser can't play this — download");
    expect(messages["pdf.leave.title"]).toBe("You're leaving Holdfast");
    expect(messages["scan.pending"]).toBe("Scanning…");
  });

  it("holes are filled like the shell's", () => {
    expect(t("preview.position", { index: 2, count: 7 })).toBe("2 of 7");
    expect(t("pdf.capped", { shown: 500, count: 812 })).toBe(
      "Showing the first 500 of 812 pages. Download the file for the rest.",
    );
  });
});
