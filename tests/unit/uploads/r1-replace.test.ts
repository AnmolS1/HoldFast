// R1 func-7: a second replace of a file while one is still being uploaded is refused at init
// (`409 replace_in_progress`), before a large file is sent for nothing.
// R1D rds-1 (Addendum 12): an OPEN replace session that nobody finishes no longer holds the file
// for a day. The file's owner, or that session's own uploader, starting a new version supersedes
// it — the session aborted, its reservation released, its multipart aborted. Refused (409) are
// an editor blocked by someone else's session, and anyone while a replace is completing. The
// check runs under the FILE's row lock, so two uploaders starting at once are one after the other.
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { uploads, user as userTable } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeShare, testDb } from "../services-core/helpers";
import {
  call,
  complete,
  init,
  initBody,
  sessionRow,
  TWO_PARTS,
  uploader,
  usedBytes,
  watchedBucket,
  type UserRow,
} from "./helpers";

const post = (caller: Parameters<typeof call>[0], json: unknown, env?: Record<string, unknown>) =>
  call(caller, "POST", "/uploads", { json, ...(env ? { env } : {}) });
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe("func-7: one replace of a file at a time", () => {
  async function target() {
    const user = await uploader();
    const file = await makeFile(user.id, null, { name: "plan.txt", scanStatus: "clean" });
    const body = (size: number) =>
      initBody({ name: "plan.txt", replaceNodeId: file.id, onConflict: "replace", size });
    return { user, file, body };
  }

  it("a second replace by the same uploader while the first is open supersedes it: 201, the first aborted (multipart too), its reservation back", async () => {
    const { user, body } = await target();
    const first = await init(user, body(TWO_PARTS));
    expect(await usedBytes(user.id)).toBe(TWO_PARTS);
    const watched = watchedBucket();
    const second = await post(user, body(20), { FILES: watched.bucket });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(await sessionRow(first.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(user.id)).toBe(20);
    expect(watched.calls["upload.abort"]).toBe(1);
    const sessions = await testDb().select().from(uploads).where(eq(uploads.uploaderId, user.id));
    expect(sessions.filter((row) => row.status === "open").map((row) => row.id)).toEqual([
      second.body.uploadId,
    ]);
  });

  it("…and while the first is completing", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    await testDb()
      .update(uploads)
      .set({ status: "completing", completingAt: new Date() })
      .where(eq(uploads.id, first.uploadId));
    expect((await post(user, body(20))).status).toBe(409);
  });

  it("CONTROL: the same local file again is the resume (200, the same session); an ended first replace frees the file", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    const again = await post(user, body(10));
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ uploadId: first.uploadId });
    await testDb().update(uploads).set({ status: "aborted" }).where(eq(uploads.id, first.uploadId));
    expect((await post(user, body(20))).status).toBe(201);
    expect(await sessionRow(first.uploadId)).toMatchObject({ status: "aborted" });
  });

  it("CONTROL: an expired first replace does not block the file", async () => {
    const { user, body } = await target();
    const first = await init(user, body(10));
    await testDb()
      .update(uploads)
      .set({ expiresAt: minutesAgo(1) })
      .where(eq(uploads.id, first.uploadId));
    expect((await post(user, body(20))).status).toBe(201);
  });
});

