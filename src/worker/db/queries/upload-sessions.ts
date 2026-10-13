// Upload sessions: the queries only the upload routes make — a session's creation and reads, its
// part bookkeeping, the node a finished upload becomes. What two or more tasks share (the resume
// lookup, the claim, the terminal states) is in queries/uploads.ts.
//
// Nothing here locks a `user` row. A caller that changes `used_bytes` in the same transaction
// does that FIRST (queries/quota.ts), then calls in here: `user` rows before everything else.

import { and, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUniqueViolation } from "../errors";
import { isUuid } from "../ids";
import { type Node, nodes, type Upload, uploadParts, uploads, user } from "../schema";

const LIVE_NAME_INDEXES = ["nodes_live_name_root_uq", "nodes_live_name_child_uq"] as const;

/** The columns of a node row to insert. */
export type NewNode = typeof nodes.$inferInsert;

export type SessionPart = { n: number; etag: string; size: number };

/** The row, whatever its state and whoever runs it. Whose it is, is the caller's check. */
export async function get(db: Executor, uploadId: string): Promise<Upload | null> {
  if (!isUuid(uploadId)) return null;
  const [row] = await db.select().from(uploads).where(eq(uploads.id, uploadId)).limit(1);
  return row ?? null;
}

/**
 * Inserts an `open` session. For purpose 'file' the caller has reserved `size` bytes on the
 * owner in the same transaction (the row is what holds the reservation from here on).
 */
export async function create(
  tx: Executor,
  session: {
    ownerId: string;
    uploaderId: string;
    parentId: string | null;
    nodeId: string;
    versionId: string;
    replaceNodeId: string | null;
    name: string;
    /** The key of the name the client ASKED for — what a later init is matched on. */
    nameKey: string;
    size: number;
    mimeDeclared: string;
    r2Key: string;
    partBytes: number;
    partCount: number;
    purpose: "file" | "avatar";
    fileLastModified: Date;
    expiresAt: Date;
  },
): Promise<Upload> {
  const [row] = await tx
    .insert(uploads)
    .values({ ...session, status: "open" })
    .returning();
  return row!;
}

/** Records the multipart upload's id on a session that is still `open`. False when it is not. */
export async function setR2UploadId(db: Executor, uploadId: string, r2UploadId: string): Promise<boolean> {
  const rows = await db
    .update(uploads)
    .set({ r2UploadId })
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, "open")))
    .returning({ id: uploads.id });
  return rows.length > 0;
}

/**
 * Records a part the store has accepted; a part uploaded again replaces its row. One statement,
 * and only while the session is `open`: false when it no longer is (nothing is written then).
 */
export async function upsertPart(db: Executor, uploadId: string, part: SessionPart): Promise<boolean> {
  const result = await db.execute(sql`
    INSERT INTO upload_parts (upload_id, part_number, etag, size)
    SELECT ${uploadId}::uuid, ${part.n}, ${part.etag}, ${part.size}
    WHERE EXISTS (SELECT 1 FROM uploads u WHERE u.id = ${uploadId}::uuid AND u.status = 'open')
    ON CONFLICT (upload_id, part_number) DO UPDATE SET etag = EXCLUDED.etag, size = EXCLUDED.size`);
  return (result.rowCount ?? 0) > 0;
}

/** The recorded parts, lowest number first. */
export async function listParts(db: Executor, uploadId: string): Promise<SessionPart[]> {
  return db
    .select({ n: uploadParts.partNumber, etag: uploadParts.etag, size: uploadParts.size })
    .from(uploadParts)
    .where(eq(uploadParts.uploadId, uploadId))
    .orderBy(uploadParts.partNumber);
}

/** The uploader's `open`, unexpired sessions, newest first, each with how many parts it has. */
export async function listOpen(
  db: Executor,
  uploaderId: string,
): Promise<{ session: Upload; uploadedParts: number }[]> {
  const rows = await db
    .select()
    .from(uploads)
    .where(
      and(eq(uploads.uploaderId, uploaderId), eq(uploads.status, "open"), gt(uploads.expiresAt, sql`now()`)),
    )
    .orderBy(sql`${uploads.createdAt} DESC`, uploads.id);
  if (rows.length === 0) return [];
  const counts = await db
    .select({ uploadId: uploadParts.uploadId, n: sql<number>`count(*)`.mapWith(Number) })
    .from(uploadParts)
    .where(
      inArray(
        uploadParts.uploadId,
        rows.map((row) => row.id),
      ),
    )
    .groupBy(uploadParts.uploadId);
  const byId = new Map(counts.map((row) => [row.uploadId, row.n]));
  return rows.map((session) => ({ session, uploadedParts: byId.get(session.id) ?? 0 }));
}

