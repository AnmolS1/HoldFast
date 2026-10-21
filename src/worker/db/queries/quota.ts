// Storage accounting on `user.used_bytes`.
//
// What counts: every file node (trashed, taken down and quarantined ones included), every kept
// old version, and every `open` / `completing` upload session of purpose 'file' (a reservation).
// Avatars (`system = 'avatar'`) never count. Hidden and held bytes count on purpose: the number
// does not move when a file is hidden, so the meter reveals nothing.
//
// TWO FIGURES (T23 review M2, brief Addenda 3-5). `used_bytes` is the operator's: it keeps what
// is still stored of the roots the owner deleted for good (the purge-requested subtrees: their
// files and old versions — what the purge would give back), whatever keeps them there — a legal
// hold, a review, a notice, or a purge that has simply not run yet. The ACCOUNT HOLDER's figure
// leaves ALL of those out: the request to delete for good is the holder's act, and what keeps the
// bytes is not theirs to see — so placing or lifting a hold, or a review ending, never moves it
// (Addendum 5, reversing Addendum 4's legal-hold-only rule). That figure is the one everywhere the
// holder meets one: the room `reserve` gives (enforcement), GET /api/account/usage and the data
// export. It is DERIVED from the rows (`deletedKeptBytes`), never kept in a counter of its own — so
// releasing, purging and the reconcile formula are untouched, and the purge, whenever it runs,
// gives the bytes back exactly once (they leave the stored counter and the derived set together).
// THE BACKSTOP (Addenda 4-5). Left out without a bound, "upload, delete forever, upload again"
// would let an account whose deletions are kept store without limit. Past KEPT_MAX_QUOTAS × its
// quota of such bytes, `reserve` refuses as for a full account — the ordinary answer, no other
// signal — and the account is shown full (`holderUsage`). It never stores more than its quota
// plus that multiple of it (one last upload past the line included).

import { eq, sql, type SQL } from "drizzle-orm";
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
  // The fit is judged on the account holder's figure: what is still kept of what they deleted
  // for good is not theirs to be refused for — up to the backstop (see the header).
  const kept = deletedKeptBytesSql(ownerId);
  const rows = await tx
    .update(user)
    .set({ usedBytes: sql`${user.usedBytes} + ${bytes}` })
    .where(
      sql`${user.id} = ${ownerId}
        AND ${kept} <= ${KEPT_MAX_QUOTAS} * ${user.quotaBytes}
        AND ${user.usedBytes} - ${kept} + ${bytes} <= ${user.quotaBytes}`,
    )
    .returning({ id: user.id });
  return rows.length > 0;
}

/** How many quotas of kept deleted-for-good bytes an account may carry before it is answered as full. */
export const KEPT_MAX_QUOTAS = 2;

/** True when the account carries more kept deleted-for-good bytes than the backstop allows. */
export async function keptBackstopReached(db: Executor, ownerId: string): Promise<boolean> {
  const result = await db.execute<{ reached: boolean }>(sql`
    SELECT (${deletedKeptBytesSql(ownerId)} > ${KEPT_MAX_QUOTAS} * u.quota_bytes) AS reached
    FROM "user" u WHERE u.id = ${ownerId}`);
  return result.rows[0]?.reached === true;
}

/**
 * The accounts past the backstop NOW — kept deleted-for-good bytes above `KEPT_MAX_QUOTAS` × their
 * quota, by the same expression `keptBackstopReached` and `reserve` use — ascending by id, at most
 * `limit`. For the backup job's daily state alarm (T27 R-6/R-8). One statement: only accounts with
 * a purge-requested root are looked at, each with its own correlated kept-tree.
 */
