import { describe, expect, it } from "vitest";
import { messages, t } from "../../../../src/client/features/account/strings";

// The three checks of tests/unit/client/shell/lib.test.ts ("voice: …"), over this feature's catalogue.
describe("voice of the account's strings", () => {
  const entries = Object.entries(messages);

  it("the catalogue is not empty and every value is text", () => {
    expect(entries.length).toBeGreaterThan(100);
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

  it("the sentences the task fixes", () => {
    expect(messages["profile.avatar.unchecked"]).toBe("Couldn't check that image. Try again.");
    expect(messages["account.signInAgain"]).toBe("Sign in again to continue.");
    expect(t("stepUp.throttled", { wait: "2 min" })).toBe(
      "Too many wrong codes. Wait 2 min, or use a browser you have signed in from before.",
    );
  });
});
