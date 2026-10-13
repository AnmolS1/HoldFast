// POST /nodes/:id/trash, POST /nodes/:id/restore and GET /trash: who may, what is marked, what
// comes back — through the real app, against rows this file made.
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  RestoreNodeResponse,
  TrashItemDto,
  TrashNodeResponse,
  TrashResponse,
} from "../../../src/shared/schemas/node";
import { setNodeLegalHold } from "../../../src/worker/db/queries/moderation";
import { listTrash } from "../../../src/worker/db/queries/trash";
import { countTrash } from "../../../src/worker/db/queries/trash-jobs";
import { effectiveTrashed } from "../../../src/worker/db/queries/tree";
import { shares } from "../../../src/worker/db/schema";
import {
  api,
  audits,
  closeNotice,
  deadlockingDb,
  envelope,
  hookedDb,
  makeFile,
  makeFolder,
  makeShare,
  member,
  nodeById,
  openNoticeOn,
  setNode,
  testDb,
  type Caller,
} from "./helpers";

const POST = { method: "POST" } as const;
const as = (user: Awaited<ReturnType<typeof member>>): Caller => ({ user });
const trash = (caller: Caller, id: string) => api(caller, `/nodes/${id}/trash`, POST);
const restore = (caller: Caller, id: string) => api(caller, `/nodes/${id}/restore`, POST);

/**
 * owner's tree:   shared/         ← shared with the two editors and the viewer
 *                   inner/
 *                     file.bin
 *                 own.bin
 */
async function tree() {
  const owner = await member();
  const editor = await member();
  const otherEditor = await member();
  const viewer = await member();
  const stranger = await member();
  const shared = await makeFolder(owner.id);
  const inner = await makeFolder(owner.id, shared.id);
  const file = await makeFile(owner.id, inner.id, { scanStatus: "clean" });
  const own = await makeFile(owner.id, null, { scanStatus: "clean" });
  await makeShare(shared.id, owner.id, editor.id, { role: "editor" });
  await makeShare(shared.id, owner.id, otherEditor.id, { role: "editor" });
  await makeShare(shared.id, owner.id, viewer.id, { role: "viewer" });
  return {
    owner: as(owner),
    editor: as(editor),
    otherEditor: as(otherEditor),
    viewer: as(viewer),
    stranger: as(stranger),
    ids: { owner: owner.id, editor: editor.id },
    shared,
    inner,
    file,
    own,
  };
}