export async function ownersPastKeptBackstop(db: Executor, opts: { limit: number }): Promise<string[]> {
  const limit = Math.max(1, Math.min(1000, Math.trunc(opts.limit)));
  const result = await db.execute<{ id: string }>(sql`
    SELECT u.id FROM "user" u
    WHERE EXISTS (SELECT 1 FROM nodes p WHERE p.owner_id = u.id AND p.purge_requested_at IS NOT NULL)
      AND ${deletedKeptBytesSql(sql`u.id`)} > ${KEPT_MAX_QUOTAS} * u.quota_bytes
    ORDER BY u.id
    LIMIT ${limit}`);
  return result.rows.map((row) => row.id);
}

/**
 * Every root the owner deleted for good that is still stored (`purge_requested_at` set — a purged
 * root's rows are gone), and everything under it, once each — nested requested roots included
 * once. (Inside, the name `asked` is taken.)
 */
const deletedKeptTree = (ownerId: string | SQL) => sql`
  WITH RECURSIVE asked(id) AS (
    SELECT n.id FROM nodes n
    WHERE n.owner_id = ${ownerId} AND n.purge_requested_at IS NOT NULL
    UNION
    SELECT c.id FROM nodes c JOIN asked ON c.parent_id = asked.id
  )`;

const keptFilesSql = sql`(SELECT COALESCE(SUM(n.size), 0) FROM nodes n JOIN asked a ON a.id = n.id
  WHERE n.kind = 'file' AND n.system IS NULL)`;
const keptVersionsSql = sql`(SELECT COALESCE(SUM(v.size), 0) FROM node_versions v JOIN asked a ON a.id = v.node_id)`;

/** `deletedKeptBytes` as one SQL expression (bigint), for a statement of its own. */
function deletedKeptBytesSql(ownerId: string | SQL) {
  return sql`(
    ${deletedKeptTree(ownerId)}
    SELECT ${keptFilesSql} + ${keptVersionsSql}
  )::bigint`;
}

/**
 * The bytes `used_bytes` keeps of what the owner deleted for good and is still stored — the files
 * and the kept old versions — apart. 0 and 0 for an account with none. What the account holder is
 * shown and given leaves them out, up to the backstop (see the header).
 */
export async function deletedKeptBytes(
  db: Executor,
  ownerId: string,
): Promise<{ files: number; versions: number }> {
  const result = await db.execute<{ files: string; versions: string }>(sql`
    ${deletedKeptTree(ownerId)}
    SELECT ${keptFilesSql}::bigint AS files, ${keptVersionsSql}::bigint AS versions`);
  const row = result.rows[0];
  return { files: Number(row?.files ?? 0), versions: Number(row?.versions ?? 0) };
}

/**
 * The account holder's usage: the operator's breakdown without the kept deleted-for-good bytes
 * (trash: the files, versions: their old versions). ONE RULE past the backstop: the account is
 * shown full — `usedBytes` is raised to the quota and the difference is added to `filesBytes`,
 * so the four parts still add up to `usedBytes`, as an ordinary full account's do.
 */
export function holderUsage(
  usage: UsageBreakdown,
  kept: { files: number; versions: number },
): UsageBreakdown {
  const trashBytes = Math.max(0, usage.trashBytes - kept.files);
  const versionsBytes = Math.max(0, usage.versionsBytes - kept.versions);
  const below = Math.max(0, usage.usedBytes - kept.files - kept.versions);
  const usedBytes = holderUsedBytes(usage.usedBytes, kept.files + kept.versions, usage.quotaBytes);
  // Shown full past the backstop: the difference is files, so the parts still add up.
  const filesBytes = usage.filesBytes + (usedBytes - below);
  return { ...usage, usedBytes, filesBytes, trashBytes, versionsBytes };
}

/** The holder's used figure alone (the export): the counter without `kept` — at least the quota past the backstop. */
export function holderUsedBytes(stored: number, kept: number, quotaBytes: number): number {
  const below = Math.max(0, stored - kept);
  return kept > KEPT_MAX_QUOTAS * quotaBytes ? Math.max(below, quotaBytes) : below;
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
