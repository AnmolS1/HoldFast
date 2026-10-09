import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { LegalHoldError, QueryError } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import { closeNotice } from "../../../src/worker/db/queries/moderation";
import { getNode, OWNER_VISIBLE_STATUSES, listChildren } from "../../../src/worker/db/queries/nodes";
import { release } from "../../../src/worker/db/queries/quota";
import {
  assertPurgeable,
  deleteSubtreeRows,
  deleteVersionRows,
  listTrash,
  purgeDue,
  restore,
  trash,
  TRASH_RETENTION_DAYS,
  versionsDue,
} from "../../../src/worker/db/queries/trash";
import { effectiveTrashed } from "../../../src/worker/db/queries/tree";
import {
  dmcaNoticeNodes,
  dmcaNotices,
  nodes,
  nodeVersions,
  scanJobs,
  shareLinks,
  shares,
  uploadParts,
  uploads,
  user,
} from "../../../src/worker/db/schema";
import {
  makeFile,
  makeFolder,
  makeLink,
  makeShare,
  makeUpload,
  makeUser,
  openDb,
  rand,
  rejection,
} from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

async function held(promise: Promise<unknown>): Promise<LegalHoldError> {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(LegalHoldError);
  expect(error).not.toBeInstanceOf(QueryError);
  return error as LegalHoldError;
}

/** root/ { keep.txt (60), sub/ { deep.txt (40) } } */
async function tree(ownerOverrides: Partial<typeof user.$inferInsert> = {}) {
  const owner = await makeUser(db, ownerOverrides);
  const root = await makeFolder(db, owner, null, `root-${rand()}`);
  const keep = await makeFile(db, owner, root.id, "keep.txt", { size: 60 });
  const sub = await makeFolder(db, owner, root.id, "sub");
  const deep = await makeFile(db, owner, sub.id, "deep.txt", { size: 40 });
  return { owner, root, keep, sub, deep };
}

