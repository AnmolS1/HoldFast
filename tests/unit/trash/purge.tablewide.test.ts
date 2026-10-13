// The purge job, and the hold matrix: every cause the gate knows × every caller that can delete.
//
// TABLE-WIDE: the job purges every due root in the database, so this file runs alone (step 3 of
// `npm test`). Rows other files left behind are purged by it too; nothing here counts them, and
// a root is made due by backdating its own `purgeAfter`, never by moving the clock.
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it } from "vitest";
import { setNodeLegalHold, setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import { usageBreakdown } from "../../../src/worker/db/queries/quota";
import { purgeDue, restore as restoreQuery, trash as trashQuery } from "../../../src/worker/db/queries/trash";
import { job as purgeJob, purgeRoot, purgeVersions } from "../../../src/worker/jobs/purge";
import { purgeAccount } from "../../../src/worker/jobs/user-purge";
import { registerCoreDeps } from "../../../src/worker/services/request-context";
import { TrashResponse } from "../../../src/shared/schemas/node";
import { realCore } from "../auth/helpers";
import {
  api,
  audits,
  backendPid,
  closeNotice,
  cronEvent,
  deadlockingDb,
  gate,
  jobContext,
  keysUnder,
  makeDue,
  makeFile,
  makeFolder,
  makeVersion,
  member,
  nodeById,
  nodesLeft,
  objectExists,
  openNoticeOn,
  pendingPurge,
  scheduleDeletion,
  setNode,
  setUsedBytes,
  storeFile,
  storeVersion,
  testDb,
  untilBlockedBy,
  usedBytes,
  userRow,
  versionsLeft,
  type Caller,
  type JobContext,
} from "./helpers";

const DELETE = { method: "DELETE" } as const;
const DAY = 86_400_000;

/** One tick of the purge job, with a context of the test's own. */
async function tick(ctx: JobContext = jobContext()) {
  const result = await purgeJob.run(ctx.bg, env, cronEvent(purgeJob.cron), { softDeadlineMs: 120_000 });
  return { ctx, result };
}

/**
 * owner:   above/
 *            root/          ← in the trash, past its date
 *              file.bin     100 bytes, one old version of 40 that is past its date too
 *          other.bin        100 bytes, live, held by nothing
 */
async function scene() {
  const owner = await member();
  const above = await makeFolder(owner.id);
  const root = await makeFolder(owner.id, above.id);
  const file = await makeFile(owner.id, root.id, { scanStatus: "clean" });
  const version = await makeVersion(file, { due: true });
  const other = await makeFile(owner.id, null, { scanStatus: "clean" });
  const stored = { file: await storeFile(file), version: await storeVersion(version) };
  const otherStored = await storeFile(other);
  await setUsedBytes(owner.id, 240);
  await trashQuery(testDb(), root.id, owner.id);
  await makeDue(root.id);
  const keys = [stored.file.object, stored.file.thumb, stored.version.object, stored.version.thumb];
  const caller: Caller = { user: owner };
  return {
    owner,
    caller,
    above,
    root,
    file,
    version,
    other,
    otherStored,
    keys,
    /** Every row and object of the root is still there. */
    async intact(when: string) {
      expect(await nodesLeft([root.id, file.id]), when).toEqual([root.id, file.id].sort());
      expect(await versionsLeft(file.id), when).toEqual([version.versionId]);
      for (const key of keys) expect(await objectExists(key), `${when}: ${key}`).toBe(true);
    },
    async gone(when: string) {
      expect(await nodesLeft([root.id, file.id]), when).toEqual([]);
      expect(await versionsLeft(file.id), when).toEqual([]);
      for (const key of keys) expect(await objectExists(key), `${when}: ${key}`).toBe(false);
    },
  };
}
type Scene = Awaited<ReturnType<typeof scene>>;

describe("the purge job", () => {
  afterEach(() => registerCoreDeps(realCore));

  it("deletes a due root — exactly its rows and objects — with its record, and gives the bytes back", async () => {
    const s = await scene();
    const notDue = await makeFile(s.owner.id, null, { scanStatus: "clean" });
    const notDueStored = await storeFile(notDue);
    await trashQuery(testDb(), notDue.id, s.owner.id);
    // A due root whose objects were never stored (what other files leave behind): not an error.
    const bare = await makeFile(s.owner.id, null, { scanStatus: "clean" });
    await trashQuery(testDb(), bare.id, s.owner.id);
    await makeDue(bare.id);
    await setUsedBytes(s.owner.id, 440);
    const before = await keysUnder(`u/${s.owner.id}/`);

    const { ctx, result } = await tick();
    expect(result).toEqual({ done: true });
    await s.gone("after the tick");
    expect(await nodesLeft([bare.id])).toEqual([]);
    // Live and not-yet-due: untouched, rows and objects.
    expect(await nodesLeft([s.above.id, s.other.id, notDue.id])).toHaveLength(3);
    expect(await keysUnder(`u/${s.owner.id}/`)).toEqual(
      before.filter((key) => key === s.otherStored.object || key === notDueStored.object),
    );
    expect(await objectExists(notDueStored.thumb)).toBe(true);
    // 100 + 40 for the root, 100 for the bare file.
    expect(await usedBytes(s.owner.id)).toBe(200);
    expect(ctx.outcomes("purge")).toContain("purged");
    expect(ctx.outcomes("purge")).not.toContain("error");

    const rows = await audits("system.purge", s.root.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorType: "system",
      ipHashDaily: null,
      ua: null,
      country: null,
      requestId: null,
      targetType: "node",
      meta: { reason: "cron", objects: 2, bytes: 140 },
    });
    // Nothing left to do: a second tick finds nothing of this owner's.
    await tick();
    expect(await nodesLeft([notDue.id, s.other.id])).toHaveLength(2);
    expect(await audits("system.purge", s.root.id)).toHaveLength(1);
  });

  it("deletes old versions past their date, and no other", async () => {
    const owner = await member();
    const file = await makeFile(owner.id, null, { scanStatus: "clean" });
    const due = await makeVersion(file, { due: true });
    const kept = await makeVersion(file);
    const stored = {
      file: await storeFile(file),
      due: await storeVersion(due),
      kept: await storeVersion(kept),
    };
    await setUsedBytes(owner.id, 180);

    await tick();
    expect(await versionsLeft(file.id)).toEqual([kept.versionId]);
    expect(await nodesLeft([file.id])).toEqual([file.id]);
    expect([await objectExists(stored.due.object), await objectExists(stored.due.thumb)]).toEqual([
      false,
      false,
    ]);
    for (const key of [stored.file.object, stored.file.thumb, stored.kept.object, stored.kept.thumb]) {
      expect(await objectExists(key), key).toBe(true);
    }
    expect(await usedBytes(owner.id)).toBe(140);
    const rows = await audits("system.purge", file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "system",
      meta: { reason: "version", objects: 1, bytes: 40 },
    });
  });

  it("no purge without its record: the audit insert fails → the rows and objects are still there", async () => {
    const s = await scene();
    const ctx = jobContext();
    registerCoreDeps({
      ...realCore,
      insertAudit: async () => {
        throw new Error("the audit insert failed");
      },
    });
    await tick(ctx);
    registerCoreDeps(realCore);
    await s.intact("after the failed insert");
    expect(await usedBytes(s.owner.id)).toBe(240);
    expect(await audits("system.purge", s.root.id)).toEqual([]);
    expect(ctx.outcomes("purge")).toContain("error");
    // It failed; it is not held: the next tick, with a working insert, finishes it.
    await tick();
    await s.gone("after the next tick");
    expect(await audits("system.purge", s.root.id)).toHaveLength(1);
  });

  it("a deadlock on a root: skipped, counted as retry, purged on the next tick", async () => {
    const s = await scene();
    // Every transaction of this tick is a deadlock victim.
    const handle = deadlockingDb(Number.POSITIVE_INFINITY);
    const { ctx } = await tick(jobContext({ db: handle.db }));
    await handle.close();
    expect(handle.counter.attempts).toBeGreaterThan(0);
    await s.intact("after the deadlocked tick");
    const outcomes = ctx.outcomes("purge");
    expect(outcomes).toContain("retry");
    expect(outcomes).not.toContain("purged");
    expect(outcomes).not.toContain("error");
    // Stamped, like every root a tick could not purge: it goes behind the roots not tried since.
    expect((await nodeById(s.root.id))!.purgeAttemptedAt).toBeInstanceOf(Date);
    // One attempt per root — a job does not retry in place.
    const single = deadlockingDb(Number.POSITIVE_INFINITY);
    expect(await purgeRoot(jobContext({ db: single.db }).bg, s.root.id, "cron")).toEqual({
      outcome: "retry",
    });
    expect(single.counter.attempts).toBe(1);
    await single.close();

    await tick();
    await s.gone("after the next tick");
  });

  it("a restore that commits first wins: the job deletes nothing", async () => {
    const s = await scene();
    expect((await purgeDue(testDb(), 10_000)).map((row) => row.id)).toContain(s.root.id);
    const committed = gate();
    const inside = gate<number>();
    // The owner restores: the tree lock is held until this transaction ends.
    const restoring = testDb().transaction(async (tx) => {
      await restoreQuery(tx, s.root.id);
      inside.open(await backendPid(tx));
      await committed.opened;
    });
    const pid = await inside.opened;
    // The job, acting on the list it read before the restore.
    const purging = purgeRoot(jobContext().bg, s.root.id, "cron");
    expect(await untilBlockedBy(pid)).toBe("blocked");
    committed.open();
    await restoring;

    expect(await purging).toEqual({ outcome: "skipped" });
    await s.intact("after the restore");
    expect((await nodeById(s.root.id))!.deletedAt).toBeNull();
    expect(await audits("system.purge", s.root.id)).toEqual([]);
    expect(await usedBytes(s.owner.id)).toBe(240);
    // And a root that is in the trash but not yet due is not the job's either.
    await trashQuery(testDb(), s.root.id, s.owner.id);
    expect(await purgeRoot(jobContext().bg, s.root.id, "cron")).toEqual({ outcome: "skipped" });
    await s.intact("not due");
    // Control: due again, the same call deletes it.
    await makeDue(s.root.id);
    expect(await purgeRoot(jobContext().bg, s.root.id, "cron")).toMatchObject({ outcome: "purged" });
    await s.gone("due again");
  });
});

