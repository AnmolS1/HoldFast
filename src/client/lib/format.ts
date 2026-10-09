// Sizes and dates. Sizes are binary multiples labelled KB/MB/GB, so the 5 GB quota
// (5,368,709,120 bytes) reads "5 GB". Dates use Intl with the account's time zone.
import { getLocale } from "./i18n";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  // Bytes and kilobytes are whole numbers; from MB up one decimal, dropped when it is zero.
  const digits = unit <= 1 ? 0 : 1;
  let text = value.toFixed(digits);
  // 1023.96 MB must not print as "1024.0 MB".
  if (Number(text) >= 1024 && unit < UNITS.length - 1) {
    unit += 1;
    text = (value / 1024).toFixed(1);
  }
  if (text.endsWith(".0")) text = text.slice(0, -2);
  return `${text} ${UNITS[unit]}`;
}

/** A time zone Intl accepts, or `undefined` (the browser's zone). */
export function resolveTimeZone(zone: string | null | undefined): string | undefined {
  if (!zone) return undefined;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

function toDate(value: string | number | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export type DateStyle = "short" | "long" | "dateTime";

/** "Oct 02" · "October 2, 2026" · "Sep 28, 2026, 14:12". */
export function formatDate(
  value: string | number | Date,
  options: { timeZone?: string | null; style?: DateStyle; now?: Date } = {},
): string {
  const date = toDate(value);
  if (!date) return "—";
  const timeZone = resolveTimeZone(options.timeZone);
  const style = options.style ?? "short";
  const locale = getLocale();
  if (style === "long") {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(date);
  }
  if (style === "dateTime") {
    return new Intl.DateTimeFormat(locale, {
      timeZone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(date);
  }
  const now = options.now ?? new Date();
  const year = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone, year: "numeric" }).format(d);
  const sameYear = year(date) === year(now);
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    month: "short",
    day: "2-digit",
    ...(sameYear ? {} : { year: "numeric" }),
  }).format(date);
}

const STEPS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["minute", 60],
  ["hour", 3600],
  ["day", 86400],
];

/** "3 minutes ago", "yesterday"; a short date once it is a week or more away. */
export function formatRelative(
  value: string | number | Date,
  options: { timeZone?: string | null; now?: Date } = {},
): string {
  const date = toDate(value);
  if (!date) return "—";
  const now = options.now ?? new Date();
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  if (abs >= 7 * 86400) return formatDate(date, { timeZone: options.timeZone, now });
  const rtf = new Intl.RelativeTimeFormat(getLocale(), { numeric: "auto" });
  if (abs < 45) return rtf.format(0, "second");
  let unit: Intl.RelativeTimeFormatUnit = "minute";
  let size = 60;
  for (const [u, s] of STEPS) {
    if (abs >= s) {
      unit = u;
      size = s;
    }
  }
  return rtf.format(Math.round(seconds / size), unit);
}

/** "0:42" for a countdown. */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.ceil(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
