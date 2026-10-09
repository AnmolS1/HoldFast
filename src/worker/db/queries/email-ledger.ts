// The per-recipient email caps (5 an hour, 50 a day by default). The counters live in the
// database because an in-isolate counter cannot enforce a cap across isolates.

import { sql } from "drizzle-orm";
import type { Executor } from "../client";

class CapReached extends Error {}

/** One conditional upsert: counts the send unless the window is already full. */
async function consumeWindow(
  tx: Executor,
  kind: "hour" | "day",
  recipientHash: string,
  cap: number,
): Promise<boolean> {
  // The three-argument date_trunc truncates in UTC whatever the session's zone is.
  const result = await tx.execute(sql`
    INSERT INTO email_ledger (window_kind, window_start, recipient_hash, count)
    VALUES (${kind}::email_window_kind, date_trunc(${kind}, now(), 'UTC'), ${recipientHash}, 1)
    ON CONFLICT (window_kind, window_start, recipient_hash) DO UPDATE
      SET count = email_ledger.count + 1
      WHERE email_ledger.count < ${cap}
    RETURNING count`);
  return result.rows.length > 0;
}

/**
 * Takes one send from the recipient's hourly AND daily allowance, or neither: both counters move
 * in one transaction, and a full window rolls the other back. False = over a cap; do not send.
 * Atomic under concurrency: the caps hold however many callers race.
 */
export async function tryConsume(
  db: Executor,
  recipientHash: string,
  caps: { perHour: number; perDay: number },
): Promise<boolean> {
  if (caps.perHour < 1 || caps.perDay < 1) return false;
  try {
    await db.transaction(async (tx) => {
      // Day first, then hour, in every caller: one lock order, so two sends cannot deadlock.
      if (!(await consumeWindow(tx, "day", recipientHash, caps.perDay))) throw new CapReached();
      if (!(await consumeWindow(tx, "hour", recipientHash, caps.perHour))) throw new CapReached();
    });
    return true;
  } catch (error) {
    if (error instanceof CapReached) return false;
    throw error;
  }
}
