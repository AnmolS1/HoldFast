import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Db, statementsSent } from "../../../src/worker/db/client";
import { LegalHoldError, QueryError } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import { holdCauses, lostByLeaving, nodeProtected } from "../../../src/worker/db/queries/holds";
import {
  closeNotice,
  restoreTakedown,
  setNodeLegalHold,
  takedownNode,
} from "../../../src/worker/db/queries/moderation";
import { getNode, OWNER_VISIBLE_STATUSES, listChildren, move } from "../../../src/worker/db/queries/nodes";
import { release } from "../../../src/worker/db/queries/quota";
import {
  assertPurgeable,
  deleteSubtreeRows,
  deleteVersionRows,
  listTrash,
  markPurgeAttempted,
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
  protectedFiles,
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

/** The gate refuses this root. */
const held_ = (rootId: string) => held(assertPurgeable(db, [rootId]));

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

  it("listTrash: a trashed root under a taken-down ancestor is not listed, until the takedown is restored", async () => {
    const owner = await makeUser(db);
    const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const folder = await makeFolder(db, owner, null, `folder-${rand()}`);
    const sub = await makeFolder(db, owner, folder.id, "sub");
    const inFolder = await makeFile(db, owner, folder.id, "in.txt", { deletedAt: at(1), trashedRoot: true });
    const deeper = await makeFile(db, owner, sub.id, "deeper.txt", { deletedAt: at(2), trashedRoot: true });
    const outside = await makeFile(db, owner, null, "outside.txt", { deletedAt: at(3), trashedRoot: true });
    const listed = async () => (await listTrash(db, owner)).items.map((n) => n.id);

    // The control: before the takedown all three trashed roots are listed.
    expect(await listed()).toEqual([inFolder.id, deeper.id, outside.id]);
    await takedownNode(db, folder.id, { reason: "dmca", by: null });
    expect(await listed()).toEqual([outside.id]);
    // A page is filled with visible rows only: the hidden ones leave no gap and no cursor.
    expect(await listTrash(db, owner, { limit: 1 })).toMatchObject({ nextCursor: null });
    await restoreTakedown(db, folder.id);
    expect(await listed()).toEqual([inFolder.id, deeper.id, outside.id]);
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

// One account on legal hold with `limit` expired trashed items used to fill every batch: each
// item throws LegalHoldError, sorts first again on the next run, and nobody else's trash is ever
// purged. Fixture dates are in 1999 so these rows sort ahead of anything another test file made.
describe("the purge queues are not wedged by rows that cannot be purged", () => {
  const at = (month: number) => new Date(Date.UTC(1999, month, 1));
  const trashedAt = (when: Date) => ({ deletedAt: when, trashedRoot: true, purgeAfter: when });

  it("purgeDue leaves out a root that is held itself or whose owner is, whatever the cause", async () => {
    const heldOwner = await makeUser(db, { legalHold: true });
    const owner = await makeUser(db);
    const held: string[] = [];
    for (let n = 0; n < 4; n++) {
      held.push((await makeFile(db, heldOwner, null, `owner-held-${n}.txt`, trashedAt(at(0)))).id);
    }
    held.push(
      (await makeFile(db, owner, null, "node-held.txt", { ...trashedAt(at(0)), legalHold: true })).id,
    );
    held.push(
      (await makeFile(db, owner, null, "review.txt", { ...trashedAt(at(0)), scanStatus: "under_review" })).id,
    );
    held.push(
      (await makeFile(db, owner, null, "csam.txt", { ...trashedAt(at(0)), scanStatus: "suspected_csam" })).id,
    );
    // Purge requested while held: `purge_after` may be null, which sorted before everything.
    held.push(
      (
        await makeFile(db, heldOwner, null, "requested-held.txt", {
          purgeRequestedAt: at(0),
          purgeAfter: null,
        })
      ).id,
    );
    const noticed = await makeFile(db, owner, null, "noticed.txt", trashedAt(at(0)));
    const [notice] = await db
      .insert(dmcaNotices)
      .values({ receivedVia: "form", status: "actioned" })
      .returning();
    await db
      .insert(dmcaNoticeNodes)
      .values({ noticeId: notice!.id, nodeId: noticed.id, nodeName: "noticed.txt" });
    held.push(noticed.id);
    const purgeable = await makeFile(db, owner, null, "purgeable.txt", trashedAt(at(6)));
    const requested = await makeFile(db, owner, null, "requested.txt", {
      purgeRequestedAt: at(6),
      purgeAfter: null,
    });

    const all = (await purgeDue(db, 100_000)).map((row) => row.id);
    expect(all).toContain(purgeable.id);
    expect(all).toContain(requested.id);
    expect(all.filter((id) => held.includes(id))).toEqual([]);
    // Every one of them really is refused by the gate — the query mirrors it, it does not replace it.
    for (const id of held) await held_(id);
    // The moment a hold is gone the row is back.
    await db.update(user).set({ legalHold: false }).where(eq(user.id, heldOwner));
    await db.update(dmcaNotices).set({ status: "closed" }).where(eq(dmcaNotices.id, notice!.id));
    const after = (await purgeDue(db, 100_000)).map((row) => row.id);
    expect(after.filter((id) => held.includes(id)).sort()).toEqual(
      held.filter((id) => ![held[4], held[5], held[6]].includes(id)).sort(),
    );
    await db.delete(nodes).where(inArray(nodes.id, [...held, purgeable.id, requested.id]));
  });

  it("a root held by something inside it goes to the back once the job has tried it", async () => {
    const owner = await makeUser(db);
    const stuck: string[] = [];
    for (let n = 0; n < 5; n++) {
      const folder = await makeFolder(db, owner, null, `stuck-${n}-${rand()}`, trashedAt(at(0)));
      await makeFile(db, owner, folder.id, "evidence.bin", { legalHold: true });
      stuck.push(folder.id);
    }
    const purgeable = await makeFile(db, owner, null, `behind-${rand()}.txt`, trashedAt(at(6)));
    const mine = async (limit: number) =>
      (await purgeDue(db, limit)).map((row) => row.id).filter((id) => [...stuck, purgeable.id].includes(id));

    // Never tried: oldest first, so the stuck roots lead — and the gate refuses each of them.
    expect(await mine(100_000)).toEqual([...stuck.slice().sort(), purgeable.id]);
    for (const id of stuck) await held(deleteSubtreeRows(db, id));
    expect(await markPurgeAttempted(db, [...stuck, uuidv7(), "junk"])).toBe(5);

    // Tried: behind every root that has not been tried since.
    const order = (await purgeDue(db, 100_000)).map((row) => row.id);
    const position = (id: string) => order.indexOf(id);
    for (const id of stuck) {
      expect(position(id), "still queued").toBeGreaterThanOrEqual(0);
      expect(position(purgeable.id)).toBeLessThan(position(id));
    }
    const batch = (await purgeDue(db, position(purgeable.id) + 1)).map((row) => row.id);
    expect(batch).toContain(purgeable.id);
    expect(batch.filter((id) => stuck.includes(id))).toEqual([]);

    // Round-robin among the stuck ones: the one tried longest ago is next.
    await db
      .update(nodes)
      .set({ purgeAttemptedAt: at(1) })
      .where(eq(nodes.id, stuck[3]!));
    const again = await mine(100_000);
    expect(again.indexOf(stuck[3]!)).toBeLessThan(again.indexOf(stuck[0]!));
    await db.delete(nodes).where(inArray(nodes.parentId, stuck));
    await db.delete(nodes).where(inArray(nodes.id, [...stuck, purgeable.id]));
  });

  it("versionsDue leaves out the old versions of a node the gate would refuse", async () => {
    const heldOwner = await makeUser(db, { legalHold: true });
    const owner = await makeUser(db);
    const blocked = [
      await makeFile(db, heldOwner, null, "owner-held.txt"),
      await makeFile(db, owner, null, "node-held.txt", { legalHold: true }),
      await makeFile(db, owner, null, "review.txt", { scanStatus: "under_review" }),
      await makeFile(db, owner, null, "csam.txt", { scanStatus: "suspected_csam" }),
    ];
    const free = await makeFile(db, owner, null, "free.txt");
    for (const node of blocked) {
      for (let n = 0; n < 3; n++) {
        await db.insert(nodeVersions).values({
          nodeId: node.id,
          versionId: `old-${n}`,
          r2Key: `k/${rand()}`,
          size: 1,
          purgeAfter: at(0),
        });
      }
    }
    await db
      .insert(nodeVersions)
      .values({ nodeId: free.id, versionId: "old", r2Key: `k/${rand()}`, size: 1, purgeAfter: at(6) });
    const ids = blocked.map((node) => node.id);
    const all = await versionsDue(db, 100_000);
    expect(all.filter((v) => ids.includes(v.nodeId))).toEqual([]);
    expect(all.filter((v) => v.nodeId === free.id)).toEqual([
      { nodeId: free.id, versionId: "old", ownerId: owner },
    ]);
    for (const node of blocked) await held(deleteVersionRows(db, node.id, ["old-0"]));
    await db.update(user).set({ legalHold: false }).where(eq(user.id, heldOwner));
    expect((await versionsDue(db, 100_000)).filter((v) => v.nodeId === blocked[0]!.id)).toHaveLength(3);
    await db.delete(nodes).where(inArray(nodes.id, [...ids, free.id]));
  });

  it("listTrash refuses a forged cursor as validation", async () => {
    const owner = await makeUser(db);
    for (let n = 0; n < 3; n++) await trash(db, (await makeFile(db, owner, null, `t-${n}.txt`)).id, owner);
    const first = await listTrash(db, owner, { limit: 1 });
    expect((await listTrash(db, owner, { limit: 1, cursor: first.nextCursor })).items).toHaveLength(1);
    const real = JSON.parse(Buffer.from(first.nextCursor!, "base64url").toString("utf8")) as {
      t: string;
      v: { at: string; id: string };
    };
    for (const at_ of ["x", "2026-13-45T00:00:00.000000Z", "2026-01-01", "", 5, null]) {
      const forged = Buffer.from(JSON.stringify({ t: real.t, v: { ...real.v, at: at_ } })).toString(
        "base64url",
      );
      const error = await rejection(listTrash(db, owner, { limit: 1, cursor: forged }));
      expect(error, String(at_)).toBeInstanceOf(QueryError);
      expect((error as QueryError).code).toBe("validation");
    }
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

  it("the gate and the retention predicate are ONE definition: for each cause a file the gate refuses is `nodeProtected`, and one with no cause is neither", async () => {
    const isProtected = async (nodeId: string) =>
      (await db.execute<{ kept: boolean }>(sql`SELECT ${nodeProtected(sql`${nodeId}::uuid`)} AS kept`))
        .rows[0]!.kept;
    const { owner, files } = await protectedFiles(db);
    // Every cause the definition knows has a fixture (a sixth cannot be added to one side only).
    expect(Object.keys(files).sort()).toEqual(Object.keys(holdCauses(sql`n`, sql`u`)).sort());
    expect(Object.keys(files)).toHaveLength(5);

    const plain = await makeFile(db, owner, null, `plain-${rand()}.bin`);
    await expect(assertPurgeable(db, [plain.id])).resolves.toBeUndefined();
    expect(await isProtected(plain.id)).toBe(false);
    expect(await isProtected(uuidv7())).toBe(false);

    for (const [cause, { node, release }] of Object.entries(files)) {
      const error = await held(assertPurgeable(db, [node.id]));
      expect(error.causes[node.id], cause).toEqual([cause]);
      expect(await isProtected(node.id), cause).toBe(true);
      // The cause lifted: neither refuses.
      await release();
      await expect(assertPurgeable(db, [node.id]), cause).resolves.toBeUndefined();
      expect(await isProtected(node.id), cause).toBe(false);
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

describe("a hold reaches down from a folder", () => {
  const past = new Date(Date.now() - 60_000);
  const trashedDue = { deletedAt: past, trashedRoot: true, purgeAfter: past };
  const isProtected = async (nodeId: string) =>
    (await db.execute<{ kept: boolean }>(sql`SELECT ${nodeProtected(sql`${nodeId}::uuid`)} AS kept`)).rows[0]!
      .kept;
  const dueIds = async () => new Set((await purgeDue(db, 100_000)).map((row) => row.id));

  /** held/ { sub/ { deep.bin (trashed, due) } }   plain/ { free.bin (trashed, due) } */
  async function twoFolders() {
    const owner = await makeUser(db);
    const held = await makeFolder(db, owner, null, `held-${rand()}`);
    const sub = await makeFolder(db, owner, held.id, "sub");
    const deep = await makeFile(db, owner, sub.id, "deep.bin", { size: 40, ...trashedDue });
    const plain = await makeFolder(db, owner, null, `plain-${rand()}`);
    const free = await makeFile(db, owner, plain.id, "free.bin", { size: 60, ...trashedDue });
    return { owner, held, sub, deep, plain, free };
  }

  it("a trashed file inside a folder on legal hold is not purged; one inside an un-held folder is, in the same run", async () => {
    const t = await twoFolders();
    // The control: before the hold both are due and both pass the gate.
    expect((await dueIds()).has(t.deep.id)).toBe(true);
    await expect(assertPurgeable(db, [t.deep.id, t.free.id])).resolves.toBeUndefined();

    // A takedown as `csam` holds the FOLDER row only.
    await takedownNode(db, t.held.id, { reason: "csam", by: null });
    expect(await getNode(db, t.held.id)).toMatchObject({ legalHold: true });
    expect(await getNode(db, t.deep.id)).toMatchObject({ legalHold: false });

    const due = await dueIds();
    expect(due.has(t.deep.id)).toBe(false);
    expect(due.has(t.free.id)).toBe(true);
    const error = await held(assertPurgeable(db, [t.deep.id, t.free.id]));
    expect(error.causes).toEqual({ [t.deep.id]: ["node_legal_hold"] });
    expect((await held(deleteSubtreeRows(db, t.deep.id))).heldRootIds).toEqual([t.deep.id]);
    expect(await getNode(db, t.deep.id)).not.toBeNull();
    expect(await deleteSubtreeRows(db, t.free.id)).toMatchObject({ ownerId: t.owner, freedBytes: 60 });
    expect(await getNode(db, t.free.id)).toBeNull();
    // The records about it are kept too: the same definition.
    expect(await isProtected(t.deep.id)).toBe(true);
    expect(await isProtected(t.sub.id)).toBe(true);
    expect(await isProtected(t.plain.id)).toBe(false);

    // The hold released: it is due and purgeable again.
    await setNodeLegalHold(db, t.held.id, false);
    expect((await dueIds()).has(t.deep.id)).toBe(true);
    expect(await isProtected(t.deep.id)).toBe(false);
    expect(await deleteSubtreeRows(db, t.deep.id)).toMatchObject({ freedBytes: 40 });
  });

  it("an open DMCA notice on a folder protects what is under it; a closed one does not", async () => {
    const t = await twoFolders();
    const [notice] = await db
      .insert(dmcaNotices)
      .values({ receivedVia: "form", status: "actioned" })
      .returning();
    await db
      .insert(dmcaNoticeNodes)
      .values({ noticeId: notice!.id, nodeId: t.held.id, nodeName: t.held.name });

    expect((await dueIds()).has(t.deep.id)).toBe(false);
    expect((await held(assertPurgeable(db, [t.deep.id]))).causes[t.deep.id]).toEqual(["open_notice"]);
    expect(await isProtected(t.deep.id)).toBe(true);
    // The control: the sibling folder's file, and this one once the notice is closed.
    await expect(assertPurgeable(db, [t.free.id])).resolves.toBeUndefined();
    await closeNotice(db, notice!.id, "closed");
    expect((await dueIds()).has(t.deep.id)).toBe(true);
    await expect(assertPurgeable(db, [t.deep.id])).resolves.toBeUndefined();
    expect(await isProtected(t.deep.id)).toBe(false);
  });

  it("under_review and suspected_csam are states of one file: on a folder above they protect nothing below", async () => {
    for (const scanStatus of ["under_review", "suspected_csam"] as const) {
      const t = await twoFolders();
      await db.update(nodes).set({ scanStatus }).where(eq(nodes.id, t.held.id));
      // The folder itself is held by its own state…
      expect((await held(assertPurgeable(db, [t.held.id]))).causes[t.held.id], scanStatus).toEqual([
        scanStatus,
      ]);
      // …the file under it is not.
      await expect(assertPurgeable(db, [t.deep.id]), scanStatus).resolves.toBeUndefined();
      expect(await isProtected(t.deep.id), scanStatus).toBe(false);
      expect((await dueIds()).has(t.deep.id), scanStatus).toBe(true);
    }
  });

  it("the old versions of a file inside a held folder are neither listed nor deleted", async () => {
    const owner = await makeUser(db);
    const heldFolder = await makeFolder(db, owner, null, `held-${rand()}`, { legalHold: true });
    const plainFolder = await makeFolder(db, owner, null, `plain-${rand()}`);
    const inside = await makeFile(db, owner, heldFolder.id, "inside.bin");
    const outside = await makeFile(db, owner, plainFolder.id, "outside.bin");
    for (const file of [inside, outside]) {
      await db
        .insert(nodeVersions)
        .values({ nodeId: file.id, versionId: "old", r2Key: `k/${rand()}`, size: 7, purgeAfter: past });
    }
    const listed = new Set((await versionsDue(db, 100_000)).map((v) => v.nodeId));
    expect(listed.has(inside.id)).toBe(false);
    expect(listed.has(outside.id)).toBe(true);

    expect((await held(deleteVersionRows(db, inside.id, ["old"]))).causes[inside.id]).toEqual([
      "node_legal_hold",
    ]);
    expect(await db.select().from(nodeVersions).where(eq(nodeVersions.nodeId, inside.id))).toHaveLength(1);
    // The control, in the same run.
    expect(await deleteVersionRows(db, outside.id, ["old"])).toMatchObject({ freedBytes: 7 });
  });

  it("a root that sits under a held folder is held as a whole, with the causes of both: above it and inside it", async () => {
    const owner = await makeUser(db);
    const top = await makeFolder(db, owner, null, `top-${rand()}`, { legalHold: true });
    const root = await makeFolder(db, owner, top.id, "root");
    const reviewed = await makeFile(db, owner, root.id, "reviewed.bin", { scanStatus: "under_review" });
    const error = await held(assertPurgeable(db, [root.id]));
    expect(error.causes[root.id]).toEqual(["node_legal_hold", "under_review"]);
    // The file's own cause alone, once the folder above is released.
    await setNodeLegalHold(db, top.id, false);
    expect((await held(assertPurgeable(db, [root.id]))).causes[root.id]).toEqual(["under_review"]);
    expect(reviewed.parentId).toBe(root.id);
  });

  it("a node cannot be moved OUT from under a held folder — or one under an open notice; within it, into it, and with a hold of its own it moves", async () => {
    const owner = await makeUser(db);
    const heldFolder = await makeFolder(db, owner, null, `held-${rand()}`, { legalHold: true });
    const inner = await makeFolder(db, owner, heldFolder.id, "inner");
    const file = await makeFile(db, owner, heldFolder.id, "file.bin");
    const elsewhere = await makeFolder(db, owner, null, `elsewhere-${rand()}`);
    const outsider = await makeFile(db, owner, elsewhere.id, "outsider.bin");
    const parentOf = async (id: string) => (await getNode(db, id))!.parentId;
    const refusedWith = async (attempt: Promise<unknown>, nodeId: string) =>
      (await held(attempt)).causes[nodeId];

    // Out: to another folder, and to the top level. Refused with the gate's own error; nothing moves.
    expect(await refusedWith(move(db, file.id, elsewhere.id), file.id)).toEqual(["node_legal_hold"]);
    expect(await refusedWith(move(db, file.id, null), file.id)).toEqual(["node_legal_hold"]);
    expect(await refusedWith(move(db, inner.id, null), inner.id)).toEqual(["node_legal_hold"]);
    expect(await parentOf(file.id)).toBe(heldFolder.id);
    // Within the held folder, and INTO it: allowed.
    expect((await move(db, file.id, inner.id)).parentId).toBe(inner.id);
    expect((await move(db, outsider.id, heldFolder.id)).parentId).toBe(heldFolder.id);
    // …and once in, it does not come out again.
    expect(await refusedWith(move(db, outsider.id, elsewhere.id), outsider.id)).toEqual(["node_legal_hold"]);
    // A held folder itself is not "under" a hold: its own hold travels with it.
    expect((await move(db, heldFolder.id, elsewhere.id)).parentId).toBe(elsewhere.id);
    expect(await isProtected(file.id)).toBe(true);

    // The same for an open notice on the folder above.
    const noticed = await makeFolder(db, owner, null, `noticed-${rand()}`);
    const under = await makeFile(db, owner, noticed.id, "under.bin");
    const [notice] = await db
      .insert(dmcaNotices)
      .values({ receivedVia: "form", status: "received" })
      .returning();
    await db
      .insert(dmcaNoticeNodes)
      .values({ noticeId: notice!.id, nodeId: noticed.id, nodeName: noticed.name });
    expect(await refusedWith(move(db, under.id, null), under.id)).toEqual(["open_notice"]);
    // From under a notice into a HELD folder: it would lose the notice's protection — refused.
    expect(await refusedWith(move(db, under.id, heldFolder.id), under.id)).toEqual(["open_notice"]);

    // The controls: the notice closed and the hold released, the same moves go through.
    await closeNotice(db, notice!.id, "closed");
    expect((await move(db, under.id, null)).parentId).toBeNull();
    await setNodeLegalHold(db, heldFolder.id, false);
    expect((await move(db, file.id, null)).parentId).toBeNull();
  });

  it("restore to the top level is the same move: a trashed file under a held folder is restored in place, not out", async () => {
    const owner = await makeUser(db);
    const heldFolder = await makeFolder(db, owner, null, `held-${rand()}`, { legalHold: true });
    const plainFolder = await makeFolder(db, owner, null, `plain-${rand()}`);
    const inHeld = await makeFile(db, owner, heldFolder.id, "in-held.bin", {
      deletedAt: past,
      trashedRoot: true,
    });
    const inPlain = await makeFile(db, owner, plainFolder.id, "in-plain.bin", {
      deletedAt: past,
      trashedRoot: true,
    });

    expect((await held(restore(db, inHeld.id, { toRoot: true }))).causes[inHeld.id]).toEqual([
      "node_legal_hold",
    ]);
    expect(await getNode(db, inHeld.id)).toMatchObject({ parentId: heldFolder.id, trashedRoot: true });
    // The control, in the same run: out of an un-held folder it goes.
    expect(await restore(db, inPlain.id, { toRoot: true })).toMatchObject({
      parentId: null,
      deletedAt: null,
    });
    // In place it is restored, and stays protected.
    expect(await restore(db, inHeld.id)).toMatchObject({ parentId: heldFolder.id, deletedAt: null });
    expect(await isProtected(inHeld.id)).toBe(true);
  });

  it("the move check compares the FOLDERS that protect, not the kind of protection: from one held folder into another is refused", async () => {
    const owner = await makeUser(db);
    const f1 = await makeFolder(db, owner, null, `matter-a-${rand()}`, { legalHold: true });
    const f2 = await makeFolder(db, owner, null, `matter-b-${rand()}`, { legalHold: true });
    const x = await makeFile(db, owner, f1.id, "x.bin", {
      ...trashedDue,
      deletedAt: null,
      trashedRoot: false,
    });
    const refused = async (attempt: Promise<unknown>, id: string) => (await held(attempt)).causes[id];

    // Same KIND of protection before and after — and still a loss: F2's hold is another matter.
    expect(await refused(move(db, x.id, f2.id), x.id)).toEqual(["node_legal_hold"]);
    expect((await getNode(db, x.id))!.parentId).toBe(f1.id);
    // What the refusal prevents: F2 released later, F1 still held — X must still be protected.
    await setNodeLegalHold(db, f2.id, false);
    expect(await isProtected(x.id)).toBe(true);
    // Within F1 it moves.
    const inF1 = await makeFolder(db, owner, f1.id, "inner");
    expect((await move(db, x.id, inF1.id)).parentId).toBe(inF1.id);

    // The same with two open notices.
    const n1 = await makeFolder(db, owner, null, `notice-a-${rand()}`);
    const n2 = await makeFolder(db, owner, null, `notice-b-${rand()}`);
    for (const folder of [n1, n2]) {
      const [notice] = await db
        .insert(dmcaNotices)
        .values({ receivedVia: "form", status: "received" })
        .returning();
      await db
        .insert(dmcaNoticeNodes)
        .values({ noticeId: notice!.id, nodeId: folder.id, nodeName: folder.name });
    }
    const y = await makeFile(db, owner, n1.id, "y.bin");
    expect(await refused(move(db, y.id, n2.id), y.id)).toEqual(["open_notice"]);
  });

  it("nested protecting folders: the node stays under the deepest one; mixed hold and notice; a folder that protects nothing is free to leave", async () => {
    const owner = await makeUser(db);
    // f1 (held) ⊃ g (under an open notice) ⊃ deep/ ;  f1 ⊃ side/ ;  x under g.
    const f1 = await makeFolder(db, owner, null, `f1-${rand()}`, { legalHold: true });
    const g = await makeFolder(db, owner, f1.id, "g");
    const [notice] = await db
      .insert(dmcaNotices)
      .values({ receivedVia: "form", status: "actioned" })
      .returning();
    await db.insert(dmcaNoticeNodes).values({ noticeId: notice!.id, nodeId: g.id, nodeName: g.name });
    const deep = await makeFolder(db, owner, g.id, "deep");
    const side = await makeFolder(db, owner, f1.id, "side");
    const x = await makeFile(db, owner, g.id, "x.bin");
    const refused = async (attempt: Promise<unknown>, id: string) => (await held(attempt)).causes[id];

    // To another child of f1, outside g: it keeps f1's hold and loses g's notice — refused, and
    // the cause named is the one it would lose.
    expect(await refused(move(db, x.id, side.id), x.id)).toEqual(["open_notice"]);
    expect(await refused(move(db, x.id, f1.id), x.id)).toEqual(["open_notice"]);
    // Out of both: both causes.
    expect(await refused(move(db, x.id, null), x.id)).toEqual(["node_legal_hold", "open_notice"]);
    // Within g, deeper: allowed.
    expect((await move(db, x.id, deep.id)).parentId).toBe(deep.id);
    // g itself is under f1's hold only (its own notice travels with it): not out of f1.
    expect(await refused(move(db, g.id, null), g.id)).toEqual(["node_legal_hold"]);
    // The control: `side` protects nothing, and a file in it is under f1 only — within f1 it moves.
    const z = await makeFile(db, owner, side.id, "z.bin");
    expect((await move(db, z.id, g.id)).parentId).toBe(g.id);
    // …and having gone under g it has g's notice too, and may not go back to `side`.
    expect(await refused(move(db, z.id, side.id), z.id)).toEqual(["open_notice"]);
  });

  it("restore: in place always (also after its folder was moved within the protection); to the top level only when no protecting folder is left behind", async () => {
    const owner = await makeUser(db);
    const f1 = await makeFolder(db, owner, null, `f1-${rand()}`, { legalHold: true });
    const sub = await makeFolder(db, owner, f1.id, "sub");
    const other = await makeFolder(db, owner, f1.id, "other");
    const t1 = await makeFile(db, owner, sub.id, "t1.bin", { deletedAt: past, trashedRoot: true });
    const t2 = await makeFile(db, owner, sub.id, "t2.bin", { deletedAt: past, trashedRoot: true });
    // Its folder moves within f1 while it sits in the trash: restoring in place re-parents nothing.
    await move(db, sub.id, other.id);
    expect(await restore(db, t1.id)).toMatchObject({ parentId: sub.id, deletedAt: null });
    expect(await isProtected(t1.id)).toBe(true);
    expect((await held(restore(db, t2.id, { toRoot: true }))).causes[t2.id]).toEqual(["node_legal_hold"]);
    expect(await getNode(db, t2.id)).toMatchObject({ parentId: sub.id, trashedRoot: true });
    // The control: the hold released, the same restore goes to the top level.
    await setNodeLegalHold(db, f1.id, false);
    expect(await restore(db, t2.id, { toRoot: true })).toMatchObject({ parentId: null, deletedAt: null });
  });

  it("the check is ONE statement whatever it finds: a protected node, an unprotected one, a destination that does not exist", async () => {
    const owner = await makeUser(db);
    const heldFolder = await makeFolder(db, owner, null, `held-${rand()}`, { legalHold: true });
    const plainFolder = await makeFolder(db, owner, null, `plain-${rand()}`);
    const protectedFile = await makeFile(db, owner, heldFolder.id, "p.bin");
    const freeFile = await makeFile(db, owner, plainFolder.id, "f.bin");
    const cost = async (nodeId: string, to: string | null) => {
      const before = statementsSent(db);
      const lost = await lostByLeaving(db, nodeId, to);
      return { statements: statementsSent(db) - before, lost };
    };
    expect(await cost(protectedFile.id, plainFolder.id)).toEqual({
      statements: 1,
      lost: ["node_legal_hold"],
    });
    expect(await cost(protectedFile.id, null)).toEqual({ statements: 1, lost: ["node_legal_hold"] });
    expect(await cost(protectedFile.id, heldFolder.id)).toEqual({ statements: 1, lost: [] });
    expect(await cost(freeFile.id, heldFolder.id)).toEqual({ statements: 1, lost: [] });
    expect(await cost(freeFile.id, null)).toEqual({ statements: 1, lost: [] });
    expect(await cost(freeFile.id, uuidv7())).toEqual({ statements: 1, lost: [] });
    expect(await cost(protectedFile.id, uuidv7())).toEqual({ statements: 1, lost: ["node_legal_hold"] });
    expect(await cost(uuidv7(), null)).toEqual({ statements: 1, lost: [] });

    // And the move as a whole: refused or carried out, it differs only by the UPDATE it did not make.
    const moveCost = async (nodeId: string, to: string | null) => {
      const before = statementsSent(db);
      const outcome = await move(db, nodeId, to).then(
        () => "moved",
        (error: unknown) => (error instanceof LegalHoldError ? "refused" : "other"),
      );
      return { statements: statementsSent(db) - before, outcome };
    };
    // Like with like: both into a folder of the same kind (a move to the top level has no target
    // to check and costs less for everybody).
    const anotherPlain = await makeFolder(db, owner, null, `plain2-${rand()}`);
    const refusedMove = await moveCost(protectedFile.id, plainFolder.id);
    const plainMove = await moveCost(freeFile.id, anotherPlain.id);
    expect(refusedMove.outcome).toBe("refused");
    expect(plainMove.outcome).toBe("moved");
    expect(plainMove.statements - refusedMove.statements).toBe(1);
  });

  it("the gate and the retention predicate agree about what is inherited", async () => {
    const t = await twoFolders();
    const refuses = async (id: string) =>
      (await rejection(assertPurgeable(db, [id]).then(() => Promise.reject(new Error("passed"))))) instanceof
      LegalHoldError;
    for (const node of [t.held, t.sub, t.deep, t.plain, t.free]) {
      expect(await isProtected(node.id), node.name).toBe(await refuses(node.id));
    }
    await setNodeLegalHold(db, t.held.id, true);
    for (const node of [t.held, t.sub, t.deep, t.plain, t.free]) {
      expect(await isProtected(node.id), node.name).toBe(await refuses(node.id));
    }
    expect(await isProtected(t.deep.id)).toBe(true);
    expect(await isProtected(t.free.id)).toBe(false);
  });
});

describe("the purge keeps a held uploader's upload sessions", () => {
  it("a session a hold protects is kept — detached from the folder, ended if it was unfinished — and every other one goes", async () => {
    const t = await tree();
    const heldEditor = await makeUser(db, { legalHold: true });
    const editor = await makeUser(db);
    const session = async (uploaderId: string, extra: Partial<typeof uploads.$inferInsert>) =>
      (await makeUpload(db, t.owner, uploaderId, { parentId: t.sub.id, ...extra })).id;
    const keptDone = await session(heldEditor, { status: "done", size: 500 });
    const keptOpen = await session(heldEditor, { status: "open", size: 300, r2UploadId: "mpu-held" });
    await db.insert(uploadParts).values({ uploadId: keptOpen, partNumber: 1, etag: "e", size: 300 });
    // The controls, in the same purge: the same two sessions of an editor who is not held.
    const goneDone = await session(editor, { status: "done", size: 500 });
    const goneOpen = await session(editor, { status: "open", size: 200, r2UploadId: "mpu-free" });
    const row = async (id: string) => (await db.select().from(uploads).where(eq(uploads.id, id)))[0] ?? null;

    const deleted = await deleteSubtreeRows(db, t.root.id);
    // Both unfinished sessions are aborted in storage and their reservations given back.
    expect(deleted.uploadsToAbort.map((u) => u.r2UploadId).sort()).toEqual(["mpu-free", "mpu-held"]);
    expect(deleted.freedBytes).toBe(60 + 40 + 300 + 200);
    expect(await getNode(db, t.root.id)).toBeNull();

    expect(await row(goneDone)).toBeNull();
    expect(await row(goneOpen)).toBeNull();
    expect(await row(keptDone)).toMatchObject({ status: "done", parentId: null, uploaderId: heldEditor });
    const ended = (await row(keptOpen))!;
    expect(ended).toMatchObject({ status: "aborted", parentId: null, uploaderId: heldEditor });
    expect(ended.completedAt).toBeInstanceOf(Date);
    expect(await db.select().from(uploadParts).where(eq(uploadParts.uploadId, keptOpen))).toEqual([]);
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
