// Upload sessions: the helpers two or more tasks share. Session creation, reads and part
// bookkeeping live in the upload task's own module.
//
// A session of purpose 'file' in `open` or `completing` holds a quota reservation of `size`
// bytes on its OWNER. These helpers never touch `used_bytes` themselves, with one exception
// (`deleteForUser`, which says so): the caller releases with `quota.release` in the same
// transaction as the status change.

import { and, eq, gt, inArray, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type Upload, uploadParts, uploads, user } from "../schema";

/** A `completing` session older than this is considered abandoned by its request. */
export const COMPLETING_STALE_MINUTES = 60;

const UNFINISHED = ["open", "completing"] as const;

/**
 * The session a client may resume: `open`, not expired, and equal in all seven fields. A null
 * `parentId`, `replaceNodeId` or `fileLastModified` matches only null.
 */
export async function findResumable(
  db: Executor,
  match: {
    uploaderId: string;
    parentId: string | null;
    nameKey: string;
    size: number;
    fileLastModified: Date | null;
    purpose: "file" | "avatar";
    replaceNodeId: string | null;
  },
): Promise<Upload | null> {
  const nullable = <T>(column: SQL, value: T | null): SQL =>
    value === null ? sql`${column} IS NULL` : sql`${column} = ${value}`;
  const [row] = await db
    .select()
    .from(uploads)
    .where(
      and(
        eq(uploads.status, "open"),
        eq(uploads.uploaderId, match.uploaderId),
        nullable(sql`${uploads.parentId}`, match.parentId),
        eq(uploads.nameKey, match.nameKey),
        eq(uploads.size, match.size),
        match.fileLastModified === null
          ? isNull(uploads.fileLastModified)
          : eq(uploads.fileLastModified, match.fileLastModified),
        eq(uploads.purpose, match.purpose),
        nullable(sql`${uploads.replaceNodeId}`, match.replaceNodeId),
        gt(uploads.expiresAt, sql`now()`),
      ),
    )
    .orderBy(sql`${uploads.createdAt} DESC`)
    .limit(1);
  return row ?? null;
}

/** The uploader's sessions in `open` or `completing` (the open-session cap). */
export async function countOpen(db: Executor, uploaderId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(uploads)
    .where(and(eq(uploads.uploaderId, uploaderId), inArray(uploads.status, [...UNFINISHED])));
  return row?.n ?? 0;
}

/**
 * Bytes and count of unfinished 'file' sessions — the part of a daily upload ceiling that is
 * promised but not yet recorded in the ledger.
 *   `{ ownerId }`  — sessions filling that owner's storage, whoever uploads;
 *   `{ editorId }` — sessions that user runs in OTHER owners' folders.
 */
