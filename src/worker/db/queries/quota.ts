// Storage accounting on `user.used_bytes`.
//
// What counts: every file node (trashed, taken down and quarantined ones included), every kept
// old version, and every `open` / `completing` upload session of purpose 'file' (a reservation).
// Avatars (`system = 'avatar'`) never count. Hidden and held bytes count on purpose: the number
// does not move when a file is hidden, so the meter reveals nothing.
//
// TWO FIGURES (T23 review M2, brief Addenda 3 and 4). `used_bytes` is the operator's: it keeps
// what a hold keeps of a root its owner deleted for good (the purge-requested subtrees: their
// files and old versions — what the purge would have given back). The ACCOUNT HOLDER's figure
// leaves out the part a LEGAL HOLD keeps — and only that part: bytes kept for any other reason
// (a file under review, suspected CSAM, an open notice) are visible states of the owner's own
// files and keep counting, as before. That figure is the one everywhere the holder meets one:
// the room `reserve` gives (enforcement), GET /api/account/usage and the data export. It is
// DERIVED from the held rows (`legalHoldKeptBytes`), never kept in a counter of its own — so
// releasing, purging and the reconcile formula are untouched, and the purge that runs once the
// hold is lifted gives the bytes back exactly once.
// THE BACKSTOP (Addendum 4). Left out without a bound, "upload, delete forever, upload again"
// would let a held account store without limit. Past HOLD_KEPT_MAX_QUOTAS × its quota of
// hold-kept bytes, `reserve` refuses as for a full account — the ordinary answer, no other
// signal — and the account is shown full (`visibleUsedBytes`). So it never stores more than
// its quota plus that multiple of it (one last upload past the line included).

import { eq, sql } from "drizzle-orm";
import { inheritedCauses } from "./holds";
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
  // The fit is judged on the account holder's figure: what a legal hold keeps of what they
  // deleted for good is not theirs to be refused for — up to the backstop (see the header).
  const kept = legalHoldKeptBytesSql(ownerId);
  const rows = await tx
    .update(user)
    .set({ usedBytes: sql`${user.usedBytes} + ${bytes}` })
    .where(
      sql`${user.id} = ${ownerId}
        AND ${kept} <= ${HOLD_KEPT_MAX_QUOTAS} * ${user.quotaBytes}
        AND ${user.usedBytes} - ${kept} + ${bytes} <= ${user.quotaBytes}`,
    )
    .returning({ id: user.id });
  return rows.length > 0;
}

/** How many quotas of hold-kept bytes an account may carry before it is answered as full. */
export const HOLD_KEPT_MAX_QUOTAS = 2;

/**
 * The account holder's used figure: the stored counter without the hold-kept bytes — or, past the
 * backstop, a full account (at least the quota), as `reserve` answers it.
 */
export function visibleUsedBytes(stored: number, kept: number, quotaBytes: number): number {
  const shown = Math.max(0, stored - kept);
  return kept > HOLD_KEPT_MAX_QUOTAS * quotaBytes ? Math.max(shown, quotaBytes) : shown;
}

/** True when the account carries more hold-kept bytes than the backstop allows. */
export async function holdBackstopReached(db: Executor, ownerId: string): Promise<boolean> {
  const result = await db.execute<{ reached: boolean }>(sql`
    SELECT (${legalHoldKeptBytesSql(ownerId)} > ${HOLD_KEPT_MAX_QUOTAS} * u.quota_bytes) AS reached
    FROM "user" u WHERE u.id = ${ownerId}`);
  return result.rows[0]?.reached === true;
}

/**
 * The rows a LEGAL HOLD keeps of what the owner deleted for good: every purge-requested root the
 * hold protects — the owner is held, or the root, a folder above it or anything under it carries
 * a node hold (the gate keeps the root whole) — and everything under those roots, once each.
 * (Inside, the names `tree`, `kept_roots`, `asked`, `kr`, `ko`, `kx`, `held_up`, `ha`, `hp` are taken.)
 */
const legalHoldKeptTree = (ownerId: string) => sql`
  WITH RECURSIVE tree(root, id) AS (
    SELECT n.id, n.id FROM nodes n
    WHERE n.owner_id = ${ownerId} AND n.purge_requested_at IS NOT NULL
    UNION
    SELECT tree.root, c.id FROM nodes c JOIN tree ON c.parent_id = tree.id
  ),
  kept_roots AS (
    SELECT kr.id FROM nodes kr JOIN "user" ko ON ko.id = kr.owner_id
    WHERE kr.id IN (SELECT root FROM tree)
      AND (ko.legal_hold OR kr.legal_hold OR ${inheritedCauses(sql`kr`).node_legal_hold}
        OR EXISTS (SELECT 1 FROM tree t2 JOIN nodes kx ON kx.id = t2.id WHERE t2.root = kr.id AND kx.legal_hold))
  ),
  asked AS (SELECT DISTINCT tree.id FROM tree JOIN kept_roots ON kept_roots.id = tree.root)`;

/** `legalHoldKeptBytes` as one SQL expression (bigint), for a statement of its own. */
function legalHoldKeptBytesSql(ownerId: string) {
  return sql`(
    ${legalHoldKeptTree(ownerId)}
    SELECT
      (SELECT COALESCE(SUM(n.size), 0) FROM nodes n JOIN asked a ON a.id = n.id
       WHERE n.kind = 'file' AND n.system IS NULL)
      + (SELECT COALESCE(SUM(v.size), 0) FROM node_versions v JOIN asked a ON a.id = v.node_id)
  )::bigint`;
}

/**
 * The bytes `used_bytes` keeps for what a LEGAL HOLD keeps of the owner's deleted-for-good roots
 * — the files and the kept old versions — apart. 0 and 0 for an account with none (an unheld
 * root is purged at once by the request). What the account holder is shown and given leaves them
 * out, up to the backstop (see the header).
 */
export async function legalHoldKeptBytes(
  db: Executor,
  ownerId: string,
): Promise<{ files: number; versions: number }> {
  const result = await db.execute<{ files: string; versions: string }>(sql`
    ${legalHoldKeptTree(ownerId)}
    SELECT
      (SELECT COALESCE(SUM(n.size), 0) FROM nodes n JOIN asked a ON a.id = n.id
       WHERE n.kind = 'file' AND n.system IS NULL)::bigint AS files,
      (SELECT COALESCE(SUM(v.size), 0) FROM node_versions v JOIN asked a ON a.id = v.node_id)::bigint AS versions`);
  const row = result.rows[0];
  return { files: Number(row?.files ?? 0), versions: Number(row?.versions ?? 0) };
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
