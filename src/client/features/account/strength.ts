// The password meter of the change-password form. The SAME rule and bounds as the sign-up form's
// (src/client/routes/auth/validation.ts `passwordStrength`, `PASSWORD_MIN`/`PASSWORD_MAX` — shell
// code that is not in lib/, so it is repeated here; see the T23 report's seams). It only advises:
// what is refused is the server's to say (the bounds, and a password found in a breach corpus).
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

export type Strength = 0 | 1 | 2 | 3 | 4;

/** 0 = too short … 4 = strong. Length carries most of the weight. */
export function passwordStrength(password: string): Strength {
  if (password.length < PASSWORD_MIN) return 0;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = 1;
  if (password.length >= 16) score += 1;
  if (classes >= 3) score += 1;
  if (password.length >= 20 || classes === 4) score += 1;
  return Math.min(4, score) as Strength;
}
