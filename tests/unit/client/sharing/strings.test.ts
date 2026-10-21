// The three catalogues of the sharing features, held to the product's voice (the shell's three
// checks over every value), and the sentences the task quotes word for word.
import { describe, expect, it } from "vitest";
import { messages as publicMessages } from "../../../../src/client/features/public-link/strings";
import { messages as shareMessages } from "../../../../src/client/features/share/strings";
import { messages as byMeMessages } from "../../../../src/client/features/shared-by-me/strings";

const catalogues = { share: shareMessages, "public-link": publicMessages, "shared-by-me": byMeMessages };

describe("sharing strings", () => {
  it.each(Object.entries(catalogues))(
    "%s — voice: no exclamation marks, no all-caps labels, no emoji",
    (_name, messages) => {
      const entries = Object.entries(messages);
      expect(entries.length).toBeGreaterThan(20);
      for (const [key, text] of entries) {
        expect(text, key).not.toContain("!");
        expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
        const letters = text.replace(/[^A-Za-z]/g, "");
        if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
      }
    },
  );

  it("control: the three checks do catch what they are for", () => {
    const bad = { a: "Shared!", b: "SHARED", c: "Done \u{1F600}" };
    expect(bad.a.includes("!")).toBe(true);
    const letters = bad.b.replace(/[^A-Za-z]/g, "");
    expect(letters.length > 4 && letters === letters.toUpperCase()).toBe(true);
    expect(/\p{Extended_Pictographic}/u.test(bad.c)).toBe(true);
  });

  it("the public page says what the task quotes, and never more", () => {
    expect(publicMessages["public.state.traffic"]).toBe(
      "This link is temporarily unavailable due to high traffic.",
    );
    expect(publicMessages["public.state.unavailable"]).toBe("This link is temporarily unavailable.");
    expect(publicMessages["public.state.limit"]).toBe("This link has reached its download limit.");
    expect(publicMessages["public.state.gone"]).toBe("This link is no longer available.");
  });

  it("the owner's words the task quotes", () => {
    expect(shareMessages["link.limitedToday"]).toBe("Limit reached today — comes back on its own");
    expect(shareMessages["link.sentence.anyone"]).toBe("Anyone with the link");
  });
});
