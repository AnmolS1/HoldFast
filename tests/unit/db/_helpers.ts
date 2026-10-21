// Shared fixtures for the database tests (node project, real local Postgres).
//
// Postgres is NOT isolated between tests or files: every fixture uses random ids, and no test
// counts a whole table.

import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { type Db, createDb } from "../../../src/worker/db/client";
import type { HoldCause } from "../../../src/worker/db/errors";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  dmcaNoticeNodes,
  dmcaNotices,
  type Node,
  nodes,
  type PauseReason,
  type ScanStatus,
  type ShareLink,
  shareLinks,
  shares,
  type Upload,
  uploads,
  user,
} from "../../../src/worker/db/schema";
import { nameKeyOf, extOf } from "../../../src/worker/services/filename";
import { localDbUrl } from "../../setup/local-env";

/** The `Env` the database layer reads under Node: one binding. */
export function testEnv(): Env {
  return { HYPERDRIVE: { connectionString: localDbUrl() } } as Env;
}

export function openDb(): { db: Db; close: () => Promise<void> } {
  return createDb(testEnv());
}

/**
 * `trimFinished` deletes EVERY finished session past an age, whoever's — so two files that call it
 * (uploads.test.ts, upload-ip.test.ts) delete each other's rows when the node project runs them side
 * by side, and no choice of ages keeps them apart (a row old enough for its own file's trim is old
 * enough for the other file's). A test that makes such rows and calls the trim runs whole under
 * this lock: one session-level advisory lock on a connection of its own, so the tests that touch
 * the table this way take turns across files.
 */
export const TRIM_LOCK = 81_500_301;
export async function withTrimLock<T>(run: () => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: localDbUrl() });
  await client.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [TRIM_LOCK]);
    return await run();
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [TRIM_LOCK]).catch(() => undefined);
    await client.end();
  }
}

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A Better Auth-shaped id: 32 characters of [A-Za-z0-9]. */
export function baId(): string {
  let out = "";
  for (const byte of randomBytes(32)) out += ALNUM[byte % ALNUM.length];
  return out;
}

export const rand = (n = 6): string => randomBytes(n).toString("hex");

export async function makeUser(db: Db, overrides: Partial<typeof user.$inferInsert> = {}): Promise<string> {
  const id = overrides.id ?? baId();
  await db.insert(user).values({
    id,
    name: `Test ${id.slice(0, 6)}`,
    email: `${id.toLowerCase()}@example.test`,
    emailVerified: true,
    ...overrides,
  });
  return id;
}