export async function openBytes(
  db: Executor,
  who: { ownerId: string } | { editorId: string },
): Promise<{ bytes: number; count: number }> {
  const subject =
    "ownerId" in who
      ? eq(uploads.ownerId, who.ownerId)
      : and(eq(uploads.uploaderId, who.editorId), ne(uploads.ownerId, who.editorId));
  const [row] = await db
    .select({
      bytes: sql<number>`COALESCE(SUM(${uploads.size}), 0)`.mapWith(Number),
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(uploads)
    .where(and(subject, eq(uploads.purpose, "file"), inArray(uploads.status, [...UNFINISHED])));
  return { bytes: row?.bytes ?? 0, count: row?.count ?? 0 };
}

/**
 * `open` → `completing`, atomically and only for the session's uploader. Returns the claimed
 * row; null = someone else is completing it, it is finished, or the caller is not the uploader.
 */
export async function claimCompleting(
  db: Executor,
  uploadId: string,
  uploaderId: string,
): Promise<Upload | null> {
  if (!isUuid(uploadId)) return null;
  const [row] = await db
    .update(uploads)
    .set({ status: "completing", completingAt: sql`now()` })
    .where(and(eq(uploads.id, uploadId), eq(uploads.uploaderId, uploaderId), eq(uploads.status, "open")))
    .returning();
  return row ?? null;
}

/** Terminal: the session's node exists. False when the session was already finished. */
export async function markDone(tx: Executor, uploadId: string): Promise<boolean> {
  if (!isUuid(uploadId)) return false;
  const rows = await tx
    .update(uploads)
    .set({ status: "done", completedAt: sql`now()` })
    .where(and(eq(uploads.id, uploadId), inArray(uploads.status, [...UNFINISHED])))
    .returning({ id: uploads.id });
  return rows.length > 0;
}

/**
 * Terminal: the session is abandoned; its part rows are deleted. False when the session was
 * already finished (so a caller releases the reservation only on true).
 */
export async function markAborted(tx: Executor, uploadId: string): Promise<boolean> {
  if (!isUuid(uploadId)) return false;
  return tx.transaction(async (sp) => {
    const rows = await sp
      .update(uploads)
      .set({ status: "aborted", completedAt: sql`now()` })
      .where(and(eq(uploads.id, uploadId), inArray(uploads.status, [...UNFINISHED])))
      .returning({ id: uploads.id });
    if (rows.length === 0) return false;
    await sp.delete(uploadParts).where(eq(uploadParts.uploadId, uploadId));
    return true;
  });
}

/**
 * Sessions the stale-upload job should look at: `open` past `expiresAt`, and `completing` for
 * more than an hour (its request died between the claim and the commit).
 */
export async function expired(db: Executor, limit: number): Promise<Upload[]> {
  return db
    .select()
    .from(uploads)
    .where(
      or(
        and(eq(uploads.status, "open"), lte(uploads.expiresAt, sql`now()`)),
        and(
          eq(uploads.status, "completing"),
          sql`COALESCE(${uploads.completingAt}, ${uploads.createdAt}) < now() - make_interval(mins => ${COMPLETING_STALE_MINUTES})`,
        ),
      ),
    )
    .orderBy(uploads.expiresAt, uploads.id)
    .limit(limit);
}

/**
 * Deletes finished (`done` / `aborted`) sessions that ended more than `olderThanDays` ago, at
 * most `limit` per call. Returns how many were deleted.
 */
export async function trimFinished(
  db: Executor,
  olderThanDays: number = 7,
  limit: number = 5000,
): Promise<number> {
  const doomed = db
    .select({ id: uploads.id })
    .from(uploads)
    .where(
      and(
        inArray(uploads.status, ["done", "aborted"]),
        lt(
          sql`COALESCE(${uploads.completedAt}, ${uploads.createdAt})`,
          sql`now() - make_interval(days => ${olderThanDays})`,
        ),
      ),
    )
    .limit(limit);
  const rows = await db.delete(uploads).where(inArray(uploads.id, doomed)).returning({ id: uploads.id });
  return rows.length;
}

/**
 * Removes every session in which the user is owner OR uploader — the step the user-purge job
 * runs before the hard delete, because both references are RESTRICT. Returns the unfinished
 * sessions' objects, still to abort in storage.
 *
 * This one helper does touch `used_bytes`: an unfinished session the user ran in ANOTHER
 * owner's folder holds a reservation on that owner, who stays; it is released here.
 */
export async function deleteForUser(
  db: Executor,
  userId: string,
): Promise<{ r2Key: string; r2UploadId: string | null }[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(uploads)
      .where(or(eq(uploads.ownerId, userId), eq(uploads.uploaderId, userId)))
      .returning({
        ownerId: uploads.ownerId,
        status: uploads.status,
        purpose: uploads.purpose,
        size: uploads.size,
        r2Key: uploads.r2Key,
        r2UploadId: uploads.r2UploadId,
      });
    const unfinished = rows.filter((r) => r.status === "open" || r.status === "completing");
    const owed = new Map<string, number>();
    for (const row of unfinished) {
      if (row.ownerId !== userId && row.purpose === "file")
        owed.set(row.ownerId, (owed.get(row.ownerId) ?? 0) + row.size);
    }
    for (const ownerId of [...owed.keys()].sort()) {
      await tx
        .update(user)
        .set({ usedBytes: sql`GREATEST(${user.usedBytes} - ${owed.get(ownerId)!}, 0)` })
        .where(eq(user.id, ownerId));
    }
    return unfinished.map((r) => ({ r2Key: r.r2Key, r2UploadId: r.r2UploadId }));
  });
}
