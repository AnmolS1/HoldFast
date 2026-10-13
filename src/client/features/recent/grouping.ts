// Which heading a recently opened file goes under. Days are CALENDAR days in the account's time
// zone, never 24-hour windows: 23:30 yesterday is "Yesterday" half an hour later, and a day that
// is 23 or 25 hours long (a clock change) is still one day.
import { resolveTimeZone } from "../../lib/format";

export type RecentGroup = "today" | "yesterday" | "week" | "earlier";

export const RECENT_GROUPS: readonly RecentGroup[] = ["today", "yesterday", "week", "earlier"];

/** The calendar date of an instant in a zone, as a count of days. */
function dayNumber(date: Date, timeZone: string | undefined): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / 86_400_000;
}

/**
 * "today" · "yesterday" · "week" (two to six calendar days ago) · "earlier". A time in the
 * future (a clock that is off) counts as today; an unreadable one as earlier.
 */
export function recentGroup(value: string, now: Date, timeZone?: string | null): RecentGroup {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "earlier";
  const zone = resolveTimeZone(timeZone);
  const daysAgo = dayNumber(now, zone) - dayNumber(date, zone);
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  if (daysAgo < 7) return "week";
  return "earlier";
}
