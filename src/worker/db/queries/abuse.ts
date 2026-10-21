// Queries only the abuse task makes (T22): the report intake's per-reporter and per-link counts,
// the hourly job's anomaly findings over `link_access_log`, `link_password_attempts`, `uploads`
// and the day's ledger, and the owed-node repair sweep's listing and row lock of `completing`
// upload sessions. Every shared helper it builds on is T05's (moderation, links, uploads, ledger).
//
// NOTHING HERE ENDS A SESSION, writes a report or pauses a link: those writes are T05's helpers,
// called by the route and the job. This module reads, and takes locks.

import { and, asc, eq, gt, gte, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { downloadLedger, nodes, reports, type Upload, uploads, user } from "../schema";
import { COMPLETING_STALE_MINUTES, owesLockedNode } from "./uploads";

/** The audit action the upload route writes when a preserved node could not be written. */
export const CSAM_NODE_OWED_ACTION = "upload.csam_node_owed";

// ── report intake ───────────────────────────────────────────────────────────────────────────

/**
 * Serialises the reports of ONE reporter (their stable address hash) for the rest of the
 * transaction: the cap is counted and the row inserted under it, so parallel reports cannot
 * pass the cap together. Taken first in the report's transaction; nothing else takes it.
 */
export async function lockReporter(tx: Executor, reporterIpHashStable: string): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${"report:" + reporterIpHashStable}, 0))`,
  );
}

/**
 * Reports filed under this reporter hash in the last `hours` hours, whatever became of them, and
 * the seconds until the oldest of them leaves that window (0: none) — the per-reporter cap and
 * its `Retry-After`.
 */
export async function reportsByReporterSince(
  db: Executor,
  reporterIpHashStable: string,
  hours: number,
): Promise<{ count: number; retryAfterSec: number }> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)`.mapWith(Number),
      retryAfterSec: sql<number>`COALESCE(ceil(extract(epoch FROM
        min(${reports.createdAt}) + make_interval(hours => ${hours}) - now())), 0)::int`.mapWith(Number),
    })
    .from(reports)
    .where(
      and(
        eq(reports.reporterIpHashStable, reporterIpHashStable),
        gt(reports.createdAt, sql`now() - make_interval(hours => ${hours})`),
      ),
    );
  return { count: row?.n ?? 0, retryAfterSec: Math.max(0, row?.retryAfterSec ?? 0) };
}

/** Open (`open` / `reviewing`) user reports filed through one link — the per-link alert cap. */
export async function openReportsOnLink(db: Executor, linkId: string): Promise<number> {
  if (!isUuid(linkId)) return 0;
  const [row] = await db
    .select({ n: sql<number>`count(*)`.mapWith(Number) })
    .from(reports)
    .where(
      and(
        eq(reports.linkId, linkId),
        eq(reports.source, "user"),
        sql`${reports.status} IN ('open', 'reviewing')`,
      ),
    );
  return row?.n ?? 0;
}

// ── the owed-node repair sweep ──────────────────────────────────────────────────────────────

/** The clock `uploads.expired` measures a `completing` session by. */
const STALE = sql`COALESCE(${uploads.completingAt}, ${uploads.createdAt}) < now() - make_interval(mins => ${COMPLETING_STALE_MINUTES})`;

/** It carries the route's "the node is owed" audit row. */
const HAS_OWED_ROW = sql`EXISTS (SELECT 1 FROM audit_log a
  WHERE a.action = ${CSAM_NODE_OWED_ACTION} AND a.target_type = 'upload' AND a.target_id = ${uploads.id}::text)`;

/**
 * The sessions the repair sweep owns: `completing`, older than `COMPLETING_STALE_MINUTES` on the
 * clock `uploads.expired` uses (a request still hashing is never raced), and EITHER carrying an
 * `upload.csam_node_owed` audit row OR owing a locked node by their declared hash
 * (`owesLockedNode()`). Oldest first, at most `limit`. `owedRow`: the audit row exists.
 */