/**
 * `open` → `aborted`, for the session's uploader, and its part rows deleted. False when the
 * session is not `open` (a complete has claimed it, or it is finished): nothing is written then.
 * `uploads.markAborted` also ends a `completing` session — right for the request that owns the
 * claim, wrong for a `DELETE` that races it.
 *
 * The caller releases the reservation FIRST in the same transaction, and rolls back on false.
 */
export async function abortOpen(tx: Executor, uploadId: string, uploaderId: string): Promise<boolean> {
  if (!isUuid(uploadId)) return false;
  return tx.transaction(async (sp) => {
    const rows = await sp
      .update(uploads)
      .set({ status: "aborted", completedAt: sql`now()` })
      .where(and(eq(uploads.id, uploadId), eq(uploads.uploaderId, uploaderId), eq(uploads.status, "open")))
      .returning({ id: uploads.id });
    if (rows.length === 0) return false;
    await sp.delete(uploadParts).where(eq(uploadParts.uploadId, uploadId));
    return true;
  });
}

/** What a daily ceiling scales with, for the owner of the tree being filled. Null: no such user. */
export async function ownerAccount(
  db: Executor,
  ownerId: string,
): Promise<{ quotaBytes: number; createdAt: Date } | null> {
  const [row] = await db
    .select({ quotaBytes: user.quotaBytes, createdAt: user.createdAt })
    .from(user)
    .where(eq(user.id, ownerId))
    .limit(1);
  return row ?? null;
}

const inFolder = (ownerId: string, parentId: string | null) =>
  and(
    eq(nodes.ownerId, ownerId),
    parentId === null ? isNull(nodes.parentId) : eq(nodes.parentId, parentId),
    isNull(nodes.deletedAt),
    isNull(nodes.system),
  );

/**
 * The live node that holds a name in a folder (null = the owner's top level), or null. This is
 * what the unique index sees: a node that is hidden from its owner holds its name too, so what
 * the caller may be TOLD about the holder is the caller's check.
 */
export async function nameHolder(
  db: Executor,
  ownerId: string,
  parentId: string | null,
  nameKey: string,
): Promise<{ id: string; kind: "file" | "folder" } | null> {
  const [row] = await db
    .select({ id: nodes.id, kind: nodes.kind })
    .from(nodes)
    .where(and(inFolder(ownerId, parentId), eq(nodes.nameKey, nameKey)))
    .limit(1);
  return row ?? null;
}

/** Which of these name keys are taken in the folder. */
export async function takenNameKeys(
  db: Executor,
  ownerId: string,
  parentId: string | null,
  nameKeys: readonly string[],
): Promise<Set<string>> {
  if (nameKeys.length === 0) return new Set();
  const rows = await db
    .select({ nameKey: nodes.nameKey })
    .from(nodes)
    .where(and(inFolder(ownerId, parentId), inArray(nodes.nameKey, [...nameKeys])));
  return new Set(rows.map((row) => row.nameKey));
}

/**
 * Inserts the node a finished upload becomes. Runs in a savepoint: null when the name is taken
 * in that folder (the caller's transaction is still usable and it tries the next name); any
 * other failure is thrown.
 */
export async function insertFileNode(tx: Executor, node: NewNode): Promise<Node | null> {
  try {
    return await tx.transaction(async (sp) => {
      const [row] = await sp
        .insert(nodes)
        .values({ ...node, kind: "file" })
        .returning();
      return row!;
    });
  } catch (error) {
    if (isUniqueViolation(error, LIVE_NAME_INDEXES)) return null;
    throw error;
  }
}

/** Points the user at their new avatar node. Takes the `user` row: call it before other writes. */
export async function setAvatarNode(tx: Executor, userId: string, nodeId: string): Promise<void> {
  await tx.update(user).set({ avatarNodeId: nodeId }).where(eq(user.id, userId));
}
