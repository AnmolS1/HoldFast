// What a person types into an address field is sent in the form the server stores — and the
// server folds nothing (src/worker/auth/preflight.ts `isStoredFormAddress`): trimmed, with ASCII
// letters lower-cased, and nothing else touched.
import { describe, expect, it } from "vitest";
import { storedForm } from "../../../../src/client/routes/auth/validation";

const SCREENS = import.meta.glob(
  "../../../../src/client/routes/auth/{Login,Signup,Password,VerifyEmail}.tsx",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
) as Record<string, string>;

describe("storedForm", () => {
  it("trims and lower-cases ASCII letters", () => {
    expect(storedForm("  Ana.Smith+Tag@Example.COM \n")).toBe("ana.smith+tag@example.com");
    expect(storedForm("already@lower.example")).toBe("already@lower.example");
  });

  it("folds nothing beyond ASCII: a look-alike stays what it is, for the server to refuse", () => {
    // `toLowerCase()` would turn the Kelvin sign into `k` and `İ` into `i̇`.
    expect(storedForm("MARK@Example.com")).toBe("marK@example.com");
    expect(storedForm("ADMİN@example.com")).toBe("admİn@example.com");
    expect(storedForm("ＡＤＭＩＮ@example.com")).toBe("ＡＤＭＩＮ@example.com");
    expect(storedForm("ad​min@example.com")).toBe("ad​min@example.com");
  });

  it("every screen that sends an address sends it in that form", () => {
    expect(Object.keys(SCREENS)).toHaveLength(4);
    for (const [file, source] of Object.entries(SCREENS)) {
      expect(source, file).toContain("storedForm(");
      // No address leaves a screen merely trimmed.
      expect(source, file).not.toMatch(/email:\s*(?:values\.)?email\.trim\(\)/);
    }
  });
});
