// POST /api/uploads/:id/complete — the stored object becomes a node, after everything init
// checked has been checked again; and the scan message it sends reaches the consumer.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { THUMB_SIZES } from "../../../src/shared/constants";
import { NodeDto } from "../../../src/shared/schemas/node";
import { uuidv7 } from "../../../src/worker/db/ids";
import * as sessions from "../../../src/worker/db/queries/upload-sessions";
import { claimCompleting, markDone } from "../../../src/worker/db/queries/uploads";
import {
  nodes,
  nodeVersions,
  shareLinks,
  shares,
  uploadIps,
  uploads,
  user as userTable,
} from "../../../src/worker/db/schema";
import { REPLACE_REFUSED_MESSAGE } from "../../../src/worker/routes/uploads";
import { extOf, nameKeyOf } from "../../../src/worker/services/filename";
import { keyFor, thumbKey } from "../../../src/worker/services/storage";
import { eicarBytes } from "../../setup/fixture-bytes";
import { makeLink } from "../auth/helpers";
import {
  deliver,
  jobsFor,
  makeFile,
  makeFolder,
  makeShare,
  nodeById,
  putObject,
  r2Event,
  testDb,
} from "../services-core/helpers";
import {
  auditFor,
  call,
  complete,
  deadlockError,
  init,
  initBody,
  ledgerOf,
  putParts,
  putSingle,
  ROOMY,
  sessionRow,
  sessionsOf,
  sha,
  TWO_PARTS,
  uploaded,
  uploader,
  usedBytes,
  watchedBucket,
  type TxFailure,
  type UserRow,
} from "./helpers";

const nodesIn = (parentId: string) => testDb().select().from(nodes).where(eq(nodes.parentId, parentId));
const versionsOf = (nodeId: string) =>
  testDb().select().from(nodeVersions).where(eq(nodeVersions.nodeId, nodeId));

