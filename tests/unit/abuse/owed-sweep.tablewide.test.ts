// The owed-node repair sweep — abuse-hourly part (0c). TABLE-WIDE: it lists every owed session in
// the database, so this file runs alone (serial step).
//
// Most cases run INSIDE ONE TRANSACTION THAT IS ROLLED BACK (`rolledBack`): the fixtures are
// written through it, dated before every other row (so a limit of one reaches them whatever
// earlier runs left behind), the sweep runs on it, the assertions read through it — and nothing
// of it is left in the shared database. Objects are in this file's own bucket. The operators are
// a made-up address of the test's own. The client addresses are documentation ranges (made up).
import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../../src/worker/db/client";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  CSAM_NODE_OWED_ACTION,
  OWED_ATTEMPTS_PER_DAY,
  owedSessions,
} from "../../../src/worker/db/queries/abuse";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { deleteForUser, remainingForUser, sealedIpOf } from "../../../src/worker/db/queries/uploads";
import {
  auditLog,
  nodes,
  reports,
  strikes,
  uploadIps,
  uploads,
  user as userTable,
} from "../../../src/worker/db/schema";
import {
  job,
  owedHooks,
  parts,
  settleOwedSession,
  sweepOwedNodes,
} from "../../../src/worker/jobs/abuse-hourly";
import { GENERATION_KEY } from "../../../src/worker/jobs/reconcile";
import { extOf, nameKeyOf } from "../../../src/worker/services/filename";
import { keyFor } from "../../../src/worker/services/storage";
import { openIp, sealIp } from "../../../src/worker/services/tokens";
import { mailTo } from "../auth/helpers";
import {
  cronEvent,
  databaseGeneration,
  jobContext,
  makeFile,
  makeFolder,
  member,
  rand,
  testDb,
} from "../trash/helpers";
import { sha256Of, uniqueBytes } from "../uploads/helpers";
import { operators } from "./helpers";

const AT_INIT = "198.51.100.23";
const ROLLBACK = Symbol("rollback");
/** Before every other row: what a limit of one reaches first. */
const LONG_AGO = new Date(Date.UTC(1971, 0, 1));
const MINUTE = 60_000;
const TODAY = () => new Date().toISOString().slice(0, 10);

afterEach(async () => {
  // In step again for the next case (a case may have put the store "ahead" of the database).
  await env.FILES.put(GENERATION_KEY, String(await databaseGeneration()));
});

/** Runs `body` in one transaction that is rolled back. */
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

type UserRow = Awaited<ReturnType<typeof member>>;

type OwedOptions = {
  owner?: UserRow;
  uploader?: UserRow;
  parentId?: string | null;
  /** What the STORED bytes are listed as (null: not listed). */
  stored: "csam" | "malware" | null;
  /** The declared hash: the stored bytes' own (default), or another hash listed as csam. */
  declared?: "own" | "other-csam";
  /** The route's `upload.csam_node_owed` audit row. */
  owedRow?: boolean;
  completingAt?: Date;
  /** The uploader's sealed address on the session (false: a session from before the column). */
  sealed?: boolean;
  replaceNodeId?: string;
  /** A multipart session: `r2UploadId` is a real upload in the store. */
  multipart?: boolean;
  /** No object at the key. */
  noObject?: boolean;
};

/** An owed (or would-be-owed) `completing` session, written through `db`, its bytes in the store. */
async function owed(db: Db, o: OwedOptions) {
  const owner = o.owner ?? (await member());
  const uploader = o.uploader ?? owner;
  const bytes = uniqueBytes(500);
  const sha256 = await sha256Of(bytes);
  if (o.stored) await blocklist.upsert(db, { sha256, reason: o.stored });
  let expectedSha256 = sha256;
  if (o.declared === "other-csam") {
    expectedSha256 = rand(32);
    await blocklist.upsert(db, { sha256: expectedSha256, reason: "csam" });
  }
  const nodeId = o.replaceNodeId ?? uuidv7();
  const versionId = uuidv7();
  const name = `owed-${rand()}.bin`;
  const sealed = o.sealed === false ? null : await sealIp(env, AT_INIT);
  const r2Key = keyFor(owner.id, nodeId, versionId);
  let r2UploadId: string | null = null;
  if (o.multipart) {
    const upload = await env.FILES.createMultipartUpload(r2Key);
    await upload.uploadPart(1, new Uint8Array(16));
    r2UploadId = upload.uploadId;
  }
  const [session] = await db
    .insert(uploads)
    .values({
      ownerId: owner.id,
      uploaderId: uploader.id,
      parentId: o.parentId ?? null,
      nodeId,
      versionId,
      replaceNodeId: o.replaceNodeId ?? null,
      name,
      nameKey: nameKeyOf(name),
      size: bytes.byteLength,
      r2Key,
      r2UploadId,
      expiresAt: new Date(Date.now() + 86_400_000),
      status: "completing",
      completingAt: o.completingAt ?? LONG_AGO,
      expectedSha256,
      ipEncrypted: sealed?.ciphertext ?? null,
      ipIv: sealed?.iv ?? null,
      ipKeyVersion: sealed?.keyVersion ?? null,
    })
    .returning();
  if (!o.noObject) await env.FILES.put(r2Key, bytes);
  // The session's reservation, on the folder's owner.
  await db.update(userTable).set({ usedBytes: bytes.byteLength }).where(eq(userTable.id, owner.id));
  if (o.owedRow) {
    await db.insert(auditLog).values({
      actorType: "system",
      action: CSAM_NODE_OWED_ACTION,
      targetType: "upload",
      targetId: session!.id,
      meta: { nodeId },
    });
  }
  return { owner, uploader, session: session!, sha256, bytes };
}

