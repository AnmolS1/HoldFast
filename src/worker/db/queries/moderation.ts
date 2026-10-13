// Moderation: the database side effects only. Callers send email, write audit rows and emit
// metrics. Every function that composes others runs them on the executor it was given, in one
// transaction (a savepoint when the caller already has one).

import { and, eq, inArray, sql } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import type { Executor } from "../client";
import { pgError } from "../errors";
import { isUuid } from "../ids";
import { dmcaNotices, hashBlocklist, nodes, reports, type ScanStatus, uploadIps, user } from "../schema";
import { pauseLinks, unpauseLinks } from "./links";

type ReportCategory = (typeof reports.category.enumValues)[number];
type ReportSource = (typeof reports.source.enumValues)[number];
type TakedownReason = NonNullable<typeof nodes.$inferSelect.takedownReason>;
type BlocklistReason = (typeof hashBlocklist.reason.enumValues)[number];

/** A notice in one of these states still protects its nodes from purge. */
export const OPEN_NOTICE_STATUSES = ["received", "incomplete", "actioned", "counter_received"] as const;
export const TERMINAL_NOTICE_STATUSES = ["rejected", "restored", "upheld", "withdrawn", "closed"] as const;
export type TerminalNoticeStatus = (typeof TERMINAL_NOTICE_STATUSES)[number];

/** The verdict columns a rescan starts from (what `nodes.resetToPending` clears). */
const NO_VERDICT = { scanReason: null, scanDetail: null, scannedAt: null } as const;

/** `reports.resolution` of a `csam` report dismissed by `clearSuspectedCsam`. */
export const CSAM_CLEARED_RESOLUTION = "false_positive";

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

/**
 * How often `lockSuspectedCsam` runs its whole transaction when Postgres ends it for a deadlock
 * (40P01) or a serialization failure (40001): this many times in all, then the error is thrown.
 */
