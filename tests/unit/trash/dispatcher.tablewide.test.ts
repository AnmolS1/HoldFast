// The registry and its dispatcher: which jobs a cron expression runs, in which order, and that
// the two jobs that ran before the registry existed still do their work.
//
// TABLE-WIDE: `runScheduled` with a real cron expression runs the real jobs. No other test file
// calls `scheduled()` or `runScheduled` with an expression a job listens to. The reconcile job
// persists `settings.reconcileCursor`; the value found is put back in `afterAll`.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sweepExpiredVerifications } from "../../../src/worker/db/queries/auth-lifecycle";
import { getSettings, setSetting } from "../../../src/worker/db/queries/settings";
import { settings as settingsTable, verification } from "../../../src/worker/db/schema";
import {
  JOB_SOFT_DEADLINE_MS,
  jobNames,
  jobs,
  runJob,
  runScheduled,
  softDeadlineOf,
  type Job,
} from "../../../src/worker/jobs/index";
import { job as operatorDigests } from "../../../src/worker/jobs/operator-digests";
import { job as verificationSweep } from "../../../src/worker/jobs/verification-sweep";
import { HOURLY_CRON, NIGHTLY_CRON, scheduled } from "../../../src/worker/scheduled";
import { flushOperatorDigests } from "../../../src/worker/services/email";
import { cronEvent, gate, jobContext, rand, testDb } from "./helpers";

vi.mock("../../../src/worker/services/email", async (original) => {
  const real = await original<typeof import("../../../src/worker/services/email")>();
  return { ...real, flushOperatorDigests: vi.fn(real.flushOperatorDigests) };
});
vi.mock("../../../src/worker/db/queries/auth-lifecycle", async (original) => {
  const real = await original<typeof import("../../../src/worker/db/queries/auth-lifecycle")>();
  return { ...real, sweepExpiredVerifications: vi.fn(real.sweepExpiredVerifications) };
});

/** wrangler.jsonc `triggers.crons`, and what each runs — in this order. */
const SLOTS: Record<string, string[]> = {
  "17 */6 * * *": ["purge"],
  "3 * * * *": ["stale-uploads", "abuse-hourly", "operator-digests"],
  "5 0 * * *": ["retention", "unpause-midnight", "verification-sweep"],
  "0 2 * * *": ["backup", "user-purge", "reconcile"],
};
/** A real slot runs real jobs over everything other files left behind. */
const REAL_RUN_MS = 300_000;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

let found: unknown;
let hadCursor = false;
beforeAll(async () => {
  const stored = await getSettings(testDb(), { fresh: true });
  hadCursor = "reconcileCursor" in stored;
  found = stored.reconcileCursor;
});
afterAll(async () => {
  if (hadCursor) await setSetting(testDb(), "reconcileCursor", found, null);
  else await testDb().delete(settingsTable).where(eq(settingsTable.key, "reconcileCursor"));
});
afterEach(() => vi.restoreAllMocks());

/** Records every job that is run, in order. `stub`: do not run the job itself. */
function watch(stub: boolean) {
  const ran: string[] = [];
  for (const job of jobs) {
    const real = job.run.bind(job);
    vi.spyOn(job, "run").mockImplementation(async (...args: Parameters<Job["run"]>) => {
      ran.push(job.name);
      if (!stub) return real(...args);
    });
  }
  return ran;
}

async function plantExpired(): Promise<string> {
  const id = `dispatch${rand(12)}`;
  const at = new Date();
  await testDb()
    .insert(verification)
    .values({
      id,
      identifier: `dispatcher-test:${id}`,
      value: "x",
      expiresAt: new Date(Date.now() - 40 * 3_600_000),
      createdAt: at,
      updatedAt: at,
    });
  return id;
}
const verificationLeft = async (id: string) =>
  (await testDb().select().from(verification).where(eq(verification.id, id))).length;

