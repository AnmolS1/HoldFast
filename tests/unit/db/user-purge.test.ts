import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { LegalHoldError } from "../../../src/worker/db/errors";
import { getById, pauseLinks } from "../../../src/worker/db/queries/links";
import { release } from "../../../src/worker/db/queries/quota";
import { deleteSubtreeRows } from "../../../src/worker/db/queries/trash";
import { ownedRoots } from "../../../src/worker/db/queries/tree";
import { deleteForUser } from "../../../src/worker/db/queries/uploads";
import {
  cancel,
  defer,
  due,
  markFailed,
  markFinished,
  markStarted,
  schedule,
} from "../../../src/worker/db/queries/user-purge";
import { userState } from "../../../src/worker/db/queries/users";
import { nodes, pendingUserPurges, uploads, user } from "../../../src/worker/db/schema";
import {
  baId,
  makeFile,
  makeFolder,
  makeLink,
  makeShare,
  makeUpload,
  makeUser,
  openDb,
  rand,
} from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const pending = async (userId: string) =>
  (await db.select().from(pendingUserPurges).where(eq(pendingUserPurges.userId, userId)))[0];
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000);
const isDue = async (userId: string) => (await due(db, 100_000)).some((row) => row.userId === userId);

async function account() {
  const owner = await makeUser(db);
  const file = await makeFile(db, owner, null, `mine-${rand()}.txt`);
  const link = await makeLink(db, file.id, owner);
  return { owner, file, link };
}

describe("schedule and cancel", () => {
  it("schedule sets the date, creates the row and pauses the links; cancel restores all three", async () => {
    const { owner, link } = await account();
    const when = inDays(7);
    expect(await schedule(db, owner, when)).toBe(true);
    expect((await userState(db, owner))!.deleteScheduledAt!.getTime()).toBe(when.getTime());
    expect(await pending(owner)).toMatchObject({
      userId: owner,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
    });
    expect((await pending(owner))!.scheduledFor.getTime()).toBe(when.getTime());
    const paused = (await getById(db, link.id))!;
    expect(paused.pauseReasons).toEqual(["owner_deletion"]);
    expect(paused.revokedAt).toBeNull();

    expect(await cancel(db, owner)).toBe(true);
    expect((await userState(db, owner))!.deleteScheduledAt).toBeNull();
    expect(await pending(owner)).toBeUndefined();
    expect(await getById(db, link.id)).toMatchObject({ pauseReasons: [], pausedAt: null });
  });

  it("schedule is idempotent: a second call moves the date and adds no second reason", async () => {
    const { owner, link } = await account();
    await schedule(db, owner, inDays(7));
    const later = inDays(9);
    expect(await schedule(db, owner, later)).toBe(true);
    expect((await pending(owner))!.scheduledFor.getTime()).toBe(later.getTime());
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["owner_deletion"]);
    expect(await schedule(db, baId(), inDays(7))).toBe(false);
  });

  it("cancel removes only owner_deletion: a link that also carries a report stays paused", async () => {
    const { owner, link } = await account();
    await pauseLinks(db, { linkId: link.id }, "report");
    await schedule(db, owner, inDays(7));
    expect([...(await getById(db, link.id))!.pauseReasons].sort()).toEqual(["owner_deletion", "report"]);
    expect(await cancel(db, owner)).toBe(true);
    const after = (await getById(db, link.id))!;
    expect(after.pauseReasons).toEqual(["report"]);
    expect(after.pausedAt).not.toBeNull();
  });

  it("cancel refuses once the purge has started, and changes nothing", async () => {
    const { owner, link } = await account();
    const when = inDays(-1);
    await schedule(db, owner, when);
    await markStarted(db, owner);
    expect(await cancel(db, owner)).toBe(false);
    expect((await userState(db, owner))!.deleteScheduledAt!.getTime()).toBe(when.getTime());
    expect(await pending(owner)).toBeDefined();
    expect((await getById(db, link.id))!.pauseReasons).toEqual(["owner_deletion"]);
    // And schedule no longer moves the date of a started purge.
    await schedule(db, owner, inDays(30));
    expect((await pending(owner))!.scheduledFor.getTime()).toBe(when.getTime());
  });

  it("schedule is one transaction", async () => {
    const { owner, link } = await account();
    await expect(
      db.transaction(async (tx) => {
        await schedule(tx, owner, inDays(7));
        throw new Error("undo");
      }),
    ).rejects.toThrow("undo");
    expect((await userState(db, owner))!.deleteScheduledAt).toBeNull();
    expect(await pending(owner)).toBeUndefined();
    expect((await getById(db, link.id))!.pauseReasons).toEqual([]);
  });
});

