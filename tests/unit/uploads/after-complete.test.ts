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
import { uuidv7 } from "../../../src/worker/db/ids";
import * as blocklist from "../../../src/worker/db/queries/blocklist";
import { QueryError } from "../../../src/worker/db/errors";
import * as quotaRows from "../../../src/worker/db/queries/quota";
import { deleteSubtreeRows } from "../../../src/worker/db/queries/trash";
import { nodes, reports, shares, uploads, user as userTable } from "../../../src/worker/db/schema";
import { FINISHED_TRIM_DAYS } from "../../../src/worker/db/queries/uploads";
import { operatorAlert, RaisedToCsam, refuseBlocked, storedSha256 } from "../../../src/worker/routes/uploads";
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
  deadlockError,
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
const seen = (answer: Answer<unknown>) => `${answer.status} ${answer.bytes}`;
/** Every header but the per-response ones (date, request id). */
const headersOf = (answer: Answer<unknown>) =>
  [...answer.headers.entries()].filter(([name]) => name !== "date" && !name.includes("request")).sort();
/** One request as a client can compare it: status, body, headers — and the work it cost. */
async function observed(caller: UserRow, method: string, path: string, json?: unknown) {
  const statements = { n: 0 };
  const answer = await call(caller, method, path, { ...(json === undefined ? {} : { json }), statements });
  return { seen: seen(answer), headers: headersOf(answer), statements: statements.n };
}
const list = (user: UserRow) => call<unknown[]>(user, "GET", "/uploads/open");

/**
 * A purge of a folder as the purger does it (T14's delete-forever / purge job, not on this
 * branch): the rows and the freed bytes in one transaction, then — after the commit — every
 * object the rows named deleted, and every unfinished upload it handed over aborted.
 */