describe("trash and restore", () => {
  it("trash marks the root only, records the actor and the purge date", async () => {
    const t = await tree();
    const editor = await makeUser(db);
    const trashed = await trash(db, t.sub.id, editor);
    expect(trashed).toMatchObject({ id: t.sub.id, trashedRoot: true, trashedBy: editor });
    const days = (trashed!.purgeAfter!.getTime() - trashed!.deletedAt!.getTime()) / 86_400_000;
    expect(days).toBeCloseTo(TRASH_RETENTION_DAYS, 3);
    expect(await getNode(db, t.deep.id)).toMatchObject({ deletedAt: null, trashedRoot: false });
    expect(await effectiveTrashed(db, t.deep.id)).toBe(true);
    // Already trashed, unknown, system: nothing to do.
    expect(await trash(db, t.sub.id, editor)).toBeNull();
    expect(await trash(db, uuidv7(), editor)).toBeNull();
    const avatar = await makeFile(db, t.owner, null, "avatar", { system: "avatar" });
    expect(await trash(db, avatar.id, t.owner)).toBeNull();
    expect((await trash(db, t.keep.id, t.owner, { retentionDays: 1 }))!.purgeAfter!.getTime()).toBeLessThan(
      Date.now() + 2 * 86_400_000,
    );
  });

  it("restore puts the root back in place and clears the trash columns", async () => {
    const t = await tree();
    await trash(db, t.sub.id, t.owner);
    const restored = await restore(db, t.sub.id);
    expect(restored).toMatchObject({
      id: t.sub.id,
      parentId: t.root.id,
      name: "sub",
      deletedAt: null,
      trashedRoot: false,
      trashedBy: null,
      purgeAfter: null,
    });
    expect(await effectiveTrashed(db, t.deep.id)).toBe(false);
    expect(await restore(db, t.sub.id)).toBeNull();
    expect(await restore(db, uuidv7())).toBeNull();
  });

  it("a name collision on restore gets the suffix ' (restored)', before the extension", async () => {
    const t = await tree();
    await trash(db, t.keep.id, t.owner);
    await makeFile(db, t.owner, t.root.id, "keep.txt");
    const first = await restore(db, t.keep.id);
    expect(first).toMatchObject({ name: "keep (restored).txt", nameKey: "keep (restored).txt", ext: "txt" });

    await trash(db, t.sub.id, t.owner);
    await makeFolder(db, t.owner, t.root.id, "sub");
    expect((await restore(db, t.sub.id))!.name).toBe("sub (restored)");
    // And once more, when that name is taken as well.
    await trash(db, t.sub.id, t.owner);
    await makeFolder(db, t.owner, t.root.id, "sub (restored)");
    expect((await restore(db, t.sub.id))!.name).toBe("sub (restored) (restored)");
  });

  it("restore refuses a trashed parent unless toRoot, then lands at the owner's root with the suffix on collision", async () => {
    const t = await tree();
    await trash(db, t.deep.id, t.owner);
    await trash(db, t.sub.id, t.owner);
    const error = await rejection(restore(db, t.deep.id));
    expect((error as QueryError).code).toBe("conflict");
    expect((await getNode(db, t.deep.id))!.deletedAt).not.toBeNull();

    await makeFile(db, t.owner, null, "deep.txt");
    const restored = await restore(db, t.deep.id, { toRoot: true });
    expect(restored).toMatchObject({ parentId: null, name: "deep (restored).txt", deletedAt: null });
    expect(await effectiveTrashed(db, t.deep.id)).toBe(false);
  });

  it("listTrash shows the owner's trashed roots only, newest first, and pages", async () => {
    const owner = await makeUser(db);
    const other = await makeUser(db);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const a = await makeFile(db, owner, null, "a.txt", { deletedAt: at(3), trashedRoot: true });
    const b = await makeFolder(db, owner, null, "b", { deletedAt: at(2), trashedRoot: true });
    const c = await makeFile(db, owner, null, "c.txt", { deletedAt: at(1), trashedRoot: true });
    await makeFile(db, owner, b.id, "child-of-trashed.txt");
    await makeFile(db, owner, null, "live.txt");
    await makeFile(db, owner, null, "purge-requested.txt", {
      deletedAt: at(1),
      trashedRoot: true,
      purgeRequestedAt: new Date(),
    });
    await makeFile(db, owner, null, "csam.bin", {
      deletedAt: at(1),
      trashedRoot: true,
      scanStatus: "suspected_csam",
    });
    await makeFile(db, owner, null, "down.bin", {
      deletedAt: at(1),
      trashedRoot: true,
      takedownAt: new Date(),
    });
    await makeFile(db, owner, null, "avatar", { deletedAt: at(1), trashedRoot: true, system: "avatar" });
    await makeFile(db, other, null, "theirs.txt", { deletedAt: at(1), trashedRoot: true });

    expect((await listTrash(db, owner)).items.map((n) => n.id)).toEqual([c.id, b.id, a.id]);
    const first = await listTrash(db, owner, { limit: 2 });
    expect(first.items.map((n) => n.id)).toEqual([c.id, b.id]);
    const second = await listTrash(db, owner, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((n) => n.id)).toEqual([a.id]);
    expect(second.nextCursor).toBeNull();
    expect(((await rejection(listTrash(db, other, { cursor: first.nextCursor }))) as QueryError).code).toBe(
      "validation",
    );
  });

  it("purgeDue returns roots past purgeAfter and every purge-requested root; versionsDue the old versions", async () => {
    const owner = await makeUser(db);
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 86_400_000);
    const due = await makeFile(db, owner, null, "due.txt", {
      deletedAt: past,
      trashedRoot: true,
      purgeAfter: past,
    });
    const notYet = await makeFile(db, owner, null, "not-yet.txt", {
      deletedAt: past,
      trashedRoot: true,
      purgeAfter: future,
    });
    const requested = await makeFile(db, owner, null, "requested.txt", {
      deletedAt: past,
      trashedRoot: true,
      purgeAfter: future,
      purgeRequestedAt: new Date(),
    });
    const live = await makeFile(db, owner, null, "live.txt");
    const rows = await purgeDue(db, 100_000);
    const mine = rows
      .filter((r) => r.ownerId === owner)
      .map((r) => r.id)
      .sort();
    expect(mine).toEqual([due.id, requested.id].sort());
    expect(mine).not.toContain(notYet.id);
    expect((await purgeDue(db, 1)).length).toBe(1);

    await db.insert(nodeVersions).values([
      { nodeId: live.id, versionId: "old", r2Key: `k/${rand()}`, size: 1, purgeAfter: past },
      { nodeId: live.id, versionId: "recent", r2Key: `k/${rand()}`, size: 1, purgeAfter: future },
    ]);
    const versions = (await versionsDue(db, 100_000)).filter((v) => v.nodeId === live.id);
    expect(versions).toEqual([{ nodeId: live.id, versionId: "old", ownerId: owner }]);
  });
});