describe("a finished upload", () => {
  it("becomes one pending node with everything the session promised, and the session is done", async () => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const session = await uploaded(user, {
      parentId: folder.id,
      name: "Notes.TXT",
      mimeDeclared: "text/plain",
    });
    const sent: unknown[] = [];
    const sha256 = sha();
    const answer = await complete(
      user,
      session.uploadId,
      { sha256 },
      { sent, headers: { "cf-connecting-ip": "203.0.113.77" } },
    );
    expect(answer.status).toBe(201);
    const dto = NodeDto.parse(answer.body);
    expect(dto).toMatchObject({
      parentId: folder.id,
      kind: "file",
      name: "Notes.TXT",
      ext: "txt",
      size: 1000,
      scanStatus: "pending",
      // Not shown while the scan is pending: until then it is only what the client declared.
      sha256: null,
      thumb: false,
      role: "owner",
      owner: { id: user.id },
      createdBy: { id: user.id },
    });
    const row = (await sessionRow(session.uploadId))!;
    expect(row).toMatchObject({ status: "done", nodeId: dto.id });
    expect(row.completedAt).not.toBeNull();
    expect(await nodeById(dto.id)).toMatchObject({
      ownerId: user.id,
      createdBy: user.id,
      parentId: folder.id,
      nameKey: "notes.txt",
      mimeDeclared: "text/plain",
      mimeSniffed: null,
      r2Key: row.r2Key,
      versionId: row.versionId,
      sha256,
      scanStatus: "pending",
      system: null,
    });
    expect(dto.etag).toBe(row.versionId);
    // The reservation became the node: the meter did not move.
    expect(await usedBytes(user.id)).toBe(1000);
    // Only now is the day's ledger charged.
    expect(await ledgerOf("upload_user", user.id)).toMatchObject([{ bytes: 1000, count: 1 }]);
    expect(await ledgerOf("upload_editor", user.id)).toHaveLength(0);
    // The one explicit scan message.
    expect(sent).toEqual([{ v: 1, nodeId: dto.id, key: row.r2Key, force: false }]);
    expect(await auditFor("node.upload", dto.id)).toHaveLength(1);
    // The uploader's address: sealed, with its IV and key version — never in the clear.
    const ips = await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, dto.id));
    expect(ips).toHaveLength(1);
    expect(ips[0]).toMatchObject({
      versionId: row.versionId,
      uploaderId: user.id,
      keyVersion: 1,
      legalHold: false,
    });
    expect(ips[0]!.iv.byteLength).toBe(12);
    expect(ips[0]!.ipEncrypted.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(ips[0]!.ipEncrypted)).not.toContain("203.0.113");
    expect(await nodesIn(folder.id)).toHaveLength(1);
  });

  it("complete is safe to repeat: the same answer again, and nothing done twice", async () => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const session = await uploaded(user, { parentId: folder.id });
    const sha256 = sha();
    const sent: unknown[] = [];
    const first = await complete(user, session.uploadId, { sha256 }, { sent });
    expect(first.status).toBe(201);
    const nodeId = String(first.body.id);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done", expectedSha256: sha256 });

    const watched = watchedBucket();
    for (let repeat = 0; repeat < 3; repeat++) {
      const again = await complete(
        user,
        session.uploadId,
        { sha256 },
        { sent, env: { FILES: watched.bucket } },
      );
      expect(again.status).toBe(200);
      expect({ ...again.body, requestId: "" }).toEqual({ ...first.body, requestId: "" });
    }
    // One node, one audit row, one usage record, one scan message, one address — and the store
    // was not touched again.
    expect(await nodesIn(folder.id)).toHaveLength(1);
    expect(await auditFor("node.upload", nodeId)).toHaveLength(1);
    expect(await ledgerOf("upload_user", user.id)).toMatchObject([{ bytes: 1000, count: 1 }]);
    expect(sent).toHaveLength(1);
    expect(await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, nodeId))).toHaveLength(1);
    expect(watched.calls).toEqual({});
    expect(await usedBytes(user.id)).toBe(1000);

    // A body that is not what completed is not "the same request again".
    expect((await complete(user, session.uploadId, { sha256: sha() })).status).toBe(409);
    expect((await complete(user, session.uploadId, { sha256, parts: [{ n: 1, etag: "x" }] })).status).toBe(
      409,
    );
    // Someone else's repeat is nobody's session.
    expect((await complete(await uploader(), session.uploadId, { sha256 })).status).toBe(404);
    // The node in the trash: what a read of it would answer — and never a second node.
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true })
      .where(eq(nodes.id, nodeId));
    expect((await complete(user, session.uploadId, { sha256 })).status).toBe(404);
    expect(await nodesIn(folder.id)).toHaveLength(1);
  });

  it("a complete that meets one still running is told so: 409 with details.state", async () => {
    const user = await uploader();
    const session = await uploaded(user);
    await claimCompleting(testDb(), session.uploadId, user.id);
    const answer = await complete(user, session.uploadId);
    expect(answer.status).toBe(409);
    expect(answer.body).toMatchObject({ error: "conflict", details: { state: "completing" } });
    expect((await sessionRow(session.uploadId))?.status).toBe("completing");
  });

  it("an editor's upload: the owner's node, created by the editor; both ledgers charged; answered as an editor sees it", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const session = await uploaded(editor, { parentId: folder.id, size: 800 });
    const answer = await complete(editor, session.uploadId);
    expect(answer.status).toBe(201);
    const dto = NodeDto.parse(answer.body);
    expect(dto).toMatchObject({ role: "editor", owner: { id: owner.id }, createdBy: { id: editor.id } });
    // What only the owner is told is not in an editor's answer.
    expect(dto.sha256).toBeNull();
    expect(await nodeById(dto.id)).toMatchObject({ ownerId: owner.id, createdBy: editor.id });
    expect(await usedBytes(owner.id)).toBe(800);
    expect(await usedBytes(editor.id)).toBe(0);
    expect(await ledgerOf("upload_user", owner.id)).toMatchObject([{ bytes: 800, count: 1 }]);
    expect(await ledgerOf("upload_editor", editor.id)).toMatchObject([{ bytes: 800 }]);
    expect(await ledgerOf("upload_user", editor.id)).toHaveLength(0);
  });

  it("completes at once: exactly one node, whatever the others are answered", async () => {
    for (let round = 0; round < 4; round++) {
      const user = await uploader();
      const folder = await makeFolder(user.id);
      const session = await uploaded(user, { parentId: folder.id });
      const answers = await Promise.all(Array.from({ length: 4 }, () => complete(user, session.uploadId)));
      // One of them makes the node; the others find it being made (409, "completing") or made (200).
      const statuses = answers.map((answer) => answer.status);
      expect(statuses.filter((status) => status === 201)).toHaveLength(1);
      const made = answers.find((answer) => answer.status === 201)!;
      for (const answer of answers) {
        if (answer.status === 409) expect(answer.body.details).toEqual({ state: "completing" });
        else expect(answer.body.id).toBe(made.body.id);
        expect([200, 201, 409]).toContain(answer.status);
      }
      expect(await nodesIn(folder.id)).toHaveLength(1);
      expect(await auditFor("node.upload", String(made.body.id))).toHaveLength(1);
      expect(await usedBytes(user.id)).toBe(1000);
      expect(await ledgerOf("upload_user", user.id)).toMatchObject([{ bytes: 1000, count: 1 }]);
    }
  });

  it("a name taken since init is resolved by a suffix, never by failing a finished upload", async () => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const session = await uploaded(user, { parentId: folder.id, name: "report.pdf" });
    await makeFile(user.id, folder.id, { name: "Report.pdf" });
    await makeFile(user.id, folder.id, { name: "report (1).pdf" });
    const answer = await complete(user, session.uploadId);
    expect(answer.status).toBe(201);
    expect(answer.body.name).toBe("report (2).pdf");
    expect(await nodeById(String(answer.body.id))).toMatchObject({ nameKey: "report (2).pdf", ext: "pdf" });
  });
});

