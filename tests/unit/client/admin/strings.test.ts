import { describe, expect, it } from "vitest";
import { messages, t } from "../../../../src/client/features/admin/strings";

// The three voice checks of tests/unit/client/shell/lib.test.ts, over the console's catalogue —
// and the sentences the task fixes word for word.
describe("the admin console's strings", () => {
  const entries = Object.entries(messages);

  it("no exclamation marks, no emoji, no all-caps labels", () => {
    expect(entries.length).toBeGreaterThan(200);
    for (const [key, text] of entries) {
      expect(text.trim(), key).not.toBe("");
      expect(text, key).not.toContain("!");
      expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length > 4 && !/^(CSAM|NCMEC|SHA)/.test(text))
        expect(letters === letters.toUpperCase(), key).toBe(false);
    }
  });

  it("the pending-counsel notice, word for word (task §5)", () => {
    expect(messages["r.counselNotice"]).toBe(
      "Adjudication rule pending counsel (T29 §C.5 / §F). Until it is written, follow the interim operator practice in the CSAM procedure; the file itself cannot be opened from this console.",
    );
  });

  it("the rescan answers (task §4)", () => {
    expect(messages["q.rescan.takenDown"]).toBe(
      "Not rescanned — this file is taken down; restore the takedown first",
    );
    expect(messages["q.rescan.locked"]).toBe("Not rescanned — this file is locked as suspected CSAM");
    expect(messages["q.rescan.queuedReview"]).toBe(
      "Queued — the result is kept until the report is resolved",
    );
  });

  it("Clear lock's sentences (task §6 table) and the folder refusal", () => {
    expect(messages["clear.notLocked"]).toBe(
      "This file is not locked as suspected CSAM — it may already have been cleared.",
    );
    expect(messages["clear.reported"]).toBe(
      "A report on this file was filed with NCMEC. A filed lock cannot be cleared.",
    );
    expect(messages["clear.cleared"]).toBe("Lock cleared. The file is being scanned again.");
    expect(t("clear.reports", { ids: "x" })).toBe("Reports closed as false positive: x");
    expect(messages["clear.bl.removed"]).toBe(
      "The hash was removed from the blocklist (this lock had added it).",
    );
    expect(t("clear.bl.restored", { reason: "malware" })).toBe(
      "The hash stays blocklisted as malware, as it was before this lock.",
    );
    expect(messages["clear.bl.none"]).toBe("There was no blocklist entry for this hash.");
    expect(messages["r.folder"]).toBe(
      "A folder cannot be locked. Take the folder down (section 7), or lock the file inside it.",
    );
    expect(t("users.strikesAtThreshold", { count: 3 })).toBe(
      "Lift a strike first — this account has 3 active strikes and would be suspended again within the hour.",
    );
  });
});