describe("assertPurgeable: each hold cause", () => {
  it("passes for an ordinary subtree, for unknown ids and for nothing", async () => {
    const t = await tree();
    await expect(assertPurgeable(db, [t.root.id])).resolves.toBeUndefined();
    await expect(assertPurgeable(db, [uuidv7(), "junk"])).resolves.toBeUndefined();
    await expect(assertPurgeable(db, [])).resolves.toBeUndefined();
  });

  it("holds a root when a node anywhere in its subtree is on legal hold", async () => {
    const t = await tree();
    await db.update(nodes).set({ legalHold: true }).where(eq(nodes.id, t.deep.id));
    const error = await held(assertPurgeable(db, [t.root.id]));
    expect(error.heldRootIds).toEqual([t.root.id]);
    expect(error.causes[t.root.id]).toEqual(["node_legal_hold"]);
    // The sibling outside the held branch is purgeable on its own; the held branch is not.
    await expect(assertPurgeable(db, [t.keep.id])).resolves.toBeUndefined();
    expect((await held(assertPurgeable(db, [t.sub.id]))).heldRootIds).toEqual([t.sub.id]);
    // Released explicitly: purgeable again.
    await db.update(nodes).set({ legalHold: false }).where(eq(nodes.id, t.deep.id));
    await expect(assertPurgeable(db, [t.root.id])).resolves.toBeUndefined();
  });

  it("holds for suspected_csam and for under_review, and no other status", async () => {
    for (const status of ["suspected_csam", "under_review"] as const) {
      const t = await tree();
      await db.update(nodes).set({ scanStatus: status }).where(eq(nodes.id, t.deep.id));
      const error = await held(assertPurgeable(db, [t.root.id]));
      expect(error.causes[t.root.id]).toEqual([status]);
    }
    for (const status of ["pending", "clean", "infected", "skipped", "error"] as const) {
      const t = await tree();
      await db.update(nodes).set({ scanStatus: status }).where(eq(nodes.id, t.deep.id));
      await expect(assertPurgeable(db, [t.root.id])).resolves.toBeUndefined();
    }
  });

  it("holds every root of an owner on legal hold", async () => {
    const t = await tree({ legalHold: true });
    const error = await held(assertPurgeable(db, [t.root.id, t.keep.id]));
    expect(error.heldRootIds.sort()).toEqual([t.root.id, t.keep.id].sort());
    expect(error.causes[t.keep.id]).toEqual(["owner_legal_hold"]);
    await db.update(user).set({ legalHold: false }).where(eq(user.id, t.owner));
    await expect(assertPurgeable(db, [t.root.id])).resolves.toBeUndefined();
  });

  it("holds a node under an open notice, for each open status, and releases it when the notice closes", async () => {
    for (const status of ["received", "incomplete", "actioned", "counter_received"] as const) {
      const t = await tree();
      const [notice] = await db.insert(dmcaNotices).values({ receivedVia: "form", status }).returning();
      await db
        .insert(dmcaNoticeNodes)
        .values({ noticeId: notice!.id, nodeId: t.deep.id, nodeName: "deep.txt" });
      const error = await held(assertPurgeable(db, [t.root.id]));
      expect(error.causes[t.root.id], status).toEqual(["open_notice"]);
      expect(await closeNotice(db, notice!.id, "closed")).toBe(true);
      await expect(assertPurgeable(db, [t.root.id])).resolves.toBeUndefined();
    }
    for (const status of ["rejected", "restored", "upheld", "withdrawn", "closed"] as const) {
      const t = await tree();
      const [notice] = await db.insert(dmcaNotices).values({ receivedVia: "form", status }).returning();
      await db.insert(dmcaNoticeNodes).values({ noticeId: notice!.id, nodeId: t.deep.id });
      await expect(assertPurgeable(db, [t.root.id]), status).resolves.toBeUndefined();
    }
  });

  it("names only the held roots among several, with every cause", async () => {
    const a = await tree();
    const b = await tree();
    const c = await tree();
    await db
      .update(nodes)
      .set({ legalHold: true, scanStatus: "under_review" })
      .where(eq(nodes.id, b.deep.id));
    const error = await held(assertPurgeable(db, [a.root.id, b.root.id, c.root.id]));
    expect(error.heldRootIds).toEqual([b.root.id]);
    expect(error.causes[b.root.id]).toEqual(["node_legal_hold", "under_review"]);
  });
});