describe("rds-1: whose session may be superseded", () => {
  /** A file in a folder the owner shares with two editors. */
  async function shared() {
    const owner = await uploader();
    const editor = await uploader();
    const other = await uploader();
    const folder = await makeFolder(owner.id);
    for (const who of [editor, other]) {
      await makeShare(folder.id, owner.id, who.id, { role: "editor", canUpload: true });
    }
    const file = await makeFile(owner.id, folder.id, { name: "plan.txt", scanStatus: "clean" });
    const body = (size: number) =>
      initBody({
        parentId: folder.id,
        name: "plan.txt",
        replaceNodeId: file.id,
        onConflict: "replace",
        size,
      });
    return { owner, editor, other, file, body };
  }
  const unfinished = (nodeId: string) =>
    testDb()
      .select()
      .from(uploads)
      .where(and(eq(uploads.replaceNodeId, nodeId), inArray(uploads.status, ["open", "completing"])));

  it("the owner supersedes an editor's open replace; the editor's next part and complete get a clean 409, not a hang", async () => {
    const { owner, editor, file, body } = await shared();
    const left = await init(editor, body(TWO_PARTS));
    expect(await usedBytes(owner.id)).toBe(TWO_PARTS);
    const watched = watchedBucket();
    const mine = await post(owner, body(30), { FILES: watched.bucket });
    expect(mine.status, JSON.stringify(mine.body)).toBe(201);
    expect(await sessionRow(left.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(owner.id)).toBe(30);
    expect(watched.calls["upload.abort"]).toBe(1);
    expect((await unfinished(file.id)).map((row) => row.uploaderId)).toEqual([owner.id]);

    // The editor's client: a part is refused at once (the client's "session gone" path), and so
    // is complete — no wait, no retry.
    const part = await call(editor, "PUT", `/uploads/${left.uploadId}/parts/1`, {
      body: new Uint8Array(16),
      contentLength: 16,
    });
    expect(part.status).toBe(409);
    expect(part.body).toMatchObject({ error: "conflict" });
    const done = await complete(editor, left.uploadId, { parts: [{ n: 1, etag: "x" }] });
    expect(done.status).toBe(409);
  });

  it("…but not a session whose uploader is on LEGAL HOLD: what a hold protects is not destroyed by someone else (409, nothing aborted)", async () => {
    const { owner, editor, file, body } = await shared();
    const left = await init(editor, body(TWO_PARTS));
    await testDb().update(userTable).set({ legalHold: true }).where(eq(userTable.id, editor.id));
    const watched = watchedBucket();
    const refused = await post(owner, body(30), { FILES: watched.bucket });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "replace_in_progress" });
    expect(await sessionRow(left.uploadId)).toMatchObject({ status: "open" });
    expect(watched.calls["upload.abort"] ?? 0).toBe(0);
    expect((await unfinished(file.id)).map((row) => row.id)).toEqual([left.uploadId]);
    await testDb().update(userTable).set({ legalHold: false }).where(eq(userTable.id, editor.id));
  });

  it("an editor blocked by the OWNER's open replace: 409 replace_in_progress, the owner's session untouched", async () => {
    const { owner, editor, file, body } = await shared();
    const owners = await init(owner, body(10));
    const refused = await post(editor, body(20));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "replace_in_progress" });
    expect(await sessionRow(owners.uploadId)).toMatchObject({ status: "open" });
    expect((await unfinished(file.id)).map((row) => row.id)).toEqual([owners.uploadId]);
  });

  it("an editor blocked by ANOTHER editor's open replace: 409, nothing aborted", async () => {
    const { editor, other, file, body } = await shared();
    const theirs = await init(other, body(10));
    const refused = await post(editor, body(20));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "replace_in_progress" });
    expect((await unfinished(file.id)).map((row) => row.id)).toEqual([theirs.uploadId]);
  });

  it("a COMPLETING replace is never superseded — not by the owner either", async () => {
    const { owner, editor, file, body } = await shared();
    const theirs = await init(editor, body(10));
    await testDb()
      .update(uploads)
      .set({ status: "completing", completingAt: new Date() })
      .where(eq(uploads.id, theirs.uploadId));
    const refused = await post(owner, body(20));
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: "replace_in_progress" });
    expect(await sessionRow(theirs.uploadId)).toMatchObject({ status: "completing" });
    expect(await unfinished(file.id)).toHaveLength(1);
  });

  it("two editors starting a replace of one file at the same moment: one 201, one 409 — one session", async () => {
    for (let round = 0; round < 6; round++) {
      const { editor, other, file, body } = await shared();
      const callers: UserRow[] = round % 2 ? [editor, other] : [other, editor];
      const answers = await Promise.all(callers.map((who, i) => post(who, body(10 + i))));
      expect(answers.map((answer) => answer.status).sort()).toEqual([201, 409]);
      expect(answers.find((answer) => answer.status === 409)!.body).toMatchObject({
        error: "replace_in_progress",
      });
      expect(await unfinished(file.id)).toHaveLength(1);
    }
  });

  it("the owner and an editor at the same moment, in either order: the owner is admitted and the one session left is the owner's", async () => {
    for (let round = 0; round < 6; round++) {
      const { owner, editor, file, body } = await shared();
      const jobs = [() => post(owner, body(10)), () => post(editor, body(20))];
      if (round % 2) jobs.reverse();
      const answers = await Promise.all(jobs.map((job) => job()));
      const left = await unfinished(file.id);
      expect(left).toHaveLength(1);
      const ownerAnswer = answers[round % 2 ? 1 : 0]!;
      // The owner is never refused by an editor's OPEN session; the one left is the owner's
      // whenever the owner was admitted.
      expect(ownerAnswer.status).toBe(201);
      expect(left[0]!.uploaderId).toBe(owner.id);
    }
  });
});