describe("what a client cannot do with a finished or a second session", () => {
  it("a failure AFTER the commit (the scan message cannot be sent) keeps the node and its bytes counted — nothing is released", async () => {
    const user = await uploader();
    const session = await uploaded(user, { size: 1000 });
    const answer = await complete(
      user,
      session.uploadId,
      {},
      {
        env: {
          SCAN_QUEUE: {
            send: async () => {
              throw new Error("test: the queue is down");
            },
          },
        },
      },
    );
    expect(answer.status).toBe(201);
    expect(await nodeById(String(answer.body.id))).toMatchObject({ scanStatus: "pending" });
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done" });
    expect(await usedBytes(user.id)).toBe(1000);
    // And the session cannot be aborted for a refund afterwards.
    expect((await call(user, "DELETE", `/uploads/${session.uploadId}`)).status).toBe(409);
    expect(await usedBytes(user.id)).toBe(1000);
  });

  it("two sessions never resolve to one key — not even two replaces of one file; the second to complete is refused", async () => {
    const owner = await uploader({ usedBytes: 100 });
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { name: "plan.txt", scanStatus: "clean" });
    await putObject(file.r2Key!, "the old version");
    const replace = {
      parentId: folder.id,
      name: "plan.txt",
      onConflict: "replace" as const,
      replaceNodeId: file.id,
    };
    const a = await uploaded(owner, replace, new Uint8Array(1000).fill(1));
    const b = await uploaded(owner, replace, new Uint8Array(2000).fill(2));
    const [rowA, rowB] = [(await sessionRow(a.uploadId))!, (await sessionRow(b.uploadId))!];
    expect(rowA.nodeId).toBe(rowB.nodeId);
    expect(new Set([rowA.r2Key, rowB.r2Key, file.r2Key]).size).toBe(3);
    expect(await usedBytes(owner.id)).toBe(3100);

    expect((await complete(owner, a.uploadId)).status).toBe(200);
    // The file is `pending` again: it cannot be replaced before it has a verdict.
    const second = await complete(owner, b.uploadId);
    expect(second.status).toBe(409);
    expect(second.body.message).toBe(REPLACE_REFUSED_MESSAGE);
    expect(await nodeById(file.id)).toMatchObject({ r2Key: rowA.r2Key, size: 1000 });
    expect(await env.FILES.head(rowB.r2Key)).toBeNull();
    // The old version (100) and the new one (1000) count; the refused upload's 2000 came back.
    expect(await usedBytes(owner.id)).toBe(1100);
    expect(await versionsOf(file.id)).toHaveLength(1);
  });
});