describe("deleteSubtreeRows", () => {
  it("deletes a whole subtree and reports objects, thumbnails and freed bytes", async () => {
    const t = await tree();
    const friend = await makeUser(db);
    await db.insert(nodeVersions).values({
      nodeId: t.keep.id,
      versionId: "v-old",
      r2Key: `u/${t.owner}/${t.keep.id}/v-old`,
      size: 9,
      purgeAfter: new Date(),
    });
    await makeShare(db, t.sub.id, t.owner, { userId: friend });
    await makeLink(db, t.deep.id, t.owner);
    await db.insert(scanJobs).values({ nodeId: t.deep.id, r2Key: t.deep.r2Key! });
    await db.update(user).set({ usedBytes: 109 }).where(eq(user.id, t.owner));

    const result = await db.transaction(async (tx) => {
      const deleted = await deleteSubtreeRows(tx, t.root.id);
      await release(tx, deleted.ownerId!, deleted.freedBytes);
      return deleted;
    });
    expect(result.ownerId).toBe(t.owner);
    expect(result.freedBytes).toBe(60 + 40 + 9);
    expect(result.r2Keys.sort()).toEqual(
      [t.keep.r2Key!, t.deep.r2Key!, `u/${t.owner}/${t.keep.id}/v-old`].sort(),
    );
    expect(result.thumbPrefixes.sort()).toEqual(
      [
        `t/${t.keep.id}/${t.keep.versionId}/`,
        `t/${t.deep.id}/${t.deep.versionId}/`,
        `t/${t.keep.id}/v-old/`,
      ].sort(),
    );
    expect(result.uploadsToAbort).toEqual([]);

    const ids = [t.root.id, t.keep.id, t.sub.id, t.deep.id];
    expect(await db.select().from(nodes).where(inArray(nodes.id, ids))).toHaveLength(0);
    expect(await db.select().from(nodeVersions).where(inArray(nodeVersions.nodeId, ids))).toHaveLength(0);
    expect(await db.select().from(shares).where(inArray(shares.nodeId, ids))).toHaveLength(0);
    expect(await db.select().from(shareLinks).where(inArray(shareLinks.nodeId, ids))).toHaveLength(0);
    expect(await db.select().from(scanJobs).where(inArray(scanJobs.nodeId, ids))).toHaveLength(0);
    const [owner] = await db.select({ usedBytes: user.usedBytes }).from(user).where(eq(user.id, t.owner));
    expect(owner!.usedBytes).toBe(0);
  });

  it("purging a folder that has a done upload row succeeds, and unfinished sessions are returned to abort", async () => {
    const t = await tree();
    const editor = await makeUser(db);
    const done = await makeUpload(db, t.owner, t.owner, { parentId: t.sub.id, status: "done", size: 5000 });
    const open = await makeUpload(db, t.owner, editor, {
      parentId: t.sub.id,
      status: "open",
      size: 700,
      r2UploadId: "mpu-1",
    });
    const completing = await makeUpload(db, t.owner, t.owner, {
      parentId: t.root.id,
      status: "completing",
      size: 300,
    });
    const replacing = await makeUpload(db, t.owner, t.owner, {
      parentId: t.root.id,
      replaceNodeId: t.keep.id,
      nodeId: t.keep.id,
      status: "open",
      size: 50,
    });
    const avatar = await makeUpload(db, t.owner, t.owner, {
      parentId: t.sub.id,
      status: "open",
      size: 4000,
      purpose: "avatar",
    });
    const elsewhere = await makeUpload(db, t.owner, t.owner, { parentId: null, status: "open", size: 999 });
    await db.insert(uploadParts).values({ uploadId: open.id, partNumber: 1, etag: "e", size: 700 });

    const result = await deleteSubtreeRows(db, t.root.id);
    expect(result.freedBytes).toBe(60 + 40 + 700 + 300 + 50);
    expect(result.uploadsToAbort.map((u) => u.r2Key).sort()).toEqual(
      [open.r2Key, completing.r2Key, replacing.r2Key, avatar.r2Key].sort(),
    );
    expect(result.uploadsToAbort.find((u) => u.r2Key === open.r2Key)!.r2UploadId).toBe("mpu-1");
    expect(result.uploadsToAbort.find((u) => u.r2Key === completing.r2Key)!.r2UploadId).toBeNull();

    const left = await db
      .select({ id: uploads.id })
      .from(uploads)
      .where(inArray(uploads.id, [done.id, open.id, completing.id, replacing.id, avatar.id, elsewhere.id]));
    expect(left.map((u) => u.id)).toEqual([elsewhere.id]);
    expect(await db.select().from(uploadParts).where(eq(uploadParts.uploadId, open.id))).toHaveLength(0);
    expect(await getNode(db, t.root.id)).toBeNull();
  });

  it("refuses a held subtree for every cause and deletes nothing", async () => {
    const arrange: ((t: Awaited<ReturnType<typeof tree>>) => Promise<unknown>)[] = [
      (t) => db.update(nodes).set({ legalHold: true }).where(eq(nodes.id, t.deep.id)),
      (t) => db.update(nodes).set({ scanStatus: "suspected_csam" }).where(eq(nodes.id, t.deep.id)),
      (t) => db.update(nodes).set({ scanStatus: "under_review" }).where(eq(nodes.id, t.deep.id)),
      (t) => db.update(user).set({ legalHold: true }).where(eq(user.id, t.owner)),
      async (t) => {
        const [notice] = await db
          .insert(dmcaNotices)
          .values({ receivedVia: "email", status: "actioned" })
          .returning();
        await db.insert(dmcaNoticeNodes).values({ noticeId: notice!.id, nodeId: t.deep.id });
      },
    ];
    for (const hold of arrange) {
      const t = await tree();
      const upload = await makeUpload(db, t.owner, t.owner, { parentId: t.sub.id, status: "open" });
      await hold(t);
      const error = await held(deleteSubtreeRows(db, t.root.id));
      expect(error.heldRootIds).toEqual([t.root.id]);
      expect(
        await db
          .select()
          .from(nodes)
          .where(inArray(nodes.id, [t.root.id, t.keep.id, t.sub.id, t.deep.id])),
      ).toHaveLength(4);
      expect(await db.select().from(uploads).where(eq(uploads.id, upload.id))).toHaveLength(1);
      // The unheld sibling can still go on its own.
      const partial = await deleteSubtreeRows(db, t.keep.id).catch((e) => e);
      if (partial instanceof LegalHoldError) expect(partial.causes[t.keep.id]).toEqual(["owner_legal_hold"]);
      else expect(partial.freedBytes).toBe(60);
      await db.update(user).set({ legalHold: false }).where(eq(user.id, t.owner));
    }
  });

  it("a held root inside the caller's transaction leaves the transaction usable", async () => {
    const t = await tree();
    const other = await tree();
    await db.update(nodes).set({ legalHold: true }).where(eq(nodes.id, t.deep.id));
    await db.transaction(async (tx) => {
      await held(deleteSubtreeRows(tx, t.root.id));
      expect((await deleteSubtreeRows(tx, other.root.id)).freedBytes).toBe(100);
    });
    expect(await getNode(db, t.root.id)).not.toBeNull();
    expect(await getNode(db, other.root.id)).toBeNull();
  });

  it("works on a live (not trashed) root, on a system node, and is a no-op for an unknown id", async () => {
    const t = await tree();
    expect((await deleteSubtreeRows(db, t.sub.id)).freedBytes).toBe(40);
    expect(await getNode(db, t.keep.id)).not.toBeNull();
    const avatar = await makeFile(db, t.owner, null, "avatar", { system: "avatar", size: 5000 });
    const result = await deleteSubtreeRows(db, avatar.id);
    expect(result).toMatchObject({ ownerId: t.owner, freedBytes: 0, r2Keys: [avatar.r2Key] });
    expect(await deleteSubtreeRows(db, uuidv7())).toEqual({
      ownerId: null,
      r2Keys: [],
      thumbPrefixes: [],
      uploadsToAbort: [],
      freedBytes: 0,
    });
  });

  it("the owner sees nothing of a purged folder afterwards", async () => {
    const t = await tree();
    await deleteSubtreeRows(db, t.sub.id);
    const listing = await listChildren(db, {
      scope: { ownerId: t.owner },
      parentId: t.root.id,
      sort: "name",
      dir: "asc",
      limit: 10,
      visibleStatuses: OWNER_VISIBLE_STATUSES,
    });
    expect(listing.items.map((n) => n.id)).toEqual([t.keep.id]);
  });
});

