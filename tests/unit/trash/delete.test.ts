// DELETE /nodes/:id and DELETE /trash: permanent deletion as its owner sees it — what goes, what
// is recorded with it, and that a hold changes nothing the owner can observe. Rows this file made.
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { EmptyTrashResponse, TrashResponse } from "../../../src/shared/schemas/node";
import { setNodeLegalHold } from "../../../src/worker/db/queries/moderation";
import { usageBreakdown } from "../../../src/worker/db/queries/quota";
import { restore as restoreQuery } from "../../../src/worker/db/queries/trash";
import { uploadParts, uploads } from "../../../src/worker/db/schema";
import {
  api,
  audits,
  backendPid,
  countingBucket,
  deadlockingDb,
  envelope,
  gate,
  keysUnder,
  makeFile,
  makeFolder,
  makeShare,
  makeUpload,
  makeVersion,
  member,
  multipartIsOpen,
  nodeById,
  nodesLeft,
  objectExists,
  partsOf,
  putObject,
  setUsedBytes,
  startMultipart,
  storeFile,
  storeVersion,
  testDb,
  untilBlockedBy,
  uploadRow,
  usedBytes,
  versionsLeft,
  type Caller,
  generationInStep,
} from "./helpers";

// The rollback detector reads "in step": a "delete forever" here is not held by a rollback.
beforeAll(generationInStep);

const POST = { method: "POST" } as const;
const DELETE = { method: "DELETE" } as const;
const as = (user: Awaited<ReturnType<typeof member>>): Caller => ({ user });
const trash = (caller: Caller, id: string) => api(caller, `/nodes/${id}/trash`, POST);
const restore = (caller: Caller, id: string) => api(caller, `/nodes/${id}/restore`, POST);
const purge = (caller: Caller, id: string, options = {}) =>
  api(caller, `/nodes/${id}`, { ...DELETE, ...options });
const listed = async (caller: Caller) =>
  TrashResponse.parse((await api(caller, "/trash")).body).items.map((item) => item.id);

/**
 * owner:   folder/
 *            file.bin      100 bytes, one kept old version of 40
 *          keep.bin        100 bytes — never touched
 * Every object and a thumbnail of each version is in the store; `used_bytes` is the sum.
 */
async function library() {
  const row = await member();
  const folder = await makeFolder(row.id);
  const file = await makeFile(row.id, folder.id, { scanStatus: "clean" });
  const version = await makeVersion(file);
  const keep = await makeFile(row.id, null, { scanStatus: "clean" });
  const stored = {
    file: await storeFile(file),
    version: await storeVersion(version),
    keep: await storeFile(keep),
  };
  await setUsedBytes(row.id, 240);
  const objects = () => keysUnder(`u/${row.id}/`);
  const thumbs = async () => [...(await keysUnder(`t/${file.id}/`)), ...(await keysUnder(`t/${keep.id}/`))];
  return { owner: as(row), id: row.id, folder, file, version, keep, stored, objects, thumbs };
}

