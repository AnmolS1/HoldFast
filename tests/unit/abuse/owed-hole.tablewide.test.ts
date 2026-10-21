// Addendum 2 (T22): a client that DECLARES a hash listed for another reason (malware) over bytes
// that hash to CSAM — the server finds the evidence, the node cannot be written, the node is owed —
// must never be taken by the stale-upload job, which runs BEFORE abuse-hourly in the same slot.
//   (b) the fix: `oweNode` writes THE SERVER's csam hash on the session (the declaration goes into
//       the owed audit row), so `owesLockedNode()` matches;
//   (a) the backstop: `owesLockedNode()` also matches a session with an `upload.csam_node_owed`
//       row — a session owed before (b), or whose hash write failed.
// TABLE-WIDE (the stale job and the sweep read whole tables): this file runs alone. The job runs
// happen in one transaction that is rolled back; the route's own requests are committed.
import { env } from "cloudflare:workers";
import { and, eq, inArray } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import { CSAM_NODE_OWED_ACTION } from "../../../src/worker/db/queries/abuse";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { auditLog, nodes, uploads, user as userTable } from "../../../src/worker/db/schema";
import { sweepOwedNodes } from "../../../src/worker/jobs/abuse-hourly";
import { job as staleJob } from "../../../src/worker/jobs/stale-uploads";
import { nameKeyOf } from "../../../src/worker/services/filename";
import { keyFor } from "../../../src/worker/services/storage";
import { cronEvent, jobContext, member, rand, testDb } from "../trash/helpers";
import { complete, sessionRow, sha256Of, uniqueBytes, uploaded, uploader } from "../uploads/helpers";

const ROLLBACK = Symbol("rollback");
const LONG_AGO = new Date(Date.UTC(1971, 0, 1));

async function rolledBack(body: (db: Db) => Promise<void>): Promise<void> {
  await testDb()
    .transaction(async (tx) => {
      await body(tx as unknown as Db);
      throw ROLLBACK;
    })
    .catch((error: unknown) => {
      if (error !== ROLLBACK) throw error;
    });
}

/** The stale job, then the sweep at limit one (the session is dated first), on `db`. */
async function staleThenSweep(db: Db) {
  const stale = jobContext({ db });
  await staleJob.run(stale.bg, env, cronEvent(staleJob.cron), {
    softDeadlineMs: 120_000,
    detection: { state: "ok", database: 0, raw: "0" },
  });
  await stale.settle();
  const afterStale = async (id: string) => (await db.select().from(uploads).where(eq(uploads.id, id)))[0]!;
  return {
    afterStale,
    async sweep() {
      const ctx = jobContext({ db });
      const result = await sweepOwedNodes(ctx.bg, { limit: 1 });
      await ctx.settle();
      return result;
    },
  };
}

const exists = async (key: string) => (await env.FILES.head(key)) !== null;

