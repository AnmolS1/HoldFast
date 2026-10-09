// ONE ANSWER, ONE AMOUNT OF WORK — for every endpoint somebody who is not signed in can call
// about an address, a code or a token.
//
// What such a caller may learn from an answer is what they put in. So, for each of those
// endpoints:
//   1. everything that depends only on the caller's INPUT is checked first and identically —
//      shape, password policy (the breach check included), captcha, rate limits, the sign-up
//      statement — before anything is looked up (hooks.ts `before`, Better Auth's own schema);
//   2. then both branches do the same expensive work: exactly one password hash where an
//      ADDRESS is the question (Better Auth hashes on its unknown-address branches — behind the
//      captcha), and the same number of database round trips BEFORE THE ANSWER — `padStatements` brings every answer of
//      an endpoint up to that endpoint's fixed number, so "the account exists" is not "three
//      more round trips";
//   3. mail and audit rows are DEFERRED on every branch (never awaited before the answer);
//   4. and the answer is the same: status, body shape, header names, cookie names.
// A wall clock cannot be compared in a test; the COUNTS can, and tests/unit/auth/parity.test.ts
// holds every endpoint here to them (statements before the answer, hashes, mails, cookies).
//
// A TOKEN is not an address: whether a 24-character random token exists is not something to
// hide by hashing — a reset with a token nobody issued does the same round trips as one with a
// good token and NO hash (a hash there would be a tenth of a second of CPU for any stranger who
// asks, with no captcha in front of it).
//
// Only a request that got past the free refusals, the limiters and the captcha is padded
// (auth/preflight.ts): the padding is itself work.
//
// The numbers below are ceilings measured on the heaviest branch of each endpoint, with room.
// A branch that needs MORE than its endpoint's number is not padded and the test fails: the
// number is then raised, deliberately.

import { sql } from "drizzle-orm";
import { statementsSent, type Db } from "../db/client";

/** Round trips before the answer, per endpoint (paths relative to /api/auth, and our own routes). */
export const STATEMENT_BUDGET: Readonly<Record<string, number>> = Object.freeze({
  "/sign-up/email": 36,
  "/sign-in/email": 12,
  "/request-password-reset": 12,
  "/send-verification-email": 12,
  "/reset-password": 20,
  "/account/pending-email": 30,
});
// Not here, on purpose: `GET /api/invites/:code` and `POST /api/auth-intent` answer about a CODE
// the caller holds, and say outright whether it is usable — there is nothing further for the
// amount of work to give away (each is one look-up either way).

/** The budget of a link that answers with an error (unknown, expired, used, wrong account). */
export const LINK_ERROR_BUDGET = 8;

/**
 * Sends no-op statements until this request has sent `target` in all. A request already past
 * `target` is left alone (and is what the parity test exists to catch).
 */
export async function padStatements(db: Db, target: number): Promise<void> {
  // Bounded twice over: by the target, and by a hard stop no budget comes near.
  for (let guard = 0; guard < 64 && statementsSent(db) < target; guard++) {
    await db.execute(sql`SELECT 1`);
  }
}
