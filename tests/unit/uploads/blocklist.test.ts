// The hash blocklist at complete. A hit on the hash the client DECLARES makes the server hash
// the stored bytes, and what happens is decided by that hash: blocked content is refused and its
// uploader struck once per content; suspected CSAM is never deleted but locked; and a false
// declaration strikes nobody and locks nothing.
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import type { SessionUser } from "../../../src/worker/auth/types";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { hashBlocklist, nodes, reports, shares, uploadIps } from "../../../src/worker/db/schema";
import { BLOCKED_MESSAGE, refuseBlocked, storedSha256 } from "../../../src/worker/routes/uploads";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { storage } from "../../../src/worker/services/storage";
import {
  ADMIN_EMAIL,
  auditRows,
  deliver,
  jobsFor,
  mailTo,
  makeFile,
  makeFolder,
  makeShare,
  nodeById,
  putObject,
  r2Event,
  testDb,
} from "../services-core/helpers";
import { invoke } from "../services-core/request";
import {
  auditFor,
  complete,
  init,
  ledgerOf,
  putParts,
  ROOMY,
  sessionRow,
  sha,
  sha256Of,
  strikesOf,
  TWO_PARTS,
  uniqueBytes,
  uploaded,
  uploader,
  usedBytes,
  userRow,
  type UserRow,
} from "./helpers";

type Reason = "malware" | "dmca" | "admin" | "csam";

/** Puts the hash of these bytes on the blocklist. */
async function listed(reason: Reason, bytes: Uint8Array = uniqueBytes()) {
  const sha256 = await sha256Of(bytes);
  await blocklist.upsert(testDb(), { sha256, reason });
  return { bytes, sha256 };
}

const nodesOf = (ownerId: string) => testDb().select().from(nodes).where(eq(nodes.ownerId, ownerId));
const reportsOn = (ownerId: string) => testDb().select().from(reports).where(eq(reports.ownerId, ownerId));
const operatorMails = () => mailTo(ADMIN_EMAIL).length;

describe("the server's own hash", () => {
  it("storedSha256 is the SHA-256 of the object, streamed", async () => {
    const bytes = uniqueBytes(70_000);
    const key = `b/t12-test/${crypto.randomUUID()}`;
    await putObject(key, bytes);
    expect(await storedSha256(storage(env), key)).toBe(await sha256Of(bytes));
    expect(await storedSha256(storage(env), `${key}-missing`)).toBeNull();
    await env.FILES.delete(key);
  });
});

