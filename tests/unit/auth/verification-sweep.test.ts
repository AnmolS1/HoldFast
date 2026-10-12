// A10 — rows in `verification` are created by requests nobody has authenticated (a sign-up
// intent, passkey options, an OAuth state, a two-factor challenge) and Better Auth deletes one
// only when it is used. The nightly cron removes what expired more than a day ago.
import { env } from "cloudflare:workers";
import { inArray } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { sweepExpiredVerifications } from "../../../src/worker/db/queries/auth-lifecycle";
import { verification } from "../../../src/worker/db/schema";
import { NIGHTLY_CRON, scheduled } from "../../../src/worker/scheduled";
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

async function plant(expiresInMs: number): Promise<string> {
  const row = id();
  const at = new Date();
  await testDb()
    .insert(verification)
    .values({
      id: row,
      identifier: `sweep-test:${row}`,
      value: "x",
      expiresAt: new Date(Date.now() + expiresInMs),
      createdAt: at,
      updatedAt: at,
    });
  return row;
}
const left = async (ids: string[]) =>
  (await testDb().select({ id: verification.id }).from(verification).where(inArray(verification.id, ids)))
    .map((row) => row.id)
    .sort();

describe("the sweep of expired verification rows", () => {
  it("removes rows that expired more than a day ago — and nothing newer, live or long-lived", async () => {
    const old = [await plant(-49 * HOUR), await plant(-25 * HOUR)];
    const kept = [
      await plant(-23 * HOUR),
      await plant(-60_000),
      await plant(HOUR),
      await plant(50 * 365 * 24 * HOUR),
    ];
    const removed = await sweepExpiredVerifications(testDb());
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(await left(old)).toEqual([]);
    expect(await left(kept)).toEqual([...kept].sort());
  });

  it("works in bounded batches: one call removes at most the limit, and says how many", async () => {
    const old = [await plant(-30 * HOUR), await plant(-30 * HOUR), await plant(-30 * HOUR)];
    // Whatever other test files left behind is swept too; the call itself never exceeds its limit.
    expect(await sweepExpiredVerifications(testDb(), { limit: 1 })).toBe(1);
    await sweepExpiredVerifications(testDb());
    expect(await left(old)).toEqual([]);
  });

  it("the nightly cron runs it; the other crons do not", async () => {
    const old = await plant(-40 * HOUR);
    const run = (cron: string) =>
      scheduled(
        { cron, scheduledTime: Date.now(), noRetry() {} } as ScheduledController,
        env,
        { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext,
        { db: testDb(), env, defer: () => {} } as unknown as BackgroundContext,
      );
    const sweep = vi.mocked(sweepExpiredVerifications);
    sweep.mockClear();
    await run("3 * * * *");
    expect(sweep).not.toHaveBeenCalled();
    await run(NIGHTLY_CRON);
    expect(sweep).toHaveBeenCalledTimes(1);
    expect(await left([old])).toEqual([]);
  });
});
