// Business days for the DMCA counter-notice window (src/worker/services/business-days.ts): weekends
// and observed US federal holidays skipped, from OPM's table (2026–2028), and a refusal — never a
// guess — past the table's end. The dates are fixed and inside the table on purpose (the fixture
// rule's far-future 2099 is outside it; the injectable set covers that case).
import { describe, expect, it } from "vitest";
import {
  addBusinessDays,
  endOfUtcDay,
  HolidayTableEndedError,
  HOLIDAYS_KNOWN_FROM,
  HOLIDAYS_KNOWN_UNTIL,
  isBusinessDay,
  US_FEDERAL_HOLIDAYS,
} from "../../../src/worker/services/business-days";

const at = (iso: string) => new Date(iso);
const DAY_MS = 86_400_000;

describe("the holiday table", () => {
  it("is sorted, inside its own range, and every observed day is a weekday", () => {
    expect([...US_FEDERAL_HOLIDAYS].sort()).toEqual(US_FEDERAL_HOLIDAYS);
    expect(new Set(US_FEDERAL_HOLIDAYS).size).toBe(US_FEDERAL_HOLIDAYS.length);
    for (const day of US_FEDERAL_HOLIDAYS) {
      expect(day >= HOLIDAYS_KNOWN_FROM && day <= HOLIDAYS_KNOWN_UNTIL, day).toBe(true);
      expect([0, 6], day).not.toContain(at(`${day}T12:00:00Z`).getUTCDay());
    }
  });

  it("has the eleven holidays of each year (New Year 2028 observed on Friday 31 December 2027)", () => {
    const byYear = (year: string) => US_FEDERAL_HOLIDAYS.filter((day) => day.startsWith(year));
    expect(byYear("2026")).toHaveLength(11);
    expect(byYear("2027")).toHaveLength(12);
    expect(byYear("2027")).toContain("2027-12-31");
    expect(byYear("2028")).toHaveLength(10);
    expect(byYear("2028")).not.toContain("2028-01-01");
  });

  it("the observed days of weekend holidays (OPM)", () => {
    for (const day of ["2026-07-03", "2027-06-18", "2027-07-05", "2027-12-24", "2027-12-31", "2028-11-10"]) {
      expect(US_FEDERAL_HOLIDAYS, day).toContain(day);
    }
    for (const day of ["2026-07-04", "2027-06-19", "2027-07-04", "2027-12-25", "2028-01-01", "2028-11-11"]) {
      expect(US_FEDERAL_HOLIDAYS, day).not.toContain(day);
    }
  });

  // The reminder: this goes red 180 days before the table ends. Extend it from OPM's next list
  // (https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/), then move the end.
  it("still covers at least 180 days from today", () => {
    const horizon = new Date(Date.now() + 180 * DAY_MS).toISOString().slice(0, 10);
    expect(horizon <= HOLIDAYS_KNOWN_UNTIL, `the table ends ${HOLIDAYS_KNOWN_UNTIL}`).toBe(true);
  });
});

describe("addBusinessDays", () => {
  it("skips weekends: Friday + 10 = the Friday two weeks on, same time of day", () => {
    expect(addBusinessDays(at("2027-03-05T15:30:00Z"), 10).toISOString()).toBe("2027-03-19T15:30:00.000Z");
    expect(addBusinessDays(at("2027-03-05T15:30:00Z"), 14).toISOString()).toBe("2027-03-25T15:30:00.000Z");
  });

  it("skips Veterans Day and Thanksgiving (November 2026)", () => {
    // Fri 6 Nov: 9, 10, (11), 12, 13, 16–20 → Mon 23 Nov; then 24, 25, (26), 27, 30 → Mon 30 Nov.
    expect(addBusinessDays(at("2026-11-06T12:00:00Z"), 10).toISOString()).toBe("2026-11-23T12:00:00.000Z");
    expect(addBusinessDays(at("2026-11-06T12:00:00Z"), 14).toISOString()).toBe("2026-11-30T12:00:00.000Z");
  });

  it("skips an observed Friday and the weekend after it (Christmas and New Year, 2027)", () => {
    expect(addBusinessDays(at("2027-12-23T12:00:00Z"), 1).toISOString()).toBe("2027-12-27T12:00:00.000Z");
    expect(addBusinessDays(at("2027-12-23T12:00:00Z"), 5).toISOString()).toBe("2028-01-03T12:00:00.000Z");
  });

  it("days are UTC days: a receipt either side of UTC midnight, with Veterans Day inside the window", () => {
    // Fri 23:55 and Sat 00:05: the first day counted is Monday 2 Nov either way → Mon 16 Nov.
    expect(addBusinessDays(at("2026-10-30T23:55:00Z"), 10).toISOString()).toBe("2026-11-16T23:55:00.000Z");
    expect(addBusinessDays(at("2026-10-31T00:05:00Z"), 10).toISOString()).toBe("2026-11-16T00:05:00.000Z");
    // Thu 23:55 and Fri 00:05: ten minutes apart, one business day apart — both ends of the window.
    expect(addBusinessDays(at("2026-11-05T23:55:00Z"), 10).toISOString()).toBe("2026-11-20T23:55:00.000Z");
    expect(addBusinessDays(at("2026-11-06T00:05:00Z"), 10).toISOString()).toBe("2026-11-23T00:05:00.000Z");
    expect(endOfUtcDay(addBusinessDays(at("2026-11-05T23:55:00Z"), 14)).toISOString()).toBe(
      "2026-11-27T23:59:59.999Z",
    );
    expect(endOfUtcDay(addBusinessDays(at("2026-11-06T00:05:00Z"), 14)).toISOString()).toBe(
      "2026-11-30T23:59:59.999Z",
    );
  });

  it("the start day itself is not counted, whatever it is", () => {
    expect(addBusinessDays(at("2026-07-03T12:00:00Z"), 1).toISOString()).toBe("2026-07-06T12:00:00.000Z");
    expect(addBusinessDays(at("2026-07-04T12:00:00Z"), 1).toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("refuses to count past the table's end, or before its start (never treats an unknown day as a working day)", () => {
    expect(() => addBusinessDays(at("2028-12-20T12:00:00Z"), 14)).toThrow(HolidayTableEndedError);
    expect(() => addBusinessDays(at("2025-12-30T12:00:00Z"), 1)).toThrow(HolidayTableEndedError);
    expect(() => isBusinessDay(at("2029-01-02T12:00:00Z"))).toThrow(/outside the US federal holiday table/);
    expect(addBusinessDays(at("2028-12-15T12:00:00Z"), 9).toISOString()).toBe("2028-12-29T12:00:00.000Z");
  });

  it("a given holiday set is used as it is (for dates outside the table)", () => {
    const none = new Set<string>();
    expect(addBusinessDays(at("2099-01-02T00:00:00Z"), 1, none).toISOString()).toBe(
      "2099-01-05T00:00:00.000Z",
    );
    const one = new Set(["2099-01-05"]);
    expect(addBusinessDays(at("2099-01-02T00:00:00Z"), 1, one).toISOString()).toBe(
      "2099-01-06T00:00:00.000Z",
    );
  });
});

describe("endOfUtcDay", () => {
  it("is the last millisecond of the same UTC day", () => {
    expect(endOfUtcDay(at("2028-11-27T12:00:00Z")).toISOString()).toBe("2028-11-27T23:59:59.999Z");
    expect(endOfUtcDay(at("2028-11-27T00:00:00Z")).toISOString()).toBe("2028-11-27T23:59:59.999Z");
  });
});
