// Move: what may go where, the one answer for every move that cannot be, and the folders a node
// may not leave.
import { describe, expect, it } from "vitest";
import { NodeDto } from "../../../src/shared/schemas/node";
import type { Tx } from "../../../src/worker/db/client";
import { move as moveQuery } from "../../../src/worker/db/queries/nodes";
import { lockOwnerTree } from "../../../src/worker/db/queries/tree";
import { backendPid, gate, untilBlockedBy } from "../services-core/helpers";
import {
  api,
  auditFor,
  comparable,
  makeFile,
  makeFolder,
  makeShare,
  nodeById,
  openNoticeOn,
  person,
  setLegalHold,
  sharedTree,
  testDb,
  type Answer,
  type Caller,
} from "./helpers";

const move = (caller: Caller, nodeId: string, parentId: string | null) =>
  api(caller, "POST", `/nodes/${nodeId}/move`, { body: { parentId } });

const parentOf = async (nodeId: string) => (await nodeById(nodeId))!.parentId;

describe("POST /nodes/:id/move", () => {
  it("moves into a folder and to the top level; the answer is the NodeDto; one audit row each", async () => {
    const t = await sharedTree();
    const into = await move(t.owner.as, t.notes.id, t.dest.id);
    expect(into.status).toBe(200);
    expect(NodeDto.parse(into.body)).toMatchObject({
      id: t.notes.id,
      parentId: t.dest.id,
      name: t.notes.name,
    });
    expect(await parentOf(t.notes.id)).toBe(t.dest.id);
    const up = await move(t.owner.as, t.notes.id, null);
    expect([up.status, up.body.parentId]).toEqual([200, null]);
    const rows = await auditFor("node.move", t.notes.id);
    expect(rows.map((row) => [row.actorUserId, row.meta])).toEqual(
      expect.arrayContaining([
        [t.owner.id, { from: t.inner.id, to: t.dest.id }],
        [t.owner.id, { from: t.dest.id, to: null }],
      ]),
    );
    expect(rows).toHaveLength(2);
  });

  it("a move that changes nothing is answered and not recorded: the same request twice is one node.move row", async () => {
    const t = await sharedTree();
    const stay = await move(t.owner.as, t.notes.id, t.inner.id);
    expect([stay.status, stay.body.parentId]).toEqual([200, t.inner.id]);
    expect(await auditFor("node.move", t.notes.id)).toEqual([]);

    expect((await move(t.owner.as, t.notes.id, t.dest.id)).status).toBe(200);
    const again = await move(t.owner.as, t.notes.id, t.dest.id);
    expect([again.status, again.body.parentId]).toEqual([200, t.dest.id]);
    const rows = await auditFor("node.move", t.notes.id);
    expect(rows.map((row) => row.meta)).toEqual([{ from: t.inner.id, to: t.dest.id }]);
    // At the top level too.
    const top = await makeFile(t.owner.id, null, { scanStatus: "clean" });
    expect((await move(t.owner.as, top.id, null)).status).toBe(200);
    expect(await auditFor("node.move", top.id)).toEqual([]);
  });

  it("an editor moves inside the share; not to the owner's top level; a viewer not at all", async () => {
    const t = await sharedTree();
    expect((await move(t.editor.as, t.notes.id, t.dest.id)).status).toBe(200);
    const toTop = await move(t.editor.as, t.notes.id, null);
    expect([toTop.status, toTop.body.error]).toEqual([403, "forbidden"]);
    const byViewer = await move(t.viewer.as, t.photo.id, t.dest.id);
    expect([byViewer.status, byViewer.body.error]).toEqual([403, "forbidden"]);
    expect(await parentOf(t.notes.id)).toBe(t.dest.id);
    expect(await parentOf(t.photo.id)).toBe(t.inner.id);
  });

  it("same owner only: not into a folder of another tree, even one the caller may edit", async () => {
    const mine = await person();
    const other = await person();
    const file = await makeFile(mine.id, null, { scanStatus: "clean" });
    const theirs = await makeFolder(other.id);
    await makeShare(theirs.id, other.id, mine.id, { role: "editor", canUpload: true });
    const answer = await move(mine.as, file.id, theirs.id);
    expect([answer.status, answer.body.error]).toEqual([404, "not_found"]);
    expect(await parentOf(file.id)).toBeNull();
  });

  it("the target is a live folder: a file, a trashed folder, an unknown id are 404", async () => {
    const t = await sharedTree();
    const trashed = await makeFolder(t.owner.id, t.shared.id, { deletedAt: new Date(), trashedRoot: true });
    for (const target of [t.photo.id, trashed.id, crypto.randomUUID()]) {
      const answer = await move(t.owner.as, t.notes.id, target);
      expect([answer.status, answer.body.error], target).toEqual([404, "not_found"]);
    }
    for (const body of [{}, { parentId: "root" }, { parentId: null, name: "x" }]) {
      const answer = await api(t.owner.as, "POST", `/nodes/${t.notes.id}/move`, { body });
      expect([answer.status, answer.body.error], JSON.stringify(body)).toEqual([400, "validation"]);
    }
    expect(await parentOf(t.notes.id)).toBe(t.inner.id);
  });

  it("a cycle and a taken name are the same 409 conflict, with no details; nothing moves, nothing is audited", async () => {
    const t = await sharedTree();
    const deep = await makeFolder(t.owner.id, t.inner.id);
    const intoItself = await move(t.owner.as, t.inner.id, t.inner.id);
    const intoOwnChild = await move(t.owner.as, t.inner.id, deep.id);
    await makeFile(t.owner.id, t.dest.id, { name: t.notes.name.toUpperCase(), scanStatus: "clean" });
    const taken = await move(t.owner.as, t.notes.id, t.dest.id);
    for (const answer of [intoItself, intoOwnChild, taken]) {
      expect([answer.status, answer.body.error]).toEqual([409, "conflict"]);
      expect("details" in answer.body).toBe(false);
      expect(comparable(answer)).toEqual(comparable(intoItself));
    }
    expect(await parentOf(t.inner.id)).toBe(t.shared.id);
    expect(await parentOf(t.notes.id)).toBe(t.inner.id);
    expect(await auditFor("node.move", t.inner.id)).toEqual([]);
    expect(await auditFor("node.move", t.notes.id)).toEqual([]);
  });
});