// ── the hold matrix ─────────────────────────────────────────────────────────────────────────

type Cause = {
  name: string;
  /** The job's list still returns the root (the hold is deeper in it): the gate refuses it. */
  listed: boolean;
  hold(s: Scene): Promise<() => Promise<unknown>>;
};

const CAUSES: Cause[] = [
  {
    name: "a legal hold on a file inside",
    listed: true,
    hold: async (s) => {
      await setNodeLegalHold(testDb(), s.file.id, true);
      return () => setNodeLegalHold(testDb(), s.file.id, false);
    },
  },
  {
    name: "the owner on legal hold",
    listed: false,
    hold: async (s) => {
      await setUserLegalHold(testDb(), s.owner.id, true);
      return () => setUserLegalHold(testDb(), s.owner.id, false);
    },
  },
  {
    name: "an under_review file inside a clean folder",
    listed: true,
    hold: async (s) => {
      await setNode(s.file.id, { scanStatus: "under_review" });
      return () => setNode(s.file.id, { scanStatus: "clean" });
    },
  },
  {
    name: "a suspected_csam file inside a clean folder",
    listed: true,
    hold: async (s) => {
      await setNode(s.file.id, { scanStatus: "suspected_csam" });
      return () => setNode(s.file.id, { scanStatus: "clean" });
    },
  },
  {
    name: "an open DMCA notice on a file inside",
    listed: true,
    hold: async (s) => {
      const notice = await openNoticeOn(s.file.id);
      return () => closeNotice(notice);
    },
  },
  {
    name: "a legal hold on the folder above",
    listed: false,
    hold: async (s) => {
      await setNodeLegalHold(testDb(), s.above.id, true);
      return () => setNodeLegalHold(testDb(), s.above.id, false);
    },
  },
  {
    name: "an open DMCA notice on the folder above",
    listed: false,
    hold: async (s) => {
      const notice = await openNoticeOn(s.above.id);
      return () => closeNotice(notice);
    },
  },
];

