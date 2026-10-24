// Upload sessions: the helpers two or more tasks share. Session creation, reads and part
// bookkeeping live in the upload task's own module.
//
// A session of purpose 'file' in `open` or `completing` holds a quota reservation of `size`
// bytes on its OWNER. These helpers never touch `used_bytes` themselves, with one exception
// (`deleteForUser`, which says so): the caller releases with `quota.release` in the same
// transaction as the status change.

import { and, eq, gt, inArray, isNull, lt, lte, ne, not, or, sql, type SQL } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { type Upload, uploadParts, uploads, user } from "../schema";
import { nodeProtected, userHeld } from "./holds";

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

/**
 * A session that can still finish: `open` and not past `expiresAt`, or `completing` and not yet
 * `COMPLETING_STALE_MINUTES` old (a closed tab during the avatar's wait leaves one; the stale-uploads
 * job ends those — hourly on prod, never on dev, R1 func-13). The rest are left to the jobs.
 */
const STILL_RUNNING = or(
  and(eq(uploads.status, "open"), gt(uploads.expiresAt, sql`now()`)),
  and(
    eq(uploads.status, "completing"),
    sql`COALESCE(${uploads.completingAt}, ${uploads.createdAt}) >= now() - make_interval(mins => ${COMPLETING_STALE_MINUTES})`,
  ),
)!;

/** The uploader's sessions that can still finish (the open-session cap). */
export async function countOpen(db: Executor, uploaderId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(uploads)
    .where(and(eq(uploads.uploaderId, uploaderId), STILL_RUNNING));
  return row?.n ?? 0;
}

/**
 * Is a new version of this file being uploaded right now — a session that can still finish,
 * replacing it, by anyone (R1 func-7)? A resume of the caller's own session never asks.
 */
export async function replaceUnderWay(db: Executor, replaceNodeId: string): Promise<boolean> {
  if (!isUuid(replaceNodeId)) return false;
  const [row] = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(and(eq(uploads.replaceNodeId, replaceNodeId), STILL_RUNNING))
    .limit(1);
  return row !== undefined;
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

/**
 * What EVERY move of a session to a terminal status writes, in its own UPDATE: the status, when,
 * and the uploader's sealed address cleared — it is kept only while the session is unfinished
 * (the repair sweep reads it from a `completing` one), never longer than `upload_ips` keeps it.
 * A terminal UPDATE of `uploads` sets `ended(…)`, never a status of its own
 * (tests/unit/db/upload-ip.test.ts scans for one).
 */
export function ended(status: "done" | "aborted") {
  return { status, completedAt: sql`now()`, ipEncrypted: null, ipIv: null, ipKeyVersion: null };
}

/**
 * A sealed address in its three parts — the shape of `Sealed` in services/tokens.ts (`sealIp`
 * returns it, `openIp` takes it). Not imported from there: a query module stays free of the
 * Workers runtime types that module needs (the db tests type-check without them).
 */
export type SealedIp = { ciphertext: Uint8Array; iv: Uint8Array; keyVersion: number };

/**
 * The uploader's address as init sealed it on the session — the three parts `openIp` and
 * `uploadIps.record` take — or null: a session from before the column, a finished one (cleared),
 * or a partial triple, which is never handed on.
 */
export function sealedIpOf(session: Pick<Upload, "ipEncrypted" | "ipIv" | "ipKeyVersion">): SealedIp | null {
  const { ipEncrypted, ipIv, ipKeyVersion } = session;
  if (ipEncrypted === null || ipIv === null || ipKeyVersion === null) return null;
  return { ciphertext: ipEncrypted, iv: ipIv, keyVersion: ipKeyVersion };
}

/** Terminal: the session's node exists. False when the session was already finished. */
export async function markDone(tx: Executor, uploadId: string): Promise<boolean> {
  if (!isUuid(uploadId)) return false;
  const rows = await tx
    .update(uploads)
    .set(ended("done"))
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
      .set(ended("aborted"))
      .where(and(eq(uploads.id, uploadId), inArray(uploads.status, [...UNFINISHED])))
      .returning({ id: uploads.id });
    if (rows.length === 0) return false;
    await sp.delete(uploadParts).where(eq(uploadParts.uploadId, uploadId));
    return true;
  });
}

/**
 * Sessions the stale-upload job should look at: `open` past `expiresAt`, and `completing` for
 * more than an hour (its request died between the claim and the commit) — except one that owes
 * a locked node (`owesLockedNode`), which the repair sweep owns.
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
          // A session that owes a locked node is never the stale job's to abort: the repair
          // sweep (T22) owns it — its object is verified bytes that must be preserved.
          not(owesLockedNode()),
        ),
      ),
    )
    .orderBy(uploads.expiresAt, uploads.id)
    .limit(limit);
}

/** How long a finished (`done` / `aborted`) session is kept before `trimFinished` deletes it. */
export const FINISHED_TRIM_DAYS = 7;

