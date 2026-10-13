// Moderation: the database side effects only. Callers send email, write audit rows and emit
// metrics. Every function that composes others runs them on the executor it was given, in one
// transaction (a savepoint when the caller already has one).

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { dmcaNotices, nodes, reports, type ScanStatus, uploadIps, user } from "../schema";
import { upsert as blocklistUpsert } from "./blocklist";
import { pauseLinks, unpauseLinks } from "./links";
import { lockUser } from "./users";

type ReportCategory = (typeof reports.category.enumValues)[number];
type ReportSource = (typeof reports.source.enumValues)[number];
type TakedownReason = NonNullable<typeof nodes.$inferSelect.takedownReason>;

/** A notice in one of these states still protects its nodes from purge. */
export const OPEN_NOTICE_STATUSES = ["received", "incomplete", "actioned", "counter_received"] as const;
export const TERMINAL_NOTICE_STATUSES = ["rejected", "restored", "upheld", "withdrawn", "closed"] as const;
export type TerminalNoticeStatus = (typeof TERMINAL_NOTICE_STATUSES)[number];

/**
 * A valid report came in: the node goes `under_review` and its links are paused with `report`.
 * The guard lives here, so callers call it unconditionally:
 * - an `infected` or `suspected_csam` node is left untouched and nothing is paused — it is
 *   already blocked and must not move to a weaker-looking state;
 * - a node that is already `under_review` keeps its saved `scanStatusPrev`.
 * `changed` is true only when the status moved to `under_review` in this call.
 */
export async function setUnderReview(db: Executor, nodeId: string): Promise<{ changed: boolean }> {
  if (!isUuid(nodeId)) return { changed: false };
  return db.transaction(async (tx) => {
    const [node] = await tx
      .select({ scanStatus: nodes.scanStatus })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .for("update");
    if (!node || node.scanStatus === "infected" || node.scanStatus === "suspected_csam")
      return { changed: false };
    const changed = node.scanStatus !== "under_review";
    if (changed) {
      await tx
        .update(nodes)
        .set({ scanStatus: "under_review", scanStatusPrev: node.scanStatus })
        .where(eq(nodes.id, nodeId));
    }
    await pauseLinks(tx, { nodeId }, "report");
    return { changed };
  });
}

/**
 * A review ended with no action: the node gets its saved status back and the `report` pause is
 * removed (other pause reasons stay). Nothing is revoked or escalated.
 * `restored` is the status the node now has — a caller re-enqueues a scan when it is `pending` —
 * or null when the node was not `under_review`.
 */
export async function dismissReview(db: Executor, nodeId: string): Promise<{ restored: ScanStatus | null }> {
  if (!isUuid(nodeId)) return { restored: null };
  return db.transaction(async (tx) => {
    const [node] = await tx
      .select({ scanStatus: nodes.scanStatus, scanStatusPrev: nodes.scanStatusPrev })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .for("update");
    if (!node || node.scanStatus !== "under_review") return { restored: null };
    const restored: ScanStatus = node.scanStatusPrev ?? "pending";
    await tx.update(nodes).set({ scanStatus: restored, scanStatusPrev: null }).where(eq(nodes.id, nodeId));
    await unpauseLinks(tx, { nodeId }, "report");
    return { restored };
  });
}

export type ReportInput = {
  /** Null for an account-level finding. */
  nodeId?: string | null;
  /** Owner of the reported node. */
  ownerId?: string | null;
  linkId?: string | null;
  source: ReportSource;
  category: ReportCategory;
  reporterUserId?: string | null;
  reporterEmail?: string | null;
  reporterIpHashStable?: string | null;
  details?: string | null;
};

/**
 * The one insert into `reports`. Returns the new report's id — or null when the same reporter
 * (stable IP hash) already has an open report of that category on that node: the duplicate is
 * dropped silently, without failing the caller's transaction.
 * Rows without a reporter hash (system findings) are never deduplicated by the database.
 */
