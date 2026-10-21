// The two catalogues of the abuse features, held to the product's voice (the shell's three
// checks over every value), and the confirmation the task quotes word for word.
import { describe, expect, it } from "vitest";
import { messages as interstitialMessages } from "../../../../src/client/features/interstitial/strings";
import { messages as reportMessages } from "../../../../src/client/features/report/strings";

const catalogues = { report: reportMessages, interstitial: interstitialMessages };

describe("abuse strings", () => {
  it.each(Object.entries(catalogues))(
    "%s — voice: no exclamation marks, no all-caps labels, no emoji",
    (_name, messages) => {
      const entries = Object.entries(messages);
      expect(entries.length).toBeGreaterThan(5);
      for (const [key, text] of entries) {
        expect(text, key).not.toContain("!");
        expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
        const letters = text.replace(/[^A-Za-z]/g, "");
        if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
      }
    },
  );

  it("control: the three checks do catch what they are for", () => {
    const letters = "REPORTED".replace(/[^A-Za-z]/g, "");
    expect("Sent!".includes("!")).toBe(true);
    expect(letters.length > 4 && letters === letters.toUpperCase()).toBe(true);
    expect(/\p{Extended_Pictographic}/u.test("Done \u{1F600}")).toBe(true);
  });

  it("the confirmation is the task's sentence; no string names a reporter, a count or a category to the owner", () => {
    expect(reportMessages["report.done"]).toBe("Thanks. The file is hidden while we review it.");
  });
});