export async function makeFolder(
  db: Db,
  ownerId: string,
  parentId: string | null,
  name: string,
  overrides: Partial<typeof nodes.$inferInsert> = {},
): Promise<Node> {
  const [row] = await db
    .insert(nodes)
    .values({
      ownerId,
      createdBy: ownerId,
      parentId,
      kind: "folder",
      name,
      nameKey: nameKeyOf(name),
      ext: "",
      scanStatus: "clean",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeFile(
  db: Db,
  ownerId: string,
  parentId: string | null,
  name: string,
  overrides: Partial<typeof nodes.$inferInsert> & { scanStatus?: ScanStatus } = {},
): Promise<Node> {
  const id = overrides.id ?? uuidv7();
  const versionId = overrides.versionId ?? rand(8);
  const [row] = await db
    .insert(nodes)
    .values({
      id,
      ownerId,
      createdBy: ownerId,
      parentId,
      kind: "file",
      name,
      nameKey: nameKeyOf(name),
      ext: extOf(name),
      size: 100,
      r2Key: `u/${ownerId}/${id}/${versionId}`,
      versionId,
      sha256: rand(32),
      scanStatus: "clean",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeLink(
  db: Db,
  nodeId: string,
  createdBy: string,
  overrides: Partial<typeof shareLinks.$inferInsert> & { pauseReasons?: PauseReason[] } = {},
): Promise<ShareLink> {
  const reasons = overrides.pauseReasons ?? [];
  const [row] = await db
    .insert(shareLinks)
    .values({
      nodeId,
      createdBy,
      tokenHash: rand(32),
      tokenEnc: randomBytes(48),
      tokenIv: randomBytes(12),
      pausedAt: reasons.length > 0 ? new Date() : null,
      ...overrides,
      pauseReasons: reasons,
    })
    .returning();
  return row!;
}

export async function makeShare(
  db: Db,
  nodeId: string,
  grantedBy: string,
  grantee: { userId: string } | { email: string },
  overrides: Partial<typeof shares.$inferInsert> = {},
) {
  const active = "userId" in grantee;
  const [row] = await db
    .insert(shares)
    .values({
      nodeId,
      grantedBy,
      granteeEmail: active ? `${grantee.userId.toLowerCase()}@example.test` : grantee.email,
      granteeUserId: active ? grantee.userId : null,
      activatedAt: active ? new Date() : null,
      role: "viewer",
      ...overrides,
    })
    .returning();
  return row!;
}

export async function makeUpload(
  db: Db,
  ownerId: string,
  uploaderId: string,
  overrides: Partial<typeof uploads.$inferInsert> = {},
): Promise<Upload> {
  const nodeId = overrides.nodeId ?? uuidv7();
  const versionId = overrides.versionId ?? rand(8);
  const name = overrides.name ?? `upload-${rand(4)}.bin`;
  const [row] = await db
    .insert(uploads)
    .values({
      ownerId,
      uploaderId,
      parentId: null,
      nodeId,
      versionId,
      name,
      nameKey: nameKeyOf(name),
      size: 1000,
      r2Key: `u/${ownerId}/${nodeId}/${versionId}`,
      expiresAt: new Date(Date.now() + 3_600_000),
      ...overrides,
    })
    .returning();
  return row!;
}

/** Awaits a promise that must reject and returns the error. */
export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/**
 * One file per cause of the purge gate (`HoldCause`), each protected for that cause ALONE, with
 * the way to lift it. The record is keyed by the cause type: a new cause does not compile until
 * it has its fixture here — and with it a row in every test that walks this record.
 * `owner` owns all of them except the `owner_legal_hold` file, whose owner is the held account.
 */
export async function protectedFiles(
  db: Db,
): Promise<{ owner: string; files: Record<HoldCause, { node: Node; release: () => Promise<void> }> }> {
  const owner = await makeUser(db);
  const heldOwner = await makeUser(db, { legalHold: true });
  const file = (ownerId: string, cause: string, overrides: Partial<typeof nodes.$inferInsert> = {}) =>
    makeFile(db, ownerId, null, `${cause}-${rand()}.bin`, overrides);
  const setNode = (id: string, values: Partial<typeof nodes.$inferInsert>) => async () => {
    await db.update(nodes).set(values).where(eq(nodes.id, id));
  };

  const nodeHold = await file(owner, "node_legal_hold", { legalHold: true });
  const ownerHold = await file(heldOwner, "owner_legal_hold");
  const underReview = await file(owner, "under_review", { scanStatus: "under_review" });
  const suspected = await file(owner, "suspected_csam", { scanStatus: "suspected_csam" });
  const noticed = await file(owner, "open_notice");
  const [notice] = await db
    .insert(dmcaNotices)
    .values({ receivedVia: "form", status: "actioned" })
    .returning();
  await db
    .insert(dmcaNoticeNodes)
    .values({ noticeId: notice!.id, nodeId: noticed.id, nodeName: noticed.name });

  return {
    owner,
    files: {
      node_legal_hold: { node: nodeHold, release: setNode(nodeHold.id, { legalHold: false }) },
      owner_legal_hold: {
        node: ownerHold,
        release: async () => {
          await db.update(user).set({ legalHold: false }).where(eq(user.id, heldOwner));
        },
      },
      under_review: { node: underReview, release: setNode(underReview.id, { scanStatus: "clean" }) },
      suspected_csam: { node: suspected, release: setNode(suspected.id, { scanStatus: "clean" }) },
      open_notice: {
        node: noticed,
        release: async () => {
          await db.update(dmcaNotices).set({ status: "closed" }).where(eq(dmcaNotices.id, notice!.id));
        },
      },
    },
  };
}