export async function insertReport(tx: Executor, report: ReportInput): Promise<string | null> {
  const [row] = await tx
    .insert(reports)
    .values({
      nodeId: report.nodeId ?? null,
      ownerId: report.ownerId ?? null,
      linkId: report.linkId ?? null,
      source: report.source,
      category: report.category,
      reporterUserId: report.reporterUserId ?? null,
      reporterEmail: report.reporterEmail ?? null,
      reporterIpHashStable: report.reporterIpHashStable ?? null,
      details: report.details ?? null,
    })
    .onConflictDoNothing({
      target: [reports.nodeId, reports.reporterIpHashStable, reports.category],
      where: sql`status IN ('open', 'reviewing')`,
    })
    .returning({ id: reports.id });
  return row?.id ?? null;
}

export type CsamSubjects = {
  nodeId: string;
  ownerId: string | null;
  /** Ascending (code-unit order, the order user rows are locked in); may include the owner. */
  uploaderIds: string[];
};

/**
 * Who a suspected-CSAM lock on this node is about: the node, its owner, and every distinct
 * uploader of ANY version of it — the current one (`nodes.created_by`), the replaced ones still
 * kept (`node_versions.created_by`) and everyone an uploader address is on record for
 * (`upload_ips.uploader_id`, which outlives a purged version). One statement.
 *
 * Only accounts that exist: an anonymised uploader (null) and an id whose account is gone are
 * left out — there is nothing to hold or to release. Null for an unknown or malformed node id.
 * `lockSuspectedCsam` locks and holds this set; "Release holds" releases it.
 */
export async function csamSubjects(db: Executor, nodeId: string): Promise<CsamSubjects | null> {
  if (!isUuid(nodeId)) return null;
  const result = await db.execute<{ id: string; owner_id: string; uploader_ids: string[] }>(sql`
    SELECT n.id, n.owner_id,
           ARRAY(
             SELECT s.uploader FROM (
               SELECT n.created_by AS uploader
               UNION
               SELECT v.created_by FROM node_versions v WHERE v.node_id = n.id
               UNION
               SELECT i.uploader_id FROM upload_ips i WHERE i.node_id = n.id
             ) s
             WHERE s.uploader IS NOT NULL
               AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = s.uploader)
           ) AS uploader_ids
    FROM nodes n WHERE n.id = ${nodeId}`);
  const row = result.rows[0];
  if (!row) return null;
  return { nodeId: row.id, ownerId: row.owner_id, uploaderIds: [...row.uploader_ids].sort() };
}

/** The uploader set grew between the unlocked read and the locked one. */
class SubjectsGrew extends Error {
  constructor(readonly userIds: string[]) {
    super("the uploader set grew");
  }
}

/**
 * The database half of the suspected-CSAM lock. Route and consumer code never call this
 * directly: they call the shared scanning service, which adds the audit row, the alert and the
 * metric.
 *
 * In one transaction: the node becomes `suspected_csam` and is put on legal hold; its owner AND
 * EVERY UPLOADER OF ANY VERSION OF IT (`csamSubjects`) are put on legal hold — an editor who
 * uploaded into someone else's folder, and one whose version was since replaced, included; the
 * node's links are paused with `moderation`, the node's `upload_ips` rows are held, its hash is
 * blocklisted as `csam`, and a `reports` row is filed. The object is never deleted. Held is not
 * banned: nobody is banned here. Safe to repeat: a second call files no second report.
 * Null when there is no such node (also when a purge that started first deleted it meanwhile).
 */
