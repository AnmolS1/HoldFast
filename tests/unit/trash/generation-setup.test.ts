// tests/setup/workers-generation.ts restates the generation key, the settings row and the parse
// rule (it may import no application module). Pinned here to the real ones.
import { describe, expect, it } from "vitest";
import { GENERATION_KEY, parseGeneration } from "../../../src/worker/jobs/reconcile";
import { SETUP_GENERATION_KEY, setupParseGeneration } from "../../setup/workers-generation";

describe("the per-file generation setup restates reconcile.ts exactly", () => {
  it("the same object key", () => {
    expect(SETUP_GENERATION_KEY).toBe(GENERATION_KEY);
  });

  it("the same parse rule, input for input", () => {
    for (const text of [
      "0",
      "1",
      "7",
      "42",
      "9007199254740991",
      "9007199254740992",
      "01",
      "-1",
      "1.0",
      " 1",
      "",
      "x",
      "1e3",
    ]) {
      expect(setupParseGeneration(text), text).toBe(parseGeneration(text));
    }
  });
});