describe("the stub scan pipeline (how files become downloadable in this wave)", () => {
  it("the message complete sent, handed to the consumer, turns the node clean — and the EICAR file infected", async () => {
    const user = await uploader();
    for (const [bytes, verdict] of [
      [new TextEncoder().encode("just some text\n"), "clean"],
      [eicarBytes(), "infected"],
    ] as const) {
      const session = await uploaded(user, {}, bytes);
      const sent: unknown[] = [];
      const answer = await complete(user, session.uploadId, {}, { sent });
      expect(answer.status).toBe(201);
      expect(sent).toHaveLength(1);
      expect(await deliver([{ body: sent[0] }])).toEqual([{ outcome: "ack" }]);
      const node = (await nodeById(String(answer.body.id)))!;
      expect(node.scanStatus).toBe(verdict);
      expect(await jobsFor(node.r2Key!)).toMatchObject([{ status: "done" }]);
    }
  });

  it("the store's own event arrives before the node exists: retried, not acknowledged, not called unknown — then one scan job", async () => {
    const user = await uploader();
    const content = new TextEncoder().encode("the race, by hand\n");
    const session = await uploaded(user, {}, content);
    // Complete has claimed the session and the object is in the store; the node is not written yet.
    const row = (await claimCompleting(testDb(), session.uploadId, user.id))!;
    const event = r2Event(row.r2Key, "PutObject", content.byteLength);
    for (const attempts of [1, 3, 7]) {
      expect(await deliver([{ body: event, attempts }])).toEqual([{ outcome: "retry", delaySeconds: 10 }]);
    }
    expect(await jobsFor(row.r2Key)).toHaveLength(0);
    // The node insert, as complete's transaction makes it.
    const node = await sessions.insertFileNode(testDb(), {
      id: row.nodeId,
      ownerId: user.id,
      createdBy: user.id,
      parentId: null,
      kind: "file",
      name: row.name,
      nameKey: nameKeyOf(row.name),
      ext: extOf(row.name),
      size: row.size,
      r2Key: row.r2Key,
      versionId: row.versionId,
      scanStatus: "pending",
    });
    await markDone(testDb(), row.id);
    // The same event again, and the explicit message after it: one job.
    expect(await deliver([{ body: event, attempts: 8 }])).toEqual([{ outcome: "ack" }]);
    expect(await deliver([{ body: { v: 1, nodeId: node!.id, key: row.r2Key, force: false } }])).toEqual([
      { outcome: "ack" },
    ]);
    expect(await jobsFor(row.r2Key)).toHaveLength(1);
    expect((await nodeById(node!.id))?.scanStatus).toBe("clean");
  });
});