describe("POST /nodes/:id/trash", () => {
  it("marks the root only, answers the trashed root, and writes one audit row", async () => {
    const t = await tree();
    const answer = await trash(t.owner, t.shared.id);
    expect(answer.status).toBe(200);
    const body = TrashNodeResponse.parse(answer.body);
    expect(body.id).toBe(t.shared.id);
    expect(body.role).toBe("owner");
    // Thirty days, to the minute.
    const kept = Date.parse(body.purgeAfter) - Date.parse(body.deletedAt);
    expect(Math.abs(kept - 30 * 86_400_000)).toBeLessThan(60_000);

    const root = (await nodeById(t.shared.id))!;
    expect(root.trashedRoot).toBe(true);
    expect(root.trashedBy).toBe(t.ids.owner);
    // What is under it carries no mark of its own: it is in the trash by ancestry.
    for (const id of [t.inner.id, t.file.id]) {
      const row = (await nodeById(id))!;
      expect([row.deletedAt, row.trashedRoot, row.purgeAfter]).toEqual([null, false, null]);
      expect(await effectiveTrashed(testDb(), id)).toBe(true);
    }
    expect(await effectiveTrashed(testDb(), t.own.id)).toBe(false);

    const rows = await audits("node.trash", t.shared.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: t.ids.owner, actorType: "user", targetType: "node" });
  });

  it("an editor trashes inside a share and never the shared folder itself; a viewer nothing", async () => {
    const t = await tree();
    const shareRoot = await trash(t.editor, t.shared.id);
    expect(envelope(shareRoot)).toMatchObject({
      status: 403,
      error: "forbidden",
      details: { reason: "share_root" },
    });
    expect((await nodeById(t.shared.id))!.deletedAt).toBeNull();

    expect(envelope(await trash(t.viewer, t.file.id))).toMatchObject({ status: 403, error: "forbidden" });
    expect((await trash(t.stranger, t.file.id)).status).toBe(404);
    expect((await trash(null, t.file.id)).status).toBe(401);
    expect((await nodeById(t.file.id))!.deletedAt).toBeNull();

    const inside = await trash(t.editor, t.inner.id);
    expect(inside.status).toBe(200);
    const body = TrashNodeResponse.parse(inside.body);
    expect(body.role).toBe("editor");
    expect((await nodeById(t.inner.id))!.trashedBy).toBe(t.ids.editor);
    // The owner's own files are not reachable through the share.
    expect((await trash(t.editor, t.own.id)).status).toBe(404);
  });

  it("refuses an unverified user, and a node that is already in the trash", async () => {
    const t = await tree();
    const unverified: Caller = { user: { ...t.owner!.user, emailVerified: false } };
    expect(envelope(await trash(unverified, t.own.id))).toMatchObject({
      status: 403,
      details: { reason: "email_unverified" },
    });
    expect((await trash(t.owner, t.shared.id)).status).toBe(200);
    // Itself, and what is under it: not there to be trashed a second time.
    expect((await trash(t.owner, t.shared.id)).status).toBe(404);
    expect((await trash(t.owner, t.file.id)).status).toBe(404);
    expect((await nodeById(t.file.id))!.deletedAt).toBeNull();
    expect((await trash(t.owner, crypto.randomUUID())).status).toBe(404);
    // An id that is not an id is no route at all.
    expect((await trash(t.owner, "root")).status).toBe(404);
  });

  it("a hidden node is not found — and a folder that merely contains one is trashed as a whole", async () => {
    const t = await tree();
    await setNode(t.inner.id, { takedownAt: new Date(), takedownReason: "abuse" });
    // The taken-down folder, and the file inside it (hidden by ancestry): unknown ids.
    for (const id of [t.inner.id, t.file.id]) {
      expect(envelope(await trash(t.owner, id))).toEqual(envelope(await trash(t.owner, crypto.randomUUID())));
      expect((await nodeById(id))!.deletedAt).toBeNull();
    }
    // Control: the same request once the takedown is lifted.
    await setNode(t.inner.id, { takedownAt: null, takedownReason: null });
    expect((await trash(t.owner, t.file.id)).status).toBe(200);

    await setNode(t.inner.id, { takedownAt: new Date(), takedownReason: "abuse" });
    expect((await trash(t.owner, t.shared.id)).status).toBe(200);
  });

  it("runs through the deadlock retry: the first attempt is a deadlock victim, the request succeeds, one audit row", async () => {
    const t = await tree();
    const handle = deadlockingDb(1);
    const answer = await api(t.owner, `/nodes/${t.own.id}/trash`, {
      ...POST,
      core: { createDb: () => handle },
    });
    expect(answer.status).toBe(200);
    expect(handle.counter.attempts).toBe(2);
    expect((await nodeById(t.own.id))!.trashedRoot).toBe(true);
    expect(await audits("node.trash", t.own.id)).toHaveLength(1);

    // Control: without the helper's patience (every attempt a victim) it is an error, and
    // nothing was written or recorded.
    const always = deadlockingDb(99);
    const failed = await api(t.owner, `/nodes/${t.shared.id}/trash`, {
      ...POST,
      core: { createDb: () => always },
    });
    expect(failed.status).toBe(500);
    expect(always.counter.attempts).toBe(4);
    expect((await nodeById(t.shared.id))!.deletedAt).toBeNull();
    expect(await audits("node.trash", t.shared.id)).toHaveLength(0);
  });
});

