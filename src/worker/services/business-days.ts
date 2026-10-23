// Business days for the DMCA counter-notice window (17 U.S.C. §512(g)(2)(C): restore "not less
// than 10, nor more than 14, business days following receipt of the counter notice").
//
//   addBusinessDays(receivedAt, 10)      // weekends and US federal holidays skipped
//
// A business day is a UTC calendar day that is neither a Saturday, a Sunday nor a US federal
// holiday AS OBSERVED (5 U.S.C. §6103: a Saturday holiday is observed on the Friday before, a
// Sunday one on the Monday after). UTC, not America/New_York: every timestamp here (the receipt,
// the Worker's clock, the stored window) is UTC and the statute names no zone; a receipt on a US
// evening can therefore count from the next day, which moves both ends one day later. The table below is copied from OPM's published lists
// (https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/, read 2026-10-22). It ends
// on HOLIDAYS_KNOWN_UNTIL: a count that would step past that day throws `HolidayTableEndedError`
// rather than treat unknown days as working days — extend the table from OPM's next list
// (tests/unit/admin/business-days.test.ts goes red 180 days before the end, as the reminder).

/** Observed US federal holidays, YYYY-MM-DD (UTC calendar days), 2026 through 2028. */
export const US_FEDERAL_HOLIDAYS: readonly string[] = [
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // Birthday of Martin Luther King, Jr.
  "2026-02-16", // Washington's Birthday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (4 July is a Saturday)
  "2026-09-07", // Labor Day
  "2026-10-12", // Columbus Day
  "2026-11-11", // Veterans Day
  "2026-11-26", // Thanksgiving Day
  "2026-12-25", // Christmas Day
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // Birthday of Martin Luther King, Jr.
  "2027-02-15", // Washington's Birthday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (19 June is a Saturday)
  "2027-07-05", // Independence Day (4 July is a Sunday)
  "2027-09-06", // Labor Day
  "2027-10-11", // Columbus Day
  "2027-11-11", // Veterans Day
  "2027-11-25", // Thanksgiving Day
  "2027-12-24", // Christmas Day (25 December is a Saturday)
  "2027-12-31", // New Year's Day 2028 (1 January 2028 is a Saturday)
  // 2028
  "2028-01-17", // Birthday of Martin Luther King, Jr.
  "2028-02-21", // Washington's Birthday
  "2028-05-29", // Memorial Day
  "2028-06-19", // Juneteenth
  "2028-07-04", // Independence Day
  "2028-09-04", // Labor Day
  "2028-10-09", // Columbus Day
  "2028-11-10", // Veterans Day (11 November is a Saturday)
  "2028-11-23", // Thanksgiving Day
  "2028-12-25", // Christmas Day
];

/** The first and last days the table speaks for (inclusive). */
export const HOLIDAYS_KNOWN_FROM = "2026-01-01";
export const HOLIDAYS_KNOWN_UNTIL = "2028-12-31";

export class HolidayTableEndedError extends Error {
  constructor(readonly day: string) {
    super(
      `business days: ${day} is outside the US federal holiday table (${HOLIDAYS_KNOWN_FROM} to ${HOLIDAYS_KNOWN_UNTIL})`,
    );
    this.name = "HolidayTableEndedError";
  }
}

const DAY_MS = 86_400_000;
const HOLIDAYS = new Set(US_FEDERAL_HOLIDAYS);

export const utcDay = (at: Date) => at.toISOString().slice(0, 10);

/** True for a weekday that is not an observed federal holiday. Throws outside the table. */
export function isBusinessDay(at: Date, holidays: ReadonlySet<string> = HOLIDAYS): boolean {
  const day = utcDay(at);
  if (holidays === HOLIDAYS && (day < HOLIDAYS_KNOWN_FROM || day > HOLIDAYS_KNOWN_UNTIL)) {
    throw new HolidayTableEndedError(day);
  }
  const weekday = at.getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

/**
 * `n` business days after `from`, at the same time of day: the days after `from`'s own day are
 * counted, weekends and observed US federal holidays skipped. `holidays` is for tests that need
 * dates outside the table; production code always uses the table.
 */
export function addBusinessDays(from: Date, n: number, holidays: ReadonlySet<string> = HOLIDAYS): Date {
  const at = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    at.setTime(at.getTime() + DAY_MS);
    if (isBusinessDay(at, holidays)) left -= 1;
  }
  return at;
}

/** The last instant of `at`'s UTC day (a window that ends "on" a day includes all of it). */
export function endOfUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate(), 23, 59, 59, 999));
}