const read = {
  async session(db: Db, id: string) {
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id));
    return row ?? null;
  },
  async nodesOnKey(db: Db, r2Key: string) {
    return db.select().from(nodes).where(eq(nodes.r2Key, r2Key));
  },
  async user(db: Db, id: string) {
    const [row] = await db.select().from(userTable).where(eq(userTable.id, id));
    return row!;
  },
  async reports(db: Db, nodeId: string) {
    return db.select().from(reports).where(eq(reports.nodeId, nodeId));
  },
  async ips(db: Db, nodeId: string) {
    return db.select().from(uploadIps).where(eq(uploadIps.nodeId, nodeId));
  },
  async audits(db: Db, action: string, targetId: string) {
    return db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.targetId, targetId)));
  },
};

const exists = async (key: string) => (await env.FILES.head(key)) !== null;
const criticalMails = (address: string) => mailTo(address).filter((m) => /CRITICAL/.test(m.subject));

/** The sweep at limit one — the fixture is dated first — on `db`, its deferred work drained. */
async function sweepOnce(db: Db, envOverride: Record<string, unknown> = {}) {
  const ctx = jobContext({ db, env: envOverride });
  const result = await sweepOwedNodes(ctx.bg, { limit: 1 });
  await ctx.settle();
  return { result, ctx };
}

describe("the listing", () => {
  it("lists a completing session older than 60 minutes with an owed audit row OR a declared hash listed with ANY reason (Addendum 3 m5); not a young one, nor one whose declared hash is not listed", async () => {
    await rolledBack(async (db) => {
      const withRow = await owed(db, { stored: "csam", owedRow: true });
      const declaredOnly = await owed(db, { stored: null, declared: "other-csam" });
      const young = await owed(db, {
        stored: "csam",
        owedRow: true,
        completingAt: new Date(Date.now() - 30 * MINUTE),
      });
      const malware = await owed(db, { stored: "malware" });
      const unlisted = await owed(db, { stored: null });
      const listed = await owedSessions(db, 1_000_000, TODAY());
      const ids = listed.map((entry) => entry.session.id);
      expect(ids).toContain(withRow.session.id);
      expect(ids).toContain(declaredOnly.session.id);
      expect(ids).toContain(malware.session.id);
      expect(ids).not.toContain(young.session.id);
      expect(ids).not.toContain(unlisted.session.id);
      expect(listed.find((e) => e.session.id === withRow.session.id)!.owedRow).toBe(true);
      expect(listed.find((e) => e.session.id === declaredOnly.session.id)!.owedRow).toBe(false);
    });
  });
});