describe("everything is checked again at complete — and a refusal gives the reservation back", () => {
  type Setup = {
    owner: UserRow;
    editor: UserRow;
    folderId: string;
    shareId: string;
    uploadId: string;
    key: string;
  };

  async function editorUpload(): Promise<Setup> {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    const share = await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const session = await uploaded(editor, { parentId: folder.id });
    expect(await usedBytes(owner.id)).toBe(1000);
    const key = (await sessionRow(session.uploadId))!.r2Key;
    return { owner, editor, folderId: folder.id, shareId: share.id, uploadId: session.uploadId, key };
  }

  async function expectGivenUp(setup: Setup) {
    expect(await sessionRow(setup.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(setup.owner.id)).toBe(0);
    expect(await env.FILES.head(setup.key)).toBeNull();
    expect(await nodesIn(setup.folderId)).toHaveLength(0);
    expect(await ledgerOf("upload_user", setup.owner.id)).toHaveLength(0);
    expect(await ledgerOf("upload_editor", setup.editor.id)).toHaveLength(0);
  }

  it("control: nothing changed → 201", async () => {
    const setup = await editorUpload();
    expect((await complete(setup.editor, setup.uploadId)).status).toBe(201);
    expect(await usedBytes(setup.owner.id)).toBe(1000);
  });

  it("the share was revoked → 404", async () => {
    const setup = await editorUpload();
    await testDb().delete(shares).where(eq(shares.id, setup.shareId));
    const answer = await complete(setup.editor, setup.uploadId);
    expect(answer.status).toBe(404);
    await expectGivenUp(setup);
  });

  it("the share no longer allows uploads → 403", async () => {
    const setup = await editorUpload();
    await testDb().update(shares).set({ canUpload: false }).where(eq(shares.id, setup.shareId));
    const answer = await complete(setup.editor, setup.uploadId);
    expect(answer.status).toBe(403);
    await expectGivenUp(setup);
  });

  it("the share was lowered to viewer → 403", async () => {
    const setup = await editorUpload();
    await testDb().update(shares).set({ role: "viewer" }).where(eq(shares.id, setup.shareId));
    expect((await complete(setup.editor, setup.uploadId)).status).toBe(403);
    await expectGivenUp(setup);
  });

  it("the parent folder was trashed → 404", async () => {
    const setup = await editorUpload();
    await testDb()
      .update(nodes)
      .set({ deletedAt: new Date(), trashedRoot: true })
      .where(eq(nodes.id, setup.folderId));
    expect((await complete(setup.owner, setup.uploadId)).status).toBe(404); // not the uploader
    expect((await sessionRow(setup.uploadId))?.status).toBe("open");
    expect((await complete(setup.editor, setup.uploadId)).status).toBe(404);
    await expectGivenUp(setup);
  });

  it("the parent folder was taken down → 404", async () => {
    const setup = await editorUpload();
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "admin" })
      .where(eq(nodes.id, setup.folderId));
    expect((await complete(setup.editor, setup.uploadId)).status).toBe(404);
    await expectGivenUp(setup);
  });

  it("the owner was suspended → 404 for the editor", async () => {
    const setup = await editorUpload();
    await testDb().update(userTable).set({ suspendedAt: new Date() }).where(eq(userTable.id, setup.owner.id));
    expect((await complete(setup.editor, setup.uploadId)).status).toBe(404);
    await expectGivenUp(setup);
  });

  it("uploads were switched off → 503 feature_disabled", async () => {
    const setup = await editorUpload();
    const answer = await complete(
      setup.editor,
      setup.uploadId,
      {},
      { settings: { ...ROOMY, uploadsEnabled: false } },
    );
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ error: "feature_disabled", details: { reason: "uploads_disabled" } });
    await expectGivenUp(setup);
  });

  it("what is stored is not the declared size → 400", async () => {
    const setup = await editorUpload();
    await env.FILES.delete(setup.key);
    expect((await complete(setup.editor, setup.uploadId)).status).toBe(400);
    await expectGivenUp(setup);
  });

  it("the stale-upload job gave the session up while complete ran: nothing is kept of the node", async () => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const session = await uploaded(user, { parentId: folder.id });
    // Between the claim and the commit: the session is ended under the request.
    const answer = await complete(
      user,
      session.uploadId,
      {},
      {
        beforeCommit: () => {
          throw new Error("test: the commit fails");
        },
      },
    );
    expect(answer.status).toBe(500);
    expect(await nodesIn(folder.id)).toHaveLength(0);
    // Left `completing` with its object and its reservation, for the stale-upload job.
    expect((await sessionRow(session.uploadId))?.status).toBe("completing");
    expect(await usedBytes(user.id)).toBe(1000);
    expect(await ledgerOf("upload_user", user.id)).toHaveLength(0);
  });
});