describe("DELETE /nodes/:id", () => {
  it("trash → restore → trash → delete: exactly the subtree's rows and objects go, and the bytes with them", async () => {
    const t = await library();
    const everything = await t.objects();
    expect(everything).toEqual([t.stored.file.object, t.stored.version.object, t.stored.keep.object].sort());

    expect((await trash(t.owner, t.folder.id)).status).toBe(200);
    // In the trash it still counts, as trash; versions count too.
    expect(await usageBreakdown(testDb(), t.id)).toMatchObject({
      usedBytes: 240,
      filesBytes: 100,
      trashBytes: 100,
      versionsBytes: 40,
    });
    expect((await restore(t.owner, t.folder.id)).status).toBe(200);
    expect(await usageBreakdown(testDb(), t.id)).toMatchObject({ filesBytes: 200, trashBytes: 0 });
    // A live node is not deleted for good: it goes through the trash.
    expect(envelope(await purge(t.owner, t.folder.id))).toMatchObject({ status: 409, error: "conflict" });
    expect(await t.objects()).toEqual(everything);
    expect((await trash(t.owner, t.folder.id)).status).toBe(200);
    // Nor is something inside a trashed folder, on its own.
    expect(envelope(await purge(t.owner, t.file.id))).toMatchObject({ status: 409, error: "conflict" });
    expect(await t.objects()).toEqual(everything);
    expect(await t.thumbs()).toHaveLength(3);

    const answer = await purge(t.owner, t.folder.id);
    expect(answer.status).toBe(204);
    expect(answer.body).toBeNull();
    expect(await nodesLeft([t.folder.id, t.file.id, t.keep.id])).toEqual([t.keep.id]);
    expect(await versionsLeft(t.file.id)).toEqual([]);
    expect(await t.objects()).toEqual([t.stored.keep.object]);
    expect(await t.thumbs()).toEqual([t.stored.keep.thumb]);
    expect(await usageBreakdown(testDb(), t.id)).toMatchObject({
      usedBytes: 100,
      filesBytes: 100,
      trashBytes: 0,
      versionsBytes: 0,
    });
    expect(await listed(t.owner)).toEqual([]);
    // Gone: an unknown id from now on.
    expect(envelope(await purge(t.owner, t.folder.id))).toEqual(
      envelope(await purge(t.owner, crypto.randomUUID())),
    );
  });

  it("is the owner's alone", async () => {
    const t = await library();
    const editor = as(await member());
    const stranger = as(await member());
    await makeShare(t.folder.id, t.id, editor!.user.id, { role: "editor" });
    expect((await trash(editor, t.file.id)).status).toBe(200);
    expect(envelope(await purge(editor, t.file.id))).toMatchObject({ status: 403, error: "forbidden" });
    expect((await purge(stranger, t.file.id)).status).toBe(404);
    expect((await purge(null, t.file.id)).status).toBe(401);
    expect(await nodesLeft([t.file.id])).toEqual([t.file.id]);
    expect(await objectExists(t.stored.file.object)).toBe(true);
  });

  it("writes the audit row a request's own audit would be — with the deletes", async () => {
    const t = await library();
    const from = {
      headers: { "user-agent": "Mozilla/5.0 Chrome/141.0 Safari/537.36" },
      cf: { country: "NZ" },
    };
    await api(t.owner, `/nodes/${t.folder.id}/trash`, { ...POST, ...from });
    const [trashed] = await audits("node.trash", t.folder.id);
    expect(trashed).toBeDefined();

    expect((await purge(t.owner, t.folder.id, from)).status).toBe(204);
    const rows = await audits("node.purge", t.folder.id);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // What `audit(c, …)` wrote for the same caller, address, browser and country.
    expect({
      actorUserId: row.actorUserId,
      actorType: row.actorType,
      ipHashDaily: row.ipHashDaily,
      ua: row.ua,
      country: row.country,
    }).toEqual({
      actorUserId: t.id,
      actorType: "user",
      ipHashDaily: trashed!.ipHashDaily,
      ua: trashed!.ua,
      country: "NZ",
    });
    expect(row.ipHashDaily).toMatch(/^[0-9a-f]{16,}$/);
    expect(row.ua).toBe("Chrome");
    expect(row.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.requestId).not.toBe(trashed!.requestId);
    // Short facts only.
    expect(row.meta).toEqual({ reason: "user", objects: 2, bytes: 140 });

    // An admin's own purge is recorded as an admin's.
    const admin = await library();
    const asAdmin: Caller = {
      user: { ...admin.owner!.user, role: "admin", twoFactorEnabled: true },
      secondFactor: true,
    };
    await trash(asAdmin, admin.keep.id);
    expect((await purge(asAdmin, admin.keep.id)).status).toBe(204);
    expect((await audits("node.purge", admin.keep.id))[0]).toMatchObject({
      actorUserId: admin.id,
      actorType: "admin",
    });
  });

  it("no purge without its record: the audit insert fails → nothing was deleted", async () => {
    const t = await library();
    await trash(t.owner, t.folder.id);
    const everything = await t.objects();
    const failing = {
      insertAudit: async () => {
        throw new Error("the audit insert failed");
      },
    };
    const answer = await purge(t.owner, t.folder.id, { core: failing });
    expect(answer.status).toBe(500);
    expect(await nodesLeft([t.folder.id, t.file.id])).toEqual([t.folder.id, t.file.id].sort());
    expect(await versionsLeft(t.file.id)).toEqual([t.version.versionId]);
    expect(await t.objects()).toEqual(everything);
    expect(await t.thumbs()).toHaveLength(3);
    expect(await usedBytes(t.id)).toBe(240);
    expect(await audits("node.purge", t.folder.id)).toEqual([]);
    expect(await audits("node.purge_requested", t.folder.id)).toEqual([]);
    // Still in the trash, still deletable: the same request with a working insert.
    expect(await listed(t.owner)).toEqual([t.folder.id]);
    expect((await purge(t.owner, t.folder.id)).status).toBe(204);
    expect(await audits("node.purge", t.folder.id)).toHaveLength(1);
    expect(await audits("node.purge_requested", t.folder.id)).toHaveLength(1);
  });

  it("runs through the deadlock retry", async () => {
    const t = await library();
    await trash(t.owner, t.folder.id);
    const handle = deadlockingDb(1);
    expect((await purge(t.owner, t.folder.id, { core: { createDb: () => handle } })).status).toBe(204);
    expect(handle.counter.attempts).toBe(2);
    expect(await nodesLeft([t.folder.id])).toEqual([]);
    expect(await audits("node.purge", t.folder.id)).toHaveLength(1);
  });

  it("a restore that commits just before the delete wins: 409, and nothing is deleted", async () => {
    const t = await library();
    const editor = as(await member());
    await makeShare(t.folder.id, t.id, editor!.user.id, { role: "editor" });
    // The editor trashed the file — and restores it while the owner deletes it for good.
    await trash(editor, t.file.id);
    const everything = await t.objects();
    const committed = gate();
    const inside = gate<number>();
    const restoring = testDb().transaction(async (tx) => {
      await restoreQuery(tx, t.file.id);
      inside.open(await backendPid(tx));
      await committed.opened;
    });
    const pid = await inside.opened;
    // The owner's request read the file as a trashed root; its purge now waits for the tree lock.
    const deleting = purge(t.owner, t.file.id);
    expect(await untilBlockedBy(pid)).toBe("blocked");
    committed.open();
    await restoring;

    expect(envelope(await deleting)).toEqual({
      status: 409,
      error: "conflict",
      message: "That conflicts with the current state.",
    });
    expect(await nodesLeft([t.file.id])).toEqual([t.file.id]);
    expect((await nodeById(t.file.id))!.deletedAt).toBeNull();
    expect(await versionsLeft(t.file.id)).toEqual([t.version.versionId]);
    expect(await t.objects()).toEqual(everything);
    expect(await usedBytes(t.id)).toBe(240);
    expect(await audits("node.purge", t.file.id)).toEqual([]);
  });

  it("a trashed file inside a held folder: the same 204, nothing deleted, and it is gone to its owner", async () => {
    const t = await library();
    const free = await makeFolder(t.id);
    const control = await makeFile(t.id, free.id, { scanStatus: "clean" });
    const controlObject = await storeFile(control);
    await setUsedBytes(t.id, 340);
    await setNodeLegalHold(testDb(), t.folder.id, true);
    await trash(t.owner, t.file.id);
    await trash(t.owner, control.id);
    const before = { objects: await t.objects(), thumbs: await t.thumbs() };

    const held = await purge(t.owner, t.file.id);
    const unheld = await purge(t.owner, control.id);
    // Control, same run: the un-held one really went.
    expect(await nodesLeft([control.id])).toEqual([]);
    expect(await objectExists(controlObject.object)).toBe(false);
    // And the two answers cannot be told apart.
    expect([held.status, held.body]).toEqual([unheld.status, unheld.body]);
    expect(held.status).toBe(204);

    expect(await t.objects()).toEqual(before.objects.filter((key) => key !== controlObject.object));
    expect(await t.thumbs()).toEqual(before.thumbs);
    expect(await versionsLeft(t.file.id)).toEqual([t.version.versionId]);
    const row = (await nodeById(t.file.id))!;
    expect(row.purgeRequestedAt).toBeInstanceOf(Date);
    expect(row.trashedRoot).toBe(true);
    expect(await audits("node.purge", t.file.id)).toEqual([]);
    // Held bytes keep counting: the meter moved by the un-held file only.
    expect(await usedBytes(t.id)).toBe(240);
    expect(await usageBreakdown(testDb(), t.id)).toMatchObject({ trashBytes: 100, versionsBytes: 40 });

    // To the owner it is deleted: not listed, and an unknown id on every route here.
    expect(await listed(t.owner)).toEqual([]);
    const unknown = crypto.randomUUID();
    expect(envelope(await purge(t.owner, t.file.id))).toEqual(envelope(await purge(t.owner, unknown)));
    expect(envelope(await restore(t.owner, t.file.id))).toEqual(envelope(await restore(t.owner, unknown)));
    expect(envelope(await trash(t.owner, t.file.id))).toEqual(envelope(await trash(t.owner, unknown)));
    const again = (await nodeById(t.file.id))!;
    expect(again.purgeRequestedAt).toEqual(row.purgeRequestedAt);
  });

  it("no request is acted on without its record: a held root, the request row's insert fails → not marked, still listed", async () => {
    const t = await library();
    await setNodeLegalHold(testDb(), t.file.id, true);
    await trash(t.owner, t.folder.id);
    const failing = {
      insertAudit: async () => {
        throw new Error("the audit insert failed");
      },
    };
    expect((await purge(t.owner, t.folder.id, { core: failing })).status).toBe(500);
    // The marker and its record go together: neither is there, and the owner still sees the root.
    expect((await nodeById(t.folder.id))!.purgeRequestedAt).toBeNull();
    expect(await audits("node.purge_requested", t.folder.id)).toEqual([]);
    expect(await listed(t.owner)).toEqual([t.folder.id]);

    // With a working insert: the marker, and the one trace that the owner asked — who, when, which.
    expect((await purge(t.owner, t.folder.id)).status).toBe(204);
    expect((await nodeById(t.folder.id))!.purgeRequestedAt).toBeInstanceOf(Date);
    const rows = await audits("node.purge_requested", t.folder.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorUserId: t.id, actorType: "user", targetType: "node", meta: null });
    expect(rows[0]!.at).toBeInstanceOf(Date);
    // Asked once: the root is gone to its owner, and a repeat records nothing more.
    expect((await purge(t.owner, t.folder.id)).status).toBe(404);
    expect(await audits("node.purge_requested", t.folder.id)).toHaveLength(1);
    expect(await audits("node.purge", t.folder.id)).toEqual([]);
  });

  it("everything under a root whose purge was requested is gone to its owner as well", async () => {
    const t = await library();
    await setNodeLegalHold(testDb(), t.file.id, true);
    await trash(t.owner, t.folder.id);
    expect((await purge(t.owner, t.folder.id)).status).toBe(204);
    expect(await nodesLeft([t.folder.id, t.file.id])).toHaveLength(2);
    const unknown = crypto.randomUUID();
    // The child of the held root: after a real purge its id would be unknown — so it is now.
    expect(envelope(await purge(t.owner, t.file.id))).toEqual(envelope(await purge(t.owner, unknown)));
    expect(envelope(await restore(t.owner, t.file.id))).toEqual(envelope(await restore(t.owner, unknown)));
    expect(envelope(await trash(t.owner, t.file.id))).toEqual(envelope(await trash(t.owner, unknown)));
  });

  it("a single-PUT session in the purged folder: no abort, and its object is not deleted here", async () => {
    const t = await library();
    const session = await makeUpload(t.id, t.id, { parentId: t.folder.id, size: 500, r2UploadId: null });
    await putObject(session.r2Key, "what the single PUT stored");
    await setUsedBytes(t.id, 740);
    await trash(t.owner, t.folder.id);
    const { bucket, calls } = countingBucket();
    expect((await purge(t.owner, t.folder.id, { env: { FILES: bucket } })).status).toBe(204);
    expect(await uploadRow(session.id)).toBeNull();
    // The reservation is given back; no multipart call was made for a session that has none.
    expect(await usedBytes(t.id)).toBe(100);
    expect(calls).not.toContain("resumeMultipartUpload");
    expect(calls).toContain("delete");
    // Nothing references it any more: an orphan, left for the reconcile job's sweep.
    expect(await objectExists(session.r2Key)).toBe(true);
    expect(await objectExists(t.stored.file.object)).toBe(false);
  });

  it("a held uploader's sessions outlive the folder as records; anyone else's go", async () => {
    const t = await library();
    const heldEditor = await member({ legalHold: true });
    const editor = await member();
    const sessionsOf = async (uploaderId: string) => {
      const done = await makeUpload(t.id, uploaderId, {
        parentId: t.folder.id,
        status: "done",
        completedAt: new Date(),
      });
      const open = await makeUpload(t.id, uploaderId, { parentId: t.folder.id, size: 1000 });
      const uploadId = await startMultipart(open.r2Key);
      await testDb().update(uploads).set({ r2UploadId: uploadId }).where(eq(uploads.id, open.id));
      await testDb().insert(uploadParts).values({ uploadId: open.id, partNumber: 1, etag: "e", size: 16 });
      return { done, open, uploadId };
    };
    const kept = await sessionsOf(heldEditor.id);
    const gone = await sessionsOf(editor.id);
    await setUsedBytes(t.id, 240 + 2000);
    await trash(t.owner, t.folder.id);
    expect((await purge(t.owner, t.folder.id)).status).toBe(204);

    // The held uploader's: both rows are still there, detached; the open one ended, its parts gone.
    expect(await uploadRow(kept.done.id)).toMatchObject({ parentId: null, status: "done" });
    expect(await uploadRow(kept.open.id)).toMatchObject({ parentId: null, status: "aborted" });
    expect(await partsOf(kept.open.id)).toBe(0);
    // Control: the other editor's are deleted.
    expect(await uploadRow(gone.done.id)).toBeNull();
    expect(await uploadRow(gone.open.id)).toBeNull();
    // Either way the multipart upload is aborted in the store and the reservation given back.
    expect(await multipartIsOpen(kept.open.r2Key, kept.uploadId)).toBe(false);
    expect(await multipartIsOpen(gone.open.r2Key, gone.uploadId)).toBe(false);
    expect(await usedBytes(t.id)).toBe(100);
  });
});