describe("the server hash is csam: the uploader's locked node", () => {
  it("one run: ONE node, the uploader's, top level, suspected_csam and held, locked (report, holds, one alert); the session ended; the object kept and now referenced; the session's sealed address recorded — a second run changes nothing", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const made = await owed(db, { stored: "csam", owedRow: true });
      const first = await sweepOnce(db, ops.env);
      expect(first.result).toMatchObject({ checked: 1, locked: 1, failed: 0 });

      const written = await read.nodesOnKey(db, made.session.r2Key);
      expect(written).toHaveLength(1);
      const node = written[0]!;
      expect(node).toMatchObject({
        id: made.session.nodeId,
        ownerId: made.uploader.id,
        createdBy: made.uploader.id,
        parentId: null,
        kind: "file",
        scanStatus: "suspected_csam",
        legalHold: true,
        sha256: made.sha256,
        size: made.bytes.byteLength,
      });
      const [report] = await read.reports(db, node.id);
      expect(report).toMatchObject({ category: "csam", status: "open", ownerId: made.uploader.id });
      expect(await read.user(db, made.uploader.id)).toMatchObject({ legalHold: true });
      expect(criticalMails(ops.address)).toHaveLength(1);
      expect(await read.session(db, made.session.id)).toMatchObject({
        status: "aborted",
        ipEncrypted: null,
        ipIv: null,
        ipKeyVersion: null,
      });
      expect(await exists(made.session.r2Key)).toBe(true);
      // The owner's own bytes: counted once, on the node.
      expect((await read.user(db, made.owner.id)).usedBytes).toBe(made.bytes.byteLength);
      const ips = await read.ips(db, node.id);
      expect(ips).toHaveLength(1);
      expect(
        await openIp(env, {
          ciphertext: ips[0]!.ipEncrypted,
          iv: ips[0]!.iv,
          keyVersion: ips[0]!.keyVersion,
        }),
      ).toBe(AT_INIT);
      const preserved = await read.audits(db, "upload.csam_preserved", node.id);
      expect(preserved).toHaveLength(1);
      expect(preserved[0]!.meta).toMatchObject({ uploadId: made.session.id, via: "sweep" });
      expect(preserved[0]!.meta).not.toHaveProperty("ip");

      const second = await sweepOnce(db, ops.env);
      expect(second.result.locked).toBe(0);
      expect(await read.nodesOnKey(db, made.session.r2Key)).toHaveLength(1);
      expect(await read.reports(db, node.id)).toHaveLength(1);
      expect(criticalMails(ops.address)).toHaveLength(1);
    });
  });

  it("a session from before the address column (NULL): recorded without an address, audit meta ip: 'absent'", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "csam", owedRow: true, sealed: false });
      expect(sealedIpOf(made.session)).toBeNull();
      expect((await sweepOnce(db)).result.locked).toBe(1);
      const [node] = await read.nodesOnKey(db, made.session.r2Key);
      expect(await read.ips(db, node!.id)).toEqual([]);
      const [row] = await read.audits(db, "upload.csam_preserved", node!.id);
      expect(row!.meta).toMatchObject({ ip: "absent", via: "sweep" });
    });
  });

  it("an editor's session into another owner's folder: the node is the EDITOR's at their top level; the folder owner's reservation released; the bytes counted once, on the editor", async () => {
    await rolledBack(async (db) => {
      const owner = await member();
      const editor = await member();
      const folder = await makeFolder(owner.id);
      const made = await owed(db, {
        owner,
        uploader: editor,
        parentId: folder.id,
        stored: "csam",
        owedRow: true,
      });
      expect((await sweepOnce(db)).result.locked).toBe(1);
      const [node] = await read.nodesOnKey(db, made.session.r2Key);
      expect(node).toMatchObject({ ownerId: editor.id, parentId: null, scanStatus: "suspected_csam" });
      expect((await read.user(db, owner.id)).usedBytes).toBe(0);
      expect((await read.user(db, editor.id)).usedBytes).toBe(made.bytes.byteLength);
      // The folder's owner is not held for it; the uploader is.
      expect(await read.user(db, owner.id)).toMatchObject({ legalHold: false });
      expect(await read.user(db, editor.id)).toMatchObject({ legalHold: true });
    });
  });

  it("a REPLACE session: the existing file is untouched; a new top-level node of the uploader's is locked", async () => {
    await rolledBack(async (db) => {
      const owner = await member();
      const target = await makeFile(owner.id, null, { scanStatus: "clean" });
      const made = await owed(db, { owner, stored: "csam", owedRow: true, replaceNodeId: target.id });
      expect(made.session.nodeId).toBe(target.id);
      expect((await sweepOnce(db)).result.locked).toBe(1);
      const [existing] = await db.select().from(nodes).where(eq(nodes.id, target.id));
      expect(existing).toMatchObject({ scanStatus: "clean", legalHold: false, r2Key: target.r2Key });
      expect(await read.reports(db, target.id)).toEqual([]);
      const [node] = await read.nodesOnKey(db, made.session.r2Key);
      expect(node!.id).not.toBe(target.id);
      expect(node).toMatchObject({
        ownerId: owner.id,
        parentId: null,
        scanStatus: "suspected_csam",
        legalHold: true,
      });
    });
  });

  it("already written (a crash after the node, before the session ended): no second node — the lock, then the session ended", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "csam", owedRow: true });
      const { writeLockedNode } = await import("../../../src/worker/routes/uploads");
      const node = await writeLockedNode({ db }, made.session, {
        uploaderId: made.uploader.id,
        sha256: made.sha256,
        size: made.bytes.byteLength,
        sealed: sealedIpOf(made.session),
      });
      const result = (await sweepOnce(db)).result;
      expect(result).toMatchObject({ locked: 1, failed: 0 });
      expect(await read.nodesOnKey(db, made.session.r2Key)).toEqual([
        expect.objectContaining({ id: node.id }),
      ]);
      expect(await read.reports(db, node.id)).toHaveLength(1);
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "aborted" });
      // Written by the earlier attempt: this run wrote no second "preserved" row.
      expect(await read.audits(db, "upload.csam_preserved", node.id)).toEqual([]);
    });
  });

  it("a run in which the node write fails: nothing deleted, the session still completing — the next run writes it", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "csam", owedRow: true });
      let transactions = 0;
      const failing = new Proxy(db, {
        get(target, property, receiver) {
          if (property === "transaction") {
            return (...args: unknown[]) => {
              transactions += 1;
              if (transactions === 1) return Promise.reject(new Error("test: the node cannot be written"));
              return (target.transaction as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
      const ctx = jobContext({ db: failing as Db });
      expect(await sweepOwedNodes(ctx.bg, { limit: 1 })).toMatchObject({ failed: 1, locked: 0 });
      await ctx.settle();
      expect(await read.nodesOnKey(db, made.session.r2Key)).toEqual([]);
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "completing" });
      expect(sealedIpOf((await read.session(db, made.session.id))!)).not.toBeNull();
      expect(await exists(made.session.r2Key)).toBe(true);
      expect((await read.user(db, made.owner.id)).usedBytes).toBe(made.bytes.byteLength);

      expect((await sweepOnce(db)).result.locked).toBe(1);
      expect(await read.nodesOnKey(db, made.session.r2Key)).toHaveLength(1);
    });
  });

  it("the same session younger than 60 minutes is untouched", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, {
        stored: "csam",
        owedRow: true,
        completingAt: new Date(Date.now() - 30 * MINUTE),
      });
      const ctx = jobContext({ db });
      // Every listed session (not only the first): the young one is never among them.
      await settleAll(ctx);
      expect(await read.nodesOnKey(db, made.session.r2Key)).toEqual([]);
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "completing" });
    });
  });
});