export async function lockSuspectedCsam(
  db: Executor,
  nodeId: string,
  opts: { source: "photodna" | "system" | "admin" },
): Promise<{ reportId: string; ownerId: string } | null> {
  if (!isUuid(nodeId)) return null;
  return db.transaction(async (tx) => {
    // LOCK ORDER: `user` rows first — every one this transaction will write, LOWEST ID FIRST
    // (the order of `enforceUploadCeilings`) — then the node: the order of the purge
    // (`deleteSubtreeRows`), the reconcile and the quota writers. Taking the node first and a
    // user second is the opposite order: run beside a purge of the same owner the two deadlock,
    // and when Postgres picks THIS transaction as the victim it rolls back whole (no
    // `suspected_csam`, no hold) and the purge goes on to delete the evidence. Owner-first
    // instead of lowest-first deadlocks the same way against a lock on a file whose owner and
    // uploader are the other way round.
    //
    // Whose rows to lock is only known from the node's rows, so the set is read WITHOUT a lock
    // first, and read again once the node is locked. If it grew in between (a Replace by a new
    // uploader committed), the locks are released — the savepoint is rolled back — and taken
    // again for the larger set: once. A set that grows a second time fails the transaction,
    // nothing written; the caller's redelivery tries again.
    const first = await csamSubjects(tx, nodeId);
    if (!first) return null;
    let userIds = subjectUserIds(first);
    for (let attempt = 1; ; attempt++) {
      try {
        return await tx.transaction((sp) => lockRows(sp, nodeId, userIds, opts.source));
      } catch (error) {
        if (!(error instanceof SubjectsGrew)) throw error;
        if (attempt >= 2) throw new Error("csam lock: the node's uploader set grew twice while locking");
        userIds = error.userIds;
      }
    }
  });
}

/** The owner and the uploaders, each once, in the order their rows are locked: ascending. */
function subjectUserIds(subjects: CsamSubjects): string[] {
  const ids = new Set(subjects.uploaderIds);
  if (subjects.ownerId !== null) ids.add(subjects.ownerId);
  return [...ids].sort();
}

async function lockRows(
  sp: Executor,
  nodeId: string,
  userIds: string[],
  source: "photodna" | "system" | "admin",
): Promise<{ reportId: string; ownerId: string } | null> {
  // An account deleted since the read locks nothing and is skipped.
  for (const userId of userIds) await lockUser(sp, userId);
  const [node] = await sp
    .select({ ownerId: nodes.ownerId, sha256: nodes.sha256 })
    .from(nodes)
    .where(eq(nodes.id, nodeId))
    .for("update");
  // Gone while this waited for a user row: a purge that began first has deleted it.
  if (!node) return null;
  const now = await csamSubjects(sp, nodeId);
  if (!now) return null;
  const all = subjectUserIds(now);
  if (all.some((id) => !userIds.includes(id))) {
    throw new SubjectsGrew([...new Set([...userIds, ...all])].sort());
  }

  await sp.update(user).set({ legalHold: true }).where(inArray(user.id, all));
  await sp
    .update(nodes)
    .set({ scanStatus: "suspected_csam", scanStatusPrev: null, legalHold: true })
    .where(eq(nodes.id, nodeId));
  await pauseLinks(sp, { nodeId }, "moderation");
  await sp.update(uploadIps).set({ legalHold: true }).where(eq(uploadIps.nodeId, nodeId));
  if (node.sha256 !== null) {
    await blocklistUpsert(sp, { sha256: node.sha256, reason: "csam", sourceNodeId: nodeId });
  }

  const [existing] = await sp
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        eq(reports.nodeId, nodeId),
        eq(reports.category, "csam"),
        inArray(reports.status, ["open", "reviewing"]),
      ),
    )
    .orderBy(reports.createdAt)
    .limit(1);
  const reportId =
    existing?.id ?? (await insertReport(sp, { nodeId, ownerId: node.ownerId, source, category: "csam" }));
  return { reportId: reportId!, ownerId: node.ownerId };
}

/**
 * Takes a node down: hidden from every non-admin listing and unservable. It is not "trash" — the
 * owner cannot restore it. For reason `csam` the node is also put on legal hold.
 * Pausing the node's links and filing a report are the caller's separate steps.
 * False when there is no such node.
 */
export async function takedownNode(
  db: Executor,
  nodeId: string,
  opts: { reason: TakedownReason; by: string | null },
): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({
      takedownAt: sql`now()`,
      takedownReason: opts.reason,
      takedownBy: opts.by,
      ...(opts.reason === "csam" ? { legalHold: true } : {}),
    })
    .where(eq(nodes.id, nodeId))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/** Clears the three takedown columns. A legal hold, if any, stays. False when nothing was down. */
