// What a session answers once complete has decided it — and what bytes the server has matched
// against the CSAM list become when something fails around the decision. Two rules:
//   - bytes the server has hashed and found listed as CSAM are a hidden, held node from the
//     first commit of their row — whatever fails afterwards, they are never a `pending` file;
//   - every "this upload's node is not there for you" is ONE answer, and a locked upload is not
//     told from a refused one by anything the uploader may send afterwards.
import { env } from "cloudflare:workers";
import { eq, sql } from "drizzle-orm";
import type { Context } from "hono";
import { beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "../../../src/worker/auth/types";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import * as quotaRows from "../../../src/worker/db/queries/quota";
import { deleteSubtreeRows } from "../../../src/worker/db/queries/trash";
import { nodes, reports, shares, uploads, user as userTable } from "../../../src/worker/db/schema";
import { RaisedToCsam, refuseBlocked, storedSha256 } from "../../../src/worker/routes/uploads";
import { requireRole } from "../../../src/worker/services/permissions";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { lockSuspectedCsam } from "../../../src/worker/services/scanning";
import { storage } from "../../../src/worker/services/storage";
import { auditRows, serviceDeps } from "../auth/helpers";
import {
  ADMIN_EMAIL,
  backendPid,
  gate,
  deliver,
  mailTo,
  makeFile,
  makeFolder,
  makeShare,
  nodeById,
  r2Event,
  testDb,
} from "../services-core/helpers";
import { invoke } from "../services-core/request";
import {
  call,
  complete,
  init,
  initBody,
  putParts,
  ROOMY,
  sessionRow,
  sha,
  sha256Of,
  TWO_PARTS,
  uniqueBytes,
  uploaded,
  uploader,
  usedBytes,
  userRow,
  watchedBucket,
  type Answer,
  type UserRow,
} from "./helpers";

type Reason = "malware" | "dmca" | "admin" | "csam";

async function listed(reason: Reason, bytes: Uint8Array = uniqueBytes()) {
  const sha256 = await sha256Of(bytes);
  await blocklist.upsert(testDb(), { sha256, reason });
  return { bytes, sha256 };
}

const operatorMails = () => mailTo(ADMIN_EMAIL).length;
const reportsOnNode = (nodeId: string) => testDb().select().from(reports).where(eq(reports.nodeId, nodeId));
const nodesOf = (ownerId: string) => testDb().select().from(nodes).where(eq(nodes.ownerId, ownerId));
const asCaller = (user: UserRow) => ({ user: user as unknown as SessionUser });
/** What a by-id read of the node answers the caller: the status of `requireRole`. */
const readById = async (user: UserRow, nodeId: string) =>
  (await invoke(asCaller(user), (c: Context<AppEnv>) => requireRole(c, nodeId, "viewer"))).status;
/** Status and bytes — what a client can compare. */
const seen = (answer: Answer) => `${answer.status} ${answer.bytes}`;
const list = (user: UserRow) => call<unknown[]>(user, "GET", "/uploads/open");

describe("B1 — verified CSAM bytes are hidden and held from the first commit of their row", () => {
  it("the lock's own transaction fails: the node exists, suspected_csam and held, 404 to its owner; a repeat does not return it; the stub cannot clean it; the handler called again completes the job", async () => {
    const owner = await uploader();
    const known = await listed("csam");
    const session = await uploaded(owner, {}, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    const mailsBefore = operatorMails();
    // Transactions on the handle: 1 = the node's (finish), 2 = the lock's (lockRows).
    const answer = await complete(
      owner,
      session.uploadId,
      { sha256: known.sha256 },
      {
        beforeCommit: (attempt) => {
          if (attempt === 2) throw new Error("test: the lock cannot be written");
        },
      },
    );
    // The answer is the blocked one, as always — not a 500.
    const someone = await uploader();
    const malware = await listed("malware");
    const other = await uploaded(someone, {}, malware.bytes);
    expect(seen(answer)).toBe(seen(await complete(someone, other.uploadId, { sha256: malware.sha256 })));

    // The lock never happened — and still the node is hidden and held.
    expect(await reportsOnNode(row.nodeId)).toHaveLength(0);
    expect(await userRow(owner.id)).toMatchObject({ legalHold: false });
    expect(await nodeById(row.nodeId)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    expect(await readById(owner, row.nodeId)).toBe(404);
    expect(await auditRows({ action: "upload.csam_lock_owed", targetId: row.nodeId })).toHaveLength(1);
    expect(operatorMails()).toBe(mailsBefore + 1);

    // A repeat of complete does not hand it out.
    const again = await complete(owner, session.uploadId, { sha256: known.sha256 });
    expect(seen(again)).toBe(seen(await complete(someone, other.uploadId, { sha256: malware.sha256 })));
    // The store's event and an explicit scan message: the verdict guard leaves it locked.
    for (const body of [
      r2Event(row.r2Key, "PutObject", 1000),
      { v: 1, nodeId: row.nodeId, key: row.r2Key, force: true },
    ]) {
      expect(await deliver([{ body }])).toEqual([{ outcome: "ack" }]);
      expect(await nodeById(row.nodeId)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
    }
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();

    // The repair: the one handler, called for a node that is already suspected_csam and has no
    // report, files the report, holds the owner, records and announces the lock.
    const { deps, settle } = serviceDeps();
    await lockSuspectedCsam(deps, row.nodeId, { source: "system" });
    await settle();
    expect(await reportsOnNode(row.nodeId)).toMatchObject([{ category: "csam", status: "open" }]);
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true });
    expect(await auditRows({ action: "scan.suspected_csam", targetId: row.nodeId })).toHaveLength(1);
  });

  it("the node's own transaction fails: the bytes are preserved anyway — a locked node, the object kept, the answer the blocked one", async () => {
    const owner = await uploader();
    const known = await listed("csam");
    const session = await uploaded(owner, {}, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    const answer = await complete(
      owner,
      session.uploadId,
      { sha256: known.sha256 },
      {
        beforeCommit: (attempt) => {
          if (attempt === 1) throw new Error("test: the node cannot be written by finish");
        },
      },
    );
    expect(answer.status).toBe(403);
    const [kept] = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
    expect(kept).toMatchObject({ ownerId: owner.id, scanStatus: "suspected_csam", legalHold: true });
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await userRow(owner.id)).toMatchObject({ legalHold: true });
    // An owner's own upload: its reservation stays where the row is.
    expect(await usedBytes(owner.id)).toBe(1000);
  });

  it("… and the lock fails after that too: the preserved node is still hidden and held, and the operators are told", async () => {
    const owner = await uploader();
    const known = await listed("csam");
    const session = await uploaded(owner, {}, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    const mailsBefore = operatorMails();
    // 1 = finish (fails), 2 = the preserved node's (commits), 3 = the lock's (fails).
    const answer = await complete(
      owner,
      session.uploadId,
      { sha256: known.sha256 },
      {
        beforeCommit: (attempt) => {
          if (attempt === 1 || attempt === 3) throw new Error(`test: transaction ${attempt} fails`);
        },
      },
    );
    expect(answer.status).toBe(403);
    const [kept] = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
    expect(kept).toMatchObject({ ownerId: owner.id, scanStatus: "suspected_csam", legalHold: true });
    expect(await reportsOnNode(kept!.id)).toHaveLength(0);
    expect(await readById(owner, kept!.id)).toBe(404);
    expect(operatorMails()).toBe(mailsBefore + 1);
  });

  it("what was declared is on the session from the claim — before the server hashes anything (a request that dies there leaves it behind)", async () => {
    const owner = await uploader();
    const known = await listed("csam");
    const session = await uploaded(owner, {}, known.bytes);
    let during: string | null | undefined;
    const watched = watchedBucket([], {
      get: async () => {
        during = (await sessionRow(session.uploadId))!.expectedSha256;
      },
    });
    await complete(owner, session.uploadId, { sha256: known.sha256 }, { env: { FILES: watched.bucket } });
    expect(during).toBe(known.sha256);
  });

  it("the folder is purged while the server hashes the object: the session row is gone, and the bytes become the uploader's locked node — the folder's owner is not held", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const known = await listed("csam");
    const session = await uploaded(editor, { parentId: folder.id }, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    let purged = false;
    const watched = watchedBucket([], {
      get: async () => {
        if (purged) return;
        purged = true;
        // What a purge does: the rows, and the freed bytes off the meter, in one transaction.
        await testDb().transaction(async (tx) => {
          const removed = await deleteSubtreeRows(tx, folder.id);
          await quotaRows.release(tx, owner.id, removed.freedBytes);
        });
      },
    });
    const answer = await complete(
      editor,
      session.uploadId,
      { sha256: known.sha256 },
      {
        env: { FILES: watched.bucket },
      },
    );
    expect(purged).toBe(true);
    expect(answer.status).toBe(404);
    expect(await sessionRow(session.uploadId)).toBeNull();
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    const [kept] = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
    expect(kept).toMatchObject({
      ownerId: editor.id,
      parentId: null,
      scanStatus: "suspected_csam",
      legalHold: true,
    });
    expect(await userRow(owner.id)).toMatchObject({ legalHold: false });
    expect(await userRow(editor.id)).toMatchObject({ legalHold: true });
    expect(await usedBytes(owner.id)).toBe(0);
    expect(await usedBytes(editor.id)).toBe(1000);
  });

  it("a share revoked WHILE the server hashes the object: the re-check follows the hash, so the folder's owner is not held (m12)", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    const share = await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const known = await listed("csam");
    const session = await uploaded(editor, { parentId: folder.id }, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    const watched = watchedBucket([], {
      get: async () => {
        await testDb().delete(shares).where(eq(shares.id, share.id));
      },
    });
    const answer = await complete(
      editor,
      session.uploadId,
      { sha256: known.sha256 },
      { env: { FILES: watched.bucket } },
    );
    expect(answer.status).toBe(404);
    const [kept] = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
    expect(kept).toMatchObject({ ownerId: editor.id, scanStatus: "suspected_csam" });
    expect(await userRow(owner.id)).toMatchObject({ legalHold: false });
  });

  it("the object is gone between its size check and the hash: nothing is decided — no node carries the declared, listed hash (m1)", async () => {
    const owner = await uploader();
    const known = await listed("malware");
    const session = await uploaded(owner, {}, uniqueBytes());
    const row = (await sessionRow(session.uploadId))!;
    const watched = watchedBucket([], { get: () => env.FILES.delete(row.r2Key) });
    const answer = await complete(
      owner,
      session.uploadId,
      { sha256: known.sha256 },
      { env: { FILES: watched.bucket } },
    );
    expect(answer.status).toBe(400);
    expect(await testDb().select().from(nodes).where(eq(nodes.sha256, known.sha256))).toHaveLength(0);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(owner.id)).toBe(0);
  });
});

describe("M1 — after the blocked 403, a locked upload is not told from a refused one", () => {
  /** What the follow-ups answer for a malware refusal: the reference every reason must equal. */
  let reference: string[];
  beforeAll(async () => {
    reference = await followUps("malware");
  });

  async function followUps(reason: Reason) {
    const user = await uploader();
    const known = await listed(reason);
    const session = await uploaded(user, {}, known.bytes);
    const first = await complete(user, session.uploadId, { sha256: known.sha256 });
    expect(first.status).toBe(403);
    return [
      seen(await complete(user, session.uploadId, { sha256: known.sha256 })),
      seen(await complete(user, session.uploadId, { sha256: sha() })),
      seen(await call(user, "DELETE", `/uploads/${session.uploadId}`)),
      seen(await call(user, "DELETE", `/uploads/${session.uploadId}`)),
      seen(await complete(user, session.uploadId, { sha256: known.sha256 })),
      seen(await list(user)),
    ];
  }

  it.each(["csam", "malware", "admin", "dmca"] as const)(
    "%s: repeat (same hash, other hash), DELETE, repeat after it, the open list — the answers every reason gets",
    async (reason) => {
      expect(await followUps(reason)).toEqual(reference);
    },
  );
});

describe("M2 — a done session whose node is not there for the caller: one answer for every reason", () => {
  /** A finished upload, and what an ABORTED session answers to a repeat (the reference). */
  async function finished() {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    const session = await uploaded(user, { parentId: folder.id });
    const sha256 = sha();
    const first = await complete(user, session.uploadId, { sha256 });
    expect(first.status).toBe(201);
    const given = await init(user, { name: "given-up.bin" });
    await call(user, "DELETE", `/uploads/${given.uploadId}`);
    const reference = seen(await complete(user, given.uploadId, { sha256 }));
    return { user, folder, session, sha256, nodeId: String(first.body.id), reference };
  }

  const changes: [string, (nodeId: string, user: UserRow, folderId: string) => Promise<unknown>][] = [
    ["taken down", (id) => testDb().update(nodes).set({ takedownAt: new Date() }).where(eq(nodes.id, id))],
    [
      "locked (suspected_csam)",
      (id) =>
        testDb().update(nodes).set({ scanStatus: "suspected_csam", legalHold: true }).where(eq(nodes.id, id)),
    ],
    [
      "in the trash",
      (id) =>
        testDb().update(nodes).set({ deletedAt: new Date(), trashedRoot: true }).where(eq(nodes.id, id)),
    ],
    [
      "under a trashed folder",
      (_id, _user, folderId) =>
        testDb()
          .update(nodes)
          .set({ deletedAt: new Date(), trashedRoot: true })
          .where(eq(nodes.id, folderId)),
    ],
    ["deleted", (id) => testDb().transaction((tx) => deleteSubtreeRows(tx, id))],
    [
      "replaced by a later upload (m7)",
      async (id, user, folderId) => {
        // A pending file is not replaceable; the scanner has passed this one.
        await testDb().update(nodes).set({ scanStatus: "clean" }).where(eq(nodes.id, id));
        const next = await uploaded(user, {
          parentId: folderId,
          replaceNodeId: id,
          onConflict: "replace",
          name: "replacement.bin",
        });
        expect((await complete(user, next.uploadId)).status).toBe(200);
      },
    ],
  ];

  it.each(changes)(
    "%s → the plain 409 a given-up session answers, and DELETE answers 204 as for one",
    async (_what, change) => {
      const { user, folder, session, sha256, nodeId, reference } = await finished();
      await change(nodeId, user, folder.id);
      const again = await complete(user, session.uploadId, { sha256 });
      expect(seen(again)).toBe(reference);
      expect((await call(user, "DELETE", `/uploads/${session.uploadId}`)).status).toBe(204);
      expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done" });
    },
  );

  it("control: nothing changed → 200 with the node, and DELETE on a finished upload is a 409", async () => {
    const { user, session, sha256, nodeId } = await finished();
    const again = await complete(user, session.uploadId, { sha256 });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(nodeId);
    const del = await call(user, "DELETE", `/uploads/${session.uploadId}`);
    expect(del.status).toBe(409);
    expect(del.body.message).toBe("This upload is complete.");
  });
});

describe("M3 — GET /uploads/open lists file sessions only", () => {
  it("an open avatar session is never offered for resume; a renamed session is listed under its stored name and resumed by the requested one", async () => {
    const user = await uploader();
    await makeFile(user.id, null, { name: "notes.txt" });
    const renamed = await init(user, { name: "notes.txt", onConflict: "rename", size: 10 });
    expect(renamed.finalName).toBe("notes (1).txt");
    await init(user, {
      purpose: "avatar",
      name: "me.png",
      mimeDeclared: "image/png",
      size: 100,
      parentId: null,
    });
    const open = await list(user);
    expect(open.status).toBe(200);
    expect(open.body.map((s) => (s as { name: string }).name)).toEqual(["notes (1).txt"]);
    // The original body again: the same session (findResumable keys on the REQUESTED name).
    const again = await call<{ uploadId: string }>(user, "POST", "/uploads", {
      json: initBody({ name: "notes.txt", onConflict: "rename", size: 10 }),
    });
    expect(again.status).toBe(200);
    expect(again.body.uploadId).toBe(renamed.uploadId);
  });
});

describe("Common addendum 12 — replace of a file the caller may not see", () => {
  it("an editor names a file in the shared folder that is under review: 404, byte for byte an unknown id; the file untouched", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const hidden = await makeFile(owner.id, folder.id, { name: "review.txt", scanStatus: "under_review" });
    const clean = await makeFile(owner.id, folder.id, { name: "clean.txt", scanStatus: "clean" });
    const body = (replaceNodeId: string) =>
      initBody({ parentId: folder.id, name: "x.txt", replaceNodeId, onConflict: "replace", size: 10 });
    const refused = await call(editor, "POST", "/uploads", { json: body(hidden.id) });
    const unknown = await call(editor, "POST", "/uploads", {
      json: body("0192f000-0000-7000-8000-000000000000"),
    });
    expect(refused.status).toBe(404);
    expect(refused.bytes).toBe(unknown.bytes);
    expect(await nodeById(hidden.id)).toMatchObject({
      scanStatus: "under_review",
      versionId: hidden.versionId,
    });
    // Control: a clean file of the same folder is the editor's to replace.
    expect((await call(editor, "POST", "/uploads", { json: body(clean.id) })).status).toBe(201);
  });

  it("… and when the file goes under review after init, complete answers 404 and replaces nothing", async () => {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const file = await makeFile(owner.id, folder.id, { name: "plan.txt", scanStatus: "clean" });
    const session = await uploaded(editor, {
      parentId: folder.id,
      name: "plan.txt",
      replaceNodeId: file.id,
      onConflict: "replace",
      size: 10,
    });
    await testDb().update(nodes).set({ scanStatus: "under_review" }).where(eq(nodes.id, file.id));
    const answer = await complete(editor, session.uploadId);
    expect(answer.status).toBe(404);
    expect(await nodeById(file.id)).toMatchObject({ versionId: file.versionId });
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
  });
});

describe("the minors", () => {
  it("m4 — a multipart session left without its store upload (init died after the admission) gets one when the same file is initialised again", async () => {
    const user = await uploader();
    const first = await init(user, { name: "big.bin", size: TWO_PARTS });
    await testDb().update(uploads).set({ r2UploadId: null }).where(eq(uploads.id, first.uploadId));
    const again = await call<{ uploadId: string }>(user, "POST", "/uploads", {
      json: initBody({ name: "big.bin", size: TWO_PARTS }),
    });
    expect(again.status).toBe(200);
    expect(again.body.uploadId).toBe(first.uploadId);
    expect((await sessionRow(first.uploadId))!.r2UploadId).not.toBeNull();
    const parts = await putParts(user, first, TWO_PARTS);
    expect((await complete(user, first.uploadId, { parts })).status).toBe(201);
  }, 60_000);

  it("m5 — two identical inits at once with room for ONE more file today: one 201, one 200 with the same session — never a 429", async () => {
    const user = await uploader();
    const tight = { settings: { ...ROOMY, ceilings: { upload_user: { count: 1 } } } } as const;
    const json = initBody({ name: "race.bin", size: 10 });
    // The uploader's row is held, so that BOTH inits get past the first resume lookup and wait
    // for the ceilings' lock; then it is let go and one of them writes the session first.
    const release = gate();
    const holder = gate<number>();
    const held = testDb().transaction(async (tx) => {
      await tx.select({ id: userTable.id }).from(userTable).where(eq(userTable.id, user.id)).for("update");
      holder.open(await backendPid(tx));
      await release.opened;
    });
    const pid = await holder.opened;
    const racing = [
      call<{ uploadId: string }>(user, "POST", "/uploads", { json, ...tight }),
      call<{ uploadId: string }>(user, "POST", "/uploads", { json, ...tight }),
    ];
    const deadline = Date.now() + 10_000;
    for (;;) {
      const result = await testDb().execute<{ n: number }>(
        // Waiting for the holder — directly, or behind the other init that waits for it.
        sql`SELECT count(*)::int AS n FROM pg_stat_activity a
            WHERE a.datname = current_database()
              AND (${pid} = ANY(pg_blocking_pids(a.pid))
                OR EXISTS (SELECT 1 FROM pg_stat_activity b
                           WHERE ${pid} = ANY(pg_blocking_pids(b.pid)) AND b.pid = ANY(pg_blocking_pids(a.pid))))`,
      );
      if (Number(result.rows[0]?.n) >= 2) break;
      if (Date.now() > deadline) throw new Error("the two inits never both waited");
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    release.open();
    await held;
    const [a, b] = await Promise.all(racing);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.uploadId).toBe(b.body.uploadId);
  });

  it("m8 — an avatar's row carries the server's hash, not the declared one", async () => {
    const user = await uploader();
    const { pngBytes } = await import("../../setup/fixture-bytes");
    const bytes = pngBytes(16, 16);
    const session = await uploaded(
      user,
      {
        purpose: "avatar",
        name: "me.png",
        mimeDeclared: "image/png",
        parentId: null,
      },
      bytes,
    );
    const declared = sha();
    const answer = await complete(user, session.uploadId, { sha256: declared });
    expect(answer.status).toBe(201);
    const row = (await sessionRow(session.uploadId))!;
    const [node] = await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key));
    expect(node!.sha256).toBe(await sha256Of(bytes));
    expect(node!.sha256).not.toBe(declared);
    expect(row.expectedSha256).toBe(declared);
  });

  it("m8 — two avatar completes at once leave ONE avatar node", async () => {
    const user = await uploader();
    const { pngBytes } = await import("../../setup/fixture-bytes");
    const a = await uploaded(
      user,
      { purpose: "avatar", name: "a.png", mimeDeclared: "image/png", parentId: null },
      pngBytes(8, 8),
    );
    const b = await uploaded(
      user,
      { purpose: "avatar", name: "b.png", mimeDeclared: "image/png", parentId: null },
      pngBytes(9, 9),
    );
    const answers = await Promise.all([complete(user, a.uploadId), complete(user, b.uploadId)]);
    expect(answers.map((x) => x.status)).toEqual([201, 201]);
    const avatars = (await nodesOf(user.id)).filter((n) => n.system === "avatar");
    expect(avatars).toHaveLength(1);
    expect((await userRow(user.id)).avatarNodeId).toBe(avatars[0]!.id);
  });

  it("m9 — refuseBlocked asks the list again: an entry raised to csam since the lookup deletes nothing", async () => {
    const user = await uploader();
    const known = await listed("malware");
    const session = await uploaded(user, {}, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    await testDb().update(uploads).set({ status: "completing" }).where(eq(uploads.id, row.id));
    await blocklist.upsert(testDb(), { sha256: known.sha256, reason: "csam" });
    const run = await invoke(asCaller(user), async (c: Context<AppEnv>) => {
      try {
        await refuseBlocked(c, (await sessionRow(row.id))!, "malware", known.sha256);
        return "refused";
      } catch (error) {
        return error instanceof RaisedToCsam ? "raised" : String(error);
      }
    });
    expect(run).toMatchObject({ ok: true, value: "raised" });
    expect(await storedSha256(storage(env), row.r2Key)).toBe(known.sha256);
    expect(await sessionRow(row.id)).toMatchObject({ status: "completing" });
  });

  it("m9 — through the route: a malware entry raised to csam between lookup and delete makes the upload the csam branch's — kept and locked", async () => {
    const user = await uploader();
    const known = await listed("malware");
    const session = await uploaded(user, {}, known.bytes);
    const row = (await sessionRow(session.uploadId))!;
    // The raise lands while the server hashes the object.
    const watched = watchedBucket([], {
      get: () => blocklist.upsert(testDb(), { sha256: known.sha256, reason: "csam" }),
    });
    const answer = await complete(
      user,
      session.uploadId,
      { sha256: known.sha256 },
      { env: { FILES: watched.bucket } },
    );
    expect(answer.status).toBe(403);
    expect(await env.FILES.head(row.r2Key)).not.toBeNull();
    expect(await nodeById(row.nodeId)).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
  });

  it("m10 — a late collision counts the suffix on: 'notes (1).txt' taken meanwhile → 'notes (2).txt', never 'notes (1) (1).txt'", async () => {
    const user = await uploader();
    const folder = await makeFolder(user.id);
    await makeFile(user.id, folder.id, { name: "notes.txt" });
    const session = await uploaded(user, {
      parentId: folder.id,
      name: "notes.txt",
      onConflict: "rename",
      size: 10,
    });
    expect((await sessionRow(session.uploadId))!.name).toBe("notes (1).txt");
    await makeFile(user.id, folder.id, { name: "notes (1).txt" });
    const answer = await complete(user, session.uploadId);
    expect(answer.status).toBe(201);
    expect(answer.body.name).toBe("notes (2).txt");
  });
});