/** Settles every session the listing gives (limit 1,000) — for the cases that assert an absence. */
async function settleAll(ctx: ReturnType<typeof jobContext>) {
  const result = await sweepOwedNodes(ctx.bg, { limit: 1_000 });
  await ctx.settle();
  return result;
}

describe("the declared hash is never acted on: the server's decides", () => {
  it("a csam-DECLARED session whose stored bytes are not listed → ended as a stale session: no node, no lock, no report; the reservation released", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const made = await owed(db, { stored: null, declared: "other-csam" });
      expect((await sweepOnce(db, ops.env)).result).toMatchObject({ stale: 1, locked: 0 });
      expect(await read.nodesOnKey(db, made.session.r2Key)).toEqual([]);
      expect(await db.select().from(reports).where(eq(reports.ownerId, made.owner.id))).toEqual([]);
      expect(criticalMails(ops.address)).toEqual([]);
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "aborted", ipEncrypted: null });
      expect((await read.user(db, made.owner.id)).usedBytes).toBe(0);
      expect(await read.user(db, made.owner.id)).toMatchObject({ legalHold: false });
    });
  });

  it("no object at the key → not listed → ended as stale", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: null, declared: "other-csam", noObject: true });
      expect((await sweepOnce(db)).result).toMatchObject({ stale: 1 });
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "aborted" });
    });
  });

  it("stored bytes listed for ANOTHER reason (malware), declared csam → the upload route's refusal: aborted, reservation released, the uploader struck once, one upload.blocked row; the object deleted — and KEPT while the database reads as rolled back (session still ended)", async () => {
    const database = await databaseGeneration();
    for (const rolled of [true, false]) {
      await env.FILES.put(GENERATION_KEY, String(rolled ? database! + 2 : database));
      await rolledBack(async (db) => {
        const made = await owed(db, { stored: "malware", declared: "other-csam" });
        expect((await sweepOnce(db)).result).toMatchObject({ refused: 1 });
        expect(await read.session(db, made.session.id)).toMatchObject({
          status: "aborted",
          ipEncrypted: null,
        });
        expect((await read.user(db, made.owner.id)).usedBytes).toBe(0);
        expect(await db.select().from(strikes).where(eq(strikes.userId, made.uploader.id))).toHaveLength(1);
        expect(await read.audits(db, "upload.blocked", made.session.id)).toHaveLength(1);
        expect(await read.nodesOnKey(db, made.session.r2Key)).toEqual([]);
        expect(await exists(made.session.r2Key)).toBe(rolled);
      });
    }
  });

  it("a multipart stale session: its upload aborted and its object deleted — while rolled back the session is ended all the same (reservation back) and the store is left as it is", async () => {
    const database = await databaseGeneration();
    for (const rolled of [true, false]) {
      await env.FILES.put(GENERATION_KEY, String(rolled ? database! + 2 : database));
      await rolledBack(async (db) => {
        const made = await owed(db, { stored: null, declared: "other-csam", multipart: true });
        expect((await sweepOnce(db)).result).toMatchObject({ stale: 1 });
        expect(await read.session(db, made.session.id)).toMatchObject({
          status: "aborted",
          ipEncrypted: null,
        });
        expect((await read.user(db, made.owner.id)).usedBytes).toBe(0);
        expect(await exists(made.session.r2Key)).toBe(rolled);
        let open = true;
        try {
          await env.FILES.resumeMultipartUpload(made.session.r2Key, made.session.r2UploadId!).uploadPart(
            2,
            new Uint8Array(16),
          );
        } catch {
          open = false;
        }
        expect(open).toBe(rolled);
      });
    }
  });

  it("Addendum 3 m1: an owed ROW (the server proved csam) whose bytes are no longer listed as csam — or whose object is gone — is left UNTOUCHED: nothing deleted, nobody struck, the session completing; ONE critical operator alert per session, not one per run", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const unlisted = await owed(db, { stored: "malware", declared: "other-csam", owedRow: true });
      const { result, ctx } = await sweepOnce(db, ops.env);
      expect(result).toMatchObject({ held: 1, refused: 0, stale: 0 });
      expect(ctx.metric.mock.calls).toContainEqual([
        "job",
        { kind: "abuse-hourly", outcome: "error", reason: "owed_not_csam" },
      ]);
      expect(await read.session(db, unlisted.session.id)).toMatchObject({ status: "completing" });
      expect(await exists(unlisted.session.r2Key)).toBe(true);
      expect(await db.select().from(strikes).where(eq(strikes.userId, unlisted.uploader.id))).toEqual([]);
      expect((await read.user(db, unlisted.owner.id)).usedBytes).toBe(unlisted.bytes.byteLength);
      expect(criticalMails(ops.address)).toHaveLength(1);
      expect(JSON.stringify(criticalMails(ops.address)[0])).toContain(unlisted.session.id);
      // Again: still untouched, and nobody is told twice.
      expect((await sweepOnce(db, ops.env)).result).toMatchObject({ held: 1 });
      expect(criticalMails(ops.address)).toHaveLength(1);
      expect(await exists(unlisted.session.r2Key)).toBe(true);
    });
    await rolledBack(async (db) => {
      const ops = operators();
      const gone = await owed(db, { stored: "csam", owedRow: true, noObject: true });
      expect((await sweepOnce(db, ops.env)).result).toMatchObject({ held: 1 });
      expect(await read.session(db, gone.session.id)).toMatchObject({ status: "completing" });
      expect(criticalMails(ops.address)).toHaveLength(1);
    });
  });

  it("Addendum 3 m5: a DECLARED hash listed as malware over stored bytes listed as malware (no owed row) → the route's refusal (aborted, struck, object deleted)", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "malware" });
      expect((await sweepOnce(db)).result).toMatchObject({ refused: 1 });
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "aborted" });
      expect(await db.select().from(strikes).where(eq(strikes.userId, made.uploader.id))).toHaveLength(1);
      expect(await exists(made.session.r2Key)).toBe(false);
    });
  });
});