describe("blocked content (malware, dmca, admin)", () => {
  it("the object is deleted, the reservation released, the session aborted, the UPLOADER struck — and the answer says only 'blocked'", async () => {
    for (const [reason, kind] of [
      ["malware", "malware"],
      ["dmca", "dmca"],
      ["admin", "abuse"],
    ] as const) {
      const owner = await uploader();
      const editor = await uploader();
      const folder = await makeFolder(owner.id);
      await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
      const { bytes, sha256 } = await listed(reason);
      const session = await uploaded(editor, { parentId: folder.id }, bytes);
      const row = (await sessionRow(session.uploadId))!;
      const sent: unknown[] = [];
      const answer = await complete(editor, session.uploadId, { sha256 }, { sent });
      expect(answer.status).toBe(403);
      expect(answer.body).toMatchObject({
        error: "forbidden",
        message: BLOCKED_MESSAGE,
        details: { reason: "blocked_content" },
      });
      expect(await env.FILES.head(row.r2Key)).toBeNull();
      expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
      expect(await usedBytes(owner.id)).toBe(0);
      expect(await nodesOf(owner.id)).toHaveLength(1); // the folder
      expect(sent).toEqual([]);
      // The strike is the uploader's, never the folder owner's, and names the content.
      expect(await strikesOf(editor.id)).toMatchObject([
        { kind, nodeId: row.nodeId, contentSha256: sha256, liftedAt: null },
      ]);
      expect(await strikesOf(owner.id)).toHaveLength(0);
      expect(await auditRows({ action: "strike.added", targetId: editor.id })).toHaveLength(1);
      expect(await auditFor("upload.blocked", session.uploadId)).toMatchObject([{ actorUserId: editor.id }]);
      expect(await ledgerOf("upload_user", owner.id)).toHaveLength(0);
      // Nobody is locked for blocked content, and nothing was added to the blocklist.
      expect(await userRow(editor.id)).toMatchObject({ legalHold: false, suspendedAt: null });
      expect((await blocklist.lookup(testDb(), sha256))?.reason).toBe(reason);
    }
  });

  it("the branch run twice for one session — the second time past the claim — is one strike, one strike audit row, one release", async () => {
    const user = await uploader();
    const kept = await init(user, { size: 300 });
    const { bytes, sha256 } = await listed("malware");
    const session = await uploaded(user, {}, bytes);
    const first = await complete(user, session.uploadId, { sha256 });
    expect(first.status).toBe(403);
    const row = (await sessionRow(session.uploadId))!;
    // A duplicated complete that got past the claim: the branch itself, called again.
    const second = await invoke({ user: user as unknown as SessionUser }, (c: Context<AppEnv>) =>
      refuseBlocked(c, row, "malware", sha256),
    );
    expect(second).toMatchObject({
      ok: false,
      status: 403,
      error: "forbidden",
      details: { reason: "blocked_content" },
    });
    expect(await strikesOf(user.id)).toHaveLength(1);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(1);
    expect(await auditFor("upload.blocked", session.uploadId)).toHaveLength(1);
    // The other session's reservation is still there: nothing was released twice.
    expect(await usedBytes(user.id)).toBe(300);
    expect((await sessionRow(kept.uploadId))?.status).toBe("open");
  });

  it("the same blocked file tried three times, in three sessions, is ONE strike and no suspension", async () => {
    const user = await uploader();
    const { bytes, sha256 } = await listed("malware");
    const nodeIds = new Set<string>();
    for (let attempt = 0; attempt < 3; attempt++) {
      const session = await uploaded(user, {}, bytes);
      nodeIds.add((await sessionRow(session.uploadId))!.nodeId);
      const answer = await complete(user, session.uploadId, { sha256 });
      expect(answer.status).toBe(403);
    }
    expect(nodeIds.size).toBe(3);
    expect(await strikesOf(user.id)).toMatchObject([{ kind: "malware", contentSha256: sha256 }]);
    expect(await auditRows({ action: "strike.added", targetId: user.id })).toHaveLength(1);
    expect((await userRow(user.id)).suspendedAt).toBeNull();
    expect(await usedBytes(user.id)).toBe(0);
  });

  it("three DIFFERENT blocked files are three strikes, and the account is suspended (the control of the test above)", async () => {
    const user = await uploader();
    for (let attempt = 0; attempt < 3; attempt++) {
      const { bytes, sha256 } = await listed("malware");
      const session = await uploaded(user, {}, bytes);
      expect((await complete(user, session.uploadId, { sha256 })).status).toBe(403);
    }
    expect(await strikesOf(user.id)).toHaveLength(3);
    expect((await userRow(user.id)).suspendedAt).not.toBeNull();
    expect((await userRow(user.id)).suspendedReason).toBe("strikes");
  });

  it("the strike's suspension step fails: still 403, the object gone, the session aborted, the strike kept", async () => {
    const user = await uploader();
    for (let earlier = 0; earlier < 2; earlier++) {
      const { bytes, sha256 } = await listed("malware");
      const session = await uploaded(user, {}, bytes);
      await complete(user, session.uploadId, { sha256 });
    }
    const { bytes, sha256 } = await listed("malware");
    const session = await uploaded(user, {}, bytes);
    const key = (await sessionRow(session.uploadId))!.r2Key;
    // The third strike suspends — in a transaction of its own, the second this request opens
    // (the first releases and aborts). It is made to fail.
    const answer = await complete(
      user,
      session.uploadId,
      { sha256 },
      {
        beforeCommit: (attempt) => {
          if (attempt === 2) throw new Error("test: the suspension fails");
        },
      },
    );
    expect(answer.status).toBe(403);
    expect(answer.body.details).toEqual({ reason: "blocked_content" });
    expect(await env.FILES.head(key)).toBeNull();
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(user.id)).toBe(0);
    expect(await strikesOf(user.id)).toHaveLength(3);
    // Not suspended by this request: the sweep completes it.
    expect((await userRow(user.id)).suspendedAt).toBeNull();
  });
});

