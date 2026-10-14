// Every audit row the nodes routes write: one for each change that happened, none for one that
// did not, with its values taken from what the database answered — not from the request. (The
// move's rows are in move.test.ts, the download's in download.test.ts, the rescan's in
// rescan.test.ts; this file has the rest, and the raced edits.)
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Tx } from "../../../src/worker/db/client";
import { lockForEdit } from "../../../src/worker/db/queries/nodes-api";
import { nodes } from "../../../src/worker/db/schema";
import { nameKeyOf } from "../../../src/worker/services/filename";
import { backendPid, gate, untilBlockedBy } from "../services-core/helpers";
import { api, auditFor, auditRows, makeFolder, nodeById, sharedTree, testDb, type Answer } from "./helpers";

const patch = (as: Parameters<typeof api>[0], id: string, body: Record<string, unknown>) =>
  api(as, "PATCH", `/nodes/${id}`, { body });

/**
 * Lets another write of the node's row land BETWEEN the request's own read of the node and its
 * edit: the row is held (`FOR UPDATE`) until the request is seen waiting for it, `other` runs in
 * the holding transaction, and the row is released.
 */
async function overtakenBy(
  nodeId: string,
  other: (tx: Tx) => Promise<unknown>,
  request: () => Promise<Answer>,
) {
  const held = gate<number>();
  const release = gate();
  const holder = testDb().transaction(async (tx) => {
    await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.id, nodeId)).for("update");
    held.open(await backendPid(tx));
    await release.opened;
    await other(tx);
  });
  const answer = request();
  expect(await untilBlockedBy(await held.opened)).toBe("blocked");
  release.open();
  await holder;
  return answer;
}

const renameRow = (tx: Tx, nodeId: string, name: string) =>
  tx
    .update(nodes)
    .set({ name, nameKey: nameKeyOf(name) })
    .where(eq(nodes.id, nodeId));

describe("node.create_folder", () => {
  it("one row per folder made, its parent as the database has it; a refused one writes none", async () => {
    const t = await sharedTree();
    const top = await api(t.owner.as, "POST", "/nodes/folder", { body: { parentId: null, name: "Top" } });
    expect(top.status).toBe(200);
    const inside = await api(t.editor.as, "POST", "/nodes/folder", {
      body: { parentId: t.shared.id, name: "In" },
    });
    expect(inside.status).toBe(200);
    expect((await auditFor("node.create_folder", top.body.id)).map((row) => row.meta)).toEqual([
      { parentId: (await nodeById(top.body.id))!.parentId },
    ]);
    const rows = await auditFor("node.create_folder", inside.body.id);
    expect(rows.map((row) => [row.actorUserId, row.meta])).toEqual([
      [t.editor.id, { parentId: (await nodeById(inside.body.id))!.parentId }],
    ]);
    expect(rows[0]!.meta).toEqual({ parentId: t.shared.id });

    const before = (await auditRows({ action: "node.create_folder", actorUserId: t.editor.id })).length;
    const taken = await api(t.editor.as, "POST", "/nodes/folder", {
      body: { parentId: t.shared.id, name: "In" },
    });
    expect(taken.status).toBe(409);
    expect(await auditRows({ action: "node.create_folder", actorUserId: t.editor.id })).toHaveLength(before);
  });
});