export async function restoreTakedown(db: Executor, nodeId: string): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({ takedownAt: null, takedownReason: null, takedownBy: null })
    .where(and(eq(nodes.id, nodeId), sql`${nodes.takedownAt} IS NOT NULL`))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/**
 * Moves an open notice to a terminal status. Its nodes stay hidden while they are taken down,
 * but stop being protected from purge. An admin closes a notice by hand; nothing closes one
 * automatically in v1. False when the notice does not exist or is already terminal.
 */
export async function closeNotice(
  db: Executor,
  noticeId: string,
  status: TerminalNoticeStatus,
): Promise<boolean> {
  if (!isUuid(noticeId)) return false;
  const rows = await db
    .update(dmcaNotices)
    .set({ status, updatedAt: sql`now()` })
    .where(and(eq(dmcaNotices.id, noticeId), inArray(dmcaNotices.status, [...OPEN_NOTICE_STATUSES])))
    .returning({ id: dmcaNotices.id });
  return rows.length > 0;
}

/** Sets or releases the legal hold on one node. False when there is no such node. */
export async function setNodeLegalHold(db: Executor, nodeId: string, held: boolean): Promise<boolean> {
  if (!isUuid(nodeId)) return false;
  const rows = await db
    .update(nodes)
    .set({ legalHold: held })
    .where(eq(nodes.id, nodeId))
    .returning({ id: nodes.id });
  return rows.length > 0;
}

/** Sets or releases the legal hold on an account. False when there is no such user. */
export async function setUserLegalHold(db: Executor, userId: string, held: boolean): Promise<boolean> {
  const rows = await db
    .update(user)
    .set({ legalHold: held })
    .where(eq(user.id, userId))
    .returning({ id: user.id });
  return rows.length > 0;
}

/**
 * Open suspected-CSAM reports with something still owed: reports of category `csam` with status
 * `open` for which
 *   - nobody has been told TODAY — today's alert marker (ledger subject `notice`, id
 *     `csam_alert:<report id>`) has not been claimed; or
 *   - the lock was NEVER recorded — no `csam_locked:<report id>` marker has been claimed on any
 *     day of the report's life (`lockRecorded: false`). The ledger's key starts with the day, so
 *     that lookup is bounded below by the report's own age: a marker names its report, so it is
 *     claimed on or after the day the report was created (one day of slack).
 * Each row carries the report's own `source`. Oldest first, at most `limit`. Read-only.
 * (A report someone is handling — `reviewing` — or has closed is not listed.)
 */
export async function csamReportsToAnnounce(
  db: Executor,
  limit: number,
): Promise<{ reportId: string; nodeId: string | null; source: ReportSource; lockRecorded: boolean }[]> {
  const result = await db.execute<{
    id: string;
    node_id: string | null;
    source: ReportSource;
    lock_recorded: boolean;
  }>(sql`
    SELECT o.id, o.node_id, o.source, o.lock_recorded
    FROM (
      SELECT r.id, r.node_id, r.source, r.created_at,
        EXISTS (
          SELECT 1 FROM download_ledger l
          WHERE l.day = (now() AT TIME ZONE 'UTC')::date
            AND l.subject_type = 'notice'
            AND l.subject_id = 'csam_alert:' || r.id::text
            AND l.count > 0) AS told_today,
        EXISTS (
          SELECT 1 FROM download_ledger k
          WHERE k.day >= (r.created_at AT TIME ZONE 'UTC')::date - 1
            AND k.subject_type = 'notice'
            AND k.subject_id = 'csam_locked:' || r.id::text
            AND k.count > 0) AS lock_recorded
      FROM reports r
      WHERE r.category = 'csam' AND r.status = 'open'
    ) o
    WHERE NOT o.told_today OR NOT o.lock_recorded
    ORDER BY o.created_at, o.id
    LIMIT ${limit}`);
  return result.rows.map((row) => ({
    reportId: row.id,
    nodeId: row.node_id,
    source: row.source,
    lockRecorded: row.lock_recorded === true,
  }));
}