const listed = async (caller: Caller) =>
  TrashResponse.parse((await api(caller, "/trash")).body).items.map((item) => item.id);

describe.each(CAUSES)("held by $name", (cause) => {
  it("no caller deletes a row or an object of the root, and no answer says so", async () => {
    const s = await scene();
    const release = await cause.hold(s);

    // What an owner with nothing held gets from the two routes.
    const free = await scene();
    const freeEmptied = await api(free.caller, "/trash", DELETE);
    await free.gone("the control really was purged");
    const other = await scene();
    const freeDeleted = await api(other.caller, `/nodes/${other.root.id}`, DELETE);
    await other.gone("the control really was purged");

    // 1. the version purge, asked directly: the gate refuses it.
    expect(await purgeVersions(jobContext().bg, s.file.id, [s.version.versionId])).toEqual({
      outcome: "held",
    });
    await s.intact("version purge");

    // 2. the cron: roots, then versions.
    const { ctx } = await tick();
    await s.intact("cron");
    expect(ctx.outcomes("purge")).not.toContain("error");
    if (cause.listed) {
      expect(ctx.outcomes("purge")).toContain("held");
      // Stamped: it goes behind every root not tried since.
      expect((await nodeById(s.root.id))!.purgeAttemptedAt).toBeInstanceOf(Date);
    }
    expect(await audits("system.purge", s.root.id)).toEqual([]);
    expect(await listed(s.caller)).toEqual([s.root.id]);

    // 3. DELETE /trash: the same answer as with nothing held, and the root is gone to its owner.
    const emptied = await api(s.caller, "/trash", DELETE);
    expect([emptied.status, emptied.body]).toEqual([freeEmptied.status, freeEmptied.body]);
    expect(emptied.status).toBe(204);
    await s.intact("DELETE /trash");
    expect((await nodeById(s.root.id))!.purgeRequestedAt).toBeInstanceOf(Date);
    expect(await listed(s.caller)).toEqual([]);

    // 4. DELETE /nodes/:id, on the root before its purge was requested.
    await setNode(s.root.id, { purgeRequestedAt: null });
    const deleted = await api(s.caller, `/nodes/${s.root.id}`, DELETE);
    expect([deleted.status, deleted.body]).toEqual([freeDeleted.status, freeDeleted.body]);
    expect(deleted.status).toBe(204);
    await s.intact("DELETE /nodes/:id");
    expect((await nodeById(s.root.id))!.purgeRequestedAt).toBeInstanceOf(Date);
    expect(await listed(s.caller)).toEqual([]);
    expect(await audits("node.purge", s.root.id)).toEqual([]);

    // Held bytes keep counting.
    expect(await usedBytes(s.owner.id)).toBe(240);
    expect(await usageBreakdown(testDb(), s.owner.id)).toMatchObject({ trashBytes: 100, versionsBytes: 40 });

    // 5. the account purge: everything that is not held goes; what is held stays, whole.
    await scheduleDeletion(s.owner.id, -1);
    const outcome = await purgeAccount(jobContext().bg, s.owner.id);
    await s.intact("user-purge");
    expect(await userRow(s.owner.id)).not.toBeNull();
    const pending = (await pendingPurge(s.owner.id))!;
    expect(pending.finishedAt).toBeNull();
    if (cause.name === "the owner on legal hold") {
      // A held account is not touched at all, and nothing records that it was looked at.
      expect(outcome).toBe("held");
      expect(await nodesLeft([s.other.id])).toEqual([s.other.id]);
      expect([pending.startedAt, pending.attempts, pending.error]).toEqual([null, 0, null]);
      expect(pending.scheduledFor.getTime()).toBeLessThan(Date.now());
    } else {
      expect(outcome).toBe("deferred");
      expect(await nodesLeft([s.other.id])).toEqual([]);
      expect(await objectExists(s.otherStored.object)).toBe(false);
      expect(pending.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
      expect(pending.error).toBeNull();
    }
    expect(await audits("system.user_purge", s.owner.id)).toEqual([]);

    // The hold is released: the next tick finishes what the owner asked for.
    await release();
    await tick();
    await s.gone("after the release");
    expect(await audits("system.purge", s.root.id)).toHaveLength(1);
  });
});