describe("a false declaration: the hash a client sends locks nobody, strikes nobody — and learns nothing", () => {
  /** A response with everything that differs between any two uploads taken out. */
  function comparable(answer: { status: number; body: Record<string, unknown>; headers: Headers }) {
    const { id, parentId, etag, sha256, createdAt, updatedAt, ...rest } = answer.body;
    void [id, parentId, etag, sha256, createdAt, updatedAt];
    const headers = [...answer.headers.entries()].filter(([name]) => name !== "x-request-id").sort();
    return JSON.stringify({ status: answer.status, rest, headers });
  }

  it("an editor declares a CSAM-listed hash for innocent bytes in someone else's folder: an ordinary pending upload — no lock, no hold, no report, no alert, no strike", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    const other = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    await makeShare(other.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const known = await listed("csam");
    const session = await uploaded(editor, { parentId: folder.id, name: "same.bin" }, uniqueBytes());
    const key = (await sessionRow(session.uploadId))!.r2Key;
    const mailsBefore = operatorMails();

    const sent: unknown[] = [];
    const answer = await complete(editor, session.uploadId, { sha256: known.sha256 }, { sent });
    expect(answer.status).toBe(201);
    expect(answer.body.scanStatus).toBe("pending");
    const nodeId = String(answer.body.id);

    // THE ANSWER SAYS NOTHING: it is, field for field and header for header, what any other
    // wrong hash gets — one that is on no list at all.
    const control = await uploaded(editor, { parentId: other.id, name: "same.bin" }, uniqueBytes());
    const unlisted = await complete(editor, control.uploadId, { sha256: sha() });
    expect(comparable(answer)).toBe(comparable(unlisted));
    expect(JSON.stringify(answer.body)).not.toMatch(/block|listed|csam/i);

    // The same rows as any upload: a pending node with the DECLARED hash, a scan message.
    expect(await nodeById(nodeId)).toMatchObject({
      scanStatus: "pending",
      legalHold: false,
      sha256: known.sha256,
      ownerId: owner.id,
      createdBy: editor.id,
    });
    expect(sent).toEqual([{ v: 1, nodeId, key, force: false }]);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done" });
    expect(await userRow(owner.id)).toMatchObject({ legalHold: false });
    expect(await userRow(editor.id)).toMatchObject({ legalHold: false, suspendedAt: null });
    expect(await reportsOn(owner.id)).toHaveLength(0);
    expect(await strikesOf(editor.id)).toHaveLength(0);
    expect(operatorMails()).toBe(mailsBefore);
    expect(await auditRows({ action: "scan.suspected_csam", targetId: nodeId })).toHaveLength(0);
    // What happened is recorded on the server only — with what the declared value was listed as.
    expect(await auditFor("upload.hash_mismatch", session.uploadId)).toMatchObject([
      { actorUserId: editor.id, meta: { declaredListedAs: "csam", actualListedAs: null } },
    ]);
    expect(await auditFor("upload.hash_mismatch", control.uploadId)).toHaveLength(0);
    // The entry on the list is what it was.
    expect(await blocklist.lookup(testDb(), known.sha256)).toMatchObject({
      reason: "csam",
      sourceNodeId: null,
    });
  });

  it("the same with a malware-listed hash: no strike, nothing refused", async () => {
    const user = await uploader();
    const known = await listed("malware");
    const session = await uploaded(user, {}, uniqueBytes());
    const answer = await complete(user, session.uploadId, { sha256: known.sha256 });
    expect(answer.status).toBe(201);
    expect(await strikesOf(user.id)).toHaveLength(0);
    expect(await auditFor("upload.blocked", session.uploadId)).toHaveLength(0);
    expect(await auditFor("upload.hash_mismatch", session.uploadId)).toMatchObject([
      { meta: { declaredListedAs: "malware", actualListedAs: null } },
    ]);
    expect(await usedBytes(user.id)).toBe(1000);
  });

  it("a false declaration over bytes that ARE listed is the real hit, with the real hash", async () => {
    const user = await uploader();
    const declared = await listed("csam");
    const actual = await listed("malware");
    const session = await uploaded(user, {}, actual.bytes);
    const answer = await complete(user, session.uploadId, { sha256: declared.sha256 });
    expect(answer.status).toBe(403);
    expect(await strikesOf(user.id)).toMatchObject([{ kind: "malware", contentSha256: actual.sha256 }]);
    expect(await userRow(user.id)).toMatchObject({ legalHold: false });
    expect(await reportsOn(user.id)).toHaveLength(0);
    expect(await auditFor("upload.hash_mismatch", session.uploadId)).toMatchObject([
      { meta: { declaredListedAs: "csam", actualListedAs: "malware" } },
    ]);
  });

  it("NOT caught here: a clean hash declared for listed bytes completes — the scanner that hashes the bytes must catch it", async () => {
    const user = await uploader();
    const actual = await listed("malware");
    const session = await uploaded(user, {}, actual.bytes);
    const answer = await complete(user, session.uploadId, { sha256: sha() });
    expect(answer.status).toBe(201);
    expect(answer.body.scanStatus).toBe("pending");
    expect(await strikesOf(user.id)).toHaveLength(0);
  });
});

