// The stale-upload job. TABLE-WIDE: it settles every stale session in the database, so this file
// runs alone; a session is made stale by backdating its own `expiresAt` / `completingAt`.
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { lockStaleUpload } from "../../../src/worker/db/queries/trash-jobs";
import { uploadParts, uploads } from "../../../src/worker/db/schema";
import { job as staleUploadsJob } from "../../../src/worker/jobs/stale-uploads";
import {
  countingBucket,
  cronEvent,
  jobContext,
  makeFile,
  makeUpload,
  makeVersion,
  member,
  multipartIsOpen,
  objectExists,
  partsOf,
  putObject,
  setUsedBytes,
  startMultipart,
  testDb,
  uploadRow,
  usedBytes,
  type JobContext,
} from "./helpers";

const HOUR = 3_600_000;
const ago = (ms: number) => new Date(Date.now() - ms);

async function run(ctx: JobContext = jobContext()) {
  const result = await staleUploadsJob.run(ctx.bg, env, cronEvent(staleUploadsJob.cron), {
    softDeadlineMs: 120_000,
  });
  return { ctx, result };
}

/** A session with a real multipart upload in the store and one part row. */
async function multipart(ownerId: string, overrides: Parameters<typeof makeUpload>[2] = {}) {
  const session = await makeUpload(ownerId, ownerId, overrides);
  const uploadId = await startMultipart(session.r2Key);
  await testDb().update(uploads).set({ r2UploadId: uploadId }).where(eq(uploads.id, session.id));
  await testDb().insert(uploadParts).values({ uploadId: session.id, partNumber: 1, etag: "e", size: 16 });
  return { ...session, r2UploadId: uploadId };
}