export async function owedSessions(
  db: Executor,
  limit: number,
): Promise<Array<{ session: Upload; owedRow: boolean }>> {
  const rows = await db
    .select({ session: uploads, owedRow: sql<boolean>`${HAS_OWED_ROW}` })
    .from(uploads)
    .where(and(eq(uploads.status, "completing"), STALE, sql`(${owesLockedNode()} OR ${HAS_OWED_ROW})`))
    .orderBy(asc(sql`COALESCE(${uploads.completingAt}, ${uploads.createdAt})`), asc(uploads.id))
    .limit(limit);
  return rows.map((row) => ({ session: row.session, owedRow: row.owedRow === true }));
}

/**
 * Locks one listed session and returns it — if it is STILL `completing` and past the same age.
 * Null when it moved on meanwhile (finished, aborted, gone). Unlike the stale job's lock it does
 * NOT exclude a session that owes a locked node: the sweep owns exactly those. Call it after the
 * `user` rows the transaction needs (lock order: user rows, then the rest).
 */
export async function lockOwedSession(tx: Executor, uploadId: string): Promise<Upload | null> {
  if (!isUuid(uploadId)) return null;
  const [row] = await tx
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.status, "completing"), STALE))
    .for("update");
  return row ?? null;
}

// ── anomaly findings (the hourly job's part (b)) ────────────────────────────────────────────

/**
 * Owners whose `link_owner` ledger row of `day` is at least half of the smaller of the two caps
 * the job passes (an old account's, a young one's) — a pre-filter: the job compares each against
 * that owner's own effective cap. Reads `link_owner` rows only: a `notice` marker is never a
 * total. Largest first, at most `limit`.
 */
export async function ownersNearEgressCap(
  db: Executor,
  day: string,
  minCapBytes: number,
  limit: number,
): Promise<Array<{ ownerId: string; bytes: number; quotaBytes: number; createdAt: Date }>> {
  const rows = await db
    .select({
      ownerId: downloadLedger.subjectId,
      bytes: downloadLedger.bytes,
      quotaBytes: user.quotaBytes,
      createdAt: user.createdAt,
    })
    .from(downloadLedger)
    .innerJoin(user, eq(user.id, downloadLedger.subjectId))
    .where(
      and(
        eq(downloadLedger.day, day),
        eq(downloadLedger.subjectType, "link_owner"),
        gt(downloadLedger.bytes, 0),
        sql`${downloadLedger.bytes} * 2 >= ${minCapBytes}::bigint`,
      ),
    )
    .orderBy(sql`${downloadLedger.bytes} DESC`, asc(downloadLedger.subjectId))
    .limit(limit);
  return rows.map((row) => ({ ...row, bytes: Number(row.bytes), quotaBytes: Number(row.quotaBytes) }));
}

/**
 * Links with more than `maxDownloads` served downloads (`ok` rows) or more than `maxAddresses`
 * distinct daily address hashes in the last hour of `link_access_log`. At most `limit`.
 */
export async function busyLinksLastHour(
  db: Executor,
  maxDownloads: number,
  maxAddresses: number,
  limit: number,
): Promise<Array<{ linkId: string; ownerId: string; downloads: number; addresses: number }>> {
  const result = await db.execute<{
    link_id: string;
    owner_id: string;
    downloads: number;
    addresses: number;
  }>(sql`
    SELECT l.link_id, s.created_by AS owner_id, l.downloads, l.addresses
    FROM (
      SELECT link_id,
             count(*) FILTER (WHERE outcome = 'ok')::int AS downloads,
             count(DISTINCT ip_hash_daily)::int AS addresses
      FROM link_access_log
      WHERE at > now() - interval '1 hour'
      GROUP BY link_id
      HAVING count(*) FILTER (WHERE outcome = 'ok') > ${maxDownloads}
          OR count(DISTINCT ip_hash_daily) > ${maxAddresses}
    ) l
    JOIN share_links s ON s.id = l.link_id
    ORDER BY l.downloads DESC, l.link_id
    LIMIT ${limit}`);
  return result.rows.map((r) => ({
    linkId: r.link_id,
    ownerId: r.owner_id,
    downloads: Number(r.downloads),
    addresses: Number(r.addresses),
  }));
}