describe("the stuck alert's severity (Addendum 4)", () => {
  afterEach(() => {
    owedHooks.afterLookup = null;
  });

  it("a stuck session with no csam in play (malware-declared, no owed row) gets ONE ROUTINE operator alert, no critical one", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const stuck = await owed(db, { stored: "malware" });
      owedHooks.afterLookup = async (session) => {
        if (session.id === stuck.session.id) throw new Error("test: this session fails every time");
      };
      for (let i = 0; i < OWED_ATTEMPTS_PER_DAY; i++) await sweepOnce(db, ops.env);
      const about = mailTo(ops.address).filter((m) => JSON.stringify(m).includes(stuck.session.id));
      expect(about.filter((m) => /CRITICAL/.test(m.subject))).toEqual([]);
      expect(about.filter((m) => m.template === "adminAlert")).toHaveLength(1);
    });
  });
});

describe("m5 and the account purge (Addendum 3, 14:15)", () => {
  it("a leaving user's malware-declared completing session: the purge keeps it (it is not the stale job's), the sweep refuses it, and then the purge takes it — the user row can go", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "malware" });
      await deleteForUser(db, made.uploader.id);
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "completing" });
      expect(await remainingForUser(db, made.uploader.id)).toBe(1);
      expect((await sweepOnce(db)).result).toMatchObject({ refused: 1 });
      await deleteForUser(db, made.uploader.id);
      expect(await remainingForUser(db, made.uploader.id)).toBe(0);
    });
  });
});

