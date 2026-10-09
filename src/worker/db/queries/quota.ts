// Storage accounting on `user.used_bytes`.
//
// What counts: every file node (trashed, taken down and quarantined ones included), every kept
// old version, and every `open` / `completing` upload session of purpose 'file' (a reservation).
// Avatars (`system = 'avatar'`) never count. Hidden and held bytes count on purpose: the number
// does not move when a file is hidden, so the meter reveals nothing.

import { eq, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { QueryError } from "../errors";
import { user } from "../schema";

function assertBytes(bytes: number): void {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new QueryError("validation", "invalid byte count");
}

/**
 * Reserves space: one atomic conditional UPDATE, so concurrent reservations can never take
 * `used_bytes` past `quota_bytes`. False = it does not fit (or no such user).
 *
 * Make it the FIRST statement of the caller's transaction: it takes the `user` row lock, and
 * every other writer of the accounting (reconcile, purge) locks that row first too.
 */
export async function reserve(tx: Executor, ownerId: string, bytes: number): Promise<boolean> {
  assertBytes(bytes);
  const rows = await tx
    .update(user)
    .set({ usedBytes: sql`${user.usedBytes} + ${bytes}` })
    .where(sql`${user.id} = ${ownerId} AND ${user.usedBytes} + ${bytes} <= ${user.quotaBytes}`)
    .returning({ id: user.id });
  return rows.length > 0;
}

/** Gives bytes back (an aborted session, purged rows). Never goes below zero. */
export async function release(tx: Executor, ownerId: string, bytes: number): Promise<void> {
  assertBytes(bytes);
  if (bytes === 0) return;
  await tx
    .update(user)
    .set({ usedBytes: sql`GREATEST(${user.usedBytes} - ${bytes}, 0)` })
    .where(eq(user.id, ownerId));
}

/**
 * A completed upload: the reservation becomes the node. There is no arithmetic — the bytes were
 * counted at `reserve` and keep being counted through the node row. Kept so that every upload
 * path names the three steps (reserve, then commit or release).
 */
export async function commit(tx: Executor, ownerId: string, bytes: number): Promise<void> {
  void tx;
  void ownerId;
  assertBytes(bytes);
}

const nodesBytes = (ownerId: string) => sql`
  (SELECT COALESCE(SUM(n.size), 0) FROM nodes n
   WHERE n.owner_id = ${ownerId} AND n.kind = 'file' AND n.system IS NULL)`;

const versionsBytes = (ownerId: string) => sql`
  (SELECT COALESCE(SUM(v.size), 0) FROM node_versions v JOIN nodes n ON n.id = v.node_id
   WHERE n.owner_id = ${ownerId} AND n.system IS NULL)`;

const reservedBytes = (ownerId: string) => sql`
  (SELECT COALESCE(SUM(u.size), 0) FROM uploads u
   WHERE u.owner_id = ${ownerId} AND u.purpose = 'file' AND u.status IN ('open', 'completing'))`;

/** The reconcile formula: what `used_bytes` should be, from the rows. */
export async function computeUsedBytes(db: Executor, ownerId: string): Promise<number> {
  const result = await db.execute<{ total: string }>(
    sql`SELECT (${nodesBytes(ownerId)} + ${versionsBytes(ownerId)} + ${reservedBytes(ownerId)})::bigint AS total`,
  );
  return Number(result.rows[0]!.total);
}

/**
 * Rewrites `used_bytes` from the rows, under the `user` row lock, and only when it differs.
 * Returns both values; `delta` is `after - before`. Null when there is no such user.
 */
export async function reconcileUsedBytes(
  tx: Executor,
  ownerId: string,
): Promise<{ before: number; after: number; delta: number } | null> {
  return tx.transaction(async (sp) => {
    const [row] = await sp
      .select({ usedBytes: user.usedBytes })
      .from(user)
      .where(eq(user.id, ownerId))
      .for("update");
    if (!row) return null;
    const after = await computeUsedBytes(sp, ownerId);
    if (after !== row.usedBytes) {
      await sp
        .update(user)
        .set({ usedBytes: sql`${after}::bigint` })
        .where(eq(user.id, ownerId));
    }
    return { before: row.usedBytes, after, delta: after - row.usedBytes };
  });
}

export type UsageBreakdown = {
  /** The stored counter: what the quota is checked against. */
  usedBytes: number;
  quotaBytes: number;
  /** Files outside the trash (hidden ones included). */
  filesBytes: number;
  /** Files in the trash, directly or under a trashed folder. */
  trashBytes: number;
  /** Old versions kept after a Replace. */
  versionsBytes: number;
  /** Uploads in progress. */
  reservedBytes: number;
};

/** Null when there is no such user. */
export async function usageBreakdown(db: Executor, ownerId: string): Promise<UsageBreakdown | null> {
  const result = await db.execute<{
    used_bytes: string;
    quota_bytes: string;
    all_files: string;
    trash: string;
    versions: string;
    reserved: string;
  }>(sql`
    WITH RECURSIVE trashed(id) AS (
      SELECT n.id FROM nodes n WHERE n.owner_id = ${ownerId} AND n.deleted_at IS NOT NULL
      UNION
      SELECT c.id FROM nodes c JOIN trashed ON c.parent_id = trashed.id
    )
    SELECT u.used_bytes, u.quota_bytes,
           ${nodesBytes(ownerId)} AS all_files,
           (SELECT COALESCE(SUM(n.size), 0) FROM nodes n JOIN trashed t ON t.id = n.id
            WHERE n.kind = 'file' AND n.system IS NULL) AS trash,
           ${versionsBytes(ownerId)} AS versions,
           ${reservedBytes(ownerId)} AS reserved
    FROM "user" u WHERE u.id = ${ownerId}`);
  const row = result.rows[0];
  if (!row) return null;
  const trashBytes = Number(row.trash);
  return {
    usedBytes: Number(row.used_bytes),
    quotaBytes: Number(row.quota_bytes),
    filesBytes: Number(row.all_files) - trashBytes,
    trashBytes,
    versionsBytes: Number(row.versions),
    reservedBytes: Number(row.reserved),
  };
}