describe("due", () => {
  it("returns rows whose date has passed and that are not finished", async () => {
    const past = await account();
    const future = await account();
    await schedule(db, past.owner, inDays(-1));
    await schedule(db, future.owner, inDays(1));
    expect(await isDue(past.owner)).toBe(true);
    expect(await isDue(future.owner)).toBe(false);
    await markStarted(db, past.owner);
    await markFailed(db, past.owner, "storage unavailable");
    expect(await isDue(past.owner)).toBe(true);
    expect(await pending(past.owner)).toMatchObject({ attempts: 1, error: "storage unavailable" });
    await markStarted(db, past.owner);
    expect((await pending(past.owner))!.attempts).toBe(2);
    await markFinished(db, past.owner);
    expect(await isDue(past.owner)).toBe(false);
    expect(await pending(past.owner)).toMatchObject({ error: null });
    expect((await pending(past.owner))!.finishedAt).toBeInstanceOf(Date);
    expect((await due(db, 1)).length).toBeLessThanOrEqual(1);
  });

  it("a user on legal hold is never due, and is due again when the hold is released", async () => {
    const { owner } = await account();
    await schedule(db, owner, inDays(-1));
    await db.update(user).set({ legalHold: true }).where(eq(user.id, owner));
    expect(await isDue(owner)).toBe(false);
    // The request still looks scheduled.
    expect((await userState(db, owner))!.deleteScheduledAt).not.toBeNull();
    expect(await pending(owner)).toBeDefined();
    await db.update(user).set({ legalHold: false }).where(eq(user.id, owner));
    expect(await isDue(owner)).toBe(true);
  });

  it("a row whose user row is already gone is still due, so the job can finish it", async () => {
    const ghost = baId();
    await db.insert(pendingUserPurges).values({ userId: ghost, scheduledFor: inDays(-1) });
    expect(await isDue(ghost)).toBe(true);
    await markFinished(db, ghost);
    expect(await isDue(ghost)).toBe(false);
  });

  it("defer: a user with a held remnant is pushed out instead of failing nightly", async () => {
    const owner = await makeUser(db);
    const free = await makeFile(db, owner, null, `free-${rand()}.txt`, { size: 10 });
    const heldRoot = await makeFolder(db, owner, null, `held-${rand()}`);
    await makeFile(db, owner, heldRoot.id, "reported.bin", { scanStatus: "under_review", size: 20 });
    await schedule(db, owner, inDays(-1));
    expect(await isDue(owner)).toBe(true);
    await markStarted(db, owner);

    // What the job does: purge every purgeable root, keep the held ones.
    const kept: string[] = [];
    for (const root of await ownedRoots(db, owner, { includeSystem: true })) {
      try {
        await db.transaction(async (tx) => {
          const deleted = await deleteSubtreeRows(tx, root.id);
          await release(tx, owner, deleted.freedBytes);
        });
      } catch (error) {
        if (!(error instanceof LegalHoldError)) throw error;
        kept.push(root.id);
      }
    }
    expect(kept).toEqual([heldRoot.id]);
    expect(await db.select().from(nodes).where(eq(nodes.id, free.id))).toHaveLength(0);

    await defer(db, owner);
    expect(await isDue(owner)).toBe(false);
    const row = (await pending(owner))!;
    const days = (row.scheduledFor.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    expect(row.finishedAt).toBeNull();
    // The account stays deletion-scheduled and the user row stays.
    expect((await userState(db, owner))!.deleteScheduledAt).not.toBeNull();
    await defer(db, owner, 1);
    expect(((await pending(owner))!.scheduledFor.getTime() - Date.now()) / 86_400_000).toBeLessThan(1.1);
  });
});

describe("hard delete of a user", () => {
  it("a user who was an editor in someone else's folder can be deleted after uploads.deleteForUser", async () => {
    const owner = await makeUser(db, { quotaBytes: 100_000, usedBytes: 0 });
    const editor = await makeUser(db);
    const shared = await makeFolder(db, owner, null, `shared-${rand()}`);
    await makeShare(db, shared.id, owner, { userId: editor }, { role: "editor" });
    const uploaded = await makeFile(db, owner, shared.id, "from-editor.txt", { createdBy: editor });
    const open = await makeUpload(db, owner, editor, {
      parentId: shared.id,
      status: "open",
      size: 700,
      r2UploadId: "mpu-9",
    });
    const done = await makeUpload(db, owner, editor, { parentId: shared.id, status: "done", size: 300 });
    const own = await makeUpload(db, editor, editor, { status: "completing", size: 50 });
    const ownersOwn = await makeUpload(db, owner, owner, { status: "open", size: 5 });
    await db.update(user).set({ usedBytes: 705 }).where(eq(user.id, owner));

    // Without the cleanup the RESTRICT reference blocks the delete.
    await expect(db.delete(user).where(eq(user.id, editor))).rejects.toThrow();

    const toAbort = await deleteForUser(db, editor);
    expect(toAbort.sort((a, b) => a.r2Key.localeCompare(b.r2Key))).toEqual(
      [
        { r2Key: open.r2Key, r2UploadId: "mpu-9" },
        { r2Key: own.r2Key, r2UploadId: null },
      ].sort((a, b) => a.r2Key.localeCompare(b.r2Key)),
    );
    const left = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.ownerId, owner));
    expect(left.map((u) => u.id)).toEqual([ownersOwn.id]);
    expect(done.id).not.toBe(ownersOwn.id);
    // The reservation the editor's open session held on the owner is released.
    const [ownerRow] = await db.select({ usedBytes: user.usedBytes }).from(user).where(eq(user.id, owner));
    expect(ownerRow!.usedBytes).toBe(5);

    await db.delete(user).where(eq(user.id, editor));
    expect(await userState(db, editor)).toBeNull();
    // The owner's tree is intact; authorship is anonymised.
    const [file] = await db.select().from(nodes).where(eq(nodes.id, uploaded.id));
    expect(file).toMatchObject({ ownerId: owner, createdBy: null });
  });
});