describe("an entry listed between the sweep's lookup and its act (review M1, m3)", () => {
  afterEach(() => {
    owedHooks.afterLookup = null;
  });

  it("M1: path (3) — the bytes were not listed at the lookup and are listed as csam before the act: the re-check under the row lock leaves the session and its object (skipped), and the next run locks it", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: null, declared: "other-csam", multipart: true });
      owedHooks.afterLookup = async (session, sha256) => {
        if (session.id === made.session.id && sha256) await blocklist.upsert(db, { sha256, reason: "csam" });
      };
      expect((await sweepOnce(db)).result).toMatchObject({ skipped: 1, stale: 0 });
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "completing" });
      expect(await exists(made.session.r2Key)).toBe(true);
      owedHooks.afterLookup = null;
      expect((await sweepOnce(db)).result).toMatchObject({ locked: 1 });
      expect(await read.nodesOnKey(db, made.session.r2Key)).toHaveLength(1);
      expect(await exists(made.session.r2Key)).toBe(true);
    });
  });

  it("m3: path (2) — the bytes were listed as malware at the lookup and raised to csam before the refusal: nothing deleted, nobody struck, and the SAME run locks the node", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "malware", declared: "other-csam" });
      owedHooks.afterLookup = async (session, sha256) => {
        if (session.id === made.session.id && sha256) await blocklist.upsert(db, { sha256, reason: "csam" });
      };
      expect((await sweepOnce(db)).result).toMatchObject({ locked: 1, refused: 0 });
      expect(await exists(made.session.r2Key)).toBe(true);
      expect(await db.select().from(strikes).where(eq(strikes.userId, made.uploader.id))).toEqual([]);
      const [node] = await read.nodesOnKey(db, made.session.r2Key);
      expect(node).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    });
  });
});

describe("a session that never resolves cannot hold the head of the list (review m6)", () => {
  afterEach(() => {
    owedHooks.afterLookup = null;
  });

  it(`after ${OWED_ATTEMPTS_PER_DAY} attempts in a day it is off the list until the next day, and the operators are told ONCE that it is stuck`, async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const stuck = await owed(db, { stored: "csam", owedRow: true });
      const stuckMails = () =>
        criticalMails(ops.address).filter((m) => JSON.stringify(m).includes(stuck.session.id));
      owedHooks.afterLookup = async (session) => {
        if (session.id === stuck.session.id) throw new Error("test: this session fails every time");
      };
      for (let i = 0; i < OWED_ATTEMPTS_PER_DAY; i++) {
        expect((await sweepOnce(db, ops.env)).result).toMatchObject({ failed: 1 });
      }
      const ids = (await owedSessions(db, 1_000_000, TODAY())).map((entry) => entry.session.id);
      expect(ids).not.toContain(stuck.session.id);
      expect(stuckMails()).toHaveLength(1);
      // Another session behind it is reached now.
      owedHooks.afterLookup = null;
      const next = await owed(db, {
        stored: "csam",
        owedRow: true,
        completingAt: new Date(Date.UTC(1972, 0, 1)),
      });
      expect((await sweepOnce(db, ops.env)).result).toMatchObject({ locked: 1 });
      expect(await read.nodesOnKey(db, next.session.r2Key)).toHaveLength(1);
      // The next day it is listed again.
      expect(
        (await owedSessions(db, 1_000_000, new Date(Date.now() + 86_400_000).toISOString().slice(0, 10))).map(
          (e) => e.session.id,
        ),
      ).toContain(stuck.session.id);
      expect(stuckMails()).toHaveLength(1);
    });
  });
});