/**
 * Lets another move of the same tree land BETWEEN a request's own read of the node and its move:
 * the owner's tree lock is held until the request is seen waiting for it (its reads have gone
 * through by then), `other` runs in the holding transaction, and the lock is released.
 */
async function overtakenBy(
  ownerId: string,
  other: (tx: Tx) => Promise<unknown>,
  request: () => Promise<Answer>,
) {
  const locked = gate<number>();
  const release = gate();
  const holder = testDb().transaction(async (tx) => {
    await lockOwnerTree(tx, ownerId);
    locked.open(await backendPid(tx));
    await release.opened;
    await other(tx);
  });
  const answer = request();
  expect(await untilBlockedBy(await locked.opened)).toBe("blocked");
  release.open();
  await holder;
  return answer;
}

describe("two moves of one node, raced: each real move is one node.move row, a move that did nothing is none", () => {
  it("overtaken by a move elsewhere, a request for the parent it READ still moves the node back — and is recorded", async () => {
    const t = await sharedTree();
    // The request reads the node under `inner`; before it gets the lock, the node goes to `dest`.
    const answer = await overtakenBy(
      t.owner.id,
      (tx) => moveQuery(tx, t.notes.id, t.dest.id),
      () => move(t.owner.as, t.notes.id, t.inner.id),
    );
    expect([answer.status, answer.body.parentId]).toEqual([200, t.inner.id]);
    expect(await parentOf(t.notes.id)).toBe(t.inner.id);
    // It did move (dest → inner): one row for it, FROM where the node was under the lock — not the
    // parent the request read. (The overtaking move was made by the test, not a request.)
    expect((await auditFor("node.move", t.notes.id)).map((row) => row.meta)).toEqual([
      { from: t.dest.id, to: t.inner.id },
    ]);
  });

  it("overtaken by the very move it asks for, a request moves nothing — and records nothing", async () => {
    const t = await sharedTree();
    const answer = await overtakenBy(
      t.owner.id,
      (tx) => moveQuery(tx, t.notes.id, t.dest.id),
      () => move(t.owner.as, t.notes.id, t.dest.id),
    );
    expect([answer.status, answer.body.parentId]).toEqual([200, t.dest.id]);
    expect(await auditFor("node.move", t.notes.id)).toEqual([]);
  });

  it("two requests for the same move, one waiting for the other: one row between them", async () => {
    const t = await sharedTree();
    let first!: Promise<Answer>;
    const second = await overtakenBy(
      t.owner.id,
      async () => {},
      () => {
        first = move(t.owner.as, t.notes.id, t.dest.id);
        return move(t.owner.as, t.notes.id, t.dest.id);
      },
    );
    expect([(await first).status, second.status]).toEqual([200, 200]);
    expect(await parentOf(t.notes.id)).toBe(t.dest.id);
    expect((await auditFor("node.move", t.notes.id)).map((row) => row.meta)).toEqual([
      { from: t.inner.id, to: t.dest.id },
    ]);
  });
});

/**
 * owner's tree:   top/                 ← shared with the editor
 *                   held/              ← the protecting folder (a legal hold, or an open notice)
 *                     file.bin
 *                     sub/
 *                   plain/
 *                     free.bin
 *                     own.bin          ← has a legal hold of its own
 */
