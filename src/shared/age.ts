// The one age rule, shared by the sign-up form and the server that decides. Two copies had
// already drifted once: the form accepted the birth month itself, the server did not, and a
// person who turns thirteen this month filled the form in and was refused after submitting it.

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/**
 * Certainly thirteen, from a birth month and year (the day is never asked). Counted in whole
 * months and strictly: someone whose thirteenth birthday falls in the current month may not have
 * had it yet, so that month does not count. A date in the future, or before 1900, is not an age.
 * The current month is read in UTC — the same on every machine, whatever its time zone.
 */
export function isThirteenOrOlder(birthYear: number, birthMonth: number, at: Date): boolean {
  if (!isInt(birthYear) || !isInt(birthMonth) || birthMonth < 1 || birthMonth > 12) return false;
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + 1;
  if (birthYear < 1900 || birthYear > year) return false;
  const monthsOld = (year - birthYear) * 12 + (month - birthMonth);
  return monthsOld > 13 * 12;
}
