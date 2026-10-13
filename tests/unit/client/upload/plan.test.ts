// The uploader's arithmetic and rules, and the voice of its strings.
import { describe, expect, it } from "vitest";
import {
  FILE_CONCURRENCY,
  foldersToCreate,
  lastModifiedIso,
  matchesResume,
  missingParts,
  PART_CONCURRENCY,
  partRange,
  partSize,
  preflight,
  RETRY_DELAYS_MS,
} from "../../../../src/client/features/upload/plan";
import { messages, t } from "../../../../src/client/features/upload/strings";

const PART = 67_108_864;

describe("slicing from the server's part size", () => {
  it("the cap-sized file is 30 parts, the last one 53,842,944 bytes", () => {
    const size = 2_000_000_000;
    const count = Math.ceil(size / PART);
    expect(count).toBe(30);
    let total = 0;
    for (let n = 1; n <= count; n += 1) {
      const { start, end } = partRange(n, PART, size);
      expect(start).toBe((n - 1) * PART);
      expect(end - start).toBe(n < count ? PART : 53_842_944);
      total += partSize(n, PART, size);
    }
    expect(total).toBe(size);
  });

  it("a last part of one byte", () => {
    const size = 2 * PART + 1;
    expect(partRange(3, PART, size)).toEqual({ start: 2 * PART, end: 2 * PART + 1 });
    expect(partSize(3, PART, size)).toBe(1);
  });

  it("follows whatever size the server names", () => {
    expect([1, 2, 3].map((n) => partSize(n, 1000, 2500))).toEqual([1000, 1000, 500]);
  });

  it("the parts still to send are the ones the server does not have", () => {
    expect(missingParts(4, [])).toEqual([1, 2, 3, 4]);
    expect(
      missingParts(4, [
        { n: 3, etag: "c" },
        { n: 1, etag: "a" },
      ]),
    ).toEqual([2, 4]);
    expect(
      missingParts(2, [
        { n: 1, etag: "a" },
        { n: 2, etag: "b" },
      ]),
    ).toEqual([]);
  });
});

describe("limits and the retry schedule", () => {
  it("three files, three parts each; retries at 0, 2, 5, 15 and 30 seconds", () => {
    expect(FILE_CONCURRENCY).toBe(3);
    expect(PART_CONCURRENCY).toBe(3);
    expect([...RETRY_DELAYS_MS]).toEqual([0, 2000, 5000, 15000, 30000]);
  });
});

describe("matching a file to an open upload", () => {
  const file = { name: "video.mp4", size: 140_000_000, lastModified: 1_760_000_000_123 };
  const candidate = { name: file.name, size: file.size, fileLastModified: lastModifiedIso(file) };

  it("the date crosses the API as an ISO timestamp", () => {
    expect(lastModifiedIso(file)).toBe(new Date(file.lastModified).toISOString());
    expect(lastModifiedIso(file)).toBe("2025-10-09T08:53:20.123Z");
  });

  it("matches on name, size and the exact millisecond", () => {
    expect(matchesResume(candidate, file)).toBe(true);
  });

  it("a file one millisecond off does not match", () => {
    expect(matchesResume(candidate, { ...file, lastModified: file.lastModified + 1 })).toBe(false);
    expect(matchesResume(candidate, { ...file, lastModified: file.lastModified - 1 })).toBe(false);
  });

  it("another name or size does not match", () => {
    expect(matchesResume(candidate, { ...file, name: "Video.mp4" })).toBe(false);
    expect(matchesResume(candidate, { ...file, size: file.size + 1 })).toBe(false);
  });

  it("a session without the file's date matches nothing", () => {
    expect(matchesResume({ ...candidate, fileLastModified: null }, file)).toBe(false);
  });
});

describe("pre-flight", () => {
  const files = [
    { name: "a.bin", size: 4_000_000_000 },
    { name: "b.bin", size: 2_200_000_000 },
  ];

  it("everything that needs more than is free starts nothing, and says the two numbers", () => {
    const checked = preflight(files, null, 1_400_000_000);
    expect(checked.quota).toEqual({ needed: 6_200_000_000, free: 1_400_000_000 });
    expect(t("preflight.quota", { needed: "6.2 GB", free: "1.4 GB" })).toBe(
      "This needs 6.2 GB and you have 1.4 GB free",
    );
  });

  it("a file above the cap and a file without a name are refused one by one", () => {
    const checked = preflight(
      [...files, { name: " ", size: 1 }, { name: "ok.txt", size: 0 }],
      2_000_000_000,
      null,
    );
    expect(checked.rejected.map((entry) => [entry.file.name, entry.reason])).toEqual([
      ["a.bin", "too_large"],
      ["b.bin", "too_large"],
      [" ", "no_name"],
    ]);
    // An empty file is allowed.
    expect(checked.accepted.map((file) => file.name)).toEqual(["ok.txt"]);
    expect(checked.quota).toBeNull();
  });

  it("exactly the cap and exactly the free space pass", () => {
    const checked = preflight([{ name: "cap.bin", size: 2_000_000_000 }], 2_000_000_000, 2_000_000_000);
    expect(checked.accepted.length).toBe(1);
    expect(checked.quota).toBeNull();
  });
});

describe("folders of a folder upload", () => {
  it("each folder once, parents before children", () => {
    expect(foldersToCreate(["a/b/c", "a/b", "d", "a/e"])).toEqual(["a", "d", "a/b", "a/e", "a/b/c"]);
    expect(foldersToCreate([])).toEqual([]);
  });
});

describe("the uploader's strings", () => {
  it("voice: no exclamation marks, no all-caps labels, no emoji", () => {
    const entries = Object.entries(messages);
    expect(entries.length).toBeGreaterThan(50);
    for (const [key, text] of entries) {
      expect(text, key).not.toContain("!");
      expect(/\p{Extended_Pictographic}/u.test(text), key).toBe(false);
      const letters = text.replace(/[^A-Za-z]/g, "");
      if (letters.length > 4) expect(letters === letters.toUpperCase(), key).toBe(false);
    }
  });

  it("the sentences the task and the design quote", () => {
    expect(t("ribbon.uploadingEta", { n: 3, total: 7, left: "1.2 GB", eta: "40 s" })).toBe(
      "Uploading 3 of 7 · 1.2 GB left · ~40 s",
    );
    expect(messages["ribbon.ceiling"]).toBe("Daily upload limit reached — resumes after midnight UTC");
    expect(messages["ribbon.disabled"]).toBe("Uploads are paused right now.");
    expect(t("row.selectAgain", { name: "video.mp4" })).toBe("Select video.mp4 again to resume");
    expect(t("drop.to", { folder: "Projects" })).toBe("Drop to upload to Projects");
    expect(messages["row.verifying"]).toBe("Verifying…");
  });

  it("a refusal says refused, and never asks for another try", () => {
    for (const key of [
      "row.refused",
      "live.refused",
      "ribbon.refused.one",
      "ribbon.refused.other",
    ] as const) {
      expect(messages[key]).toMatch(/refused/i);
      expect(messages[key]).not.toMatch(/again|retry|wrong/i);
    }
  });
});