async function heldTree(protect: "legalHold" | "notice") {
  const owner = await person();
  const editor = await person();
  const top = await makeFolder(owner.id);
  const held = await makeFolder(owner.id, top.id);
  const sub = await makeFolder(owner.id, held.id);
  const file = await makeFile(owner.id, held.id, { scanStatus: "clean" });
  const plain = await makeFolder(owner.id, top.id);
  const free = await makeFile(owner.id, plain.id, { scanStatus: "clean" });
  const own = await makeFile(owner.id, plain.id, { scanStatus: "clean", legalHold: true });
  await makeShare(top.id, owner.id, editor.id, { role: "editor", canUpload: true });
  if (protect === "legalHold") await setLegalHold(held.id, true);
  else await openNoticeOn(held.id);
  return { owner, editor, top, held, sub, file, plain, free, own };
}

describe("a node may not leave a folder that protects it", () => {
  it.each([
    { protect: "legalHold", who: "owner" },
    { protect: "legalHold", who: "editor" },
    { protect: "notice", who: "owner" },
    { protect: "notice", who: "editor" },
  ] as const)(
    "$protect, as $who: out of the folder → the cycle's 409, nothing moved, no audit row; the controls move",
    async ({ protect, who }) => {
      const t = await heldTree(protect);
      const caller = t[who].as;
      // The reference: a refusal nobody doubts, from the same caller in the same test.
      const cycle = await move(caller, t.sub.id, t.sub.id);
      expect([cycle.status, cycle.body.error]).toEqual([409, "conflict"]);

      // Out from under the folder: to a folder beside it, and (the owner) to the top level.
      const targets = who === "owner" ? [t.plain.id, t.top.id, null] : [t.plain.id, t.top.id];
      for (const target of targets) {
        const refused = await move(caller, t.file.id, target);
        expect(comparable(refused), String(target)).toEqual(comparable(cycle));
        expect(Object.keys(refused.body).sort()).toEqual(["error", "message", "requestId"]);
      }
      // A folder inside it may not leave either.
      expect(comparable(await move(caller, t.sub.id, t.plain.id))).toEqual(comparable(cycle));
      expect(await parentOf(t.file.id)).toBe(t.held.id);
      expect(await parentOf(t.sub.id)).toBe(t.held.id);
      expect(await auditFor("node.move", t.file.id)).toEqual([]);
      expect(await auditFor("node.move", t.sub.id)).toEqual([]);

      // Controls. Deeper INSIDE the protecting folder: allowed.
      const inside = await move(caller, t.file.id, t.sub.id);
      expect(inside.status).toBe(200);
      expect(await parentOf(t.file.id)).toBe(t.sub.id);
      expect(await auditFor("node.move", t.file.id)).toHaveLength(1);
      // A file under a folder that protects nothing: out of it.
      expect((await move(caller, t.free.id, t.top.id)).status).toBe(200);
      // A file whose hold is its own takes it along.
      expect((await move(caller, t.own.id, t.top.id)).status).toBe(200);
      // And INTO the protecting folder from outside.
      expect((await move(caller, t.free.id, t.held.id)).status).toBe(200);
    },
  );

  it("the owner's controls at the top level: a free file and a file with its own hold move there", async () => {
    const t = await heldTree("legalHold");
    expect((await move(t.owner.as, t.free.id, null)).status).toBe(200);
    expect((await move(t.owner.as, t.own.id, null)).status).toBe(200);
    expect(await parentOf(t.free.id)).toBeNull();
  });

  it("from one held folder into another is refused too — and the file is still protected when the second is released", async () => {
    const owner = await person();
    const f1 = await makeFolder(owner.id, null, { legalHold: true });
    const f2 = await makeFolder(owner.id, null, { legalHold: true });
    const file = await makeFile(owner.id, f1.id, { scanStatus: "clean" });
    const cycle = await move(owner.as, f1.id, f1.id);

    const refused = await move(owner.as, file.id, f2.id);
    expect(comparable(refused)).toEqual(comparable(cycle));
    expect(await parentOf(file.id)).toBe(f1.id);

    await setLegalHold(f2.id, false);
    // Still under F1, whose hold stands: it cannot leave, not even into the folder just released.
    expect(await parentOf(file.id)).toBe(f1.id);
    expect((await nodeById(f1.id))!.legalHold).toBe(true);
    expect(comparable(await move(owner.as, file.id, f2.id))).toEqual(comparable(cycle));
    expect(comparable(await move(owner.as, file.id, null))).toEqual(comparable(cycle));
    expect(await auditFor("node.move", file.id)).toEqual([]);

    // The control: with F1 released as well, the same move goes through.
    await setLegalHold(f1.id, false);
    expect((await move(owner.as, file.id, f2.id)).status).toBe(200);
  });

  it("nested protection: a sibling inside the outer folder still leaves the inner one", async () => {
    const owner = await person();
    const outer = await makeFolder(owner.id, null, { legalHold: true });
    const inner = await makeFolder(owner.id, outer.id);
    await openNoticeOn(inner.id);
    const sibling = await makeFolder(owner.id, outer.id);
    const file = await makeFile(owner.id, inner.id, { scanStatus: "clean" });
    const answer = await move(owner.as, file.id, sibling.id);
    expect([answer.status, answer.body.error]).toEqual([409, "conflict"]);
    expect(await parentOf(file.id)).toBe(inner.id);
  });
});