describe("DELETE /trash", () => {
  /** A request that began a minute ago by the server's clock: its 20 seconds are long over. */
  const late = () => ({
    ...DELETE,
    headers: { "x-holdfast-test-now": new Date(Date.now() - 60_000).toISOString() },
  });

  it("deletes every trashed root of the caller — held ones included, as far as the caller can tell", async () => {
    const t = await library();
    const other = await library();
    const loose = await makeFile(t.id, null, { scanStatus: "clean" });
    const heldFile = await makeFile(t.id, null, { scanStatus: "clean", legalHold: true });
    const heldObject = await storeFile(heldFile);
    for (const id of [t.folder.id, loose.id, heldFile.id]) await trash(t.owner, id);
    await trash(other.owner, other.folder.id);

    const answer = await api(t.owner, "/trash", DELETE);
    expect([answer.status, answer.body]).toEqual([204, null]);
    expect(await nodesLeft([t.folder.id, t.file.id, loose.id, t.keep.id])).toEqual([t.keep.id]);
    expect(await objectExists(t.stored.file.object)).toBe(false);
    // The held root: every row and object, the marker, and out of the listing.
    expect(await nodesLeft([heldFile.id])).toEqual([heldFile.id]);
    expect(await objectExists(heldObject.object)).toBe(true);
    expect(await objectExists(heldObject.thumb)).toBe(true);
    expect((await nodeById(heldFile.id))!.purgeRequestedAt).toBeInstanceOf(Date);
    expect(await listed(t.owner)).toEqual([]);
    // Somebody else's trash is theirs.
    expect(await listed(other.owner)).toEqual([other.folder.id]);
    expect(await nodesLeft([other.folder.id])).toEqual([other.folder.id]);
    // Nothing left: the same answer again.
    expect((await api(t.owner, "/trash", DELETE)).status).toBe(204);
    expect((await api(null, "/trash", DELETE)).status).toBe(401);
  });

  it("past its deadline it answers 202 with what is left, and converges", async () => {
    const t = await library();
    const files = [];
    for (let i = 0; i < 3; i++) files.push(await makeFile(t.id, null, { scanStatus: "clean" }));
    for (const file of files) await trash(t.owner, file.id);
    // The deadline has passed before the first purge returns: one root a request.
    const first = await api(t.owner, "/trash", late());
    expect(first.status).toBe(202);
    expect(EmptyTrashResponse.parse(first.body)).toEqual({ remaining: 2 });
    expect(await nodesLeft(files.map((file) => file.id))).toHaveLength(2);
    const second = await api(t.owner, "/trash", late());
    expect([second.status, second.body]).toEqual([202, { remaining: 1 }]);
    // The last root: nothing is left, so it is done whatever the clock says.
    const third = await api(t.owner, "/trash", late());
    expect([third.status, third.body]).toEqual([204, null]);
    expect(await nodesLeft(files.map((file) => file.id))).toEqual([]);

    // Control: a request that began now has its 20 seconds, and does it all.
    for (let i = 0; i < 3; i++)
      await trash(t.owner, (await makeFile(t.id, null, { scanStatus: "clean" })).id);
    expect((await api(t.owner, "/trash", DELETE)).status).toBe(204);
    expect(await listed(t.owner)).toEqual([]);
  });
});