describe("the registry", () => {
  it("holds exactly the ten jobs, each on its expression, in run order", () => {
    expect(jobs.map((job) => job.name)).toEqual(Object.values(SLOTS).flat());
    expect(jobNames).toEqual(jobs.map((job) => job.name));
    for (const [cron, names] of Object.entries(SLOTS)) {
      expect(
        jobs.filter((job) => job.cron === cron).map((job) => job.name),
        cron,
      ).toEqual(names);
    }
    // The two expressions other modules name are the hourly and the nightly slot.
    expect(operatorDigests.cron).toBe(HOURLY_CRON);
    expect(verificationSweep.cron).toBe(NIGHTLY_CRON);
    expect([HOURLY_CRON, NIGHTLY_CRON]).toEqual(["3 * * * *", "5 0 * * *"]);
    // The two that walk every account get twice the time.
    expect(softDeadlineOf("purge")).toBe(JOB_SOFT_DEADLINE_MS);
    expect([softDeadlineOf("user-purge"), softDeadlineOf("reconcile")]).toEqual([120_000, 120_000]);
  });

  it.each(Object.entries(SLOTS))(
    "%s runs exactly its jobs, in order, each handed its deadline",
    async (cron, names) => {
      const ran = watch(true);
      const job = jobContext();
      await expect(runScheduled(cronEvent(cron), env, ctx, job.bg)).resolves.toBeUndefined();
      expect(ran).toEqual(names);
      for (const candidate of jobs.filter((entry) => entry.cron === cron)) {
        expect(vi.mocked(candidate.run).mock.calls[0]![3]).toEqual({
          softDeadlineMs: softDeadlineOf(candidate.name),
        });
      }
      expect(job.outcomes(names[0]!)).toEqual([]);
    },
  );

  it("an expression no job listens to — and an empty one — runs nothing", async () => {
    const ran = watch(true);
    for (const cron of ["59 23 31 12 *", "", "3 * * * * "]) {
      await runScheduled(cronEvent(cron), env, ctx, jobContext().bg);
    }
    expect(ran).toEqual([]);
  });

  it("a job that throws is counted and reported, and the next one still runs", async () => {
    const ran = watch(true);
    vi.mocked(jobs.find((job) => job.name === "stale-uploads")!.run).mockRejectedValueOnce(
      new Error("stale-uploads failed"),
    );
    const job = jobContext();
    await expect(runScheduled(cronEvent("3 * * * *"), env, ctx, job.bg)).resolves.toBeUndefined();
    expect(ran).toEqual(["abuse-hourly", "operator-digests"]);
    expect(job.metric.mock.calls).toContainEqual(["job", { kind: "stale-uploads", outcome: "error" }]);
    expect(job.outcomes("abuse-hourly")).toEqual([]);
  });

  it("does not resolve before a slow job has finished, and starts the next only after it", async () => {
    const ran = watch(true);
    const slow = gate();
    const started = gate();
    vi.mocked(jobs.find((job) => job.name === "retention")!.run).mockImplementationOnce(async () => {
      ran.push("retention");
      started.open();
      await slow.opened;
    });
    let resolved = false;
    const running = runScheduled(cronEvent("5 0 * * *"), env, ctx, jobContext().bg).then(() => {
      resolved = true;
    });
    await started.opened;
    // Every microtask and timer that is ready has run: it is still waiting for the job.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    expect(ran).toEqual(["retention"]);
    slow.open();
    await running;
    expect(ran).toEqual(["retention", "unpause-midnight", "verification-sweep"]);
  });

  it("runJob: one pass of one named job, and nothing that is not in the registry", async () => {
    const job = jobContext();
    await expect(runJob("no-such-job", job.bg)).rejects.toThrow("unknown job");
    await expect(runJob("purge; drop", job.bg)).rejects.toThrow("unknown job");
    // A placeholder returns nothing: that is done.
    expect(await runJob("abuse-hourly", job.bg)).toEqual({ done: true });
    // A job stopped at its deadline says that more is left.
    expect(await runJob("retention", job.bg, { softDeadlineMs: 0 })).toEqual({ done: false });
    const ran = watch(true);
    await runJob("reconcile", job.bg);
    await runJob("purge", job.bg, { softDeadlineMs: 5 });
    expect(ran).toEqual(["reconcile", "purge"]);
    const reconcile = vi.mocked(jobs.find((entry) => entry.name === "reconcile")!.run).mock.calls[0]!;
    expect(reconcile[2].cron).toBe("0 2 * * *");
    expect(reconcile[3]).toEqual({ softDeadlineMs: 120_000 });
    expect(vi.mocked(jobs[0]!.run).mock.calls[0]![3]).toEqual({ softDeadlineMs: 5 });
  });
});

describe("the four cron expressions, with the real jobs", () => {
  it(
    "every slot runs its jobs without error — through runScheduled and through scheduled() alike",
    async () => {
      for (const entry of [runScheduled, scheduled]) {
        for (const [cron, names] of Object.entries(SLOTS)) {
          const ran = watch(false);
          const job = jobContext();
          await expect(entry(cronEvent(cron), env, ctx, job.bg)).resolves.toBeUndefined();
          await job.settle();
          expect(ran, `${entry.name} ${cron}`).toEqual(names);
          // No job of the slot failed: the dispatcher counted no error, and neither did a job.
          const errors = job.metric.mock.calls.filter(
            ([name, tags]) => name === "job" && (tags as { outcome?: string }).outcome === "error",
          );
          expect(errors, `${entry.name} ${cron}`).toEqual([]);
          vi.restoreAllMocks();
        }
      }
    },
    2 * 4 * REAL_RUN_MS,
  );

  it(
    "the hourly slot flushes the operator digests once and does not sweep; the nightly slot sweeps",
    async () => {
      const flush = vi.mocked(flushOperatorDigests);
      const sweep = vi.mocked(sweepExpiredVerifications);
      const expired = await plantExpired();
      flush.mockClear();
      sweep.mockClear();

      await runScheduled(cronEvent(HOURLY_CRON), env, ctx, jobContext().bg);
      expect(flush).toHaveBeenCalledTimes(1);
      expect(sweep).not.toHaveBeenCalled();
      expect(await verificationLeft(expired)).toBe(1);

      await runScheduled(cronEvent(NIGHTLY_CRON), env, ctx, jobContext().bg);
      expect(sweep).toHaveBeenCalled();
      expect(flush).toHaveBeenCalledTimes(1);
      expect(await verificationLeft(expired)).toBe(0);

      // The other two slots do neither.
      flush.mockClear();
      sweep.mockClear();
      const later = await plantExpired();
      await runScheduled(cronEvent("17 */6 * * *"), env, ctx, jobContext().bg);
      await runScheduled(cronEvent("0 2 * * *"), env, ctx, jobContext().bg);
      expect(flush).not.toHaveBeenCalled();
      expect(sweep).not.toHaveBeenCalled();
      expect(await verificationLeft(later)).toBe(1);
    },
    4 * REAL_RUN_MS,
  );
});