export const CSAM_LOCK_ATTEMPTS = 4;
/** The pause before attempt n + 1: up to n × this many milliseconds, at random. */
const CSAM_LOCK_BACKOFF_MS = 15;
const RETRYABLE = new Set(["40P01", "40001"]);

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
 * banned: nobody is banned here. Safe to repeat: a second call files no second report — it
 * returns the node's `csam` report that is `open` or `reviewing`, or else the one that was FILED
 * (`actioned`: a redelivered verdict on a reported node opens no new case). Only after a
 * `dismissed` one is a lock a new case with a new report.
 * Null when there is no such node (also when a purge that started first deleted it meanwhile).
 *
 * LOSING A DEADLOCK DOES NOT LOSE THE LOCK. Called with the database handle itself (not inside a
 * caller's transaction — every caller in the product), a transaction that Postgres ended as a
 * deadlock victim (40P01) or for a serialization failure (40001) is run again from the start:
 * `CSAM_LOCK_ATTEMPTS` times in all, a short random pause between, then the error is thrown.
 * Nothing was written by the attempt that failed, and the lock is safe to repeat. Called INSIDE
 * a transaction it cannot do that — the failure has ended the caller's transaction — and the
 * error is the caller's to retry. (The "uploader set grew twice" failure below is not retried.)
 */
export async function lockSuspectedCsam(
  db: Executor,
  nodeId: string,
  opts: { source: "photodna" | "system" | "admin" },
): Promise<{ reportId: string; ownerId: string } | null> {
  if (!isUuid(nodeId)) return null;
  if (isTransaction(db)) return lockInOneTransaction(db, nodeId, opts.source);
  for (let attempt = 1; ; attempt++) {
    try {
      return await lockInOneTransaction(db, nodeId, opts.source);
    } catch (error) {
      if (attempt >= CSAM_LOCK_ATTEMPTS || !RETRYABLE.has(pgError(error)?.code ?? "")) throw error;
      const pause = Math.random() * CSAM_LOCK_BACKOFF_MS * attempt;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
}

/** Is this executor a transaction (a `Tx`), not the database handle? */
function isTransaction(db: Executor): boolean {
  return db instanceof PgTransaction;
}

function lockInOneTransaction(
  db: Executor,
  nodeId: string,
  source: "photodna" | "system" | "admin",
): Promise<{ reportId: string; ownerId: string } | null> {
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
    //
    // The user rows are locked FOR NO KEY UPDATE — what the hold's own UPDATE takes — not FOR
    // UPDATE: it excludes every other writer and locker of the row just the same, but not the
    // KEY SHARE lock a foreign-key check takes. A Replace or a trash that already holds the node
    // and then names one of these users in a row it writes (`created_by`, `trashed_by`) would
    // otherwise wait for this transaction while this one waits for its node: a deadlock.
    const first = await csamSubjects(tx, nodeId);
    if (!first) return null;
    let userIds = subjectUserIds(first);
    for (let attempt = 1; ; attempt++) {
      try {
        return await tx.transaction((sp) => lockRows(sp, nodeId, userIds, source));
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
  // One at a time, in order. An account deleted since the read locks nothing and is skipped.
  for (const userId of userIds) {
    await sp.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("no key update");
  }
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
    // NOT `blocklist.upsert`, which rewrites the whole entry. One atomic statement:
    //   - no entry: one is created, `sourceNodeId` this node — the only entry this lock OWNS;
    //   - an entry with another reason (an admin's, an earlier verdict's): it keeps its source,
    //     its author and its note; its reason is RAISED to `csam`, and what it was and whose
    //     lock raised it are recorded (`raisedFrom`, `raisedByNodeId`) so that a false positive
    //     can be undone. Only an entry that is not `csam` is ever raised, so a raise that is in
    //     force is never recorded over;
    //   - a `csam` entry: untouched.
    await sp
      .insert(hashBlocklist)
      .values({ sha256: node.sha256, reason: "csam", sourceNodeId: nodeId })
      .onConflictDoUpdate({
        target: hashBlocklist.sha256,
        set: { reason: "csam", raisedFrom: sql`${hashBlocklist.reason}`, raisedByNodeId: nodeId },
        setWhere: sql`${hashBlocklist.reason} <> 'csam'`,
      });
  }

  const [existing] = await sp
    .select({ id: reports.id })
    .from(reports)
    .where(
      and(
        eq(reports.nodeId, nodeId),
        eq(reports.category, "csam"),
        inArray(reports.status, ["open", "reviewing", "actioned"]),
      ),
    )
    // The case that is still being worked on first; else the one that was filed.
    .orderBy(sql`(${reports.status} = 'actioned')`, reports.createdAt)
    .limit(1);
  const reportId =
    existing?.id ?? (await insertReport(sp, { nodeId, ownerId: node.ownerId, source, category: "csam" }));
  return { reportId: reportId!, ownerId: node.ownerId };
}

export type CsamClearResult = {
  cleared: boolean;
  /**
   * Why nothing was written, when `cleared` is false: the node is not `suspected_csam` (or does
   * not exist), or a `csam` report on it was FILED (`actioned`) — that is never undone here.
   */
  refused: "not_locked" | "reported" | null;
  /** The entry a lock CREATED was deleted: the hash is no longer blocklisted. */
  blocklistRemoved: boolean;
  /** The entry a lock RAISED to `csam` was put back to this reason: still blocklisted, as before. */
  blocklistRestoredTo: BlocklistReason | null;
  /**
   * Why the entry was left exactly as it is: it is no lock's (an admin's, an unknown source's);
   * another node with the same hash is still locked; a `csam` report on a node with that hash
   * was filed; or it was this lock's and someone has changed its reason since (`edited`).
   * Null when it was removed or restored, or there is none.
   */
  blocklistKept: "not_this_locks" | "other_node_locked" | "reported" | "edited" | null;
  /** The `csam` reports dismissed, ascending. */
  reportIds: string[];
};

/**
 * The way back from a false positive: the reverse of the lock's database half EXCEPT THE HOLDS.
 * For the admin console's "Clear lock" only, inside its transaction; the caller writes the audit
 * row (which is where WHO cleared it is recorded) and enqueues the rescan after the commit.
 *
 * REFUSED — `cleared: false`, nothing written, `refused` says why:
 *   - `not_locked`: the node is not `suspected_csam` right now (also an unknown or malformed id).
 *     That is what makes a second call a no-op;
 *   - `reported`: a `csam` report on this node is `actioned` — it was filed. Content that was
 *     reported is not un-hidden by one call.
 * Otherwise:
 *   - the node goes to `pending` (never straight to `clean`: it is scanned again before it can
 *     be served) with `scanStatusPrev` cleared — or, when a report of ANOTHER category on it is
 *     still `open` or `reviewing`, to `under_review` with `scanStatusPrev = 'pending'`: that
 *     review is still open, and a clean scan must not make the file servable under it. The
 *     links' `report` pause is made to match: set when the node goes back under review (a
 *     report that arrived during the lock paused nothing), removed when it does not (a review
 *     that ended during the lock lifted nothing);
 *     either way the verdict that came with the lock is cleared (`scanReason`, `scanDetail`,
 *     `scannedAt` — what a rescan clears), so the node does not carry it while it waits;
 *   - `moderation` — that reason only — is removed from the links ON the node, unless the node
 *     or an ancestor is taken down: that takedown put, or would have put, the same reason
 *     there, and its restore removes it;
 *   - the blocklist entry of the hash goes back to what it was before any lock touched it —
 *     DELETED when a lock created it, its reason put back (`raisedFrom`) when a lock only raised
 *     it — but only when ALL of this holds: it is a lock's doing, this node's or that of a twin
 *     (another node with the content) that was itself cleared as a false positive; no OTHER
 *     node with the same hash is `suspected_csam`; and no `csam` report on any node with that
 *     hash was filed. So of two locked twins the FIRST clear leaves the entry and the SECOND
 *     undoes it, whichever of the two created or raised it. Otherwise the entry stays exactly
 *     as it is and `blocklistKept` says why — also when someone changed its reason in between;
 *   - every `csam` report on the node that is `open` or `reviewing` becomes `dismissed`
 *     (`resolvedAt` now, `resolution` `false_positive`; `assignedTo` as it was). Their ids are
 *     returned.
 * THE RULE FOR WRITERS that makes the refusal hold: whoever changes the status of a `csam`
 * report takes the report's NODE row first (`FOR UPDATE`), then the report. This function does —
 * node, then the hash's blocklist entry, then the reports it decides on, all `FOR UPDATE` — and
 * it also holds the reports themselves, so even a writer that skips the node row is either seen
 * or made to wait: a report filed while this runs can never end up on a cleared node.
 * LEGAL HOLDS ARE NOT TOUCHED: the node's, its owner's and uploaders', and the `upload_ips`
 * rows' stay exactly as they are. Releasing them is a separate, deliberate act.
 */
export async function clearSuspectedCsam(tx: Executor, nodeId: string): Promise<CsamClearResult> {
  const refused = (why: "not_locked" | "reported"): CsamClearResult => ({
    cleared: false,
    refused: why,
    blocklistRemoved: false,
    blocklistRestoredTo: null,
    blocklistKept: null,
    reportIds: [],
  });
  if (!isUuid(nodeId)) return refused("not_locked");
  return tx.transaction(async (sp) => {
    // LOCK ORDER: the node, then the hash's blocklist entry, then the reports — ascending by id.
    // Everything this function decides on is read under those locks, so nothing it has checked
    // can change before it writes.
    const [node] = await sp
      .select({ scanStatus: nodes.scanStatus, sha256: nodes.sha256 })
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .for("update");
    if (!node || node.scanStatus !== "suspected_csam") return refused("not_locked");

    const [entry] =
      node.sha256 === null
        ? []
        : await sp
            .select({
              reason: hashBlocklist.reason,
              sourceNodeId: hashBlocklist.sourceNodeId,
              raisedFrom: hashBlocklist.raisedFrom,
              raisedByNodeId: hashBlocklist.raisedByNodeId,
            })
            .from(hashBlocklist)
            .where(eq(hashBlocklist.sha256, node.sha256))
            .for("update");

    // Every report on this node, and the `csam` reports on every other node with the same
    // content (`nodes.sha256`, indexed: the node's twins — a handful). A filing that is setting
    // one of them `actioned` right now either has committed and is seen here, or waits.
    const sameContent =
      node.sha256 === null
        ? sql`false`
        : sql`(${reports.category} = 'csam' AND ${reports.nodeId} IN (SELECT t.id FROM nodes t WHERE t.sha256 = ${node.sha256}))`;
    const held = await sp
      .select({ nodeId: reports.nodeId, category: reports.category, status: reports.status })
      .from(reports)
      .where(sql`${reports.nodeId} = ${nodeId} OR ${sameContent}`)
      .orderBy(reports.id)
      .for("update");
    const onNode = held.filter((r) => r.nodeId === nodeId);
    if (onNode.some((r) => r.category === "csam" && r.status === "actioned")) return refused("reported");
    const otherCaseOpen = onNode.some(
      (r) => r.category !== "csam" && (r.status === "open" || r.status === "reviewing"),
    );

    await sp
      .update(nodes)
      .set(
        // The lock's verdict goes with it — the columns `resetToPending` clears.
        otherCaseOpen
          ? { scanStatus: "under_review", scanStatusPrev: "pending", ...NO_VERDICT }
          : { scanStatus: "pending", scanStatusPrev: null, ...NO_VERDICT },
      )
      .where(eq(nodes.id, nodeId));

    // The links end where `setUnderReview` / `dismissReview` would leave them. A report that
    // came in WHILE the node was locked paused nothing (the lock was the stronger state), and
    // a review that ended meanwhile lifted nothing: the `report` pause is set to match the
    // review state the node now has. `moderation` goes — unless the node is still hidden (a
    // takedown of it or of an ancestor: `unpauseLinks` keeps it, and that restore lifts it).
    if (otherCaseOpen) await pauseLinks(sp, { nodeId }, "report");
    else await unpauseLinks(sp, { nodeId }, "report");
    await unpauseLinks(sp, { nodeId }, "moderation");

    const filedElsewhere = held.some((r) => r.category === "csam" && r.status === "actioned");
    const released =
      node.sha256 === null || !entry
        ? null
        : await releaseBlocklistEntry(sp, nodeId, node.sha256, entry, filedElsewhere);

    const dismissed = await sp
      .update(reports)
      .set({ status: "dismissed", resolvedAt: sql`now()`, resolution: CSAM_CLEARED_RESOLUTION })
      .where(
        and(
          eq(reports.nodeId, nodeId),
          eq(reports.category, "csam"),
          inArray(reports.status, ["open", "reviewing"]),
        ),
      )
      .returning({ id: reports.id });

    return {
      cleared: true,
      refused: null,
      blocklistRemoved: released === "removed",
      blocklistRestoredTo: released !== null && typeof released === "object" ? released.restoredTo : null,
      blocklistKept: typeof released === "string" && released !== "removed" ? released : null,
      reportIds: dismissed.map((r) => r.id).sort(),
    };
  });
}

/**
 * Undoes what a lock did to the hash's blocklist entry, if the cleared node was the last thing
 * standing behind it. The caller holds the entry `FOR UPDATE` (a lock of another node with the
 * same hash, running now, either finished before — its node is seen below — or waits and then
 * writes its own) and the hash's `csam` reports (`filed`: one of them is `actioned`).
 * `removed`, `{ restoredTo }`, or why it was left alone.
 */
async function releaseBlocklistEntry(
  sp: Executor,
  nodeId: string,
  sha256: string,
  entry: {
    reason: BlocklistReason;
    sourceNodeId: string | null;
    raisedFrom: BlocklistReason | null;
    raisedByNodeId: string | null;
  },
  filed: boolean,
): Promise<
  "removed" | { restoredTo: BlocklistReason } | "not_this_locks" | "other_node_locked" | "reported" | "edited"
> {
  // RAISED is tested before CREATED: an entry a lock raised keeps its own `sourceNodeId` —
  // which may be this very node (its earlier verdict listed the hash) — and must be put back,
  // never deleted. "Created by a lock" therefore requires that nothing raised it.
  const lockedBy = entry.raisedFrom !== null ? entry.raisedByNodeId : entry.sourceNodeId;
  // Not `csam` any more: no lock's entry now. If it was this lock's, somebody edited it.
  if (entry.reason !== "csam") return lockedBy === nodeId ? "edited" : "not_this_locks";
  if (lockedBy === null) return "not_this_locks";

  const [alsoLocked] = await sp
    .select({ id: nodes.id })
    .from(nodes)
    .where(
      and(eq(nodes.sha256, sha256), eq(nodes.scanStatus, "suspected_csam"), sql`${nodes.id} <> ${nodeId}`),
    )
    .limit(1);
  if (alsoLocked) return "other_node_locked";
  if (filed) return "reported";

  // A lock's doing — this node's, or a twin's whose own clear had to leave the entry because
  // this node was still locked then. A twin counts only on the record of its clear: a `csam`
  // report on it dismissed as a false positive. Any other source (an admin's entry, a node that
  // is gone, an id nobody knows) is not ours to undo.
  if (lockedBy !== nodeId) {
    const [clearedTwin] = await sp
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.nodeId, lockedBy),
          eq(reports.category, "csam"),
          eq(reports.status, "dismissed"),
          eq(reports.resolution, CSAM_CLEARED_RESOLUTION),
        ),
      )
      .limit(1);
    if (!clearedTwin) return "not_this_locks";
  }

  if (entry.raisedFrom !== null) {
    await sp
      .update(hashBlocklist)
      .set({ reason: entry.raisedFrom, raisedFrom: null, raisedByNodeId: null })
      .where(eq(hashBlocklist.sha256, sha256));
    return { restoredTo: entry.raisedFrom };
  }
  await sp.delete(hashBlocklist).where(eq(hashBlocklist.sha256, sha256));
  return "removed";
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