/** Accounts whose `link_user` ledger count of `day` (links created) is above `max`. At most `limit`. */
export async function linkCreatorsOn(
  db: Executor,
  day: string,
  max: number,
  limit: number,
): Promise<Array<{ userId: string; links: number }>> {
  const rows = await db
    .select({ userId: downloadLedger.subjectId, links: downloadLedger.count })
    .from(downloadLedger)
    .where(
      and(
        eq(downloadLedger.day, day),
        eq(downloadLedger.subjectType, "link_user"),
        gt(downloadLedger.count, max),
      ),
    )
    .orderBy(sql`${downloadLedger.count} DESC`, asc(downloadLedger.subjectId))
    .limit(limit);
  return rows.map((row) => ({ userId: row.userId, links: Number(row.links) }));
}

/**
 * Accounts younger than `newAccountDays` that started more than `max` upload sessions in the
 * last hour. At most `limit`.
 */
export async function busyNewUploadersLastHour(
  db: Executor,
  newAccountDays: number,
  max: number,
  limit: number,
): Promise<Array<{ userId: string; uploads: number }>> {
  const result = await db.execute<{ user_id: string; uploads: number }>(sql`
    SELECT u.uploader_id AS user_id, count(*)::int AS uploads
    FROM uploads u
    JOIN "user" a ON a.id = u.uploader_id
    WHERE u.created_at > now() - interval '1 hour'
      AND a.created_at > now() - make_interval(days => ${newAccountDays})
    GROUP BY u.uploader_id
    HAVING count(*) > ${max}
    ORDER BY uploads DESC, user_id
    LIMIT ${limit}`);
  return result.rows.map((r) => ({ userId: r.user_id, uploads: Number(r.uploads) }));
}

/**
 * Links whose password failed from more than `maxAddresses` distinct stable address hashes
 * within the last hour (`link_password_attempts`) — distributed guessing, which the inline
 * throttle cannot see (it looks at one address at a time). At most `limit`.
 */
export async function guessedLinksLastHour(
  db: Executor,
  maxAddresses: number,
  limit: number,
): Promise<Array<{ linkId: string; ownerId: string; addresses: number }>> {
  const result = await db.execute<{ link_id: string; owner_id: string; addresses: number }>(sql`
    SELECT p.link_id, s.created_by AS owner_id, p.addresses
    FROM (
      SELECT link_id, count(DISTINCT ip_hash_stable)::int AS addresses
      FROM link_password_attempts
      WHERE last_failure_at > now() - interval '1 hour'
      GROUP BY link_id
      HAVING count(DISTINCT ip_hash_stable) > ${maxAddresses}
    ) p
    JOIN share_links s ON s.id = p.link_id
    ORDER BY p.addresses DESC, p.link_id
    LIMIT ${limit}`);
  return result.rows.map((r) => ({ linkId: r.link_id, ownerId: r.owner_id, addresses: Number(r.addresses) }));
}

/**
 * Users suspended for strikes at or after `since` — the strike sweep's work of this run, by id,
 * for the digest. At most `limit`.
 */
export async function suspendedForStrikesSince(
  db: Executor,
  since: Date,
  reason: string,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: user.id })
    .from(user)
    .where(and(eq(user.suspendedReason, reason), gte(user.suspendedAt, since)))
    .orderBy(asc(user.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

// ── the midnight job ────────────────────────────────────────────────────────────────────────

/**
 * For each owner, their address and name and the name of ONE of the given nodes (the first in
 * `nodeIds` order that still exists) — what the "link available again" mail needs. Owners with
 * no such node, or no row, are left out.
 */
export async function availableAgainRecipients(
  db: Executor,
  byOwner: Array<{ ownerId: string; nodeIds: string[] }>,
): Promise<Array<{ ownerId: string; email: string; name: string | null; itemName: string }>> {
  const out: Array<{ ownerId: string; email: string; name: string | null; itemName: string }> = [];
  for (const { ownerId, nodeIds } of byOwner) {
    const ids = nodeIds.filter(isUuid);
    if (ids.length === 0) continue;
    const rows = await db
      .select({ email: user.email, name: user.name, nodeId: nodes.id, itemName: nodes.name })
      .from(user)
      .innerJoin(nodes, eq(nodes.ownerId, user.id))
      .where(and(eq(user.id, ownerId), inArray(nodes.id, ids)));
    const first = ids.map((id) => rows.find((row) => row.nodeId === id)).find((row) => row !== undefined);
    if (first) out.push({ ownerId, email: first.email, name: first.name, itemName: first.itemName });
  }
  return out;
}
