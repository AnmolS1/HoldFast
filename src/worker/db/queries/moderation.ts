// Moderation: the database side effects only. Callers send email, write audit rows and emit
// metrics. Every function that composes others runs them on the executor it was given, in one
// transaction (a savepoint when the caller already has one).

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Executor } from "../client";
import { isUuid } from "../ids";
import { dmcaNotices, nodes, reports, type ScanStatus, uploadIps, user } from "../schema";
import { upsert as blocklistUpsert } from "./blocklist";
import { pauseLinks, unpauseLinks } from "./links";

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

/**
 * The database half of the suspected-CSAM lock. Route and consumer code never call this
 * directly: they call the shared scanning service, which adds the audit row, the alert and the
 * metric.
 *
 * In one transaction: the node becomes `suspected_csam` and is put on legal hold, its owner is
 * put on legal hold, the node's links are paused with `moderation`, the node's `upload_ips` rows
 * are held, its hash is blocklisted as `csam`, and a `reports` row is filed. The object is never
 * deleted. Safe to repeat: a second call files no second report.
 * Null when there is no such node (also when a purge that started first deleted it meanwhile).
 */
export async function lockSuspectedCsam(
  db: Executor,
  nodeId: string,
  opts: { source: "photodna" | "system" | "admin" },
): Promise<{ reportId: string; ownerId: string } | null> {
  if (!isUuid(nodeId)) return null;
  return db.transaction(async (tx) => {
    // LOCK ORDER: the owner's `user` row first, then the node — the order of the purge
    // (`deleteSubtreeRows`), the reconcile and the quota writers. Taking the node first and the
    // owner second is the opposite order: run beside a purge of the same owner the two deadlock,
    // and when Postgres picks THIS transaction as the victim it rolls back whole (no
    // `suspected_csam`, no hold) and the purge goes on to delete the evidence.
    // The owner is read without a lock only to learn whose row to lock; `owner_id` never changes.
    const [peek] = await tx.select({ ownerId: nodes.ownerId }).from(nodes).where(eq(nodes.id, nodeId));
    if (!peek) return null;
    await tx.select({ id: user.id }).from(user).where(eq(user.id, peek.ownerId)).for("update");
    const [node] = await tx
      .select({ ownerId: nodes.ownerId, sha256: nodes.sha256 })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .for("update");
    // Gone while this waited for the owner's row: a purge that began first has deleted it.
    if (!node) return null;

    await tx.update(user).set({ legalHold: true }).where(eq(user.id, node.ownerId));
    await tx
      .update(nodes)
      .set({ scanStatus: "suspected_csam", scanStatusPrev: null, legalHold: true })
      .where(eq(nodes.id, nodeId));
    await pauseLinks(tx, { nodeId }, "moderation");
    await tx.update(uploadIps).set({ legalHold: true }).where(eq(uploadIps.nodeId, nodeId));
    if (node.sha256 !== null) {
      await blocklistUpsert(tx, { sha256: node.sha256, reason: "csam", sourceNodeId: nodeId });
    }

    const [existing] = await tx
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
      existing?.id ??
      (await insertReport(tx, { nodeId, ownerId: node.ownerId, source: opts.source, category: "csam" }));
    return { reportId: reportId!, ownerId: node.ownerId };
  });
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