describe("an owed node behind a malware-listed declaration", () => {
  it("(b) through the route: the server's csam hash is on the session, the declaration in the owed row — the stale job leaves it, the object is kept, and the sweep writes the locked node", async () => {
    const user = await uploader();
    const stored = uniqueBytes(700);
    const storedSha = await sha256Of(stored);
    await blocklist.upsert(testDb(), { sha256: storedSha, reason: "csam" });
    const declaredSha = rand(32);
    await blocklist.upsert(testDb(), { sha256: declaredSha, reason: "malware" });
    const session = await uploaded(user, {}, stored);
    // Both transactions fail: the in-place node and the preserved one — the node is owed.
    const answer = await complete(
      user,
      session.uploadId,
      { sha256: declaredSha },
      {
        beforeCommit: () => {
          throw new Error("test: the node cannot be written");
        },
      },
    );
    expect(answer.status).toBe(403);
    const row = (await sessionRow(session.uploadId))!;
    expect(row).toMatchObject({ status: "completing", expectedSha256: storedSha });
    const [owedRow] = await testDb()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, CSAM_NODE_OWED_ACTION), eq(auditLog.targetId, session.uploadId)));
    expect(owedRow!.meta).toMatchObject({ nodeId: row.nodeId, declaredSha256: declaredSha });

    await rolledBack(async (db) => {
      await db.update(uploads).set({ completingAt: LONG_AGO }).where(eq(uploads.id, row.id));
      const run = await staleThenSweep(db);
      expect(await run.afterStale(row.id)).toMatchObject({ status: "completing" });
      expect(await exists(row.r2Key)).toBe(true);
      expect(await run.sweep()).toMatchObject({ locked: 1 });
      const [node] = await db.select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
      expect(node).toMatchObject({
        ownerId: user.id,
        scanStatus: "suspected_csam",
        legalHold: true,
        sha256: storedSha,
      });
      expect(await exists(row.r2Key)).toBe(true);
    });
  });

  it("(a) alone — a session owed before (b), its hash still the client's UNLISTED declaration (multipart): the owed row keeps it from the stale job; the object and its upload are kept; the sweep locks it", async () => {
    await rolledBack(async (db) => {
      const owner = await member();
      const bytes = uniqueBytes(500);
      const storedSha = await sha256Of(bytes);
      await blocklist.upsert(db, { sha256: storedSha, reason: "csam" });
      // Not listed at all (an avatar's shape, or an entry removed since): only the owed row says so.
      const declaredSha = rand(32);
      const nodeId = uuidv7();
      const versionId = uuidv7();
      const name = `owed-${rand()}.bin`;
      const r2Key = keyFor(owner.id, nodeId, versionId);
      const multipart = await env.FILES.createMultipartUpload(r2Key);
      await multipart.uploadPart(1, new Uint8Array(16));
      await env.FILES.put(r2Key, bytes);
      const [session] = await db
        .insert(uploads)
        .values({
          ownerId: owner.id,
          uploaderId: owner.id,
          parentId: null,
          nodeId,
          versionId,
          name,
          nameKey: nameKeyOf(name),
          size: bytes.byteLength,
          r2Key,
          r2UploadId: multipart.uploadId,
          expiresAt: new Date(Date.now() + 86_400_000),
          status: "completing",
          completingAt: LONG_AGO,
          expectedSha256: declaredSha,
        })
        .returning();
      await db.update(userTable).set({ usedBytes: bytes.byteLength }).where(eq(userTable.id, owner.id));
      await db.insert(auditLog).values({
        actorType: "system",
        action: CSAM_NODE_OWED_ACTION,
        targetType: "upload",
        targetId: session!.id,
        meta: { nodeId },
      });

      const run = await staleThenSweep(db);
      expect(await run.afterStale(session!.id)).toMatchObject({ status: "completing" });
      expect(await exists(r2Key)).toBe(true);
      expect(await run.sweep()).toMatchObject({ locked: 1 });
      const [node] = await db.select().from(nodes).where(eq(nodes.r2Key, r2Key));
      expect(node).toMatchObject({ ownerId: owner.id, scanStatus: "suspected_csam", legalHold: true });
      expect(await exists(r2Key)).toBe(true);
    });
  });

  it("Addendum 3 m5: a malware-DECLARED multipart session with NO owed row over stored csam bytes (the request died before the route decided) — the stale job leaves it, the object is kept, and the sweep hashes first and locks it", async () => {
    await rolledBack(async (db) => {
      const owner = await member();
      const bytes = uniqueBytes(500);
      await blocklist.upsert(db, { sha256: await sha256Of(bytes), reason: "csam" });
      const declaredSha = rand(32);
      await blocklist.upsert(db, { sha256: declaredSha, reason: "malware" });
      const nodeId = uuidv7();
      const versionId = uuidv7();
      const name = `died-${rand()}.bin`;
      const r2Key = keyFor(owner.id, nodeId, versionId);
      const multipart = await env.FILES.createMultipartUpload(r2Key);
      await multipart.uploadPart(1, new Uint8Array(16));
      await env.FILES.put(r2Key, bytes);
      const [session] = await db
        .insert(uploads)
        .values({
          ownerId: owner.id,
          uploaderId: owner.id,
          parentId: null,
          nodeId,
          versionId,
          name,
          nameKey: nameKeyOf(name),
          size: bytes.byteLength,
          r2Key,
          r2UploadId: multipart.uploadId,
          expiresAt: new Date(Date.now() + 86_400_000),
          status: "completing",
          completingAt: LONG_AGO,
          expectedSha256: declaredSha,
        })
        .returning();
      const run = await staleThenSweep(db);
      expect(await run.afterStale(session!.id)).toMatchObject({ status: "completing" });
      expect(await exists(r2Key)).toBe(true);
      expect(await run.sweep()).toMatchObject({ locked: 1 });
      const [node] = await db.select().from(nodes).where(eq(nodes.r2Key, r2Key));
      expect(node).toMatchObject({ ownerId: owner.id, scanStatus: "suspected_csam", legalHold: true });
      expect(await exists(r2Key)).toBe(true);
    });
  });

  it("Addendum 3 m4: the route's owed row is held from the 180-day audit retention (meta.legalHold) — an unheld twin of the same age is deleted", async () => {
    const user = await uploader();
    const stored = uniqueBytes(600);
    const storedSha = await sha256Of(stored);
    await blocklist.upsert(testDb(), { sha256: storedSha, reason: "csam" });
    const session = await uploaded(user, {}, stored);
    const answer = await complete(
      user,
      session.uploadId,
      { sha256: storedSha },
      {
        beforeCommit: () => {
          throw new Error("test: the node cannot be written");
        },
      },
    );
    expect(answer.status).toBe(403);
    const { deleteOldAudit } = await import("../../../src/worker/db/queries/trash-jobs");
    await rolledBack(async (db) => {
      const [owedRow] = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.action, CSAM_NODE_OWED_ACTION), eq(auditLog.targetId, session.uploadId)));
      expect(owedRow!.meta).toMatchObject({ legalHold: true });
      const [twin] = await db
        .insert(auditLog)
        .values({
          actorType: "system",
          action: "t22.retention_twin",
          targetType: "upload",
          targetId: session.uploadId,
          meta: { nodeId: "made-up" },
        })
        .returning();
      await db
        .update(auditLog)
        .set({ at: new Date(Date.now() - 200 * 86_400_000) })
        .where(inArray(auditLog.id, [owedRow!.id, twin!.id]));
      await deleteOldAudit(db, 1_000_000);
      const left = await db
        .select({ id: auditLog.id })
        .from(auditLog)
        .where(inArray(auditLog.id, [owedRow!.id, twin!.id]));
      expect(left.map((row) => row.id)).toEqual([owedRow!.id]);
    });
  });
});