describe("deleteVersionRows", () => {
  async function withVersions(overrides: Partial<typeof nodes.$inferInsert> = {}) {
    const owner = await makeUser(db);
    const file = await makeFile(db, owner, null, `v-${rand()}.txt`, overrides);
    await db.insert(nodeVersions).values([
      {
        nodeId: file.id,
        versionId: "v1",
        r2Key: `u/${owner}/${file.id}/v1`,
        size: 10,
        purgeAfter: new Date(),
      },
      {
        nodeId: file.id,
        versionId: "v2",
        r2Key: `u/${owner}/${file.id}/v2`,
        size: 20,
        purgeAfter: new Date(),
      },
    ]);
    return { owner, file };
  }

  it("deletes the named versions only and reports their objects and bytes", async () => {
    const { owner, file } = await withVersions();
    const result = await deleteVersionRows(db, file.id, ["v1", "missing"]);
    expect(result).toEqual({
      ownerId: owner,
      r2Keys: [`u/${owner}/${file.id}/v1`],
      thumbPrefixes: [`t/${file.id}/v1/`],
      uploadsToAbort: [],
      freedBytes: 10,
    });
    const left = await db
      .select({ versionId: nodeVersions.versionId })
      .from(nodeVersions)
      .where(eq(nodeVersions.nodeId, file.id));
    expect(left).toEqual([{ versionId: "v2" }]);
    expect(await getNode(db, file.id)).not.toBeNull();
    expect((await deleteVersionRows(db, file.id, [])).freedBytes).toBe(0);
  });

  it("refuses the versions of a held node", async () => {
    for (const overrides of [
      { legalHold: true },
      { scanStatus: "under_review" as const },
      { scanStatus: "suspected_csam" as const },
    ]) {
      const { file } = await withVersions(overrides);
      const error = await held(deleteVersionRows(db, file.id, ["v1", "v2"]));
      expect(error.heldRootIds).toEqual([file.id]);
      expect(await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, file.id))).toHaveLength(2);
    }
  });
});
