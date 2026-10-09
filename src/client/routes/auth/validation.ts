// Pure checks for the auth forms. The server is the authority on every one of them; these exist
// so a person sees what is wrong before a round trip.
import { isThirteenOrOlder as sharedIsThirteenOrOlder } from "../../../shared/age";
import type { MessageKey } from "../../lib/i18n";

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/**
 * Where to go after signing in. Only a same-origin, path-absolute `next` is honoured:
 * `//host`, `https://host`, `/\host`, `javascript:` and anything that resolves to another origin
 * fall back to "/". The returned value is the NORMALISED path + search + hash, never the raw input.
 */
export function safeNext(raw: string | null | undefined, origin: string = window.location.origin): string {
  if (!raw) return "/";
  // A real path starts with exactly one slash; a backslash or control character anywhere is the
  // signature of a parser-differential attack (browsers treat "\" as "/" and strip tab/newline).
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is rejected
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return "/";
  let url: URL;
  try {
    url = new URL(raw, origin);
  } catch {
    return "/";
  }
  if (url.origin !== origin) return "/";
  if (url.pathname.startsWith("//")) return "/";
  return url.pathname + url.search + url.hash;
}

/**
 * An address as the server stores it and accepts it: trimmed, with its ASCII letters lower-cased.
 * The server folds NOTHING (it refuses an address that is not already in this form), so that what
 * is stored, mailed and compared is exactly what was sent. Only A–Z are touched: a non-ASCII
 * character is left for the server to refuse, not folded into a look-alike.
 */
export function storedForm(value: string): string {
  return value.trim().replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

export function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}

/** 0 = too short … 4 = strong. Length carries most of the weight. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length < PASSWORD_MIN) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = 1;
  if (password.length >= 16) score += 1;
  if (classes >= 3) score += 1;
  if (password.length >= 20 || classes === 4) score += 1;
  return Math.min(4, score) as 1 | 2 | 3 | 4;
}

/**
 * Certainly thirteen, from a birth month and year (the day is never asked). The rule is the
 * server's own function (src/shared/age.ts): the form must never accept what the server refuses.
 */
export function isThirteenOrOlder(birthYear: number, birthMonth: number, now: Date = new Date()): boolean {
  return sharedIsThirteenOrOlder(birthYear, birthMonth, now);
}

export interface SignupValues {
  name: string;
  email: string;
  password: string;
  inviteCode: string;
  birthMonth: string;
  birthYear: string;
  acceptTerms: boolean;
}

export type SignupField = keyof SignupValues | "birth";
export type SignupErrors = Partial<Record<SignupField, MessageKey>>;

export function parseBirth(
  values: Pick<SignupValues, "birthMonth" | "birthYear">,
  now: Date = new Date(),
): { month: number; year: number } | null {
  if (!/^\d{1,2}$/.test(values.birthMonth.trim()) || !/^\d{4}$/.test(values.birthYear.trim())) return null;
  const month = Number(values.birthMonth);
  const year = Number(values.birthYear);
  // The current year in UTC, as the age rule reads it.
  if (month < 1 || month > 12 || year < 1900 || year > now.getUTCFullYear()) return null;
  return { month, year };
}

/** The checks shared by email sign-up and the pre-OAuth intent step. */
export function validateIntent(
  values: SignupValues,
  options: { inviteRequired: boolean; now?: Date },
): SignupErrors {
  const errors: SignupErrors = {};
  if (options.inviteRequired && values.inviteCode.trim() === "") errors.inviteCode = "signup.error.invite";
  const birth = parseBirth(values, options.now);
  if (!birth) errors.birth = "signup.error.birth";
  else if (!isThirteenOrOlder(birth.year, birth.month, options.now)) errors.birth = "signup.error.age";
  if (!values.acceptTerms) errors.acceptTerms = "signup.error.assent";
  return errors;
}

export function validateSignup(
  values: SignupValues,
  options: { inviteRequired: boolean; now?: Date },
): SignupErrors {
  const errors: SignupErrors = {};
  if (values.name.trim() === "") errors.name = "signup.error.name";
  if (!isEmail(values.email)) errors.email = "signup.error.email";
  if (values.password.length < PASSWORD_MIN) errors.password = "signup.error.password";
  else if (values.password.length > PASSWORD_MAX) errors.password = "signup.error.passwordLong";
  return { ...errors, ...validateIntent(values, options) };
}