describe("decided again under the row's lock (standing check a)", () => {
  it("a session that moved on between the listing and the act (finished meanwhile) is skipped and not written to", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "csam", owedRow: true });
      const [listed] = (await owedSessions(db, 1_000_000, TODAY())).filter(
        (e) => e.session.id === made.session.id,
      );
      await db.update(uploads).set({ status: "done" }).where(eq(uploads.id, made.session.id));
      const ctx = jobContext({ db });
      expect(await settleOwedSession(ctx.bg, listed!, async () => true)).toBe("skipped");
      expect(await read.nodesOnKey(db, made.session.r2Key)).toEqual([]);
    });
  });

  it("paths (2) and (3) too: a session that moved on between the listing and the act — refused bytes are NOT deleted and nobody is struck; a would-be stale one is not ended again", async () => {
    await rolledBack(async (db) => {
      const refused = await owed(db, { stored: "malware", declared: "other-csam" });
      const stale = await owed(db, { stored: null, declared: "other-csam", multipart: true });
      const listed = (await owedSessions(db, 1_000_000, TODAY())).filter((e) =>
        [refused.session.id, stale.session.id].includes(e.session.id),
      );
      expect(listed).toHaveLength(2);
      for (const id of [refused.session.id, stale.session.id]) {
        await db.update(uploads).set({ status: "done" }).where(eq(uploads.id, id));
      }
      const ctx = jobContext({ db });
      for (const entry of listed)
        expect(await settleOwedSession(ctx.bg, entry, async () => true)).toBe("skipped");
      await ctx.settle();
      expect(await exists(refused.session.r2Key)).toBe(true);
      expect(await db.select().from(strikes).where(eq(strikes.userId, refused.uploader.id))).toEqual([]);
      expect(await read.audits(db, "upload.blocked", refused.session.id)).toEqual([]);
      expect(await exists(stale.session.r2Key)).toBe(true);
      expect((await read.user(db, stale.owner.id)).usedBytes).toBe(stale.bytes.byteLength);
    });
  });

  it("the uploader's account purge before the sweep: deleteForUser keeps the completing session (the purge waits); the sweep's node then holds the account", async () => {
    await rolledBack(async (db) => {
      const made = await owed(db, { stored: "csam", owedRow: true });
      await deleteForUser(db, made.uploader.id);
      expect(await read.session(db, made.session.id)).toMatchObject({ status: "completing" });
      expect((await sweepOnce(db)).result.locked).toBe(1);
      expect(await read.user(db, made.uploader.id)).toMatchObject({ legalHold: true });
    });
  });
});

describe("abuse-hourly runs the sweep (part 0c)", () => {
  // T21 (R4, Addendum 3 Q5): the pending-scan part is a no-op here — the real one would re-send
  // whatever pending nodes other runs left in the shared database to this file's queue.
  const realPendingSweep = parts.sweepPendingScans;
  const realLockedSweep = parts.sweepLockedUnhashed;
  beforeEach(() => {
    parts.sweepPendingScans = async () => ({ checked: 0, requeued: 0 });
    // (The same for R2 mod-2's locked-hash part: whatever other runs left locked.)
    parts.sweepLockedUnhashed = async () => ({ checked: 0, requeued: 0 });
  });
  afterEach(() => {
    parts.sweepPendingScans = realPendingSweep;
    parts.sweepLockedUnhashed = realLockedSweep;
  });

  it("one run of the job: the owed session becomes one locked, held node of the uploader's; nothing deleted; a second run changes nothing", async () => {
    await rolledBack(async (db) => {
      const ops = operators();
      const made = await owed(db, { stored: "csam", owedRow: true });
      const run = async () => {
        const ctx = jobContext({ db, env: ops.env });
        await job.run(ctx.bg, env, cronEvent(job.cron), { softDeadlineMs: 120_000 });
        await ctx.settle();
        return ctx;
      };
      const ctx = await run();
      const [node] = await read.nodesOnKey(db, made.session.r2Key);
      expect(node).toMatchObject({
        ownerId: made.uploader.id,
        scanStatus: "suspected_csam",
        legalHold: true,
      });
      expect(await exists(made.session.r2Key)).toBe(true);
      expect(ctx.metric.mock.calls).toContainEqual([
        "job",
        { kind: "abuse-hourly", outcome: "ok", reason: "owed_node_sweep" },
        expect.any(Number),
      ]);
      await run();
      expect(await read.nodesOnKey(db, made.session.r2Key)).toHaveLength(1);
      expect(await read.reports(db, node!.id)).toHaveLength(1);
    });
  });
});