describe("replace", () => {
  async function target(owner: UserRow, overrides: Parameters<typeof makeFile>[2] = {}) {
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { name: "plan.txt", scanStatus: "clean", ...overrides });
    await putObject(file.r2Key!, "the old version");
    return { folder, file };
  }
  const replaceBody = (folderId: string, fileId: string, extra = {}) =>
    initBody({
      parentId: folderId,
      name: "plan.txt",
      onConflict: "replace",
      replaceNodeId: fileId,
      ...extra,
    });

  it("keeps the node's id, shares and links; the old version goes to node_versions and its thumbnails are deleted", async () => {
    const owner = await uploader({ usedBytes: 100 });
    const friend = await uploader();
    const { folder, file } = await target(owner);
    const share = await makeShare(file.id, owner.id, friend.id);
    const link = await makeLink(file.id, owner.id);
    for (const size of THUMB_SIZES) await putObject(thumbKey(file.id, file.versionId!, size), "old thumb");
    const otherVersion = thumbKey(file.id, uuidv7(), THUMB_SIZES[0]);
    await putObject(otherVersion, "another version's thumb");

    const first = await call(owner, "POST", "/uploads", { json: replaceBody(folder.id, file.id) });
    expect(first.status).toBe(201);
    expect(first.body.finalName).toBe("plan.txt");
    const session = (await sessionRow(String(first.body.uploadId)))!;
    expect(session).toMatchObject({ nodeId: file.id, replaceNodeId: file.id });
    expect(session.versionId).not.toBe(file.versionId);
    expect(session.r2Key).toBe(keyFor(owner.id, file.id, session.versionId));
    // The whole new size is reserved: the old version keeps counting until it is purged.
    expect(await usedBytes(owner.id)).toBe(1100);

    expect((await putSingle(owner, session.id, new Uint8Array(1000))).status).toBe(200);
    const sent: unknown[] = [];
    const sha256 = sha();
    const answer = await complete(owner, session.id, { sha256 }, { sent });
    expect(answer.status).toBe(200);
    const dto = NodeDto.parse(answer.body);
    expect(dto).toMatchObject({
      id: file.id,
      name: "plan.txt",
      size: 1000,
      scanStatus: "pending",
      etag: session.versionId,
    });
    expect(dto.sharing).toMatchObject({ people: 1, link: "active" });

    expect(await nodeById(file.id)).toMatchObject({
      r2Key: session.r2Key,
      versionId: session.versionId,
      size: 1000,
      sha256,
      scanStatus: "pending",
      scanReason: null,
      createdBy: owner.id,
    });
    const versions = await versionsOf(file.id);
    expect(versions).toMatchObject([{ versionId: file.versionId, r2Key: file.r2Key, size: 100 }]);
    const days = (versions[0]!.purgeAfter.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
    // The old object stays until its purge; its thumbnails are gone, another version's are not.
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();
    for (const size of THUMB_SIZES)
      expect(await env.FILES.head(thumbKey(file.id, file.versionId!, size))).toBeNull();
    expect(await env.FILES.head(otherVersion)).not.toBeNull();
    expect(await testDb().select().from(shares).where(eq(shares.id, share.id))).toHaveLength(1);
    expect(await testDb().select().from(shareLinks).where(eq(shareLinks.id, link.id))).toMatchObject([
      { nodeId: file.id },
    ]);
    expect(await usedBytes(owner.id)).toBe(1100);
    expect(sent).toEqual([{ v: 1, nodeId: file.id, key: session.r2Key, force: false }]);
    expect(await auditFor("node.replace", file.id)).toHaveLength(1);
    expect(await auditFor("node.upload", file.id)).toHaveLength(0);
    expect(await nodesIn(folder.id)).toHaveLength(1);
  });

  it("the guard at init: every reason a file cannot be replaced is the same 409 — a hold is not told from a scan", async () => {
    const owner = await uploader();
    const held = await uploader({ legalHold: true });
    const cases: Record<string, { caller: UserRow; folderId: string; fileId: string }> = {};
    for (const [label, overrides] of [
      ["pending", { scanStatus: "pending" }],
      ["infected", { scanStatus: "infected" }],
      ["under_review", { scanStatus: "under_review" }],
      ["node on legal hold", { legalHold: true }],
      ["in the trash", { deletedAt: new Date(), trashedRoot: true }],
      ["an avatar", { system: "avatar" }],
    ] as const) {
      const { folder, file } = await target(owner, overrides);
      cases[label] = { caller: owner, folderId: folder.id, fileId: file.id };
    }
    const ofHeld = await target(held);
    cases["owner on legal hold"] = { caller: held, folderId: ofHeld.folder.id, fileId: ofHeld.file.id };
    const elsewhere = await target(owner);
    cases["in another folder"] = {
      caller: owner,
      folderId: (await makeFolder(owner.id)).id,
      fileId: elsewhere.file.id,
    };
    const aFolder = await makeFolder(owner.id);
    cases["a folder"] = {
      caller: owner,
      folderId: aFolder.id,
      fileId: (await makeFolder(owner.id, aFolder.id)).id,
    };

    const bodies = new Set<string>();
    for (const [label, { caller, folderId, fileId }] of Object.entries(cases)) {
      const answer = await call(caller, "POST", "/uploads", { json: replaceBody(folderId, fileId) });
      expect(answer.status, label).toBe(409);
      expect(answer.body, label).toMatchObject({ error: "conflict", message: REPLACE_REFUSED_MESSAGE });
      expect(answer.body.details, label).toBeUndefined();
      bodies.add(answer.bytes);
      expect(await sessionsOf(caller.id), label).toHaveLength(0);
    }
    expect(bodies.size).toBe(1);
    // Control: the three statuses that may be replaced are admitted.
    for (const scanStatus of ["clean", "skipped", "error"] as const) {
      const { folder, file } = await target(owner, { scanStatus });
      const answer = await call(owner, "POST", "/uploads", { json: replaceBody(folder.id, file.id) });
      expect(answer.status, scanStatus).toBe(201);
    }
  });

  it("a taken-down or locked target is 404 — byte for byte an unknown replaceNodeId", async () => {
    const owner = await uploader();
    const down = await target(owner, { takedownAt: new Date(), takedownReason: "admin" });
    const locked = await target(owner, { scanStatus: "suspected_csam", legalHold: true });
    const stranger = await target(await uploader());
    const folder = await makeFolder(owner.id);
    const unknown = await call(owner, "POST", "/uploads", { json: replaceBody(folder.id, uuidv7()) });
    expect(unknown.status).toBe(404);
    for (const [folderId, fileId] of [
      [down.folder.id, down.file.id],
      [locked.folder.id, locked.file.id],
      [folder.id, stranger.file.id],
    ]) {
      const answer = await call(owner, "POST", "/uploads", { json: replaceBody(folderId!, fileId!) });
      expect(answer.status).toBe(404);
      expect(answer.bytes).toBe(unknown.bytes);
    }
    expect(await sessionsOf(owner.id)).toHaveLength(0);
    expect(await usedBytes(owner.id)).toBe(0);
  });

  it("the guard at complete: the target changed after init → the same 409 (404 once hidden), reservation released, the file untouched", async () => {
    const changes: [string, Partial<typeof nodes.$inferInsert>, number][] = [
      ["infected", { scanStatus: "infected" }, 409],
      ["pending", { scanStatus: "pending" }, 409],
      ["under_review", { scanStatus: "under_review" }, 409],
      ["legal hold", { legalHold: true }, 409],
      ["trashed", { deletedAt: new Date(), trashedRoot: true }, 409],
      ["taken down", { takedownAt: new Date(), takedownReason: "admin" }, 404],
      ["locked", { scanStatus: "suspected_csam" }, 404],
    ];
    const bodies = new Set<string>();
    for (const [label, change, status] of changes) {
      const owner = await uploader({ usedBytes: 100 });
      const { folder, file } = await target(owner);
      const session = await uploaded(owner, {
        parentId: folder.id,
        name: "plan.txt",
        onConflict: "replace",
        replaceNodeId: file.id,
      });
      const key = (await sessionRow(session.uploadId))!.r2Key;
      await testDb().update(nodes).set(change).where(eq(nodes.id, file.id));
      const answer = await complete(owner, session.uploadId);
      expect(answer.status, label).toBe(status);
      if (status === 409) {
        expect(answer.body.message, label).toBe(REPLACE_REFUSED_MESSAGE);
        bodies.add(answer.bytes);
      }
      expect(await sessionRow(session.uploadId), label).toMatchObject({ status: "aborted" });
      expect(await usedBytes(owner.id), label).toBe(100);
      expect(await env.FILES.head(key), label).toBeNull();
      // The file is exactly what it was: nothing was laundered back to `pending`, nothing moved.
      expect(await nodeById(file.id), label).toMatchObject({
        r2Key: file.r2Key,
        versionId: file.versionId,
        ...change,
      });
      expect(await versionsOf(file.id), label).toHaveLength(0);
      expect(await env.FILES.head(file.r2Key!), label).not.toBeNull();
    }
    expect(bodies.size).toBe(1);
  });

  it("the owner's account was put on hold after init → the same 409", async () => {
    const owner = await uploader();
    const { folder, file } = await target(owner);
    const session = await uploaded(owner, {
      parentId: folder.id,
      name: "plan.txt",
      onConflict: "replace",
      replaceNodeId: file.id,
    });
    await testDb().update(userTable).set({ legalHold: true }).where(eq(userTable.id, owner.id));
    const answer = await complete(owner, session.uploadId);
    expect(answer.status).toBe(409);
    expect(answer.body.message).toBe(REPLACE_REFUSED_MESSAGE);
    expect(await versionsOf(file.id)).toHaveLength(0);
  });

  it("the transaction is run again after a deadlock: one node version, one complete() in the store, one audit row", async () => {
    const owner = await uploader({ usedBytes: 100 });
    const { folder, file } = await target(owner);
    const first = await init(owner, {
      parentId: folder.id,
      name: "plan.txt",
      size: TWO_PARTS,
      onConflict: "replace",
      replaceNodeId: file.id,
    });
    const parts = await putParts(owner, first, TWO_PARTS);
    const failures: TxFailure[] = [];
    const watched = watchedBucket();
    const sent: unknown[] = [];
    const answer = await complete(
      owner,
      first.uploadId,
      { parts },
      {
        failures,
        sent,
        env: { FILES: watched.bucket },
        // The first attempt runs to its end and is then thrown away as a deadlock victim.
        beforeCommit: (attempt) => {
          if (attempt === 1) throw deadlockError();
        },
      },
    );
    expect(answer.status).toBe(200);
    expect(failures).toEqual([{ code: "40P01" }]);
    expect(watched.calls["upload.complete"]).toBe(1);
    expect(await versionsOf(file.id)).toHaveLength(1);
    expect(await auditFor("node.replace", file.id)).toHaveLength(1);
    expect(sent).toHaveLength(1);
    expect(await usedBytes(owner.id)).toBe(100 + TWO_PARTS);
    expect(await ledgerOf("upload_user", owner.id)).toMatchObject([{ bytes: TWO_PARTS, count: 1 }]);
    expect(await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, file.id))).toHaveLength(1);
    expect((await sessionRow(first.uploadId))?.status).toBe("done");
    // A deadlock every time is given up on after four attempts, and nothing is half-written.
    const other = await target(owner);
    const second = await uploaded(owner, {
      parentId: other.folder.id,
      name: "plan.txt",
      onConflict: "replace",
      replaceNodeId: other.file.id,
    });
    const always: TxFailure[] = [];
    const lost = await complete(
      owner,
      second.uploadId,
      {},
      {
        failures: always,
        beforeCommit: () => {
          throw deadlockError();
        },
      },
    );
    expect(lost.status).toBe(500);
    expect(always).toHaveLength(4);
    expect(await versionsOf(other.file.id)).toHaveLength(0);
    expect(await auditFor("node.replace", other.file.id)).toHaveLength(0);
    expect(await nodeById(other.file.id)).toMatchObject({
      scanStatus: "clean",
      versionId: other.file.versionId,
    });
    // Left for the stale-upload job, with its object and its reservation.
    expect(await testDb().select().from(uploads).where(eq(uploads.id, second.uploadId))).toMatchObject([
      { status: "completing" },
    ]);
  }, 60_000);
});