async function purge(folderId: string, ownerId: string) {
  const removed = await testDb().transaction(async (tx) => {
    const rows = await deleteSubtreeRows(tx, folderId);
    await quotaRows.release(tx, ownerId, rows.freedBytes);
    return rows;
  });
  const store = storage(env);
  if (removed.r2Keys.length > 0) await store.delete(removed.r2Keys);
  for (const upload of removed.uploadsToAbort) {
    await env.FILES.delete(upload.r2Key);
    if (upload.r2UploadId)
      await store.abort(store.resumeMultipart(upload.r2Key, upload.r2UploadId)).catch(() => undefined);
  }
  return removed;
}

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

  it("the folder is purged — rows AND objects, as the purger does — while the server hashes the object: the evidence survives as the uploader's locked node; the folder's owner is not held", async () => {
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
        const removed = await purge(folder.id, owner.id);
        // The completing session is kept by the purge: its key is not handed to the purger.
        expect(removed.uploadsToAbort.map((u) => u.r2Key)).not.toContain(row.r2Key);
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
    // Kept by the purge, detached; ended by this request once the node was written.
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted", parentId: null });
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

  it("ordinary bytes whose folder is purged while complete runs: given up — the plain 404, the object deleted, the reservation back, no node", async () => {
    const owner = await uploader();
    const folder = await makeFolder(owner.id);
    const session = await uploaded(owner, { parentId: folder.id });
    const row = (await sessionRow(session.uploadId))!;
    let purged = false;
    // The re-check has passed; the purge lands before the node is written.
    const watched = watchedBucket([], {
      head: async () => {
        if (purged) return;
        purged = true;
        await purge(folder.id, owner.id);
      },
    });
    const answer = await complete(owner, session.uploadId, {}, { env: { FILES: watched.bucket } });
    expect(purged).toBe(true);
    expect(answer.status).toBe(404);
    expect(await testDb().select().from(nodes).where(eq(nodes.r2Key, row.r2Key))).toHaveLength(0);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await env.FILES.head(row.r2Key)).toBeNull();
    expect(await usedBytes(owner.id)).toBe(0);
  });

  it("a re-check refused by a QueryError the driver wrapped gives the upload up, as an unwrapped one does", async () => {
    const owner = await uploader();
    const folder = await makeFolder(owner.id);
    // Listed as malware, the true hash: the server hashes first, then re-checks.
    const known = await listed("malware");
    const session = await uploaded(owner, { parentId: folder.id }, known.bytes);
    const fault = { armed: false, error: new QueryError("validation") as Error };
    const watched = watchedBucket([], {
      get: async () => {
        fault.armed = true;
      },
    });
    const answer = await complete(
      owner,
      session.uploadId,
      { sha256: known.sha256 },
      { env: { FILES: watched.bucket }, fault },
    );
    expect(answer.status).toBe(400);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "aborted" });
    expect(await usedBytes(owner.id)).toBe(0);
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

describe("Addendum 14 / r2-m2 — every verified CSAM object ends as a locked node, or as a node OWED", () => {
  type Ends = "node" | "owed";
  type Setup = { revoke: () => Promise<unknown>; trash: () => Promise<unknown> };
  type Row = {
    what: string;
    before?: (x: Setup) => Promise<unknown>;
    beforeCommit?: (attempt: number) => void;
    env?: Record<string, unknown>;
    /** Armed while the server hashes: the next statement (the re-check's first) fails. */
    faultInRecheck?: boolean;
    status: number;
    ends: Ends;
    /** An innocent upload in the same situation: the answers must be alike (status, body, headers). */
    twin?: boolean;
  };
  const fail =
    (...attempts: number[]) =>
    (n: number) => {
      if (attempts.includes(n)) throw new Error(`test: transaction ${n} fails`);
    };
  const rows: Row[] = [
    { what: "re-check passes", status: 403, ends: "node" },
    { what: "share revoked", before: (x) => x.revoke(), status: 404, ends: "node", twin: true },
    { what: "folder trashed", before: (x) => x.trash(), status: 404, ends: "node", twin: true },
    {
      what: "the node's transaction fails, the preserved one commits",
      beforeCommit: fail(1),
      status: 403,
      ends: "node",
    },
    {
      what: "share revoked, the preserved node's transaction fails",
      before: (x) => x.revoke(),
      beforeCommit: fail(1),
      status: 404,
      ends: "owed",
    },
    { what: "both transactions fail", beforeCommit: fail(1, 2), status: 403, ends: "owed" },
    // A made-up value that is not a key (not a credential): the client address cannot be sealed.
    {
      what: "the client address cannot be sealed (r2-m2)",
      env: { IP_ENC_KEY: "not-a-key" },
      status: 500,
      ends: "owed",
    },
    {
      what: "the re-check fails with a database error (r2-m2)",
      faultInRecheck: true,
      status: 500,
      ends: "owed",
    },
  ];

  async function setup() {
    const owner = await uploader();
    const editor = await uploader();
    const folder = await makeFolder(owner.id);
    const share = await makeShare(folder.id, owner.id, editor.id, { role: "editor", canUpload: true });
    const x: Setup = {
      revoke: () => testDb().delete(shares).where(eq(shares.id, share.id)),
      trash: () =>
        testDb()
          .update(nodes)
          .set({ deletedAt: new Date(), trashedRoot: true })
          .where(eq(nodes.id, folder.id)),
    };
    return { owner, editor, folder, x };
  }

  it.each(rows)("$what → $status, ends as $ends", async (row) => {
    const { editor, folder, x } = await setup();
    const known = await listed("csam");
    const session = await uploaded(editor, { parentId: folder.id }, known.bytes);
    const r2Key = (await sessionRow(session.uploadId))!.r2Key;
    await row.before?.(x);
    const mailsBefore = operatorMails();
    const fault = { armed: false };
    const watched = watchedBucket([], {
      get: async () => {
        if (row.faultInRecheck) fault.armed = true;
      },
    });
    const answer = await complete(
      editor,
      session.uploadId,
      { sha256: known.sha256 },
      {
        env: { FILES: watched.bucket, ...row.env },
        ...(row.beforeCommit ? { beforeCommit: row.beforeCommit } : {}),
        ...(row.faultInRecheck ? { fault } : {}),
      },
    );
    expect(answer.status).toBe(row.status);
    expect(await env.FILES.head(r2Key)).not.toBeNull();
    const [node] = await testDb().select().from(nodes).where(eq(nodes.r2Key, r2Key));
    const owed = await auditRows({ action: "upload.csam_node_owed", targetId: session.uploadId });
    if (row.ends === "node") {
      expect(node).toMatchObject({ scanStatus: "suspected_csam", legalHold: true });
      expect(owed).toHaveLength(0);
    } else {
      expect(node).toBeUndefined();
      // Owed: the session still holds the key, with the listed hash; recorded, and the operators told.
      expect(await sessionRow(session.uploadId)).toMatchObject({
        status: "completing",
        r2Key,
        expectedSha256: known.sha256,
      });
      expect(owed).toHaveLength(1);
      expect(operatorMails()).toBeGreaterThan(mailsBefore);
    }
    expect(await auditRows({ action: "upload.csam_object_kept", targetId: session.uploadId })).toHaveLength(
      0,
    );

    if (row.twin) {
      const other = await setup();
      const innocent = await uploaded(other.editor, { parentId: other.folder.id }, uniqueBytes());
      await row.before?.(other.x);
      const twin = await complete(other.editor, innocent.uploadId, { sha256: known.sha256 });
      expect(seen(twin)).toBe(seen(answer));
      expect(headersOf(twin)).toEqual(headersOf(answer));
    }
  });
});

describe("M1 — after the blocked 403, a locked upload is not told from a refused one", () => {
  /** What the follow-ups answer for a malware refusal: the reference every reason must equal. */
  let reference: Awaited<ReturnType<typeof observed>>[];
  beforeAll(async () => {
    reference = await followUps("malware");
  });

  async function followUps(reason: Reason) {
    const user = await uploader();
    const known = await listed(reason);
    const session = await uploaded(user, {}, known.bytes);
    const first = await complete(user, session.uploadId, { sha256: known.sha256 });
    expect(first.status).toBe(403);
    const path = `/uploads/${session.uploadId}`;
    const body = (sha256: string) => ({ sha256, parts: [] });
    // Status, body, headers AND the statements each one cost (R2-M1 / r2-m1).
    return [
      await observed(user, "POST", `${path}/complete`, body(known.sha256)),
      await observed(user, "POST", `${path}/complete`, body(sha())),
      // The same hash with parts that are not what completed (r3-m1).
      await observed(user, "POST", `${path}/complete`, {
        sha256: known.sha256,
        parts: [{ n: 1, etag: "x" }],
      }),
      await observed(user, "DELETE", path),
      await observed(user, "DELETE", path),
      await observed(user, "POST", `${path}/complete`, body(known.sha256)),
      await observed(user, "GET", "/uploads/open"),
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

  /** The repeat and the DELETE as a client can compare them, statements included. */
  async function followUps(change: (typeof changes)[number][1]) {
    const { user, folder, session, sha256, nodeId, reference } = await finished();
    await change(nodeId, user, folder.id);
    const path = `/uploads/${session.uploadId}`;
    const again = await observed(user, "POST", `${path}/complete`, { sha256, parts: [] });
    const del = await observed(user, "DELETE", path);
    expect(again.seen).toBe(reference);
    expect(del.seen.startsWith("204 ")).toBe(true);
    expect(await sessionRow(session.uploadId)).toMatchObject({ status: "done" });
    return { again, del };
  }

  // The cheapest way the node can be gone — deleted — is the reference every other must cost.
  let deleted: Awaited<ReturnType<typeof followUps>>;
  beforeAll(async () => {
    deleted = await followUps(changes.find(([what]) => what === "deleted")![1]);
  });

  it.each(changes)(
    "%s → the plain 409 a given-up session answers, DELETE 204 as for one — same headers, same statements",
    async (_what, change) => {
      expect(await followUps(change)).toEqual(deleted);
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
    // Room for these 1000 bytes today, and not for a second 1000.
    const user = await uploader({ quotaBytes: 1000 });
    const tight = { settings: { ...ROOMY, ceilings: { ...ROOMY.ceilings, CEIL_UPLOAD_BYTES_DAY: 1000 } } };
    const json = initBody({ name: "race.bin", size: 1000 });
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

describe("r3-m2 — the operator alert failing changes nothing but the alert", () => {
  // Two operators (made-up addresses), so that one failing can be seen not to stop the other.
  const OPERATORS = { ADMIN_EMAILS: "admin@example.test,second-operator@example.test", E2E_ADMIN_EMAILS: "" };

  /** `send` is handed the real sender, to pass the mails it does not fail on. */
  async function owedWith(send: (real: typeof operatorAlert.send) => typeof operatorAlert.send) {
    const owner = await uploader();
    const known = await listed("csam");
    const session = await uploaded(owner, {}, known.bytes);
    const original = operatorAlert.send;
    operatorAlert.send = send(original);
    try {
      // Both transactions fail: the node is owed, and the operators are to be told.
      const answer = await complete(
        owner,
        session.uploadId,
        { sha256: known.sha256 },
        {
          env: OPERATORS,
          beforeCommit: (n) => {
            if (n <= 2) throw new Error(`test: transaction ${n} fails`);
          },
        },
      );
      return { answer, session, known };
    } finally {
      operatorAlert.send = original;
    }
  }

  async function expectOwed({ answer, session, known }: Awaited<ReturnType<typeof owedWith>>) {
    expect(answer.status).toBe(403);
    expect(await auditRows({ action: "upload.csam_node_owed", targetId: session.uploadId })).toHaveLength(1);
    expect(await sessionRow(session.uploadId)).toMatchObject({
      status: "completing",
      expectedSha256: known.sha256,
    });
  }

  it("the first operator's mail fails (a rejected send): the audit row, the session, the answer as always — and the second operator is still told", async () => {
    const secondBefore = mailTo("second-operator@example.test").length;
    const run = await owedWith(
      (real) => (deps, d) =>
        d.to === "admin@example.test"
          ? Promise.reject(new Error("test: the mail transport is down"))
          : real(deps, d),
    );
    await expectOwed(run);
    expect(mailTo("second-operator@example.test").length).toBe(secondBefore + 1);
  });

  it("the alert cannot even start (a send that throws at once): still the answer, the audit row, the session completing", async () => {
    const run = await owedWith(() => () => {
      throw new Error("test: the mailer cannot be built");
    });
    await expectOwed(run);
  });
});

describe("r3-m3 — a finished session past the trim age answers as an unknown upload id, kept by a hold or not", () => {
  it("held-and-kept, trimmed, never existed: one answer — status, body, headers, statements — for a repeat and a DELETE", async () => {
    const user = await uploader();
    const old = new Date(Date.now() - (FINISHED_TRIM_DAYS + 1) * 86_400_000);
    async function finishedLongAgo() {
      const session = await uploaded(user, {});
      const sha256 = sha();
      expect((await complete(user, session.uploadId, { sha256 })).status).toBe(201);
      await testDb().update(uploads).set({ completedAt: old }).where(eq(uploads.id, session.uploadId));
      return { id: session.uploadId, sha256, nodeId: (await sessionRow(session.uploadId))!.nodeId };
    }
    // Kept by the trim: its node is taken down AND on legal hold.
    const kept = await finishedLongAgo();
    await testDb()
      .update(nodes)
      .set({ takedownAt: new Date(), takedownReason: "admin", legalHold: true })
      .where(eq(nodes.id, kept.nodeId));
    // Trimmed: the row is gone (what the trim does to it).
    const trimmed = await finishedLongAgo();
    await testDb().delete(uploads).where(eq(uploads.id, trimmed.id));
    const never = { id: uuidv7(), sha256: sha() };

    const answers = async (target: { id: string; sha256: string }) => [
      await observed(user, "POST", `/uploads/${target.id}/complete`, { sha256: target.sha256, parts: [] }),
      await observed(user, "DELETE", `/uploads/${target.id}`),
    ];
    const reference = await answers(never);
    expect(reference[0]!.seen.startsWith("404 ")).toBe(true);
    expect(await answers(kept)).toEqual(reference);
    expect(await answers(trimmed)).toEqual(reference);
    expect(await sessionRow(kept.id)).toMatchObject({ status: "done" });
  });

  it("control: the same held session a day before the trim age still answers as a finished upload does (409)", async () => {
    const user = await uploader();
    const session = await uploaded(user, {});
    const sha256 = sha();
    await complete(user, session.uploadId, { sha256 });
    const recent = new Date(Date.now() - (FINISHED_TRIM_DAYS - 1) * 86_400_000);
    await testDb().update(uploads).set({ completedAt: recent }).where(eq(uploads.id, session.uploadId));
    const nodeId = (await sessionRow(session.uploadId))!.nodeId;
    await testDb().update(nodes).set({ takedownAt: new Date(), legalHold: true }).where(eq(nodes.id, nodeId));
    expect((await complete(user, session.uploadId, { sha256 })).status).toBe(409);
  });
});

describe("fail safe — bytes are destroyed only on a definitive answer, never on a transient or unknown error", () => {
  type Kind = {
    what: string;
    /** Listed (malware) with the true hash: the server hashes first, then re-checks. */
    listed?: boolean;
    multipart?: boolean;
    /** The re-check's first statement fails with this. */
    faultInRecheck?: Error;
    fail?: string[];
    beforeCommit?: (attempt: number) => void;
    before?: (folderId: string) => Promise<unknown>;
    status: number;
    survives: boolean;
  };
  const kinds: Kind[] = [
    {
      what: "a lost database connection in the re-check",
      listed: true,
      faultInRecheck: new Error("test: Connection terminated unexpectedly"),
      status: 500,
      survives: true,
    },
    {
      what: "a driver-wrapped QueryError rate_limited (not definitive)",
      listed: true,
      faultInRecheck: new QueryError("rate_limited"),
      status: 429,
      survives: true,
    },
    {
      what: "a driver-wrapped QueryError not_found (definitive)",
      listed: true,
      faultInRecheck: new QueryError("not_found"),
      status: 404,
      survives: false,
    },
    {
      what: "a driver-wrapped QueryError validation (definitive)",
      listed: true,
      faultInRecheck: new QueryError("validation"),
      status: 400,
      survives: false,
    },
    {
      what: "a deadlock on every attempt of the node write",
      beforeCommit: () => {
        throw deadlockError();
      },
      status: 500,
      survives: true,
    },
    { what: "the store fails at head", fail: ["head"], status: 500, survives: true },
    {
      what: "the store fails while the server hashes",
      listed: true,
      fail: ["get"],
      status: 500,
      survives: true,
    },
    {
      what: "the store fails at assembling the parts",
      multipart: true,
      fail: ["upload.complete"],
      status: 500,
      survives: true,
    },
    {
      what: "the folder was trashed (definitive)",
      before: (folderId) =>
        testDb()
          .update(nodes)
          .set({ deletedAt: new Date(), trashedRoot: true })
          .where(eq(nodes.id, folderId)),
      status: 404,
      survives: false,
    },
  ];

  it.each(kinds)(
    "$what → $status; bytes survive: $survives",
    async (kind) => {
      const owner = await uploader();
      const folder = await makeFolder(owner.id);
      let parts: { n: number; etag: string }[] = [];
      let sha256 = sha();
      let uploadId: string;
      if (kind.multipart) {
        const session = await init(owner, { parentId: folder.id, size: TWO_PARTS });
        parts = await putParts(owner, session, TWO_PARTS);
        uploadId = session.uploadId;
      } else {
        const known = kind.listed ? await listed("malware") : { bytes: uniqueBytes(), sha256 };
        sha256 = known.sha256;
        uploadId = (await uploaded(owner, { parentId: folder.id }, known.bytes)).uploadId;
      }
      const row = (await sessionRow(uploadId))!;
      await kind.before?.(folder.id);
      const fault = { armed: false, error: kind.faultInRecheck };
      // Armed by the FIRST read only — the server's hash of the object — so that the fault lands
      // on the re-check's first statement (a later read, e.g. the restore detector's, does not
      // move it).
      let reads = 0;
      const watched = watchedBucket(kind.fail ?? [], {
        get: async () => {
          if (kind.faultInRecheck && reads++ === 0) fault.armed = true;
        },
      });
      const answer = await complete(
        owner,
        uploadId,
        { sha256, parts },
        {
          env: { FILES: watched.bucket },
          ...(kind.faultInRecheck ? { fault } : {}),
          ...(kind.beforeCommit ? { beforeCommit: kind.beforeCommit } : {}),
        },
      );
      expect(answer.status).toBe(kind.status);
      const after = (await sessionRow(uploadId))!;
      if (kind.survives) {
        // Left for the client's retry or the stale-upload job: the session, its key, its bytes.
        expect(after).toMatchObject({ status: "completing", r2Key: row.r2Key });
        expect(watched.calls["delete"] ?? 0).toBe(0);
        expect(watched.calls["upload.abort"] ?? 0).toBe(0);
        if (!kind.multipart) expect(await env.FILES.head(row.r2Key)).not.toBeNull();
        expect(await usedBytes(owner.id)).toBe(kind.multipart ? TWO_PARTS : 1000);
      } else {
        expect(after).toMatchObject({ status: "aborted" });
        expect(await env.FILES.head(row.r2Key)).toBeNull();
        expect(await usedBytes(owner.id)).toBe(0);
      }
    },
    60_000,
  );
});
