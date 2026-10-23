// Business days for the DMCA counter-notice window (src/worker/services/business-days.ts): weekends
// and observed US federal holidays skipped, from OPM's table (2026–2028), and a refusal — never a
// guess — past the table's end. The dates are fixed and inside the table on purpose (the fixture
// rule's far-future 2099 is outside it; the injectable set covers that case).
import { describe, expect, it } from "vitest";
import { restoreWindow } from "../../../src/worker/services/admin-actions";
import {
  addBusinessDays,
  endOfNewYorkDay,
  HolidayTableEndedError,
  HOLIDAYS_KNOWN_FROM,
  HOLIDAYS_KNOWN_UNTIL,
  isBusinessDay,
  newYorkDay,
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

describe("addBusinessDays — New York business days", () => {
  it("skips weekends: Friday + 10 = the Friday two weeks on, same New York time of day", () => {
    // 10:30 EST; the 19th and 25th are after the March change, 10:30 EDT = 14:30Z.
    expect(addBusinessDays(at("2027-03-05T15:30:00Z"), 10).toISOString()).toBe("2027-03-19T14:30:00.000Z");
    expect(addBusinessDays(at("2027-03-05T15:30:00Z"), 14).toISOString()).toBe("2027-03-25T14:30:00.000Z");
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

  it("the start day itself is not counted, whatever it is", () => {
    expect(addBusinessDays(at("2026-07-03T12:00:00Z"), 1).toISOString()).toBe("2026-07-06T12:00:00.000Z");
    expect(addBusinessDays(at("2026-07-04T12:00:00Z"), 1).toISOString()).toBe("2026-07-06T12:00:00.000Z");
  });

  it("a receipt at 03:30Z is still the day before in New York; at 05:30Z it is the same day", () => {
    // 03:30Z Fri 30 Oct 2026 = 23:30 EDT Thu 29 Oct: Thursday is the start day, Friday the first counted.
    // 30, 2–6, 9, 10, (11), 12, 13 → Fri 13 Nov 23:30 EST = 04:30Z on the 14th.
    expect(addBusinessDays(at("2026-10-30T03:30:00Z"), 10).toISOString()).toBe("2026-11-14T04:30:00.000Z");
    expect(endOfNewYorkDay(addBusinessDays(at("2026-10-30T03:30:00Z"), 14)).toISOString()).toBe(
      "2026-11-20T04:59:59.999Z",
    );
    // 05:30Z = 01:30 EDT Fri 30 Oct: Friday is the start day → Mon 16 Nov 01:30 EST = 06:30Z.
    expect(addBusinessDays(at("2026-10-30T05:30:00Z"), 10).toISOString()).toBe("2026-11-16T06:30:00.000Z");
    expect(endOfNewYorkDay(addBusinessDays(at("2026-10-30T05:30:00Z"), 14)).toISOString()).toBe(
      "2026-11-21T04:59:59.999Z",
    );
  });

  it("a receipt on the eve of a federal holiday, before and after UTC midnight", () => {
    // Tue 10 Nov 2026 17:00 EST and 22:00 EST (03:00Z on the 11th, Veterans Day in UTC): both are
    // the 10th in New York → 12, 13, 16–20, 23, 24, 25 → Wed 25 Nov; the 14th is Wed 2 Dec
    // (Thanksgiving, 26 Nov, skipped).
    expect(addBusinessDays(at("2026-11-10T22:00:00Z"), 10).toISOString()).toBe("2026-11-25T22:00:00.000Z");
    expect(addBusinessDays(at("2026-11-11T03:00:00Z"), 10).toISOString()).toBe("2026-11-26T03:00:00.000Z");
    expect(endOfNewYorkDay(addBusinessDays(at("2026-11-11T03:00:00Z"), 14)).toISOString()).toBe(
      "2026-12-03T04:59:59.999Z",
    );
    // A receipt ON the holiday (Wed 11 Nov 12:00 EST): not counted, the 12th is the first.
    expect(addBusinessDays(at("2026-11-11T17:00:00Z"), 1).toISOString()).toBe("2026-11-12T17:00:00.000Z");
  });

  it("across the clock changes: same New York time of day, UTC moves by an hour", () => {
    // Fall back (Sun 1 Nov 2026): Fri 12:00 EDT → Mon 12:00 EST.
    expect(addBusinessDays(at("2026-10-30T16:00:00Z"), 1).toISOString()).toBe("2026-11-02T17:00:00.000Z");
    // Spring forward (Sun 14 Mar 2027): Fri 12:00 EST → Mon 12:00 EDT.
    expect(addBusinessDays(at("2027-03-12T17:00:00Z"), 1).toISOString()).toBe("2027-03-15T16:00:00.000Z");
    // Just before New York midnight on the Friday, either side of a change: still Friday.
    expect(addBusinessDays(at("2026-10-31T03:59:00Z"), 1).toISOString()).toBe("2026-11-03T04:59:00.000Z");
    expect(addBusinessDays(at("2027-03-13T04:59:00Z"), 1).toISOString()).toBe("2027-03-16T03:59:00.000Z");
  });

  it("refuses to count past the table's end, or before its start (never treats an unknown day as a working day)", () => {
    expect(() => addBusinessDays(at("2028-12-20T12:00:00Z"), 14)).toThrow(HolidayTableEndedError);
    expect(() => addBusinessDays(at("2025-12-30T12:00:00Z"), 1)).toThrow(HolidayTableEndedError);
    expect(() => isBusinessDay(at("2029-01-02T12:00:00Z"))).toThrow(/outside the US federal holiday table/);
    // 2029-01-01T03:00Z is still 31 December 2028 in New York: inside the table.
    expect(isBusinessDay(at("2029-01-01T03:00:00Z"))).toBe(false);
    expect(addBusinessDays(at("2028-12-15T12:00:00Z"), 9).toISOString()).toBe("2028-12-29T12:00:00.000Z");
  });

  it("a given holiday set is used as it is (for dates outside the table)", () => {
    const none = new Set<string>();
    expect(addBusinessDays(at("2099-01-02T12:00:00Z"), 1, none).toISOString()).toBe(
      "2099-01-05T12:00:00.000Z",
    );
    const one = new Set(["2099-01-05"]);
    expect(addBusinessDays(at("2099-01-02T12:00:00Z"), 1, one).toISOString()).toBe(
      "2099-01-06T12:00:00.000Z",
    );
  });
});

describe("newYorkDay and endOfNewYorkDay", () => {
  it("the New York calendar day, and its last millisecond (EST, EDT, and the 25-hour day)", () => {
    expect(newYorkDay(at("2026-10-30T03:30:00Z"))).toBe("2026-10-29");
    expect(newYorkDay(at("2026-10-30T04:00:00Z"))).toBe("2026-10-30");
    expect(newYorkDay(at("2026-11-11T03:00:00Z"))).toBe("2026-11-10");
    expect(endOfNewYorkDay(at("2028-11-27T12:00:00Z")).toISOString()).toBe("2028-11-28T04:59:59.999Z");
    expect(endOfNewYorkDay(at("2028-11-27T00:00:00Z")).toISOString()).toBe("2028-11-27T04:59:59.999Z");
    expect(endOfNewYorkDay(at("2027-03-15T16:00:00Z")).toISOString()).toBe("2027-03-16T03:59:59.999Z");
    expect(endOfNewYorkDay(at("2026-11-01T12:00:00Z")).toISOString()).toBe("2026-11-02T04:59:59.999Z");
  });
});

describe("restoreWindow is never later than a New York count", () => {
  // An independent count: step a New York calendar (read with toLocaleDateString) day by day.
  const nyDate = (ms: number) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const holidays = new Set(US_FEDERAL_HOLIDAYS);
  const isWorkday = (day: string) =>
    ![0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay()) && !holidays.has(day);
  /** The New York day of the `n`th business day after `ms`'s New York day. */
  function nthNewYorkBusinessDay(ms: number, n: number): string {
    let day = nyDate(ms);
    let left = n;
    while (left > 0) {
      day = new Date(Date.parse(`${day}T12:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
      if (isWorkday(day)) left -= 1;
    }
    return day;
  }

  it("every half hour of autumn 2026 and of March 2027: the window's ends fall on the New York 10th and 14th", () => {
    const spans: [string, string][] = [
      ["2026-10-20T00:00:00Z", "2026-12-31T00:00:00Z"],
      ["2027-03-01T00:00:00Z", "2027-03-31T00:00:00Z"],
    ];
    for (const [from, to] of spans) {
      for (let ms = Date.parse(from); ms < Date.parse(to); ms += 30 * 60_000) {
        const { restoreNotBefore, restoreNotAfter } = restoreWindow(new Date(ms));
        const tenth = nthNewYorkBusinessDay(ms, 10);
        const fourteenth = nthNewYorkBusinessDay(ms, 14);
        const label = new Date(ms).toISOString();
        expect(nyDate(restoreNotBefore.getTime()), label).toBe(tenth);
        expect(nyDate(restoreNotAfter.getTime()), label).toBe(fourteenth);
        // The last instant of the New York 14th: one millisecond later is the next New York day.
        expect(nyDate(restoreNotAfter.getTime() + 1), label).not.toBe(fourteenth);
      }
    }
  });
});
