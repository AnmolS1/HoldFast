// The account purge re-reads the operator's pause switch before EACH account (R1 func-n3, the
// user-purge half): the `0 2` slot reads the detector once and the purge can run on that reading
// for minutes. A pause switched on after the slot's reading stops the accounts that are left —
// kept whole, still due — instead of being honoured only by the next night's run.
// TABLE-WIDE: the job works through every pending purge that is due.
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { pendingUserPurges } from "../../../src/worker/db/schema";
import { DESTROY_PAUSED_KEY, detectRollback } from "../../../src/worker/jobs/reconcile";
import { job as userPurgeJob } from "../../../src/worker/jobs/user-purge";
import { eq } from "drizzle-orm";
import {
  cronEvent,
  generationInStep,
  jobContext,
  makeFile,
  member,
  nodesLeft,
  scheduleDeletion,
  testDb,
  userRow,
} from "./helpers";

beforeAll(generationInStep);
afterEach(() => env.FILES.delete(DESTROY_PAUSED_KEY));

async function dueAccount() {
  const row = await member();
  const file = await makeFile(row.id, null, { scanStatus: "clean" });
  await scheduleDeletion(row.id, -1);
  return { id: row.id, nodeId: file.id };
}

describe("the account purge and the pause switch", () => {
  it("a pause switched on after the slot's reading: no account is purged, each stays due, the run is not done", async () => {
    const accounts = [await dueAccount(), await dueAccount()];
    const job = jobContext();
    // The slot read the detector BEFORE the operator paused: it says "ok".
    const detection = await detectRollback(job.bg);
    expect(detection).toMatchObject({ state: "ok" });
    await env.FILES.put(DESTROY_PAUSED_KEY, "paused by a test");

    const result = await userPurgeJob.run(job.bg, env, cronEvent(userPurgeJob.cron), {
      softDeadlineMs: 120_000,
      detection,
    });
    expect(result).toEqual({ done: false });
    expect(job.outcomes("user-purge")).toEqual(["paused_stopped"]);
    for (const account of accounts) {
      expect(await userRow(account.id)).not.toBeNull();
      expect(await nodesLeft([account.nodeId])).toEqual([account.nodeId]);
      const [pending] = await testDb()
        .select()
        .from(pendingUserPurges)
        .where(eq(pendingUserPurges.userId, account.id));
      expect(pending!.startedAt).toBeNull();
    }
  });

  it("an unreadable switch counts as on", async () => {
    const account = await dueAccount();
    const job = jobContext({
      env: {
        FILES: new Proxy(env.FILES, {
          get(target, prop) {
            if (prop === "get") {
              return (key: string, ...rest: unknown[]) =>
                key === DESTROY_PAUSED_KEY
                  ? Promise.reject(new Error("store unavailable (made up)"))
                  : (target.get as (...args: unknown[]) => unknown).call(target, key, ...rest);
            }
            const value = Reflect.get(target, prop, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      },
    });
    const result = await userPurgeJob.run(job.bg, env, cronEvent(userPurgeJob.cron), {
      softDeadlineMs: 120_000,
      detection: { state: "ok", database: 1, raw: "1" },
    });
    expect(result).toEqual({ done: false });
    expect(await userRow(account.id)).not.toBeNull();
  });

  it("with the switch off the same run purges them (the control for the two above)", async () => {
    const accounts = [await dueAccount(), await dueAccount()];
    const job = jobContext();
    const detection = await detectRollback(job.bg);
    const result = await userPurgeJob.run(job.bg, env, cronEvent(userPurgeJob.cron), {
      softDeadlineMs: 120_000,
      detection,
    });
    expect(result).toEqual({ done: true });
    for (const account of accounts) expect(await userRow(account.id)).toBeNull();
  });
});
