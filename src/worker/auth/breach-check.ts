// Is this password in a known breach? — asked of Have I Been Pwned's range API by k-anonymity:
// only the first five hex digits of the password's SHA-1 leave the Worker.
//
// This replaces Better Auth's `haveIBeenPwned` plugin, which does the same lookup from INSIDE
// the password hash (plugins/haveibeenpwned/index.mjs) — that is, after the endpoint has already
// looked things up and, for a reset, after it has CONSUMED the reset token: a breached password
// with a valid token burnt the token and answered differently from one with an invalid token.
// Here the check is part of what depends only on the caller's input, and runs FIRST
// (hooks.ts `before`), for every caller alike. The plugin also had no time limit of its own.
//
// WHEN THE SERVICE DOES NOT ANSWER (3 s, or an error): the request is REFUSED — `503`, code
// `BREACH_CHECK_UNAVAILABLE`, try again — and counted. Fail closed: an outage of a third party
// must not be the moment known-breached passwords are accepted. (The cost is that sign-up,
// reset and change-password wait out such an outage; the decision is recorded for review.)

import { APIError } from "better-auth/api";
import { countFor } from "./observe";

export const BREACH_PATHS = new Set(["/sign-up/email", "/reset-password", "/change-password"]);
export const BREACH_CHECK_TIMEOUT_MS = 3000;
export const PASSWORD_COMPROMISED_MESSAGE = "This password appears in a known breach. Choose another.";
export const BREACH_CHECK_UNAVAILABLE = {
  code: "BREACH_CHECK_UNAVAILABLE",
  message: "We could not check this password right now. Try again in a moment.",
} as const;

async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/** True when the corpus knows the password. Throws when the service gave no usable answer in time. */
export async function isBreached(password: string, timeoutMs = BREACH_CHECK_TIMEOUT_MS): Promise<boolean> {
  const hash = await sha1Hex(password);
  const response = await fetch(`https://api.pwnedpasswords.com/range/${hash.slice(0, 5)}`, {
    // Padded: the size of the answer does not say how many hashes share the prefix.
    headers: { "Add-Padding": "true", "User-Agent": "Holdfast password check" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`breach check: status ${response.status}`);
  const suffix = `${hash.slice(5)}:`;
  for (const line of (await response.text()).split(/\r?\n/)) {
    if (!line.toUpperCase().startsWith(suffix)) continue;
    const count = Number(line.slice(suffix.length).trim());
    return Number.isSafeInteger(count) && count > 0;
  }
  return false;
}

/** Throws the refusal for a breached password, or for a check that could not be made. */
export async function refuseBreachedPassword(env: Env, password: string): Promise<void> {
  let breached: boolean;
  try {
    breached = await isBreached(password);
  } catch {
    countFor(env, "auth", { outcome: "error", kind: "breach_check" });
    throw new APIError("SERVICE_UNAVAILABLE", { ...BREACH_CHECK_UNAVAILABLE });
  }
  if (breached) {
    throw new APIError("BAD_REQUEST", {
      message: PASSWORD_COMPROMISED_MESSAGE,
      code: "PASSWORD_COMPROMISED",
    });
  }
}
