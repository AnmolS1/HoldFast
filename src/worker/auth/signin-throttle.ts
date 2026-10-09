// The password-guess throttle on POST /api/auth/sign-in/email.
//
// WHAT IT IS KEYED ON. One row per (address signed in to, client address) — both as keyed
// hashes — in the `rate_limit` table (Postgres: this count has to be exact, which the per-location
// rate-limit binding is not). It counts for an address that has no account exactly as for one that
// has: the row is about what was typed and from where, and nothing about an account is read to
// keep it. So the answer cannot say whether the account exists.
//
// WHAT IT DOES. It THROTTLES; it never locks. Within THROTTLE_WINDOW_S (15 minutes of no attempt
// from that client on that account ends the window):
//   - the first FREE_ATTEMPTS (5) wrong passwords from one client on one account are not delayed;
//   - after that the client must wait before its next attempt: 1, 2, 4, 8, 16, 32 and then
//     MAX_DELAY_S (60) seconds, counted from its OWN last attempt;
//   - once an account has collected ACCOUNT_PRESSURE (20) wrong passwords in the window from all
//     clients together, a client that has itself already been wrong about that account waits the
//     full 60 seconds between attempts — its five free ones are gone.
//   A refused attempt is answered 429 with `Retry-After` (never more than 60), costs no password
//   hash, is not counted, and does not move anybody's wait. A correct password removes the
//   client's row.
//
// WHY THE OWNER CANNOT BE LOCKED OUT. A client's wait is counted from that client's own last
// attempt and is never more than 60 seconds. Nothing another client does can lengthen it: other
// clients' failures only take away the free attempts of a client that has ALREADY failed on that
// account. So:
//   - the owner, at an address that has not been wrong about the account in the last 15 minutes,
//     is never delayed — whatever number of other addresses are guessing;
//   - the owner after a mistake of their own waits at most 60 seconds after that mistake.
// (An attacker at the owner's OWN address — behind the same NAT — shares the row, as with any
// per-address limit; the owner then waits at most 60 s between tries and competes for the next
// one. Recorded as a residual risk.)
//
// WHAT A GUESSER GETS. One client: 5 guesses, then at most 1 a minute (6 more in the first
// minute while the wait doubles) — and Better Auth's own rule on the path allows an address 5
// requests a minute in any case. Many clients on one account: each gets ONE undelayed guess per
// 15 minutes once the account is under pressure, then 1 a minute; every guess also costs a
// solved Turnstile challenge. Passwords are at least 12 characters and checked against the
// breach corpus, and an account with two-factor on needs the second factor too.
//
// ATOMIC. Admission is one statement that COUNTS the attempt as a failure before the password is
// looked at (db/queries/auth-lifecycle.ts `admitSignIn`): fifty simultaneous attempts are admitted
// exactly as fifty in a row would be. The count is given back when the password turns out right.
//
// The rows are pruned by Better Auth's own limiter (api/rate-limiter/index.mjs:174 — rows older
// than its longest window, one hour), which is longer than this window.

import { APIError } from "better-auth/api";
import { admitSignIn, forgetSignInFailures } from "../db/queries/auth-lifecycle";
import { ipHashStable } from "../services/ip-hash";
import { hmacHex } from "../services/keys";
import { count } from "./observe";
import type { AuthScope } from "./scope";

export const SIGN_IN_PATH = "/sign-in/email";
export const THROTTLE_WINDOW_S = 15 * 60;
export const FREE_ATTEMPTS = 5;
export const MAX_DELAY_S = 60;
export const ACCOUNT_PRESSURE = 20;

export const SIGN_IN_THROTTLED = {
  code: "SIGN_IN_THROTTLED",
  message: "Too many attempts. Wait a moment and try again.",
} as const;

type Ctx = { body?: unknown; context: { returned?: unknown } };

/** `signin:<account>:` — every client's row for one address signed in to starts with this. */
export async function throttleKeys(
  scope: Pick<AuthScope, "keys">,
  email: string,
  ip: string,
): Promise<{ account: string; pair: string }> {
  const [who, where] = await Promise.all([
    hmacHex(scope.keys, "email-ledger", `signin|${email.trim().toLowerCase()}`),
    ipHashStable(scope.keys, ip),
  ]);
  const account = `signin:${who.slice(0, 32)}:`;
  return { account, pair: `${account}${where.slice(0, 32)}` };
}

/** `hooks.before` on the sign-in: admit the attempt (counting it), or answer 429. */
export async function beforeSignIn(scope: AuthScope, ctx: Ctx): Promise<void> {
  const email = (ctx.body as { email?: unknown } | null | undefined)?.email;
  if (typeof email !== "string" || !scope.client) return;
  const keys = await throttleKeys(scope, email, scope.client.ip);
  const admitted = await admitSignIn(scope.db, keys, {
    windowSeconds: THROTTLE_WINDOW_S,
    free: FREE_ATTEMPTS,
    maxDelaySeconds: MAX_DELAY_S,
    pressure: ACCOUNT_PRESSURE,
  });
  if (admitted.ok) {
    scope.facts.signInAttempt = keys.pair;
    return;
  }
  scope.facts.throttled = true;
  count("auth", { outcome: "throttled", kind: "password" });
  const wait = Math.min(MAX_DELAY_S, Math.max(1, admitted.retryAfterSeconds));
  throw new APIError("TOO_MANY_REQUESTS", { ...SIGN_IN_THROTTLED }, { "Retry-After": String(wait) });
}

/** `hooks.after`: a password that was right is not a failure — the client's row goes. */
export async function afterSignIn(scope: AuthScope, ctx: Ctx): Promise<void> {
  const pair = scope.facts.signInAttempt;
  if (!pair) return;
  scope.facts.signInAttempt = null;
  const returned = ctx.context.returned;
  // 401 is the one answer to a wrong password or an unknown address (api/routes/sign-in.mjs:323–337).
  // Everything else Better Auth answers after the password has been verified: a session, the
  // two-factor step, "verify your address first" (:339), a ban.
  const wrong = returned instanceof APIError && returned.statusCode === 401;
  const failedOtherwise = returned instanceof Error && !(returned instanceof APIError);
  if (!wrong && !failedOtherwise) await forgetSignInFailures(scope.db, pair);
}