describe("node.rename and node.star", () => {
  it("a rename that changes the name is one row; to the name it already has, none; refused, none", async () => {
    const t = await sharedTree();
    expect((await patch(t.owner.as, t.notes.id, { name: t.notes.name })).status).toBe(200);
    expect(await auditFor("node.rename", t.notes.id)).toEqual([]);

    expect((await patch(t.owner.as, t.notes.id, { name: "renamed.txt" })).status).toBe(200);
    // Only the case differs: a different name, and recorded.
    expect((await patch(t.owner.as, t.notes.id, { name: "RENAMED.txt" })).status).toBe(200);
    expect(await auditFor("node.rename", t.notes.id)).toHaveLength(2);

    const sibling = await makeFolder(t.owner.id, t.inner.id);
    const taken = await patch(t.owner.as, sibling.id, { name: "renamed.txt" });
    expect(taken.status).toBe(409);
    expect(await auditFor("node.rename", sibling.id)).toEqual([]);
  });

  it("a star that changes the star is one row with the stored value; the same star again, none", async () => {
    const t = await sharedTree();
    expect((await patch(t.owner.as, t.notes.id, { starred: false })).status).toBe(200);
    expect(await auditFor("node.star", t.notes.id)).toEqual([]);
    expect((await patch(t.owner.as, t.notes.id, { starred: true })).status).toBe(200);
    expect((await patch(t.owner.as, t.notes.id, { starred: true })).status).toBe(200);
    expect((await patch(t.owner.as, t.notes.id, { starred: false })).status).toBe(200);
    expect((await auditFor("node.star", t.notes.id)).map((row) => row.meta)).toEqual(
      expect.arrayContaining([{ starred: true }, { starred: false }]),
    );
    expect(await auditFor("node.star", t.notes.id)).toHaveLength(2);
    expect((await nodeById(t.notes.id))!.starred).toBe(false);
  });

  it("{ name, starred } is one transaction: a refused half leaves the other undone and unrecorded", async () => {
    const t = await sharedTree();
    const sibling = await makeFolder(t.owner.id, t.inner.id);
    const answer = await patch(t.owner.as, sibling.id, { starred: true, name: t.notes.name });
    expect(answer.status).toBe(409);
    expect((await nodeById(sibling.id))!.starred).toBe(false);
    expect(await auditFor("node.star", sibling.id)).toEqual([]);
    expect(await auditFor("node.rename", sibling.id)).toEqual([]);
  });

  it("{ name, starred } changing both: both kept, two rows", async () => {
    const t = await sharedTree();
    const answer = await patch(t.owner.as, t.notes.id, { name: "both.txt", starred: true });
    expect([answer.status, answer.body.name, answer.body.starred]).toEqual([200, "both.txt", true]);
    expect(await auditFor("node.rename", t.notes.id)).toHaveLength(1);
    expect((await auditFor("node.star", t.notes.id)).map((row) => row.meta)).toEqual([{ starred: true }]);
  });

  it("a star alone answers with the row as stored — a rename that landed while it waited included", async () => {
    const t = await sharedTree();
    const answer = await overtakenBy(
      t.notes.id,
      (tx) => renameRow(tx, t.notes.id, "renamed-meanwhile.txt"),
      () => patch(t.owner.as, t.notes.id, { starred: true }),
    );
    expect([answer.status, answer.body.name, answer.body.starred]).toEqual([
      200,
      "renamed-meanwhile.txt",
      true,
    ]);
  });

  it("the edit's row lock does not hold up a folder being made inside it (no key lock)", async () => {
    const t = await sharedTree();
    const held = gate<number>();
    const release = gate();
    const holder = testDb().transaction(async (tx) => {
      expect(await lockForEdit(tx, t.dest.id)).not.toBeNull();
      held.open(await backendPid(tx));
      await release.opened;
    });
    let made = false;
    const child = makeFolder(t.owner.id, t.dest.id).then((row) => {
      made = true;
      return row;
    });
    expect(await untilBlockedBy(await held.opened, () => made)).toBe("passed");
    release.open();
    await holder;
    expect((await child).parentId).toBe(t.dest.id);
  });

  it("raced: what changed is decided under the row lock, not from what the request read", async () => {
    // Overtaken by the very rename it asks for: it changes nothing, and records nothing.
    const a = await sharedTree();
    const same = await overtakenBy(
      a.notes.id,
      (tx) => renameRow(tx, a.notes.id, "theirs.txt"),
      () => patch(a.owner.as, a.notes.id, { name: "theirs.txt" }),
    );
    expect(same.status).toBe(200);
    expect(await auditFor("node.rename", a.notes.id)).toEqual([]);

    // Asks for the name it READ, but the node was renamed meanwhile: it does rename — recorded.
    const b = await sharedTree();
    const back = await overtakenBy(
      b.notes.id,
      (tx) => renameRow(tx, b.notes.id, "theirs.txt"),
      () => patch(b.owner.as, b.notes.id, { name: b.notes.name }),
    );
    expect([back.status, back.body.name]).toEqual([200, b.notes.name]);
    expect(await auditFor("node.rename", b.notes.id)).toHaveLength(1);

    // The same for the star.
    const c = await sharedTree();
    const starred = await overtakenBy(
      c.notes.id,
      (tx) => tx.update(nodes).set({ starred: true }).where(eq(nodes.id, c.notes.id)),
      () => patch(c.owner.as, c.notes.id, { starred: true }),
    );
    expect(starred.status).toBe(200);
    expect(await auditFor("node.star", c.notes.id)).toEqual([]);
  });
});
