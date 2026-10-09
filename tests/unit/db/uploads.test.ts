import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  claimCompleting,
  COMPLETING_STALE_MINUTES,
  countOpen,
  expired,
  findResumable,
  markAborted,
  markDone,
  openBytes,
  trimFinished,
} from "../../../src/worker/db/queries/uploads";
import { uploadParts, uploads } from "../../../src/worker/db/schema";
import { makeFile, makeFolder, makeUpload, makeUser, openDb, rand } from "./_helpers";

let db: Db;
let close: () => Promise<void>;
beforeAll(() => {
  ({ db, close } = openDb());
});
afterAll(() => close());

const row = async (id: string) => (await db.select().from(uploads).where(eq(uploads.id, id)))[0]!;

describe("findResumable", () => {
  it("matches on all seven fields, and only an open, unexpired session", async () => {
    const owner = await makeUser(db);
    const parent = await makeFolder(db, owner, null, `up-${rand()}`);
    const target = await makeFile(db, owner, parent.id, "existing.bin");
    const modified = new Date("2026-05-06T07:08:09.000Z");
    const session = await makeUpload(db, owner, owner, {
      parentId: parent.id,
      name: "Movie.MP4",
      nameKey: "movie.mp4",
      size: 123_456,
      fileLastModified: modified,
      purpose: "file",
    });
    const match = {
      uploaderId: owner,
      parentId: parent.id,
      nameKey: "movie.mp4",
      size: 123_456,
      fileLastModified: modified,
      purpose: "file",
      replaceNodeId: null,
    } as const;
    expect((await findResumable(db, match))!.id).toBe(session.id);

    const other = await makeUser(db);
    expect(await findResumable(db, { ...match, uploaderId: other })).toBeNull();
    expect(await findResumable(db, { ...match, parentId: null })).toBeNull();
    expect(await findResumable(db, { ...match, nameKey: "movie2.mp4" })).toBeNull();
    expect(await findResumable(db, { ...match, size: 123_457 })).toBeNull();
    expect(
      await findResumable(db, { ...match, fileLastModified: new Date(modified.getTime() + 1000) }),
    ).toBeNull();
    expect(await findResumable(db, { ...match, fileLastModified: null })).toBeNull();
    // It distinguishes purpose and replaceNodeId.
    expect(await findResumable(db, { ...match, purpose: "avatar" })).toBeNull();
    expect(await findResumable(db, { ...match, replaceNodeId: target.id })).toBeNull();

    const replace = await makeUpload(db, owner, owner, {
      ...match,
      name: "Movie.MP4",
      replaceNodeId: target.id,
      nodeId: target.id,
    });
    expect((await findResumable(db, { ...match, replaceNodeId: target.id }))!.id).toBe(replace.id);
    expect((await findResumable(db, match))!.id).toBe(session.id);

    await db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.id, session.id));
    expect(await findResumable(db, match)).toBeNull();
    await db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() + 60_000), status: "completing" })
      .where(eq(uploads.id, session.id));
    expect(await findResumable(db, match)).toBeNull();
  });

  it("matches null parent and null modification time only with null", async () => {
    const owner = await makeUser(db);
    const session = await makeUpload(db, owner, owner, { name: "root.bin", nameKey: "root.bin", size: 9 });
    const match = {
      uploaderId: owner,
      parentId: null,
      nameKey: "root.bin",
      size: 9,
      fileLastModified: null,
      purpose: "file",
      replaceNodeId: null,
    } as const;
    expect((await findResumable(db, match))!.id).toBe(session.id);
    expect(await findResumable(db, { ...match, parentId: uuidv7() })).toBeNull();
    expect(await findResumable(db, { ...match, fileLastModified: new Date() })).toBeNull();
  });
});

describe("countOpen and openBytes", () => {
  it("count unfinished sessions; openBytes separates the owner's storage from an editor's uploads elsewhere", async () => {
    const owner = await makeUser(db);
    const editor = await makeUser(db);
    await makeUpload(db, owner, owner, { size: 100, status: "open" });
    await makeUpload(db, owner, owner, { size: 200, status: "completing" });
    await makeUpload(db, owner, editor, { size: 400, status: "open" });
    await makeUpload(db, owner, editor, { size: 800, status: "completing" });
    await makeUpload(db, owner, owner, { size: 1600, status: "done" });
    await makeUpload(db, owner, editor, { size: 3200, status: "aborted" });
    await makeUpload(db, owner, owner, { size: 6400, status: "open", purpose: "avatar" });
    await makeUpload(db, editor, editor, { size: 12_800, status: "open" });

    expect(await countOpen(db, owner)).toBe(3);
    expect(await countOpen(db, editor)).toBe(3);
    expect(await openBytes(db, { ownerId: owner })).toEqual({ bytes: 1500, count: 4 });
    expect(await openBytes(db, { editorId: editor })).toEqual({ bytes: 1200, count: 2 });
    expect(await openBytes(db, { ownerId: editor })).toEqual({ bytes: 12_800, count: 1 });
    expect(await openBytes(db, { editorId: owner })).toEqual({ bytes: 0, count: 0 });
    const nobody = await openBytes(db, { ownerId: await makeUser(db) });
    expect(nobody).toEqual({ bytes: 0, count: 0 });
    expect(typeof nobody.bytes).toBe("number");
    expect(typeof (await countOpen(db, owner))).toBe("number");
  });
});

