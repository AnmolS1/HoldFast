// Business days for the DMCA counter-notice window (17 U.S.C. §512(g)(2)(C): restore "not less
// than 10, nor more than 14, business days following receipt of the counter notice").
//
//   addBusinessDays(receivedAt, 10)      // weekends and US federal holidays skipped
//
// A business day is a calendar day IN NEW YORK (America/New_York) that is neither a Saturday, a
// Sunday nor a US federal holiday AS OBSERVED (5 U.S.C. §6103: a Saturday holiday is observed on
// the Friday before, a Sunday one on the Monday after). New York, not UTC (team-lead ruling
// 2026-10-22): the holidays are US days and the Copyright Office keeps Eastern time, and a UTC
// count could end the 14th day up to a day AFTER the US reading — the unsafe side of a deadline.
// Only this arithmetic is zoned: every stored timestamp, and the Worker's clock, stays UTC. Zone
// rules come from the runtime's Intl (Workers has it), so EST/EDT changes need no table here.
// The holiday table below is copied from OPM's published lists
// (https://www.opm.gov/policy-data-oversight/pay-leave/federal-holidays/, read 2026-10-22). It ends
// on HOLIDAYS_KNOWN_UNTIL: a count that would step past that day throws `HolidayTableEndedError`
// rather than treat unknown days as working days — extend the table from OPM's next list
// (tests/unit/admin/business-days.test.ts goes red 180 days before the end, as the reminder).

/** Observed US federal holidays, YYYY-MM-DD (New York calendar days), 2026 through 2028. */
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

export const BUSINESS_TIME_ZONE = "America/New_York";

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** The New York wall clock at `ms`, written as if it were a UTC time (ms since the epoch). */
function wallClock(ms: number): number {
  const part: Record<string, number> = {};
  for (const { type, value } of NEW_YORK.formatToParts(new Date(ms))) part[type] = Number(value);
  const wholeSecond = Date.UTC(
    part.year!,
    part.month! - 1,
    part.day!,
    part.hour!,
    part.minute!,
    part.second!,
  );
  return wholeSecond + (((ms % 1000) + 1000) % 1000);
}

/** The instant at which New York's wall clock reads `wall` (asked only of times that exist once). */
function fromWallClock(wall: number): number {
  const guess = wall - (wallClock(wall) - wall);
  return wall - (wallClock(guess) - guess);
}

const dayOf = (wall: number) => new Date(wall).toISOString().slice(0, 10);

/** `at`'s calendar day in New York, YYYY-MM-DD. */
export const newYorkDay = (at: Date) => dayOf(wallClock(at.getTime()));

/** True for a New York day `day` (YYYY-MM-DD) that is a weekday and not an observed holiday. */
function isBusinessDayOn(day: string, holidays: ReadonlySet<string>): boolean {
  if (holidays === HOLIDAYS && (day < HOLIDAYS_KNOWN_FROM || day > HOLIDAYS_KNOWN_UNTIL)) {
    throw new HolidayTableEndedError(day);
  }
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
  return weekday !== 0 && weekday !== 6 && !holidays.has(day);
}

/** True when `at` falls on a New York business day. Throws outside the table. */
export function isBusinessDay(at: Date, holidays: ReadonlySet<string> = HOLIDAYS): boolean {
  return isBusinessDayOn(newYorkDay(at), holidays);
}

/**
 * `n` business days after `from`, at the same New York time of day: the New York days after
 * `from`'s own are counted, weekends and observed US federal holidays skipped. `holidays` is for
 * tests that need dates outside the table; production code always uses the table. (A result is
 * always a weekday, so its time of day is never inside a clock change, which happens on Sundays.)
 */
export function addBusinessDays(from: Date, n: number, holidays: ReadonlySet<string> = HOLIDAYS): Date {
  const wall = wallClock(from.getTime());
  const timeOfDay = ((wall % DAY_MS) + DAY_MS) % DAY_MS;
  let day = wall - timeOfDay;
  let left = n;
  while (left > 0) {
    day += DAY_MS;
    if (isBusinessDayOn(dayOf(day), holidays)) left -= 1;
  }
  return new Date(fromWallClock(day + timeOfDay));
}

/** The last instant of `at`'s New York day (a window that ends "on" a day includes all of it). */
export function endOfNewYorkDay(at: Date): Date {
  const wall = wallClock(at.getTime());
  const nextMidnight = wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS) + DAY_MS;
  return new Date(fromWallClock(nextMidnight) - 1);
}
