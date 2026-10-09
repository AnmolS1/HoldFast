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

// ── operator alerts held for a digest (services/email.ts) ───────────────────────────────────
//
// A ROUTINE operator alert beyond the mailbox's hourly count is not sent on its own and is not
// dropped: it is held here until the next digest lists it. The rows live in `verification`
// (identifier `opalert:<ledger key of the mailbox>`, value = the alert as JSON — a kind, an id
// and the operator's own address; never anything a user typed), expiring after a week.

export type HeldAlert = { kind: string; id: string; to: string };
const HELD_PREFIX = "opalert:";
const HELD_DAYS = 7;

export async function holdAlert(db: Executor, mailboxKey: string, alert: HeldAlert): Promise<void> {
  await db.execute(sql`
    INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
    VALUES (gen_random_uuid()::text, ${HELD_PREFIX + mailboxKey}, ${JSON.stringify(alert)},
            (now() AT TIME ZONE 'UTC') + make_interval(days => ${HELD_DAYS}),
            now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`);
}

/** Takes (removes and returns) up to `limit` held alerts of one mailbox, oldest first. */
export async function takeHeldAlerts(db: Executor, mailboxKey: string, limit: number): Promise<HeldAlert[]> {
  const result = await db.execute<{ value: string }>(sql`
    DELETE FROM verification WHERE id IN (
      SELECT id FROM verification WHERE identifier = ${HELD_PREFIX + mailboxKey}
      ORDER BY created_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
    RETURNING value`);
  const alerts: HeldAlert[] = [];
  for (const row of result.rows) {
    try {
      const parsed = JSON.parse(row.value) as Partial<HeldAlert>;
      if (typeof parsed.kind === "string" && typeof parsed.id === "string" && typeof parsed.to === "string") {
        alerts.push({ kind: parsed.kind, id: parsed.id, to: parsed.to });
      }
    } catch {
      // Not one of ours.
    }
  }
  return alerts;
}

/** One address per mailbox that has alerts waiting (for the hourly flush). */
export async function heldAlertMailboxes(db: Executor, limit = 50): Promise<string[]> {
  const result = await db.execute<{ value: string }>(sql`
    SELECT DISTINCT ON (identifier) value FROM verification
    WHERE identifier LIKE ${`${HELD_PREFIX}%`} ORDER BY identifier, created_at LIMIT ${limit}`);
  const addresses: string[] = [];
  for (const row of result.rows) {
    try {
      const to = (JSON.parse(row.value) as { to?: unknown }).to;
      if (typeof to === "string") addresses.push(to);
    } catch {
      // Not one of ours.
    }
  }
  return addresses;
}