describe("the stale-upload job", () => {
  it("an open session past its expiry: aborted, its parts gone, the reservation given back", async () => {
    const owner = await member();
    const stale = await multipart(owner.id, { size: 1000, expiresAt: ago(HOUR) });
    const live = await multipart(owner.id, { size: 500 });
    // An avatar upload holds no reservation: aborting it gives nothing back.
    const avatar = await makeUpload(owner.id, owner.id, {
      purpose: "avatar",
      size: 70,
      expiresAt: ago(HOUR),
    });
    await setUsedBytes(owner.id, 1500);

    const { ctx, result } = await run();
    expect(result).toEqual({ done: true });
    expect(await uploadRow(stale.id)).toMatchObject({ status: "aborted" });
    expect((await uploadRow(stale.id))!.completedAt).toBeInstanceOf(Date);
    expect(await partsOf(stale.id)).toBe(0);
    expect(await multipartIsOpen(stale.r2Key, stale.r2UploadId)).toBe(false);
    expect(await uploadRow(avatar.id)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(owner.id)).toBe(500);
    // Control: a session that has not expired is not touched.
    expect(await uploadRow(live.id)).toMatchObject({ status: "open" });
    expect(await partsOf(live.id)).toBe(1);
    expect(await multipartIsOpen(live.r2Key, live.r2UploadId)).toBe(true);
    expect(ctx.outcomes("stale-uploads")).toContain("aborted");
    expect(ctx.outcomes("stale-uploads")).not.toContain("error");

    // Settled once: a second run gives nothing back twice.
    await run();
    expect(await usedBytes(owner.id)).toBe(500);
  });

  it("a single-PUT session: no multipart upload to abort, and its object is not deleted here", async () => {
    const owner = await member();
    const open = await makeUpload(owner.id, owner.id, { r2UploadId: null, size: 300, expiresAt: ago(HOUR) });
    const completing = await makeUpload(owner.id, owner.id, {
      r2UploadId: null,
      size: 200,
      status: "completing",
      completingAt: ago(2 * HOUR),
    });
    await putObject(open.r2Key, "what the single PUT stored");
    await putObject(completing.r2Key, "stored, never committed");
    await setUsedBytes(owner.id, 500);
    const { bucket, calls } = countingBucket();

    await run(jobContext({ env: { FILES: bucket } }));
    expect(await uploadRow(open.id)).toMatchObject({ status: "aborted" });
    expect(await uploadRow(completing.id)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(owner.id)).toBe(0);
    // Orphans now: the reconcile job's sweep removes them, under its own guards.
    expect(await objectExists(open.r2Key)).toBe(true);
    expect(await objectExists(completing.r2Key)).toBe(true);
    expect(calls.filter((call) => call === "resumeMultipartUpload")).toEqual([]);
    expect(calls.filter((call) => call === "delete")).toEqual([]);
  });

  it("a session stuck in completing: done when a node or a version has its object, aborted and cleaned when nothing has", async () => {
    const owner = await member();
    const stuck = { status: "completing" as const, completingAt: ago(2 * HOUR) };
    // Its commit happened: a node carries the key.
    const committed = await makeUpload(owner.id, owner.id, { ...stuck, size: 100 });
    const node = await makeFile(owner.id, null, {
      id: committed.nodeId,
      versionId: committed.versionId,
      r2Key: committed.r2Key,
    });
    await putObject(committed.r2Key, "committed");
    // A replace whose new version was since replaced again: a kept version carries the key.
    const file = await makeFile(owner.id, null);
    const version = await makeVersion(file);
    const replaced = await makeUpload(owner.id, owner.id, { ...stuck, size: 40, r2Key: version.r2Key });
    // Its commit never happened; the multipart upload was completed in the store.
    const lost = await multipart(owner.id, { ...stuck, size: 700 });
    await putObject(lost.r2Key, "completed in the store, referenced by nothing");
    // Still inside its hour.
    const recent = await multipart(owner.id, { status: "completing", completingAt: ago(HOUR / 2), size: 50 });
    await setUsedBytes(owner.id, 100 + 100 + 40 + 700 + 50);

    const { ctx } = await run();
    expect(await uploadRow(committed.id)).toMatchObject({ status: "done" });
    expect(await uploadRow(replaced.id)).toMatchObject({ status: "done" });
    expect(await objectExists(node.r2Key!)).toBe(true);
    expect(await uploadRow(lost.id)).toMatchObject({ status: "aborted" });
    expect(await partsOf(lost.id)).toBe(0);
    expect(await objectExists(lost.r2Key)).toBe(false);
    expect(await multipartIsOpen(lost.r2Key, lost.r2UploadId)).toBe(false);
    expect(await uploadRow(recent.id)).toMatchObject({ status: "completing" });
    expect(await multipartIsOpen(recent.r2Key, recent.r2UploadId)).toBe(true);
    // Only the lost session's reservation comes back: a committed upload's bytes are the node's.
    expect(await usedBytes(owner.id)).toBe(290);
    expect(ctx.outcomes("stale-uploads")).toEqual(expect.arrayContaining(["done", "aborted"]));
    expect(ctx.outcomes("stale-uploads")).not.toContain("error");
  });

  it("the row decides, not the list: a session a client claimed meanwhile is left alone", async () => {
    const owner = await member();
    const session = await makeUpload(owner.id, owner.id, { expiresAt: ago(HOUR) });
    const locked = (id: string) => testDb().transaction((tx) => lockStaleUpload(tx, id));
    expect((await locked(session.id))?.id).toBe(session.id);
    // What `claimCompleting` does between the job's list and its transaction.
    await testDb()
      .update(uploads)
      .set({ status: "completing", completingAt: new Date() })
      .where(eq(uploads.id, session.id));
    expect(await locked(session.id)).toBeNull();
    await testDb().update(uploads).set({ status: "done" }).where(eq(uploads.id, session.id));
    expect(await locked(session.id)).toBeNull();
    const fresh = await makeUpload(owner.id, owner.id, {});
    expect(await locked(fresh.id)).toBeNull();
  });
});
