import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { backlog, claim, finish, SCAN_CLAIM_STALE_MINUTES } from "../../../src/worker/db/queries/scan-jobs";
import { scanJobs } from "../../../src/worker/db/schema";
import { makeFile, makeUser, openDb, rand } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

async function target() {
  const owner = await makeUser(db);
  const file = await makeFile(db, owner, null, `scan-${rand()}.bin`, { scanStatus: "pending" });
  return { nodeId: file.id, r2Key: file.r2Key!, etag: "etag-1" };
}

const job = async (r2Key: string) => (await db.select().from(scanJobs).where(eq(scanJobs.r2Key, r2Key)))[0]!;
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);

describe("claim", () => {
  it("a fresh key is claimed with attempt 1", async () => {
    const t = await target();
    const result = await claim(db, t);
    expect(result).toEqual({ claimed: true, jobId: expect.any(String), attempt: 1 });
    expect(await job(t.r2Key)).toMatchObject({
      nodeId: t.nodeId,
      status: "running",
      attempt: 1,
      etag: "etag-1",
      finishedAt: null,
    });
  });

  it("a duplicate delivery while the scan is running is not claimed", async () => {
    const t = await target();
    const first = await claim(db, t);
    expect(await claim(db, t)).toEqual({ claimed: false, status: "running" });
    expect(await claim(db, { nodeId: t.nodeId, r2Key: t.r2Key })).toEqual({
      claimed: false,
      status: "running",
    });
    expect(await job(t.r2Key)).toMatchObject({ attempt: 1, id: (first as { jobId: string }).jobId });
  });

  it("20 concurrent deliveries of a fresh key: exactly one claims", async () => {
    const t = await target();
    const results = await Promise.all(Array.from({ length: 20 }, () => claim(db, t)));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(results.filter((r) => !r.claimed).every((r) => !r.claimed && r.status === "running")).toBe(true);
    expect((await job(t.r2Key)).attempt).toBe(1);
  });

  it("a done job is not claimed again (the consumer acks)", async () => {
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    expect(await finish(db, first, "done", { engine: "clamav", outcome: "clean" })).toBe(true);
    expect(await claim(db, t)).toEqual({ claimed: false, status: "done" });
    expect(await job(t.r2Key)).toMatchObject({
      status: "done",
      attempt: 1,
      engine: "clamav",
      verdict: { engine: "clamav", outcome: "clean" },
      lastError: null,
    });
    expect((await job(t.r2Key)).finishedAt).toBeInstanceOf(Date);
  });

  it("after failed, the next delivery claims with attempt 2 and the same job id", async () => {
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    expect(await finish(db, first, "failed", null, "timeout")).toBe(true);
    expect(await job(t.r2Key)).toMatchObject({ status: "failed", lastError: "timeout" });
    const second = await claim(db, t);
    expect(second).toEqual({ claimed: true, jobId: first.jobId, attempt: 2 });
    expect(await job(t.r2Key)).toMatchObject({ status: "running", attempt: 2, finishedAt: null });
  });

  it(`a running claim older than ${SCAN_CLAIM_STALE_MINUTES} minutes is taken over; a younger one is not`, async () => {
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    await db
      .update(scanJobs)
      .set({ startedAt: minutesAgo(SCAN_CLAIM_STALE_MINUTES - 1) })
      .where(eq(scanJobs.id, first.jobId));
    expect(await claim(db, t)).toEqual({ claimed: false, status: "running" });
    await db
      .update(scanJobs)
      .set({ startedAt: minutesAgo(SCAN_CLAIM_STALE_MINUTES + 1) })
      .where(eq(scanJobs.id, first.jobId));
    expect(await claim(db, t)).toEqual({ claimed: true, jobId: first.jobId, attempt: 2 });
    expect((await job(t.r2Key)).startedAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
    // The delivery that was taken over can no longer finish the job as its own — it is running
    // again under attempt 2, and that attempt finishes it.
    expect(await claim(db, t)).toEqual({ claimed: false, status: "running" });
  });

  it("force re-claims a done job but never a fresh running one", async () => {
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    expect(await claim(db, { ...t, force: true })).toEqual({ claimed: false, status: "running" });
    await finish(db, first, "done", { outcome: "clean" });
    expect(await claim(db, { ...t, force: false })).toEqual({ claimed: false, status: "done" });
    const rescan = await claim(db, { ...t, force: true });
    expect(rescan).toEqual({ claimed: true, jobId: first.jobId, attempt: 2 });
    // The earlier verdict survives until the new attempt stores its own.
    expect((await job(t.r2Key)).verdict).toEqual({ outcome: "clean" });
    expect(await claim(db, { ...t, force: true })).toEqual({ claimed: false, status: "running" });
  });
});

describe("finish", () => {
  it("only a running job changes; a failure keeps the earlier verdict", async () => {
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    await finish(db, first, "done", { outcome: "clean", effects: ["blocklist"] });
    expect(await finish(db, first, "failed", null, "late")).toBe(false);
    expect((await job(t.r2Key)).status).toBe("done");

    const rescan = await claim(db, { ...t, force: true });
    if (!rescan.claimed) throw new Error("not claimed");
    expect(await finish(db, rescan, "failed", undefined, "engine")).toBe(true);
    expect(await job(t.r2Key)).toMatchObject({
      status: "failed",
      lastError: "engine",
      verdict: { outcome: "clean", effects: ["blocklist"] },
    });
    expect(await finish(db, { jobId: uuidv7(), attempt: 1 }, "done", {})).toBe(false);
    expect(await finish(db, { jobId: "junk", attempt: 1 }, "done", {})).toBe(false);
  });

  // A consumer whose claim went stale (it hung past the 20 minutes) was taken over. When it
  // wakes up it must not end the new owner's claim: that would let a third delivery claim the
  // key while the second is still scanning, and store the stale worker's verdict as the job's.
  it("a taken-over attempt cannot finish the new owner's claim", async () => {
    const t = await target();
    const stale = await claim(db, t);
    if (!stale.claimed) throw new Error("not claimed");
    await db
      .update(scanJobs)
      .set({ startedAt: minutesAgo(SCAN_CLAIM_STALE_MINUTES + 1) })
      .where(eq(scanJobs.id, stale.jobId));
    const owner = await claim(db, t);
    expect(owner).toEqual({ claimed: true, jobId: stale.jobId, attempt: 2 });
    if (!owner.claimed) throw new Error("not claimed");

    expect(await finish(db, stale, "done", { outcome: "clean", from: "stale" })).toBe(false);
    expect(await finish(db, stale, "failed", null, "stale worker gave up")).toBe(false);
    expect(await job(t.r2Key)).toMatchObject({
      status: "running",
      attempt: 2,
      verdict: null,
      lastError: null,
      finishedAt: null,
    });
    // Still owned: a third delivery is told to retry, not handed the job.
    expect(await claim(db, t)).toEqual({ claimed: false, status: "running" });

    expect(await finish(db, owner, "done", { outcome: "infected", from: "owner" })).toBe(true);
    expect(await job(t.r2Key)).toMatchObject({
      status: "done",
      verdict: { outcome: "infected", from: "owner" },
    });
    expect(await finish(db, { jobId: stale.jobId, attempt: Number.NaN }, "done", {})).toBe(false);
  });

  it("works inside the caller's transaction", async () => {
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    await expect(
      db.transaction(async (tx) => {
        expect(await finish(tx, first, "done", { outcome: "clean" })).toBe(true);
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect((await job(t.r2Key)).status).toBe("running");
  });
});

describe("backlog", () => {
  it("counts running jobs and reports the oldest start", async () => {
    const before = await backlog(db);
    const t = await target();
    const first = await claim(db, t);
    if (!first.claimed) throw new Error("not claimed");
    const old = new Date(Date.UTC(2001, 0, 1));
    await db.update(scanJobs).set({ startedAt: old }).where(eq(scanJobs.id, first.jobId));
    const during = await backlog(db);
    expect(typeof during.running).toBe("number");
    expect(during.running).toBeGreaterThanOrEqual(1);
    expect(before.running).toBeGreaterThanOrEqual(0);
    expect(during.oldestStartedAt!.getTime()).toBe(old.getTime());
    await finish(db, first, "done", {});
    const after = await backlog(db);
    expect(after.oldestStartedAt === null || after.oldestStartedAt.getTime() > old.getTime()).toBe(true);
  });
});
