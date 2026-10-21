// A10 — rows in `verification` are created by requests nobody has authenticated (a sign-up
// intent, passkey options, an OAuth state, a two-factor challenge) and Better Auth deletes one
// only when it is used. The nightly cron removes what expired more than a day ago.
import { env } from "cloudflare:workers";
import { inArray, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { sweepExpiredVerifications } from "../../../src/worker/db/queries/auth-lifecycle";
import { verification } from "../../../src/worker/db/schema";
import { job } from "../../../src/worker/jobs/verification-sweep";
import { NIGHTLY_CRON } from "../../../src/worker/scheduled";
import type { BackgroundContext } from "../../../src/worker/services/request-context";
import { testDb } from "./helpers";

// The sweep is table-wide by nature, and other test files sweep too (any nightly cron run): "the
// hourly cron did NOT sweep" cannot be read off the table — a neighbour's sweep removes this
// file's row at any moment. It is read off the CALL instead; that the nightly run then removes
// this file's own row is still read off the table.
vi.mock("../../../src/worker/db/queries/auth-lifecycle", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/auth-lifecycle")>();
  return { ...real, sweepExpiredVerifications: vi.fn(real.sweepExpiredVerifications) };
});

const HOUR = 3_600_000;
const id = () => crypto.randomUUID().replace(/-/g, "");

type Db = ReturnType<typeof testDb>;
type Exec = Parameters<Parameters<Db["transaction"]>[0]>[0] | Db;

async function plant(expiresInMs: number, db: Exec = testDb()): Promise<string> {
  const row = id();
  const at = new Date();
  await db.insert(verification).values({
    id: row,
    identifier: `sweep-test:${row}`,
    value: "x",
    expiresAt: new Date(Date.now() + expiresInMs),
    createdAt: at,
    updatedAt: at,
  });
  return row;
}
const left = async (ids: string[], db: Exec = testDb()) =>
  (await db.select({ id: verification.id }).from(verification).where(inArray(verification.id, ids)))
    .map((row) => row.id)
    .sort();

// The table is shared with every other test file, and Better Auth itself deletes EVERY expired
// row on each verification lookup (internal-adapter: `deleteVerificationByIdentifier` cleanup) —
// so a neighbour's auth request between "plant" and "sweep" removes this file's rows first and
// the sweep then counts nothing. Rows planted in a transaction that has not committed are
// invisible to all of that: the count below is the sweep's own.
const ROLLBACK = new Error("rollback");
async function isolated(run: (tx: Exec) => Promise<void>): Promise<void> {
  await testDb()
    .transaction(async (tx) => {
      await run(tx);
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
}
/** What a neighbour does at any moment: every expired row, table-wide, on its own connection. */
const neighbourCleanup = () =>
  testDb().execute(sql`DELETE FROM ${verification} WHERE expires_at < (now() AT TIME ZONE 'UTC')`);

describe("the sweep of expired verification rows", () => {
  it("removes rows that expired more than a day ago — and nothing newer, live or long-lived", async () => {
    await isolated(async (tx) => {
      const old = [await plant(-49 * HOUR, tx), await plant(-25 * HOUR, tx)];
      const kept = [
        await plant(-23 * HOUR, tx),
        await plant(-60_000, tx),
        await plant(HOUR, tx),
        await plant(50 * 365 * 24 * HOUR, tx),
      ];
      await neighbourCleanup();
      const removed = await sweepExpiredVerifications(tx);
      expect(removed).toBeGreaterThanOrEqual(2);
      expect(await left(old, tx)).toEqual([]);
      expect(await left(kept, tx)).toEqual([...kept].sort());
    });
  });

  it("works in bounded batches: one call removes at most the limit, and says how many", async () => {
    await isolated(async (tx) => {
      const old = [await plant(-30 * HOUR, tx), await plant(-30 * HOUR, tx), await plant(-30 * HOUR, tx)];
      await neighbourCleanup();
      // Whatever other test files left behind is swept too; the call itself never exceeds its limit.
      expect(await sweepExpiredVerifications(tx, { limit: 1 })).toBe(1);
      await sweepExpiredVerifications(tx);
      expect(await left(old, tx)).toEqual([]);
    });
  });

  it("the nightly cron runs it; the other crons do not", async () => {
    const old = await plant(-40 * HOUR);
    // The job itself, not the cron entry: the entry would run every job of the slot, table-wide,
    // beside the other test files. Which jobs an expression runs is the registry's own test.
    const run = () =>
      job.run({ db: testDb(), env, defer: () => {} } as unknown as BackgroundContext, env, {
        cron: NIGHTLY_CRON,
        scheduledTime: Date.now(),
        noRetry() {},
      } as ScheduledController);
    const sweep = vi.mocked(sweepExpiredVerifications);
    sweep.mockClear();
    expect(job.cron).toBe(NIGHTLY_CRON);
    await run();
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(await left([old])).toEqual([]);
  });
});
