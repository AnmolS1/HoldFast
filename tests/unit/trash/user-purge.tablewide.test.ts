// The account purge. TABLE-WIDE: the job works through every pending purge that is due, so this
// file runs alone; an account is made due by the date on its own pending row.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { setUserLegalHold } from "../../../src/worker/db/queries/moderation";
import { ownedRoots } from "../../../src/worker/db/queries/tree";
import { remainingForUser } from "../../../src/worker/db/queries/uploads";
import { cancel, due } from "../../../src/worker/db/queries/user-purge";
import { pendingUserPurges, session, uploads, user } from "../../../src/worker/db/schema";
import { job as userPurgeJob, purgeAccount } from "../../../src/worker/jobs/user-purge";
import { registerCoreDeps } from "../../../src/worker/services/request-context";
import { avatarKey } from "../../../src/worker/services/storage";
import { realCore } from "../auth/helpers";
import {
  audits,
  backendPid,
  countingBucket,
  cronEvent,
  gate,
  jobContext,
  keysUnder,
  makeFile,
  makeFolder,
  makeShare,
  makeUpload,
  member,
  multipartIsOpen,
  nodeById,
  nodesLeft,
  objectExists,
  pendingPurge,
  putObject,
  rand,
  scheduleDeletion,
  setNode,
  startMultipart,
  storeFile,
  testDb,
  untilBlockedBy,
  uploadRow,
  userRow,
  type JobContext,
} from "./helpers";

const DAY = 86_400_000;

async function run(ctx: JobContext = jobContext()) {
  const result = await userPurgeJob.run(ctx.bg, env, cronEvent(userPurgeJob.cron), {
    softDeadlineMs: 120_000,
  });
  return { ctx, result };
}

/** An account with a folder, a file in it, a top-level file, a sign-in row — and a deletion date. */
async function account(dueInDays = -1) {
  const row = await member();
  const folder = await makeFolder(row.id);
  const inner = await makeFile(row.id, folder.id, { scanStatus: "clean" });
  const loose = await makeFile(row.id, null, { scanStatus: "clean" });
  const stored = [await storeFile(inner), await storeFile(loose)];
  const sessionId = `sess${rand(14)}`;
  await testDb()
    .insert(session)
    .values({
      id: sessionId,
      token: `made-up-token-${rand(8)}`,
      userId: row.id,
      expiresAt: new Date(Date.now() + DAY),
      updatedAt: new Date(),
    });
  await scheduleDeletion(row.id, dueInDays);
  const nodeIds = [folder.id, inner.id, loose.id];
  const keys = stored.flatMap((entry) => [entry.object, entry.thumb]);
  return {
    id: row.id,
    folder,
    inner,
    loose,
    nodeIds,
    keys,
    sessionId,
    async intact(when: string) {
      expect(await userRow(row.id), when).not.toBeNull();
      expect(await nodesLeft(nodeIds), when).toEqual([...nodeIds].sort());
      for (const key of keys) expect(await objectExists(key), `${when}: ${key}`).toBe(true);
    },
    async gone(when: string) {
      expect(await userRow(row.id), when).toBeNull();
      expect(await nodesLeft(nodeIds), when).toEqual([]);
      for (const key of keys) expect(await objectExists(key), `${when}: ${key}`).toBe(false);
    },
  };
}

const sessionsLeft = async (id: string) =>
  (await testDb().select({ id: session.id }).from(session).where(eq(session.id, id))).length;
const backdate = (userId: string) =>
  testDb()
    .update(pendingUserPurges)
    .set({ scheduledFor: sql`now() - interval '1 minute'` })
    .where(eq(pendingUserPurges.userId, userId));