describe("POST /nodes/:id/restore", () => {
  it("the owner restores in place; the answer is the node as it came back", async () => {
    const t = await tree();
    await trash(t.owner, t.inner.id);
    const answer = await restore(t.owner, t.inner.id);
    expect(answer.status).toBe(200);
    const body = RestoreNodeResponse.parse(answer.body);
    expect(body).toMatchObject({ id: t.inner.id, parentId: t.shared.id, name: t.inner.name });
    expect([body.deletedAt, body.purgeAfter]).toEqual([null, null]);
    const row = (await nodeById(t.inner.id))!;
    expect([row.deletedAt, row.trashedRoot, row.trashedBy, row.purgeAfter]).toEqual([
      null,
      false,
      null,
      null,
    ]);
    expect(await audits("node.restore", t.inner.id)).toHaveLength(1);
    // Not in the trash any more: nothing to restore.
    expect(envelope(await restore(t.owner, t.inner.id))).toMatchObject({ status: 409, error: "conflict" });
  });

  it("the editor who trashed it may restore it; another editor and a viewer may not", async () => {
    const t = await tree();
    await trash(t.editor, t.inner.id);
    expect(envelope(await restore(t.otherEditor, t.inner.id))).toMatchObject({ status: 403 });
    expect(envelope(await restore(t.viewer, t.inner.id))).toMatchObject({ status: 403 });
    expect((await restore(t.stranger, t.inner.id)).status).toBe(404);
    expect((await nodeById(t.inner.id))!.trashedRoot).toBe(true);

    const answer = await restore(t.editor, t.inner.id);
    expect(answer.status).toBe(200);
    expect(RestoreNodeResponse.parse(answer.body)).toMatchObject({ id: t.inner.id, role: "editor" });
    expect((await nodeById(t.inner.id))!.deletedAt).toBeNull();
  });

  it("an editor who trashed it and is no editor of that folder any more may not", async () => {
    const t = await tree();
    await trash(t.editor, t.inner.id);
    await testDb()
      .update(shares)
      .set({ role: "viewer" })
      .where(and(eq(shares.nodeId, t.shared.id), eq(shares.granteeUserId, t.ids.editor)));
    expect(envelope(await restore(t.editor, t.inner.id))).toMatchObject({ status: 403, error: "forbidden" });
    expect((await nodeById(t.inner.id))!.trashedRoot).toBe(true);
  });

  it("the editor's right is decided again inside the transaction: lowered, or the file re-trashed by someone else, in between → 403", async () => {
    // The share is lowered after the route has looked and before its transaction starts.
    const t = await tree();
    await trash(t.editor, t.inner.id);
    let done = false;
    const lowered = hookedDb(async () => {
      if (done) return;
      done = true;
      await testDb()
        .update(shares)
        .set({ role: "viewer" })
        .where(and(eq(shares.nodeId, t.shared.id), eq(shares.granteeUserId, t.ids.editor)));
    });
    const refusal = await api(t.editor, `/nodes/${t.inner.id}/restore`, {
      ...POST,
      core: { createDb: () => lowered },
    });
    expect(done).toBe(true);
    expect(envelope(refusal)).toMatchObject({ status: 403, error: "forbidden", details: { reason: "role" } });
    expect((await nodeById(t.inner.id))!.trashedRoot).toBe(true);
    expect(await audits("node.restore", t.inner.id)).toEqual([]);

    // Someone else restored it and trashed it again in between: it is their trash now.
    const u = await tree();
    await trash(u.editor, u.inner.id);
    let swapped = false;
    const retrashed = hookedDb(async () => {
      if (swapped) return;
      swapped = true;
      await setNode(u.inner.id, { trashedBy: u.ids.owner });
    });
    const second = await api(u.editor, `/nodes/${u.inner.id}/restore`, {
      ...POST,
      core: { createDb: () => retrashed },
    });
    expect(second.status).toBe(403);
    expect((await nodeById(u.inner.id))!.trashedRoot).toBe(true);

    // Control: nothing changed in between — the same request restores.
    const v = await tree();
    await trash(v.editor, v.inner.id);
    const untouched = hookedDb(async () => {});
    expect(
      (await api(v.editor, `/nodes/${v.inner.id}/restore`, { ...POST, core: { createDb: () => untouched } }))
        .status,
    ).toBe(200);
  });

  it("under a trashed folder: the owner gets it back at the top level, renamed when the name is taken; an editor is refused", async () => {
    const t = await tree();
    // A name that is already taken at the owner's top level.
    const twin = await makeFile(t.ids.owner, null, { name: t.file.name, scanStatus: "clean" });
    await trash(t.editor, t.file.id);
    await trash(t.owner, t.inner.id);

    const refusal = await restore(t.editor, t.file.id);
    expect(envelope(refusal)).toEqual({
      status: 409,
      error: "conflict",
      message: "That conflicts with the current state.",
    });
    expect((await nodeById(t.file.id))!.trashedRoot).toBe(true);

    const answer = await restore(t.owner, t.file.id);
    expect(answer.status).toBe(200);
    const body = RestoreNodeResponse.parse(answer.body);
    expect(body.parentId).toBeNull();
    expect(body.name).toBe(t.file.name.replace(/\.bin$/, " (restored).bin"));
    expect(body.name).not.toBe(twin.name);
    const rows = await audits("node.restore", t.file.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.meta).toEqual({ toRoot: true });
  });

  it("refuses to take a file out from under a folder that protects it — with the editor's 409, byte for byte", async () => {
    for (const protect of ["legal hold", "open notice"] as const) {
      const t = await tree();
      const held = await makeFile(t.ids.owner, t.inner.id, { scanStatus: "clean" });
      const free = await makeFolder(t.ids.owner);
      const control = await makeFile(t.ids.owner, free.id, { scanStatus: "clean" });
      await trash(t.editor, t.file.id);
      await trash(t.owner, held.id);
      await trash(t.owner, control.id);
      await trash(t.owner, t.inner.id);
      await trash(t.owner, free.id);
      const notice =
        protect === "legal hold"
          ? (await setNodeLegalHold(testDb(), t.inner.id, true), null)
          : await openNoticeOn(t.inner.id);

      const editorRefusal = envelope(await restore(t.editor, t.file.id));
      const before = (await nodeById(held.id))!;
      const refusal = await restore(t.owner, held.id);
      expect(refusal.status, protect).toBe(409);
      expect(envelope(refusal), protect).toEqual(editorRefusal);
      const after = (await nodeById(held.id))!;
      expect([after.deletedAt, after.trashedRoot, after.parentId, after.purgeAfter]).toEqual([
        before.deletedAt,
        true,
        t.inner.id,
        before.purgeAfter,
      ]);
      expect(await audits("node.restore", held.id)).toHaveLength(0);

      // Control: the same file under a folder that protects nothing goes to the top level.
      const moved = await restore(t.owner, control.id);
      expect(moved.status, protect).toBe(200);
      expect(RestoreNodeResponse.parse(moved.body).parentId).toBeNull();

      // Control: the protecting folder first, then the file — in place.
      expect((await restore(t.owner, t.inner.id)).status, protect).toBe(200);
      const inPlace = await restore(t.owner, held.id);
      expect(inPlace.status, protect).toBe(200);
      expect(RestoreNodeResponse.parse(inPlace.body).parentId).toBe(t.inner.id);
      if (notice) await closeNotice(notice);
    }
  });

  it("a hidden node is not found; a live node and a child of a trashed folder are a conflict", async () => {
    const t = await tree();
    await trash(t.owner, t.shared.id);
    // Inside a trashed folder, but no trashed root itself.
    expect(envelope(await restore(t.owner, t.file.id))).toMatchObject({ status: 409, error: "conflict" });
    expect(envelope(await restore(t.owner, t.own.id))).toMatchObject({ status: 409, error: "conflict" });
    await setNode(t.shared.id, { takedownAt: new Date(), takedownReason: "abuse" });
    expect(envelope(await restore(t.owner, t.shared.id))).toEqual(
      envelope(await restore(t.owner, crypto.randomUUID())),
    );
    expect((await nodeById(t.shared.id))!.trashedRoot).toBe(true);
    // Control: visible again, it restores.
    await setNode(t.shared.id, { takedownAt: null, takedownReason: null });
    expect((await restore(t.owner, t.shared.id)).status).toBe(200);
  });

  it("runs through the deadlock retry, with one audit row", async () => {
    const t = await tree();
    await trash(t.owner, t.own.id);
    const handle = deadlockingDb(1);
    const answer = await api(t.owner, `/nodes/${t.own.id}/restore`, {
      ...POST,
      core: { createDb: () => handle },
    });
    expect(answer.status).toBe(200);
    expect(handle.counter.attempts).toBe(2);
    expect(await audits("node.restore", t.own.id)).toHaveLength(1);
  });
});

