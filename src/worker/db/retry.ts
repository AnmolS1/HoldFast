// Running a transaction again when Postgres ended it for a reason that says nothing about the
// work: it was picked as a deadlock victim (40P01), or it could not be serialised (40001).
// Nothing of a transaction that failed this way was written, so it can simply be run again.

import { PgTransaction } from "drizzle-orm/pg-core";
import type { Executor } from "./client";
import { pgError } from "./errors";

/** How often a transaction is run in all, unless the caller says otherwise. */
export const DEADLOCK_ATTEMPTS = 4;
/** The pause before attempt n + 1: up to n × this many milliseconds, at random. */
const BACKOFF_MS = 15;
const RETRYABLE = new Set(["40P01", "40001"]);

/** Is this executor a transaction (a `Tx`), not the database handle? */
export function isTransaction(db: Executor): boolean {
  return db instanceof PgTransaction;
}

/**
 * Runs `run` in a transaction on `db`, and runs the WHOLE transaction again when Postgres ended
 * it as a deadlock victim (40P01) or for a serialization failure (40001): `attempts` times in
 * all (default `DEADLOCK_ATTEMPTS`), a short random pause between, then the error is thrown.
 * Any other error is thrown at once.
 *
 * ONLY ON THE DATABASE HANDLE. When `db` is itself a transaction, `run` runs once, in a
 * savepoint. A failure there rolls back the SAVEPOINT only: the caller's transaction is still
 * usable and still holds every lock it took before — which is why running `run` again here
 * would meet the same deadlock, and why it is not done. The caller should let the error
 * through (rethrow it, do not carry on with half the work): its own transaction then ends, its
 * locks are released, and the `retryOnDeadlock` at the top level, if there is one, runs
 * everything again from the start.
 *
 * `run` MUST DO DATABASE STATEMENTS ONLY — through the `tx` it is given. It may run several
 * times, and what it did outside the database (a mail, a queue message, an object written or
 * deleted, a metric, a value kept in memory) is not undone when an attempt is thrown away. Do
 * those after this function has returned.
 */
export async function retryOnDeadlock<T>(
  db: Executor,
  run: (tx: Executor) => Promise<T>,
  opts: { attempts?: number } = {},
): Promise<T> {
  if (isTransaction(db)) return db.transaction(run);
  const attempts = Math.max(1, Math.trunc(opts.attempts ?? DEADLOCK_ATTEMPTS));
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction(run);
    } catch (error) {
      if (attempt >= attempts || !RETRYABLE.has(pgError(error)?.code ?? "")) throw error;
      const pause = Math.random() * BACKOFF_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}