describe("the account purge", () => {
  afterEach(() => registerCoreDeps(realCore));

  it("deletes a due account — files, objects, sign-in rows, the user row last — with its record", async () => {
    const a = await account();
    const early = await account(+1);
    const { ctx, result } = await run();
    expect(result).toEqual({ done: true });
    await a.gone("after the run");
    expect(await sessionsLeft(a.sessionId)).toBe(0);
    expect(ctx.outcomes("user-purge")).toContain("purged");
    expect(ctx.outcomes("user-purge")).not.toContain("error");
    const pending = (await pendingPurge(a.id))!;
    expect(pending.finishedAt).toBeInstanceOf(Date);
    expect(pending.error).toBeNull();

    const rows = await audits("system.user_purge", a.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorUserId: null,
      actorType: "system",
      ipHashDaily: null,
      ua: null,
      country: null,
      requestId: null,
      targetType: "user",
      // Counts, and nothing that says who it was.
      meta: { roots: 2, bytes: 200 },
    });
    // Each root's own record is there too.
    expect(await audits("system.purge", a.folder.id)).toHaveLength(1);

    // Not before its date.
    await early.intact("an account whose date has not come");
    expect(await sessionsLeft(early.sessionId)).toBe(1);
    expect((await pendingPurge(early.id))!.startedAt).toBeNull();
    // A finished row is never taken again.
    await run();
    expect(await audits("system.user_purge", a.id)).toHaveLength(1);
  });

  it("a cancelled deletion and an account that is gone: the pending row is dropped, nothing is purged", async () => {
    const cancelled = await account();
    // The date cleared, the pending row left behind (a cancel that raced).
    await testDb().update(user).set({ deleteScheduledAt: null }).where(eq(user.id, cancelled.id));
    const ghost = `gone${rand(14)}`;
    await testDb()
      .insert(pendingUserPurges)
      .values({ userId: ghost, scheduledFor: new Date(Date.now() - DAY) });

    const { ctx } = await run();
    await cancelled.intact("cancelled");
    expect(await sessionsLeft(cancelled.sessionId)).toBe(1);
    expect(await pendingPurge(cancelled.id)).toBeNull();
    expect(await pendingPurge(ghost)).toBeNull();
    expect(await audits("system.user_purge", cancelled.id)).toEqual([]);
    expect(ctx.outcomes("user-purge")).not.toContain("error");
  });

  it("an account on legal hold is never due, and nothing shows that it was looked at", async () => {
    const a = await account();
    await setUserLegalHold(testDb(), a.id, true);
    const before = { user: await userRow(a.id), pending: await pendingPurge(a.id) };
    expect((await due(testDb(), 10_000)).map((row) => row.userId)).not.toContain(a.id);
    await run();
    // Asked for directly — as if the hold had been placed just after the job listed it.
    expect(await purgeAccount(jobContext().bg, a.id)).toBe("held");
    await a.intact("held");
    expect(await sessionsLeft(a.sessionId)).toBe(1);
    expect(await userRow(a.id)).toEqual(before.user);
    expect(await pendingPurge(a.id)).toEqual(before.pending);
    expect(await audits("system.user_purge", a.id)).toEqual([]);

    // Released: the next run deletes it.
    await setUserLegalHold(testDb(), a.id, false);
    await run();
    await a.gone("after the release");
  });

  it("one held root: everything else goes, the account waits seven days, and finishes once the hold is lifted", async () => {
    const a = await account();
    await setNode(a.inner.id, { scanStatus: "under_review" });
    const { ctx } = await run();
    expect(ctx.outcomes("user-purge")).toContain("deferred");
    expect(ctx.outcomes("user-purge")).not.toContain("error");
    // The held root, whole; the other root gone.
    expect(await nodesLeft(a.nodeIds)).toEqual([a.folder.id, a.inner.id].sort());
    expect(await objectExists(a.keys[0]!)).toBe(true);
    expect(await objectExists(a.keys[2]!)).toBe(false);
    expect(await userRow(a.id)).not.toBeNull();
    expect(await sessionsLeft(a.sessionId)).toBe(1);
    const pending = (await pendingPurge(a.id))!;
    expect(pending.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect(pending.scheduledFor.getTime()).toBeLessThan(Date.now() + 8 * DAY);
    expect([pending.finishedAt, pending.error]).toEqual([null, null]);
    expect(await audits("system.user_purge", a.id)).toEqual([]);
    // Not due for a week: another run leaves it alone.
    await run();
    expect(await userRow(a.id)).not.toBeNull();

    await setNode(a.inner.id, { scanStatus: "clean" });
    await backdate(a.id);
    await run();
    await a.gone("after the hold was lifted");
    expect(await audits("system.user_purge", a.id)).toHaveLength(1);
  });

  it("what the account uploaded into someone else's folder stays there, its author anonymised", async () => {
    const a = await account();
    const host = await member();
    const shared = await makeFolder(host.id);
    await makeShare(shared.id, host.id, a.id, { role: "editor" });
    const guest = await makeFile(host.id, shared.id, { scanStatus: "clean", createdBy: a.id });
    const guestStored = await storeFile(guest);
    // Its finished session in the host's folder goes with the account (nothing holds it).
    const done = await makeUpload(host.id, a.id, {
      parentId: shared.id,
      status: "done",
      completedAt: new Date(),
    });

    await run();
    await a.gone("the account");
    expect(await uploadRow(done.id)).toBeNull();
    const survivor = (await nodeById(guest.id))!;
    expect(survivor.ownerId).toBe(host.id);
    expect(survivor.createdBy).toBeNull();
    expect(await nodesLeft([shared.id])).toEqual([shared.id]);
    expect(await objectExists(guestStored.object)).toBe(true);
    expect(await userRow(host.id)).not.toBeNull();
  });

  it("an upload into a HELD owner's folder: the session stays, so the account waits — and goes once that hold is lifted", async () => {
    const withHost = async (held: boolean) => {
      const a = await account();
      const host = await member({ legalHold: held });
      const shared = await makeFolder(host.id);
      const done = await makeUpload(host.id, a.id, {
        parentId: shared.id,
        status: "done",
        completedAt: new Date(),
      });
      return { a, host, done };
    };
    const kept = await withHost(true);
    const control = await withHost(false);
    await run();

    // Control, same run: with the host not held the account is deleted at once.
    await control.a.gone("the control");
    expect(await uploadRow(control.done.id)).toBeNull();

    // Its own files and objects are gone; the session row a hold protects still names it.
    expect(await nodesLeft(kept.a.nodeIds)).toEqual([]);
    for (const key of kept.a.keys) expect(await objectExists(key), key).toBe(false);
    expect(await uploadRow(kept.done.id)).not.toBeNull();
    expect(await remainingForUser(testDb(), kept.a.id)).toBe(1);
    // The account row was not deleted — nor attempted: no failure is recorded, no record written.
    expect(await userRow(kept.a.id)).not.toBeNull();
    expect(await sessionsLeft(kept.a.sessionId)).toBe(1);
    expect(await audits("system.user_purge", kept.a.id)).toEqual([]);
    const pending = (await pendingPurge(kept.a.id))!;
    expect(pending.scheduledFor.getTime()).toBeGreaterThan(Date.now() + 6 * DAY);
    expect([pending.finishedAt, pending.error]).toEqual([null, null]);

    await setUserLegalHold(testDb(), kept.host.id, false);
    await backdate(kept.a.id);
    await run();
    expect(await remainingForUser(testDb(), kept.a.id)).toBe(0);
    expect(await userRow(kept.a.id)).toBeNull();
    expect((await pendingPurge(kept.a.id))!.finishedAt).toBeInstanceOf(Date);
  });

  it("its unfinished uploads: a multipart one is aborted, a single-PUT one is skipped and its object left", async () => {
    const a = await account();
    const multipart = await makeUpload(a.id, a.id, {});
    const uploadId = await startMultipart(multipart.r2Key);
    await testDb().update(uploads).set({ r2UploadId: uploadId }).where(eq(uploads.id, multipart.id));
    const single = await makeUpload(a.id, a.id, { r2UploadId: null });
    await putObject(single.r2Key, "what the single PUT stored");
    const { bucket, calls } = countingBucket();

    expect(await purgeAccount(jobContext({ env: { FILES: bucket } }).bg, a.id)).toBe("purged");
    await a.gone("the account");
    expect(await uploadRow(multipart.id)).toBeNull();
    expect(await uploadRow(single.id)).toBeNull();
    expect(await multipartIsOpen(multipart.r2Key, uploadId)).toBe(false);
    // Exactly one multipart upload was resumed to be aborted: the multipart session's.
    expect(calls.filter((call) => call === "resumeMultipartUpload")).toHaveLength(1);
    // An orphan now: the reconcile job's sweep removes it, not this job.
    expect(await objectExists(single.r2Key)).toBe(true);
  });

  it("no account is deleted without its record: the audit insert fails → the account is still there, and the next run finishes", async () => {
    const a = await account();
    const ctx = jobContext();
    registerCoreDeps({
      ...realCore,
      insertAudit: async (db, row) => {
        // The roots' own records are written; the account's is the one that fails.
        if (row.action === "system.user_purge") throw new Error("the audit insert failed");
        return realCore.insertAudit(db, row);
      },
    });
    await run(ctx);
    registerCoreDeps(realCore);
    expect(await userRow(a.id)).not.toBeNull();
    expect(await sessionsLeft(a.sessionId)).toBe(1);
    expect(await audits("system.user_purge", a.id)).toEqual([]);
    expect(ctx.outcomes("user-purge")).toContain("error");
    const failed = (await pendingPurge(a.id))!;
    expect(failed.finishedAt).toBeNull();
    expect(failed.startedAt).toBeInstanceOf(Date);
    // What is kept about the failure is its kind, not its text.
    expect(failed.error).toBe("Error");

    // Started and not finished: it resumes.
    await run();
    await a.gone("after the resumed run");
    const finished = (await pendingPurge(a.id))!;
    expect(finished.finishedAt).toBeInstanceOf(Date);
    expect(finished.error).toBeNull();
    expect(finished.attempts).toBe(2);
    expect(await audits("system.user_purge", a.id)).toHaveLength(1);
  });

  it("a cancel that commits just before the purge starts wins: nothing is deleted", async () => {
    const a = await account();
    // The job has listed the account…
    expect((await due(testDb(), 10_000)).map((row) => row.userId)).toContain(a.id);
    const committed = gate();
    const inside = gate<number>();
    // …and its owner cancels: the user row is locked until this transaction ends.
    const cancelling = testDb().transaction(async (tx) => {
      expect(await cancel(tx, a.id)).toBe(true);
      inside.open(await backendPid(tx));
      await committed.opened;
    });
    const pid = await inside.opened;
    const purging = purgeAccount(jobContext().bg, a.id);
    expect(await untilBlockedBy(pid)).toBe("blocked");
    committed.open();
    await cancelling;

    expect(await purging).toBe("skipped");
    await a.intact("after the cancel");
    expect(await sessionsLeft(a.sessionId)).toBe(1);
    expect((await userRow(a.id))!.deleteScheduledAt).toBeNull();
    expect(await pendingPurge(a.id)).toBeNull();
    expect(await audits("system.user_purge", a.id)).toEqual([]);
  });

  it("once the purge has started, a cancel is refused", async () => {
    const a = await account();
    await setNode(a.inner.id, { scanStatus: "under_review" });
    expect(await purgeAccount(jobContext().bg, a.id)).toBe("deferred");
    expect(await cancel(testDb(), a.id)).toBe(false);
    expect((await userRow(a.id))!.deleteScheduledAt).not.toBeNull();
  });

  it("a hold placed just before the purge starts wins: nothing is deleted, nothing is recorded", async () => {
    const a = await account();
    const before = await pendingPurge(a.id);
    const committed = gate();
    const inside = gate<number>();
    const holding = testDb().transaction(async (tx) => {
      await setUserLegalHold(tx, a.id, true);
      inside.open(await backendPid(tx));
      await committed.opened;
    });
    const pid = await inside.opened;
    const purging = purgeAccount(jobContext().bg, a.id);
    expect(await untilBlockedBy(pid)).toBe("blocked");
    committed.open();
    await holding;

    expect(await purging).toBe("held");
    await a.intact("after the hold");
    expect(await pendingPurge(a.id)).toEqual(before);
  });

  it("a hold placed while the purge is running stops the account row: it is re-read under the row's lock", async () => {
    const a = await account();
    // The hold lands after the LAST root's rows have been committed — while its objects are
    // being removed — so that nothing but the final re-read can see it.
    const roots = await ownedRoots(testDb(), a.id, { includeSystem: true });
    const last = roots[roots.length - 1]!.id === a.loose.id ? a.loose.r2Key! : a.inner.r2Key!;
    let placed = false;
    const bucket = new Proxy(env.FILES, {
      get(target, property) {
        const value = Reflect.get(target, property) as unknown;
        if (typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          if (property === "delete" && !placed && Array.isArray(args[0]) && args[0].includes(last)) {
            placed = true;
            await setUserLegalHold(testDb(), a.id, true);
          }
          return (value as (...inner: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const outcome = await purgeAccount(jobContext({ env: { FILES: bucket } }).bg, a.id);
    expect(placed).toBe(true);
    expect(outcome).toBe("held");
    // What was purged before the hold stays purged; the account and its sign-in rows are kept.
    expect(await nodesLeft(a.nodeIds)).toEqual([]);
    expect(await userRow(a.id)).not.toBeNull();
    expect(await sessionsLeft(a.sessionId)).toBe(1);
    expect(await audits("system.user_purge", a.id)).toEqual([]);
    const pending = (await pendingPurge(a.id))!;
    expect([pending.finishedAt, pending.error]).toEqual([null, null]);
    // Held, not deferred: its date is not moved.
    expect(pending.scheduledFor.getTime()).toBeLessThan(Date.now());
  });

  it("two runs for the same account at once: one deletion, one record, no error", async () => {
    const a = await account();
    const outcomes = await Promise.all([
      purgeAccount(jobContext().bg, a.id),
      purgeAccount(jobContext().bg, a.id),
    ]);
    expect(outcomes).toContain("purged");
    expect(outcomes.filter((outcome) => outcome !== "purged" && outcome !== "skipped")).toEqual([]);
    await a.gone("after both");
    expect(await audits("system.user_purge", a.id)).toHaveLength(1);
  });

  it("a held avatar keeps its object: the avatar prefix is cleared only after the account row is gone", async () => {
    const a = await account();
    const avatarId = crypto.randomUUID();
    const key = avatarKey(a.id, avatarId);
    const avatar = await makeFile(a.id, null, { system: "avatar", r2Key: key, scanStatus: "under_review" });
    await putObject(key, "the avatar");
    const stray = avatarKey(a.id, crypto.randomUUID());
    await putObject(stray, "an avatar no row references");

    expect(await purgeAccount(jobContext().bg, a.id)).toBe("deferred");
    // The held avatar node and its object — and nothing under the prefix was touched.
    expect(await nodesLeft([avatar.id])).toEqual([avatar.id]);
    expect(await keysUnder(`a/${a.id}/`)).toEqual([key, stray].sort());

    await setNode(avatar.id, { scanStatus: "clean" });
    await backdate(a.id);
    expect(await purgeAccount(jobContext().bg, a.id)).toBe("purged");
    expect(await userRow(a.id)).toBeNull();
    expect(await keysUnder(`a/${a.id}/`)).toEqual([]);
  });
});