describe("GET /trash", () => {
  it("lists the caller's own trashed roots, newest first, a page at a time", async () => {
    const t = await tree();
    const first = await makeFile(t.ids.owner, null, { scanStatus: "clean" });
    const second = await makeFolder(t.ids.owner);
    await trash(t.owner, first.id);
    await trash(t.owner, second.id);
    await trash(t.editor, t.file.id);

    const whole = TrashResponse.parse((await api(t.owner, "/trash")).body);
    expect(whole.items.map((item) => item.id)).toEqual([t.file.id, second.id, first.id]);
    expect(whole.nextCursor).toBeNull();
    for (const item of whole.items) expect(TrashItemDto.parse(item).role).toBe("owner");
    // "Where it was" is the folder it was in.
    expect(whole.items[0]!.parentId).toBe(t.inner.id);

    const pageOne = TrashResponse.parse((await api(t.owner, "/trash?limit=2")).body);
    expect(pageOne.items.map((item) => item.id)).toEqual([t.file.id, second.id]);
    expect(pageOne.nextCursor).not.toBeNull();
    const pageTwo = TrashResponse.parse(
      (await api(t.owner, `/trash?limit=2&cursor=${encodeURIComponent(pageOne.nextCursor!)}`)).body,
    );
    expect(pageTwo.items.map((item) => item.id)).toEqual([first.id]);
    expect(pageTwo.nextCursor).toBeNull();

    // It is the OWNER's trash: the editor who trashed a file there does not see it in theirs.
    expect(TrashResponse.parse((await api(t.editor, "/trash")).body).items).toEqual([]);
    expect((await api(null, "/trash")).status).toBe(401);
  });

  it("refuses a limit over 200, an unknown key and a cursor that is not one", async () => {
    const t = await tree();
    for (const query of ["limit=201", "limit=0", "order=name", "cursor=not-a-cursor"]) {
      expect(envelope(await api(t.owner, `/trash?${query}`)), query).toMatchObject({
        status: 400,
        error: "validation",
      });
    }
    expect((await api(t.owner, "/trash?limit=200")).status).toBe(200);
  });

  it("never lists a root whose purge was requested, a hidden one, or one under a taken-down folder", async () => {
    const t = await tree();
    const requested = await makeFile(t.ids.owner, null, { scanStatus: "clean" });
    const locked = await makeFile(t.ids.owner, null, { scanStatus: "clean" });
    const takenDown = await makeFile(t.ids.owner, null, { scanStatus: "clean" });
    const plain = await makeFile(t.ids.owner, null, { scanStatus: "clean" });
    for (const node of [requested, locked, takenDown, plain, t.file]) await trash(t.owner, node.id);
    await setNode(requested.id, { purgeRequestedAt: new Date() });
    await setNode(locked.id, { scanStatus: "suspected_csam" });
    await setNode(takenDown.id, { takedownAt: new Date(), takedownReason: "dmca" });
    await setNode(t.inner.id, { takedownAt: new Date(), takedownReason: "abuse" });

    const listed = TrashResponse.parse((await api(t.owner, "/trash")).body).items.map((item) => item.id);
    expect(listed).toEqual([plain.id]);
    // The count `DELETE /trash` answers with is of the same rows.
    expect(await countTrash(testDb(), t.ids.owner)).toBe(
      (await listTrash(testDb(), t.ids.owner, { limit: 200 })).items.length,
    );
    expect(await countTrash(testDb(), t.ids.owner)).toBe(1);

    // By id they are unknown as well.
    const unknown = envelope(await restore(t.owner, crypto.randomUUID()));
    for (const node of [requested, locked, takenDown, t.file]) {
      expect(envelope(await restore(t.owner, node.id)), node.id).toEqual(unknown);
      expect(envelope(await api(t.owner, `/nodes/${node.id}`, { method: "DELETE" })), node.id).toEqual(
        unknown,
      );
    }
    // Control: the takedown lifted, the file under it is listed again.
    await setNode(t.inner.id, { takedownAt: null, takedownReason: null });
    expect(TrashResponse.parse((await api(t.owner, "/trash")).body).items.map((item) => item.id)).toEqual([
      t.file.id,
      plain.id,
    ]);
  });
});