describe("status changes", () => {
  it("claimCompleting is atomic and refuses anyone but the uploader", async () => {
    const owner = await makeUser(db);
    const editor = await makeUser(db);
    const session = await makeUpload(db, owner, editor);
    expect(await claimCompleting(db, session.id, owner)).toBeNull();
    expect((await row(session.id)).status).toBe("open");

    const results = await Promise.all(
      Array.from({ length: 10 }, () => claimCompleting(db, session.id, editor)),
    );
    const claimed = results.filter((r) => r !== null);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({
      id: session.id,
      status: "completing",
      uploaderId: editor,
      r2Key: session.r2Key,
    });
    expect((await row(session.id)).completingAt).toBeInstanceOf(Date);
    expect(await claimCompleting(db, session.id, editor)).toBeNull();
    expect(await claimCompleting(db, uuidv7(), editor)).toBeNull();
    expect(await claimCompleting(db, "junk", editor)).toBeNull();
  });

  it("markDone and markAborted are terminal; markAborted removes the part rows", async () => {
    const owner = await makeUser(db);
    const finished = await makeUpload(db, owner, owner, { status: "completing" });
    expect(await markDone(db, finished.id)).toBe(true);
    expect(await row(finished.id)).toMatchObject({ status: "done" });
    expect((await row(finished.id)).completedAt).toBeInstanceOf(Date);
    expect(await markDone(db, finished.id)).toBe(false);
    expect(await markAborted(db, finished.id)).toBe(false);
    expect((await row(finished.id)).status).toBe("done");

    const abandoned = await makeUpload(db, owner, owner, { status: "open", r2UploadId: "mpu" });
    await db.insert(uploadParts).values([
      { uploadId: abandoned.id, partNumber: 1, etag: "a", size: 10 },
      { uploadId: abandoned.id, partNumber: 2, etag: "b", size: 10 },
    ]);
    const untouched = await makeUpload(db, owner, owner, { status: "open" });
    await db.insert(uploadParts).values({ uploadId: untouched.id, partNumber: 1, etag: "c", size: 10 });

    await db.transaction(async (tx) => {
      expect(await markAborted(tx, abandoned.id)).toBe(true);
    });
    expect((await row(abandoned.id)).status).toBe("aborted");
    expect(await db.select().from(uploadParts).where(eq(uploadParts.uploadId, abandoned.id))).toHaveLength(0);
    expect(await db.select().from(uploadParts).where(eq(uploadParts.uploadId, untouched.id))).toHaveLength(1);
    expect(await markAborted(db, abandoned.id)).toBe(false);
    expect(await markDone(db, abandoned.id)).toBe(false);
    expect(await markDone(db, uuidv7())).toBe(false);
  });
});

describe("expired and trimFinished", () => {
  it("expired: open past expiresAt, and completing for more than an hour", async () => {
    const owner = await makeUser(db);
    const past = new Date(Date.now() - 1000);
    const future = new Date(Date.now() + 3_600_000);
    const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000);
    const staleOpen = await makeUpload(db, owner, owner, { status: "open", expiresAt: past });
    const liveOpen = await makeUpload(db, owner, owner, { status: "open", expiresAt: future });
    const stuck = await makeUpload(db, owner, owner, {
      status: "completing",
      expiresAt: future,
      completingAt: minutesAgo(COMPLETING_STALE_MINUTES + 1),
    });
    const busy = await makeUpload(db, owner, owner, {
      status: "completing",
      expiresAt: past,
      completingAt: minutesAgo(COMPLETING_STALE_MINUTES - 1),
    });
    const done = await makeUpload(db, owner, owner, { status: "done", expiresAt: past });

    const ids = (await expired(db, 100_000))
      .filter((u) => u.ownerId === owner)
      .map((u) => u.id)
      .sort();
    expect(ids).toEqual([staleOpen.id, stuck.id].sort());
    expect(ids).not.toContain(liveOpen.id);
    expect(ids).not.toContain(busy.id);
    expect(ids).not.toContain(done.id);
    const one = await expired(db, 1);
    expect(one).toHaveLength(1);
    expect(one[0]).toHaveProperty("r2Key");
  });

  it("trimFinished deletes done and aborted sessions older than the limit, and nothing unfinished", async () => {
    const owner = await makeUser(db);
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
    const oldDone = await makeUpload(db, owner, owner, { status: "done", completedAt: daysAgo(8) });
    const oldAborted = await makeUpload(db, owner, owner, { status: "aborted", completedAt: daysAgo(30) });
    const recentDone = await makeUpload(db, owner, owner, { status: "done", completedAt: daysAgo(6) });
    const oldOpen = await makeUpload(db, owner, owner, { status: "open", createdAt: daysAgo(30) });
    const ids = [oldDone.id, oldAborted.id, recentDone.id, oldOpen.id];

    expect(await trimFinished(db)).toBeGreaterThanOrEqual(2);
    const left = await db.select({ id: uploads.id }).from(uploads).where(inArray(uploads.id, ids));
    expect(left.map((u) => u.id).sort()).toEqual([recentDone.id, oldOpen.id].sort());
    expect(await trimFinished(db, 5)).toBeGreaterThanOrEqual(1);
    expect(
      (await db.select({ id: uploads.id }).from(uploads).where(inArray(uploads.id, ids))).map((u) => u.id),
    ).toEqual([oldOpen.id]);

    const batch = [];
    for (let i = 0; i < 3; i++)
      batch.push((await makeUpload(db, owner, owner, { status: "done", completedAt: daysAgo(9) })).id);
    expect(await trimFinished(db, 7, 2)).toBe(2);
    expect(await db.select().from(uploads).where(inArray(uploads.id, batch))).toHaveLength(1);
  });
});