describe("suspected CSAM: never deleted, locked by the one shared handler", () => {
  async function hit(caller: UserRow, parentId: string | null, extra: Record<string, unknown> = {}) {
    const known = await listed("csam");
    const session = await uploaded(caller, { parentId, ...extra }, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    const sent: unknown[] = [];
    const answer = await complete(caller, session.uploadId, { sha256: known.sha256 }, { sent });
    return { known, session, row, sent, answer };
  }

  it("the object stays, the node is suspected_csam and held, the owner is held, a report is filed, the meter does not move — and the answer is the blocked one", async () => {
    const owner = await uploader();
    const mailsBefore = operatorMails();
    const { known, row, sent, answer } = await hit(owner, null);

    // Byte for byte what any other blocked content gets (shown with another user's malware).
    const someone = await uploader();
    const malware = await listed("malware");
    const other = await uploaded(someone, {}, malware.bytes);
    const refused = await complete(someone, other.uploadId, { sha256: malware.sha256 });
    expect(answer.status).toBe(403);
    expect(answer.bytes).toBe(refused.bytes);

    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await storedSha256(storage(env), row.r2Key)).toBe(known.sha256);
    expect(await nodeById(row.nodeId)).toMatchObject({
      scanStatus: "suspected_csam",
      legalHold: true,
      ownerId: owner.id,
      createdBy: owner.id,
      r2Key: row.r2Key,
      sha256: known.sha256,
    });
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true, suspendedAt: null });
    expect(await sessionRow(row.id)).toMatchObject({ status: "done" });
    // The reservation is kept: the bytes go on counting, so the meter reveals nothing.
    expect(await usedBytes(owner.id)).toBe(1000);
    expect(await reportsOn(owner.id)).toMatchObject([
      { nodeId: row.nodeId, category: "csam", source: "system", status: "open" },
    ]);
    expect(await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, row.nodeId))).toMatchObject([
      { legalHold: true, uploaderId: owner.id },
    ]);
    // No strike, no explicit scan message, and this route wrote no blocklist row.
    expect(await strikesOf(owner.id)).toHaveLength(0);
    expect(sent).toEqual([]);
    expect(
      await testDb().select().from(hashBlocklist).where(eq(hashBlocklist.sha256, known.sha256)),
    ).toMatchObject([{ reason: "csam", sourceNodeId: null }]);
    // The lock's record and the alert ran through the request's own deferred work.
    expect(await auditRows({ action: "scan.suspected_csam", targetId: row.nodeId })).toMatchObject([
      { meta: expect.objectContaining({ source: "system" }) },
    ]);
    expect(await auditRows({ action: "scan.csam_alert_sent", targetId: row.nodeId })).toHaveLength(1);
    expect(operatorMails()).toBe(mailsBefore + 1);
    expect(await auditFor("upload.blocked", row.id)).toHaveLength(0);
  });

  it("an editor's upload into another user's folder: the editor's account is held too", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const { row, answer } = await hit(editor, folder.id);
    expect(answer.status).toBe(403);
    expect(await nodeById(row.nodeId)).toMatchObject({
      scanStatus: "suspected_csam",
      ownerId: owner.id,
      createdBy: editor.id,
    });
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true });
    expect(await userRow(editor.id)).toMatchObject({ legalHold: true });
    expect(await usedBytes(owner.id)).toBe(1000);
    expect(await strikesOf(editor.id)).toHaveLength(0);
  });

  it("the store's own event for the key arrives anyway: the consumer leaves the node suspected_csam", async () => {
    const owner = await uploader();
    const { row } = await hit(owner, null);
    for (const body of [
      r2Event(row.r2Key, "PutObject", 1000),
      { v: 1, nodeId: row.nodeId, key: row.r2Key, force: true },
    ]) {
      expect(await deliver([{ body }])).toEqual([{ outcome: "ack" }]);
      expect(await nodeById(row.nodeId)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    }
    expect((await jobsFor(row.r2Key)).length).toBeLessThanOrEqual(1);
  });

  it("on a replace the existing file is left untouched: the held object becomes a row of its own", async () => {
    const owner = await uploader({ usedBytes: 100 });
    const folder = await makeFolder(owner.id);
    const file = await makeFile(owner.id, folder.id, { name: "plan.txt", scanStatus: "clean" });
    await putObject(file.r2Key!, "the old version");
    const { row, answer } = await hit(owner, folder.id, {
      name: "plan.txt",
      onConflict: "replace",
      replaceNodeId: file.id,
    });
    expect(answer.status).toBe(403);
    expect(await nodeById(file.id)).toMatchObject({
      scanStatus: "clean",
      legalHold: false,
      r2Key: file.r2Key,
      versionId: file.versionId,
    });
    const [held] = await testDb()
      .select()
      .from(nodes)
      .where(and(eq(nodes.parentId, folder.id), eq(nodes.r2Key, row.r2Key)));
    expect(held).toMatchObject({ scanStatus: "suspected_csam", legalHold: true, name: "plan (1).txt" });
    expect(held!.id).not.toBe(file.id);
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await env.FILES.head(file.r2Key!)).not.toBeNull();
    expect(await usedBytes(owner.id)).toBe(1100);
  });

  /** An editor's finished upload into an owner's folder — about to fail complete's re-check. */
  async function beforeComplete(bytes: Uint8Array, size?: number) {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    const share = await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const session =
      size === undefined
        ? await uploaded(editor, { parentId: folder.id, name: "held.bin" }, bytes)
        : await init(editor, { parentId: folder.id, size });
    const row = (await sessionRow(session.uploadId))!;
    const revoke = () => testDb().delete(shares).where(eq(shares.id, share.id));
    return { owner, editor, folder, session, row, revoke };
  }

  it.each([
    ["the share was revoked", 404],
    ["the folder was trashed", 404],
    ["uploads were switched off", 503],
  ] as const)(
    "bytes the server found on the list are evidence even when complete gives the upload up (%s): a locked node of the UPLOADER's, the folder's owner untouched",
    async (what, status) => {
      const known = await listed("csam");
      const { owner, editor, folder, session, row, revoke } = await beforeComplete(known.bytes);
      const mailsBefore = operatorMails();
      let settings = {};
      if (what === "the share was revoked") await revoke();
      if (what === "the folder was trashed") {
        await testDb()
          .update(nodes)
          .set({ deletedAt: new Date(), trashedRoot: true })
          .where(eq(nodes.id, folder.id));
      }
      if (what === "uploads were switched off") settings = { settings: { ...ROOMY, uploadsEnabled: false } };

      const answer = await complete(editor, session.uploadId, { sha256: known.sha256 }, settings);
      // The request is answered as the failed re-check is; nothing about the lock.
      expect(answer.status).toBe(status);
      expect(JSON.stringify(answer.body)).not.toMatch(/block|csam|held/i);

      // The object is there, and it has a row: a node of the uploader's own, at their top level.
      expect(await env.FILES.head(row.r2Key)).not.toBeNull();
      const [held] = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
      expect(held).toMatchObject({
        ownerId: editor.id,
        createdBy: editor.id,
        parentId: null,
        name: "held.bin",
        scanStatus: "suspected_csam",
        legalHold: true,
        sha256: known.sha256,
        size: 1000,
      });
      expect(await userRow(editor.id)).toMatchObject({ legalHold: true });
      expect(await reportsOn(editor.id)).toMatchObject([
        { nodeId: held!.id, category: "csam", status: "open" },
      ]);
      expect(await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, held!.id))).toMatchObject([
        { legalHold: true, uploaderId: editor.id },
      ]);
      expect(operatorMails()).toBe(mailsBefore + 1);
      expect(await auditRows({ action: "scan.suspected_csam", targetId: held!.id })).toHaveLength(1);
      // The folder's owner: not held, nothing of theirs written, their reservation back.
      expect(await userRow(owner.id)).toMatchObject({ legalHold: false });
      expect(await reportsOn(owner.id)).toHaveLength(0);
      expect(await nodesOf(owner.id)).toHaveLength(1); // the folder
      expect(await usedBytes(owner.id)).toBe(0);
      expect(await usedBytes(editor.id)).toBe(0);
      expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
      expect(await strikesOf(editor.id)).toHaveLength(0);
    },
  );

  it("… but a DECLARED hash alone keeps nothing: innocent bytes under a listed hash are deleted like any abandoned upload (no storage outside the quota, nobody locked)", async () => {
    const known = await listed("csam");
    const { owner, editor, session, row, revoke } = await beforeComplete(uniqueBytes());
    await revoke();
    const answer = await complete(editor, session.uploadId, { sha256: known.sha256 });
    expect(answer.status).toBe(404);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(owner.id)).toBe(0);
    expect(await env.FILES.head(row.r2Key)).toBeNull();
    expect(await nodesOf(editor.id)).toHaveLength(0);
    expect(await userRow(editor.id)).toMatchObject({ legalHold: false });
  });

  it("… and an unfinished multipart upload has no object to keep: it is aborted in the store", async () => {
    const known = await listed("csam");
    const { owner, editor, session, row, revoke } = await beforeComplete(new Uint8Array(0), TWO_PARTS);
    const parts = await putParts(editor, session, TWO_PARTS);
    await revoke();
    const answer = await complete(editor, session.uploadId, { sha256: known.sha256, parts });
    expect(answer.status).toBe(404);
    expect(await usedBytes(owner.id)).toBe(0);
    expect(await env.FILES.head(row.r2Key)).toBeNull();
    const store = storage(env);
    await expect(
      store.uploadPart(store.resumeMultipart(row.r2Key, row.r2UploadId!), 1, new Uint8Array(8), 8),
    ).rejects.toThrow();
    expect(await nodesOf(editor.id)).toHaveLength(0);
  });

  it("if the node cannot be written the object still stays, and the operators are told by its session", async () => {
    const known = await listed("csam");
    const { editor, session, row, revoke } = await beforeComplete(known.bytes);
    await revoke();
    const mailsBefore = operatorMails();
    // The first transaction this request opens is the one that would write the node.
    const answer = await complete(
      editor,
      session.uploadId,
      { sha256: known.sha256 },
      {
        beforeCommit: (attempt) => {
          if (attempt === 1) throw new Error("test: the node cannot be written");
        },
      },
    );
    expect(answer.status).toBe(404);
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await nodesOf(editor.id)).toHaveLength(0);
    expect(await auditFor("upload.csam_object_kept", session.uploadId)).toHaveLength(1);
    expect(operatorMails()).toBe(mailsBefore + 1);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
  });
});