/**
 * Deletes finished (`done` / `aborted`) sessions that ended more than `olderThanDays` ago, at
 * most `limit` per call. Returns how many were deleted.
 * A session is kept while its owner or its uploader is on legal hold, or while the node it wrote
 * is one the purge gate protects (queries/holds.ts: a hold, `under_review`, `suspected_csam`, an
 * open notice).
 */
export async function trimFinished(
  db: Executor,
  olderThanDays: number = FINISHED_TRIM_DAYS,
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
        not(userHeld(sql`${uploads.ownerId}`)),
        not(userHeld(sql`${uploads.uploaderId}`)),
        not(nodeProtected(sql`${uploads.nodeId}`)),
      ),
    )
    .limit(limit);
  const rows = await db.delete(uploads).where(inArray(uploads.id, doomed)).returning({ id: uploads.id });
  return rows.length;
}

/**
 * A `completing` session that is the REPAIR SWEEP's (T22), never the stale job's to end blindly:
 *   - the hash on the session is listed — with ANY reason (Addendum 3, m5). The uploads route
 *     writes the server's csam hash there when it owes a locked node (Addendum 2); otherwise it is
 *     the client's declaration, and a request that died (or a database that failed) between the
 *     server's hash and its decision may have left verified bytes behind a declaration listed for
 *     another reason. The sweep hashes the stored bytes first and branches on THAT: csam → the
 *     locked node; another reason → the route's refusal; not listed → ended as any stale session;
 *   - or the route recorded `upload.csam_node_owed` for it (Addendum 2's backstop).
 * Decided when the statement runs, so an entry listed meanwhile counts.
 */
export function owesLockedNode(): SQL {
  return sql`(${uploads.status} = 'completing' AND (
    (${uploads.expectedSha256} IS NOT NULL
      AND EXISTS (SELECT 1 FROM hash_blocklist b WHERE b.sha256 = ${uploads.expectedSha256}))
    OR EXISTS (SELECT 1 FROM audit_log a
               WHERE a.action = 'upload.csam_node_owed' AND a.target_type = 'upload'
                 AND a.target_id = ${uploads.id}::text)))`;
}

/**
 * Removes every session in which the user is owner OR uploader — the step the user-purge job
 * runs before the hard delete, because both references are RESTRICT. Returns the unfinished
 * sessions' objects, still to abort in storage.
 *
 * This one helper does touch `used_bytes`: an unfinished session the user ran in ANOTHER
 * owner's folder holds a reservation on that owner, who stays; it is released here.
 *
 * WHAT A HOLD PROTECTS STAYS: a session whose owner or uploader is on legal hold, or whose node
 * is one the purge gate protects (queries/holds.ts), is not deleted — a held account is not
 * purged at all, so in practice this is the OTHER party's hold (the user uploaded into a held
 * owner's folder, or a held editor uploaded into the user's) or a node under review, locked or
 * under an open notice. Such a row still references the user, so the `user` row cannot be
 * deleted yet: `remainingForUser` says how many are left, and the purge job waits (`defer`).
 *
 * SO DOES EVERY `completing` SESSION: a request is working on its object right now (hashing it;
 * one whose declared hash is listed as csam owes a LOCKED node for verified bytes — the uploads
 * route, or the repair sweep, writes it). Its row is kept (it cannot be detached: `owner_id` and
 * `uploader_id` are NOT NULL, RESTRICT — so the user row waits, as for a hold), its object is
 * NOT returned to abort and its reservation is not released here. When the request ends it
 * (done or aborted) the next run deletes it; a request that died leaves it to the stale-upload
 * job (`expired`) — except an owed one, which the repair sweep owns. Once an owed node is
 * written the csam lock holds the owner and the uploader, and the account is not purged at all.
 */
export async function deleteForUser(
  db: Executor,
  userId: string,
): Promise<{ r2Key: string; r2UploadId: string | null }[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .delete(uploads)
      .where(
        and(
          or(eq(uploads.ownerId, userId), eq(uploads.uploaderId, userId)),
          not(userHeld(sql`${uploads.ownerId}`)),
          not(userHeld(sql`${uploads.uploaderId}`)),
          not(nodeProtected(sql`${uploads.nodeId}`)),
          ne(uploads.status, "completing"),
        ),
      )
      .returning({
        ownerId: uploads.ownerId,
        status: uploads.status,
        purpose: uploads.purpose,
        size: uploads.size,
        r2Key: uploads.r2Key,
        r2UploadId: uploads.r2UploadId,
      });
    const unfinished = rows.filter((r) => r.status === "open");
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

/**
 * Sessions that still name the user as owner or uploader — after `deleteForUser`, the ones a
 * hold protects. While this is not zero the `user` row cannot be deleted (both references are
 * RESTRICT) and the purge must wait.
 */
export async function remainingForUser(db: Executor, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(uploads)
    .where(or(eq(uploads.ownerId, userId), eq(uploads.uploaderId, userId)));
  return row?.n ?? 0;
}