describe("no drift: the route and the sweep write the same node through writeLockedNode", () => {
  it("preserveAndEnd (complete gives a csam upload up: the share was revoked) and the sweep on a twin session: the same node values, the same reservations, the session ended alike", async () => {
    const uploadsHelpers = await import("../uploads/helpers");
    const { makeShare } = await import("../services-core/helpers");
    const { shares } = await import("../../../src/worker/db/schema");
    const bytesRoute = uniqueBytes(500);
    const shaRoute = await sha256Of(bytesRoute);
    await blocklist.upsert(testDb(), { sha256: shaRoute, reason: "csam" });
    const owner = await uploadsHelpers.uploader();
    const editor = await uploadsHelpers.uploader();
    const folder = await makeFolder(owner.id);
    const share = await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const session = await uploadsHelpers.uploaded(editor, { parentId: folder.id }, bytesRoute);
    await testDb().delete(shares).where(eq(shares.id, share.id));
    const answer = await uploadsHelpers.complete(editor, session.uploadId, { sha256: shaRoute });
    expect(answer.status).toBe(404);
    const routeSession = (await uploadsHelpers.sessionRow(session.uploadId))!;
    const [routeNode] = await testDb().select().from(nodes).where(eq(nodes.r2Key, routeSession.r2Key));

    await rolledBack(async (db) => {
      const twinOwner = await member();
      const twinEditor = await member();
      const twinFolder = await makeFolder(twinOwner.id);
      const twin = await owed(db, {
        owner: twinOwner,
        uploader: twinEditor,
        parentId: twinFolder.id,
        stored: "csam",
        owedRow: true,
      });
      expect((await sweepOnce(db)).result.locked).toBe(1);
      const [sweepNode] = await read.nodesOnKey(db, twin.session.r2Key);
      const shape = (
        node: typeof routeNode,
        ownerOf: string,
        sessionRow: { nodeId: string; r2Key: string; size: number },
      ) => ({
        id: node!.id === sessionRow.nodeId,
        ownerIsUploader: node!.ownerId === ownerOf,
        createdBy: node!.createdBy === ownerOf,
        parentId: node!.parentId,
        kind: node!.kind,
        scanStatus: node!.scanStatus,
        legalHold: node!.legalHold,
        r2Key: node!.r2Key === sessionRow.r2Key,
        size: node!.size === sessionRow.size,
        ext: node!.ext === extOf(node!.name),
        system: node!.system,
      });
      expect(shape(sweepNode, twinEditor.id, twin.session)).toEqual(
        shape(routeNode, editor.id, routeSession),
      );
      // Reservations: the folder owner's released, the bytes on the editor — alike.
      expect((await read.user(db, twinOwner.id)).usedBytes).toBe(0);
      expect((await read.user(db, twinEditor.id)).usedBytes).toBe(twin.bytes.byteLength);
      expect((await uploadsHelpers.userRow(owner.id)).usedBytes).toBe(0);
      expect((await uploadsHelpers.userRow(editor.id)).usedBytes).toBe(bytesRoute.byteLength);
      // Both sessions ended the same way, the address cleared; both nodes have their upload_ips row.
      const twinRow = (await read.session(db, twin.session.id))!;
      expect([twinRow.status, twinRow.ipEncrypted]).toEqual([routeSession.status, routeSession.ipEncrypted]);
      expect((await read.ips(db, sweepNode!.id)).length).toBe(1);
      expect(
        (await testDb().select().from(uploadIps).where(eq(uploadIps.nodeId, routeNode!.id))).length,
      ).toBe(1);
    });
  });
});

describe("no drift: path (3) ends a session as the stale-upload job ends its twin", () => {
  it("a csam-declared multipart session whose bytes are not listed, and an ordinary stale twin through the stale job: the same row, reservation, parts, store state", async () => {
    const { job: staleJob } = await import("../../../src/worker/jobs/stale-uploads");
    const { uploadParts } = await import("../../../src/worker/db/schema");
    await rolledBack(async (db) => {
      const owedOne = await owed(db, { stored: null, declared: "other-csam", multipart: true });
      // The twin: the same kind of session, owing nothing (its declared hash is its own, unlisted).
      const twin = await owed(db, { stored: null, multipart: true });
      for (const made of [owedOne, twin]) {
        await db
          .insert(uploadParts)
          .values({ uploadId: made.session.id, partNumber: 1, etag: "e", size: 16 });
      }
      expect((await sweepOnce(db)).result).toMatchObject({ stale: 1 });
      const ctx = jobContext({ db });
      await staleJob.run(ctx.bg, env, cronEvent(staleJob.cron), {
        softDeadlineMs: 120_000,
        detection: { state: "ok", database: 0, raw: "0" },
      });
      const after = async (made: Awaited<ReturnType<typeof owed>>) => {
        const row = (await read.session(db, made.session.id))!;
        let open = true;
        try {
          await env.FILES.resumeMultipartUpload(row.r2Key, row.r2UploadId!).uploadPart(3, new Uint8Array(16));
        } catch {
          open = false;
        }
        return {
          status: row.status,
          ended: row.completedAt instanceof Date,
          ip: [row.ipEncrypted, row.ipIv, row.ipKeyVersion],
          parts: (await db.select().from(uploadParts).where(eq(uploadParts.uploadId, row.id))).length,
          used: (await read.user(db, made.owner.id)).usedBytes,
          object: await exists(row.r2Key),
          multipartOpen: open,
        };
      };
      const mine = await after(owedOne);
      expect(mine).toEqual(await after(twin));
      expect(mine).toEqual({
        status: "aborted",
        ended: true,
        ip: [null, null, null],
        parts: 0,
        used: 0,
        object: false,
        multipartOpen: false,
      });
    });
  });
});
