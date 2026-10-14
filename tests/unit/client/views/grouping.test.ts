// Recent's headings are calendar days in the account's time zone.
import { describe, expect, it } from "vitest";
import { recentGroup } from "../../../../src/client/features/recent/grouping";

const at = (iso: string) => new Date(iso);

describe("recentGroup", () => {
  it("the same instant is today in one zone and yesterday in another", () => {
    const now = at("2026-10-13T01:00:00Z"); // Oct 12, 18:00 in Los Angeles
    const opened = "2026-10-12T08:00:00Z"; // Oct 12, 01:00 in Los Angeles
    expect(recentGroup(opened, now, "America/Los_Angeles")).toBe("today");
    expect(recentGroup(opened, now, "UTC")).toBe("yesterday");
    expect(recentGroup(opened, now, "Asia/Tokyo")).toBe("yesterday");
  });

  it("forty minutes across midnight is yesterday, not today", () => {
    const now = at("2026-10-13T00:10:00Z");
    expect(recentGroup("2026-10-12T23:30:00Z", now, "UTC")).toBe("yesterday");
    // …and the same forty minutes do not cross midnight in New York (still the 12th).
    expect(recentGroup("2026-10-12T23:30:00Z", now, "America/New_York")).toBe("today");
  });

  it("a 25-hour day (clocks go back) is one day", () => {
    // Berlin, 25 October 2026: 03:00 CEST becomes 02:00 CET.
    const now = at("2026-10-25T22:30:00Z"); // 23:30 CET on the 25th
    // 24 hours earlier is 00:30 CEST — still the 25th.
    expect(recentGroup("2026-10-24T22:30:00Z", now, "Europe/Berlin")).toBe("today");
    expect(recentGroup("2026-10-24T21:30:00Z", now, "Europe/Berlin")).toBe("yesterday");
  });

  it("a 23-hour day (clocks go forward) is one day", () => {
    // New York, 8 March 2026: 02:00 EST becomes 03:00 EDT.
    const now = at("2026-03-09T03:30:00Z"); // 23:30 EDT on the 8th
    expect(recentGroup("2026-03-08T05:30:00Z", now, "America/New_York")).toBe("today"); // 00:30 EST
    // 23 hours before now — inside a 24-hour window, but the day before.
    expect(recentGroup("2026-03-08T04:30:00Z", now, "America/New_York")).toBe("yesterday");
  });

  it("two to six calendar days ago is this week; seven is earlier", () => {
    const now = at("2026-10-13T12:00:00Z");
    expect(recentGroup("2026-10-11T23:59:00Z", now, "UTC")).toBe("week");
    expect(recentGroup("2026-10-07T00:00:00Z", now, "UTC")).toBe("week");
    expect(recentGroup("2026-10-06T23:59:00Z", now, "UTC")).toBe("earlier");
    expect(recentGroup("2025-10-13T12:00:00Z", now, "UTC")).toBe("earlier");
  });

  it("across a year's end", () => {
    const now = at("2027-01-01T00:30:00Z");
    expect(recentGroup("2026-12-31T23:50:00Z", now, "UTC")).toBe("yesterday");
    expect(recentGroup("2026-12-31T23:50:00Z", now, "America/New_York")).toBe("today");
  });

  it("a time ahead of now is today; an unreadable one is earlier; an unknown zone does not throw", () => {
    const now = at("2026-10-13T12:00:00Z");
    expect(recentGroup("2026-10-14T12:00:00Z", now, "UTC")).toBe("today");
    expect(recentGroup("not a date", now, "UTC")).toBe("earlier");
    expect(() => recentGroup("2026-10-13T08:00:00Z", now, "Mars/Olympus")).not.toThrow();
    expect(() => recentGroup("2026-10-13T08:00:00Z", now, null)).not.toThrow();
  });
});
