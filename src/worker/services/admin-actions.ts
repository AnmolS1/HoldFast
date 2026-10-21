// The admin console's actions (T25): report resolution, the NCMEC procedure, the CSAM lock and
// its way back, the quarantine, the DMCA workflow, the rollback detector's "accept the
// database's generation", the pause switch and the uploads kept under "keep and alert".
// ORCHESTRATION ONLY: every state change goes through its owner (T05 queries, T06 account state,
// T10 strikes and scanning, T14 purge); what this file adds is the order, the guards and the
// answers. Routes (routes/admin.ts) parse, call `requireAdmin`, call these, and write nothing
// themselves.
//
// RULES THAT HOLD IN EVERY FUNCTION HERE
//  - Lock order (PLAN §6 rule 15): tree lock → `user` rows ascending → the `nodes` row → the
//    blocklist entry → reports → the rest. A report's status changes only after its NODE row is
//    locked. A T05 helper that takes the tree lock itself is the FIRST statement of its
//    transaction, unless this file took the same lock explicitly before it.
//  - Audit rows are written with `audit(c, …)` AFTER the transaction has returned (never inside
//    a retried callback). The purge's own `system.purge` row is the one written inside
//    (`purgeRoot`). A two-step action's preview writes nothing — audit row included.
//  - A refusal writes nothing: every `409` below is thrown before the first write, or from
//    inside the transaction, which then rolls back.
//  - Every object delete asks `readsRolledBack` first (PLAN §6 rule 17); "paused" answers as
//    "rolled back". The ONE exemption is the pause switch's own object (turning it off).
//  - No content: nothing here mints a `/t/`, `/i/` or `/d/` URL or reads an object's bytes.
//  - The raw uploader address exists only inside `ncmecEvidence`, and only in its answer: never
//    in an audit row, a log line, a metric, an error message or an `AppError` detail.

import type { Context } from "hono";
import { STRIKES_TO_SUSPEND } from "../../shared/constants";
import type {
  AcceptGenerationResponse,
  ClearLockResponse,
  DetectorDto,
  LockCsamResponse,
  NcmecEvidenceResponse,
  ReleaseHoldsResponse,
} from "../../shared/schemas/admin";
import type { Tx } from "../db/client";
import { LegalHoldError } from "../db/errors";
import { isUuid } from "../db/ids";
import * as adminQ from "../db/queries/admin";
import * as blocklist from "../db/queries/blocklist";
import { pauseLinks, unpauseLinks } from "../db/queries/links";
import {
  clearSuspectedCsam,
  closeNotice,
  csamSubjects,
  dismissReview,
  restoreTakedown,
  setNodeLegalHold,
  setUserLegalHold,
  takedownNode,
  type CsamClearResult,
} from "../db/queries/moderation";
import { keyReference } from "../db/queries/nodes";
import { release } from "../db/queries/quota";
import { advanceGenerationRow, readDetectorFields, withJobLock } from "../db/queries/trash-jobs";
import { assertPurgeable } from "../db/queries/trash";
import { lockOwnerTree } from "../db/queries/tree";
import { forNode, releaseForNode } from "../db/queries/upload-ips";
import { markAborted, markDone } from "../db/queries/uploads";
import { retryOnDeadlock } from "../db/retry";
import type { DmcaNotice, Node, Report, Upload } from "../db/schema";
import { purgeRoot } from "../jobs/purge";
import {
  DESTROY_PAUSED_KEY,
  GENERATION_KEY,
  GENERATION_LOCK,
  GENERATION_LOCK_HOLD_MS,
  parseGeneration,
  readPauseSwitch,
  readsRolledBack,
  type PauseSwitch,
} from "../jobs/reconcile";
import { captureError } from "../sentry";
import { unsuspendUser } from "./account-state";
import { audit } from "./audit";
import { now } from "./clock";
import { sendContentRemovedCopyright, sendContentRestored, sendReportReviewed } from "./email";
import { AppError } from "./errors";
import { metric } from "./metrics";
import { db, deps, type AppEnv } from "./request-context";
import { enqueueRescan, lockSuspectedCsam } from "./scanning";
import { storage } from "./storage";
import { addStrike, enforceStrikeThreshold, liftStrike, type StrikeKind } from "./strikes";
import { openIp } from "./tokens";

type C = Context<AppEnv>;

/**
 * TEST SEAMS, null in production: awaited at the two points where a concurrent writer must be
 * seen — after a kept upload's unlocked read (before its transaction), and after the hold toggle
 * has locked the user's row.
 */
export const adminHooks: {
  afterKeptRead: (() => Promise<void>) | null;
  /** After the hold toggle's check, before its write (the user's row is locked). */
  afterHoldUserLock: ((tx: Tx) => Promise<void>) | null;
} = { afterKeptRead: null, afterHoldUserLock: null };
export type Admin = { id: string };

const conflict = (reason: string, details: Record<string, unknown> = {}, message?: string) =>
  new AppError("conflict", message, { reason, ...details });

const DAY_MS = 86_400_000;
/** 18 U.S.C. § 2258A(h)(1): preserved for one year AFTER the submission to the CyberTipline. */
export function releasableAt(filedAt: Date): Date {
  const at = new Date(filedAt.getTime());
  at.setUTCFullYear(at.getUTCFullYear() + 1);
  return at;
}

/** Reruns `run` once when it throws `Retry` (a set that grew between an unlocked read and the lock). */
class Retry extends Error {}
async function onceMore<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof Retry) return run();
    throw error;
  }
}

// ── who uploaded what ───────────────────────────────────────────────────────────────────────

/**
 * The uploader of the node's CURRENT version: the `upload_ips` row for its `versionId`, else
 * `nodes.createdBy` (null: anonymised or unknown). The account the strike and the ban go to.
 */
export async function currentUploader(c: C, node: Node): Promise<string | null> {
  if (node.versionId) {
    const rows = await forNode(db(c), node.id);
    const match = rows.filter((row) => row.versionId === node.versionId).at(-1);
    if (match) return match.uploaderId;
  }
  return node.createdBy;
}

// ── reports (section 5) ─────────────────────────────────────────────────────────────────────

const OPEN_STATES: readonly Report["status"][] = ["open", "reviewing"];

function tellReporter(c: C, report: Report): void {
  // Only that the report was reviewed: never what happened (T06's template).
  if (report.reporterEmail) deps(c).defer(sendReportReviewed(deps(c), { to: report.reporterEmail }));
}

/**
 * Dismiss (typed reason). Report → `dismissed`; when no other open or reviewing report is left on
 * the node, `dismissReview` gives it its saved status back and lifts the `report` pause — and a
 * node whose saved status was `pending` is scanned again. ONLY "Clear lock" closes a `csam` case on
 * a locked file: such a Dismiss is `409 csam_locked`, nothing written.
 */
export async function dismissReport(c: C, reportId: string, resolution: string) {
  const done = await retryOnDeadlock(db(c), async (tx) => {
    const locked = await adminQ.lockReportAndNode(tx, reportId);
    if (!locked) throw new AppError("not_found");
    const { report, node } = locked;
    if (!OPEN_STATES.includes(report.status)) throw conflict("state", { status: report.status });
    if (report.category === "csam" && node?.scanStatus === "suspected_csam") throw conflict("csam_locked");
    const updated = await adminQ.setReportStatus(tx, reportId, {
      status: "dismissed",
      resolution,
      resolved: true,
    });
    let restored: Node["scanStatus"] | null = null;
    if (node && (await adminQ.openReportsOn(tx, node.id, reportId)).open === 0) {
      restored = (await dismissReview(tx, node.id)).restored;
    }
    return { report: updated, restored };
  });
  if (done.report.nodeId && done.restored === "pending") await rescanQuietly(c, done.report.nodeId);
  audit(
    c,
    "admin.report_dismissed",
    { type: "report", id: reportId },
    {
      reason: resolution,
      nodeId: done.report.nodeId,
      restored: done.restored,
    },
  );
  metric("report", { outcome: "dismissed" });
  tellReporter(c, done.report);
  return done.report;
}

/** A rescan whose refusal is not this caller's business (a folder, a node gone meanwhile). */
async function rescanQuietly(c: C, nodeId: string): Promise<void> {
  try {
    await enqueueRescan(deps(c), nodeId, { by: "admin" });
  } catch (error) {
    if (!(error instanceof AppError)) captureError(error, { kind: "admin", reason: "rescan" });
  }
}

const strikeKindFor = (category: Report["category"]): StrikeKind =>
  category === "malware" ? "malware" : "abuse";

/**
 * Action: take down (reason `abuse`) or strike the uploader of the current version — each sets the
 * report `actioned`. Neither is offered on a `csam`-category report (`409 csam_report`): such a
 * report ends only as dismissed or as FILED (`actioned` ⇔ `ncmecFiledAt`, section 5).
 */
export async function actionReport(
  c: C,
  admin: Admin,
  reportId: string,
  action: "takedown" | "strike",
  resolution: string,
) {
  const seen = await adminQ.reportRow(db(c), reportId);
  if (!seen) throw new AppError("not_found");
  if (seen.category === "csam") throw conflict("csam_report");
  if (!OPEN_STATES.includes(seen.status)) throw conflict("state", { status: seen.status });
  if (!seen.nodeId) throw conflict("no_node");
  const node = await adminQ.nodeRow(db(c), seen.nodeId);
  if (!node || node.system !== null) throw conflict("no_node");

  if (action === "takedown") {
    const report = await retryOnDeadlock(db(c), async (tx) => {
      // The takedown takes the owner's tree lock FIRST; then the subtree's links; then the node
      // row (already the takedown's) and the report.
      await takedownNode(tx, node.id, { reason: "abuse", by: admin.id });
      await pauseLinks(tx, { subtreeOf: node.id }, "moderation");
      const locked = await adminQ.lockReportAndNode(tx, reportId);
      if (!locked || !OPEN_STATES.includes(locked.report.status)) throw conflict("state");
      const updated = await adminQ.setReportStatus(tx, reportId, {
        status: "actioned",
        resolution,
        resolved: true,
      });
      // The review is over: with no other report open, the node leaves `under_review` (it is
      // hidden by the takedown now) and its `report` pause goes; `moderation` stays.
      if ((await adminQ.openReportsOn(tx, node.id, reportId)).open === 0) await dismissReview(tx, node.id);
      return updated;
    });
    audit(
      c,
      "admin.report_actioned",
      { type: "report", id: reportId },
      {
        action,
        nodeId: node.id,
        reason: resolution,
      },
    );
    metric("report", { outcome: "actioned" });
    tellReporter(c, report);
    return { report, csamReportId: null };
  }

  const uploader = await currentUploader(c, node);
  if (!uploader) throw conflict("no_uploader");
  const scanned = node.scanStatus !== "pending" ? node.sha256 : null;
  const { report, strike } = await retryOnDeadlock(db(c), async (tx) => {
    const locked = await adminQ.lockReportAndNode(tx, reportId);
    if (!locked || !OPEN_STATES.includes(locked.report.status)) throw conflict("state");
    const updated = await adminQ.setReportStatus(tx, reportId, {
      status: "actioned",
      resolution,
      resolved: true,
    });
    if ((await adminQ.openReportsOn(tx, node.id, reportId)).open === 0) await dismissReview(tx, node.id);
    const struck = await addStrike(
      deps(c),
      {
        userId: uploader,
        kind: strikeKindFor(seen.category),
        reportId,
        nodeId: node.id,
        ...(scanned ? { sha256: scanned } : {}),
        note: resolution,
        issuedBy: admin.id,
      },
      { tx: tx as Tx },
    );
    return { report: updated, strike: struck };
  });
  // After the commit: the strike's audit row and the threshold.
  await strike.applySuspension?.();
  audit(
    c,
    "admin.report_actioned",
    { type: "report", id: reportId },
    {
      action,
      nodeId: node.id,
      strikeId: strike.strikeId,
      created: strike.created,
      reason: resolution,
    },
  );
  metric("report", { outcome: "actioned" });
  tellReporter(c, report);
  return { report, csamReportId: null };
}

/**
 * Escalate to `suspected_csam` — an admin decision, never automatic. A folder is refused first
 * (`409 folder`: nothing inherits from a lock). The lock is T10's one handler, on the handle,
 * outside any transaction here. Then, by the escalated report's category:
 *   (a) `csam`: the lock returns the node's open `csam` report — this one: it IS the case and
 *       stays `open` (no status written);
 *   (b) another: the lock files (or finds) the node's `csam` report; the original is closed as
 *       `actioned` with `resolution = 'escalated_csam:<id>'` (node row first, then the report).
 */
export async function escalateReport(c: C, reportId: string, resolution: string) {
  const seen = await adminQ.reportRow(db(c), reportId);
  if (!seen) throw new AppError("not_found");
  if (!OPEN_STATES.includes(seen.status)) throw conflict("state", { status: seen.status });
  if (!seen.nodeId) throw conflict("no_node");
  const node = await adminQ.nodeRow(db(c), seen.nodeId);
  if (!node || node.system !== null) throw conflict("no_node");
  if (node.kind !== "file") throw conflict("folder");

  const { reportId: csamReportId } = await lockSuspectedCsam(deps(c), node.id, { source: "admin" });
  let report = seen;
  if (seen.category !== "csam") {
    report = await retryOnDeadlock(db(c), async (tx) => {
      const locked = await adminQ.lockReportAndNode(tx, reportId);
      if (!locked) throw new AppError("not_found");
      if (!OPEN_STATES.includes(locked.report.status)) return locked.report;
      return adminQ.setReportStatus(tx, reportId, {
        status: "actioned",
        resolution: `escalated_csam:${csamReportId}`,
        resolved: true,
      });
    });
  } else if (csamReportId !== reportId) {
    // Two open `csam` reports on one file: the lock returned the other one, which is the case
    // now. This one is left as it is (a `csam` report is never `actioned` without a filing).
    captureError(new Error("escalation: the lock returned another csam report of the node"), {
      kind: "admin",
      reason: "escalate_other_case",
    });
  }
  audit(
    c,
    "admin.report_escalated",
    { type: "report", id: reportId },
    {
      nodeId: node.id,
      csamReportId,
      reason: resolution,
    },
  );
  metric("report", { outcome: "escalated" });
  if (report.status === "actioned") tellReporter(c, report);
  return { report, csamReportId };
}

/** Assign to the acting admin (or unassign). A non-`csam` report that is `open` starts review. */
export async function assignReport(c: C, admin: Admin, reportId: string, assignToMe: boolean) {
  const report = await retryOnDeadlock(db(c), async (tx) => {
    const locked = await adminQ.lockReportAndNode(tx, reportId);
    if (!locked) throw new AppError("not_found");
    const { report: current } = locked;
    // A `csam` report's `reviewing` means "the NCMEC procedure was started": only that sets it.
    const startReview = assignToMe && current.category !== "csam" && current.status === "open";
    return adminQ.setReportStatus(tx, reportId, {
      assignedTo: assignToMe ? admin.id : null,
      ...(startReview ? { status: "reviewing" } : {}),
    });
  });
  audit(c, "admin.report_assigned", { type: "report", id: reportId }, { assignedTo: report.assignedTo });
  return report;
}

// ── the NCMEC procedure (section 6) ─────────────────────────────────────────────────────────

/**
 * `POST …/ncmec/start`: report → `reviewing`, `ncmecStartedAt`; reminders stop. Idempotent.
 * THE PROCEDURE RUNS ON A LOCKED NODE (Addendum 3, B1): a `csam` report whose file is not locked
 * yet — a user's report, `under_review` only — is first locked through T10's one handler (the
 * node `suspected_csam`; node, owner and every uploader held; addresses held; links paused; its
 * record and alert), on the handle, outside any transaction here. A folder is refused.
 */
export async function ncmecStart(c: C, reportId: string) {
  const seen = await adminQ.reportRow(db(c), reportId);
  if (!seen) throw new AppError("not_found");
  if (seen.category !== "csam") throw conflict("not_csam");
  if (OPEN_STATES.includes(seen.status) && seen.nodeId) {
    const node = await adminQ.nodeRow(db(c), seen.nodeId);
    if (node && node.scanStatus !== "suspected_csam") {
      if (node.kind !== "file" || node.system !== null) throw conflict("folder");
      await lockSuspectedCsam(deps(c), node.id, { source: "admin" });
    }
  }
  const { report, changed } = await retryOnDeadlock(db(c), async (tx) => {
    const locked = await adminQ.lockReportAndNode(tx, reportId);
    if (!locked) throw new AppError("not_found");
    const { report: current, node } = locked;
    if (current.category !== "csam") throw conflict("not_csam");
    if (current.status === "reviewing") return { report: current, changed: false };
    if (current.status !== "open") throw conflict("state", { status: current.status });
    if (!node || node.scanStatus !== "suspected_csam") throw conflict("not_locked");
    const updated = await adminQ.setReportStatus(tx, reportId, {
      status: "reviewing",
      ...(current.ncmecStartedAt ? {} : { ncmecStartedAt: now(c) }),
    });
    return { report: updated, changed: true };
  });
  audit(c, "admin.ncmec_started", { type: "report", id: reportId }, { nodeId: report.nodeId, changed });
  return report;
}

/** The evidence step requires a session made within this long (sign out, sign in again). */
export const EVIDENCE_SESSION_MAX_AGE_MS = 15 * 60_000;

/**
 * `POST …/ncmec/evidence`: what a CyberTipline report needs, for EVERY subject of the lock — the
 * owner and each uploader of any version — with that person's upload addresses for THIS node's
 * versions only, opened here (the only place an address is decrypted). Audited with counts and
 * row ids only. The caller answers `Cache-Control: no-store`.
 */
export async function ncmecEvidence(c: C, reportId: string): Promise<NcmecEvidenceResponse> {
  const created = c.get("session")?.createdAt;
  const madeAt = created ? new Date(created).getTime() : Number.NaN;
  if (!(now(c).getTime() - madeAt <= EVIDENCE_SESSION_MAX_AGE_MS)) {
    throw new AppError("forbidden", "Sign out and sign in again, then open the evidence.", {
      reason: "reauth_required",
    });
  }
  const report = await adminQ.reportRow(db(c), reportId);
  if (!report || report.category !== "csam") throw new AppError("not_found");
  const node = report.nodeId ? await adminQ.nodeRow(db(c), report.nodeId) : null;
  if (!node) throw new AppError("not_found");
  // A step of the procedure for a LOCKED file (m2): nothing is opened for any other.
  if (node.scanStatus !== "suspected_csam") throw conflict("not_locked");

  const subjects = await csamSubjects(db(c), node.id);
  const subjectIds = subjects
    ? [...new Set([...(subjects.ownerId ? [subjects.ownerId] : []), ...subjects.uploaderIds])]
    : [];
  const rows = await forNode(db(c), node.id);
  const versions = await adminQ.versionsOf(db(c), node);
  const current = await currentUploader(c, node);

  let opened = 0;
  const open = async (row: (typeof rows)[number]) => {
    try {
      const ip = await openIp(c.env, { ciphertext: row.ipEncrypted, iv: row.iv, keyVersion: row.keyVersion });
      opened += 1;
      return { uploadIpRowId: row.id, versionId: row.versionId, at: row.at.toISOString(), ip };
    } catch {
      // The failure says nothing about the address; the row is still listed.
      return {
        uploadIpRowId: row.id,
        versionId: row.versionId,
        at: row.at.toISOString(),
        ip: null,
        error: "undecryptable" as const,
      };
    }
  };

  const people: NcmecEvidenceResponse["subjects"] = [];
  for (const userId of subjectIds) {
    const account = await adminQ.adminUser(db(c), userId);
    if (!account) continue;
    const own = rows.filter((row) => row.uploaderId === userId);
    const uploaded = new Set<string>([
      ...versions.filter((v) => v.createdBy === userId).map((v) => v.versionId),
      ...own.map((row) => row.versionId),
    ]);
    const addresses = [];
    for (const row of own) addresses.push(await open(row));
    people.push({
      userId,
      isOwner: userId === node.ownerId,
      uploadedVersionIds: [...uploaded],
      isCurrentVersionUploader: current !== null && userId === current,
      held: account.legalHold,
      account: {
        email: account.email,
        name: account.name,
        createdAt: account.createdAt.toISOString(),
        signInCountries: await adminQ.signInCountries(db(c), userId),
      },
      addresses,
    });
  }
  const known = new Set(people.map((person) => person.userId));
  const orphanAddresses = [];
  for (const row of rows.filter((candidate) => !known.has(candidate.uploaderId))) {
    orphanAddresses.push({ ...(await open(row)), uploaderId: row.uploaderId });
  }

  const links = await adminQ.linkSummary(db(c), node.id);
  audit(
    c,
    "admin.ncmec_evidence_opened",
    { type: "report", id: reportId },
    {
      nodeId: node.id,
      subjects: people.length,
      addresses: opened,
      uploadIpRowIds: rows.map((row) => row.id),
    },
  );
  return {
    reportId,
    node: {
      id: node.id,
      name: node.name,
      mimeSniffed: node.mimeSniffed,
      size: node.size,
      // Locked (checked above): the server's hash, never a declaration.
      sha256: node.sha256,
      uploadedAt: node.createdAt.toISOString(),
      versions: versions.map((v) => ({ versionId: v.versionId, at: v.at.toISOString(), current: v.current })),
    },
    links,
    subjects: people,
    currentVersionUploader: current !== null && known.has(current) ? "present" : "deleted",
    orphanAddresses,
  };
}

/**
 * `POST …/ncmec/filed`: `ncmecReportId`, `ncmecFiledAt`, report → `actioned`, and the earliest
 * release date (filed + 1 year) into `resolution`. ONE transaction in the clear's order — the
 * report's node row, `confirmCsam` of its hash, then the report — so from this moment the hash
 * is a confirmed listing no clear can lower. A second call changes nothing.
 */
export async function ncmecFiled(c: C, reportId: string, body: { reportId: string; filedAt: string }) {
  const filedAt = new Date(body.filedAt);
  if (filedAt.getTime() > now(c).getTime() + 60_000) {
    throw new AppError("validation", "The filing date cannot be in the future.", {
      reason: "filed_in_future",
    });
  }
  const outcome = await retryOnDeadlock(db(c), async (tx) => {
    const seen = await adminQ.reportRow(tx, reportId);
    if (!seen || seen.category !== "csam") throw new AppError("not_found");
    const node = seen.nodeId ? await adminQ.lockNodeRow(tx, seen.nodeId) : null;
    const filedBefore = seen.status === "actioned" && seen.ncmecFiledAt !== null;
    // NO FILING WITHOUT A LOCK (Addendum 3, B1): the node must be locked and held — a filing
    // starts the preservation clock, and what it preserves is what the lock holds. (A node row
    // that is gone — purged — has nothing left to hold; the filing then confirms no hash.)
    if (node && !filedBefore && (node.scanStatus !== "suspected_csam" || !node.legalHold)) {
      throw conflict("not_locked");
    }
    const confirmed = node?.sha256 ? await blocklist.confirmCsam(tx, node.sha256) : false;
    const locked = await adminQ.lockReportAndNode(tx, reportId);
    const report = locked!.report;
    if (report.status === "actioned" && report.ncmecFiledAt) return { report, changed: false, confirmed };
    // ...and only after `ncmec/start`: the case was started (and, there, locked).
    if (report.status === "open") throw conflict("not_started");
    if (report.status !== "reviewing") throw conflict("state", { status: report.status });
    const updated = await adminQ.setReportStatus(tx, reportId, {
      status: "actioned",
      ncmecReportId: body.reportId,
      ncmecFiledAt: filedAt,
      resolution: `release_not_before:${releasableAt(filedAt).toISOString()}`,
      resolved: true,
    });
    return { report: updated, changed: true, confirmed };
  });
  audit(
    c,
    "admin.ncmec_filed",
    { type: "report", id: reportId },
    {
      nodeId: outcome.report.nodeId,
      changed: outcome.changed,
      hashConfirmed: outcome.confirmed,
      filedAt: outcome.report.ncmecFiledAt?.toISOString() ?? null,
    },
  );
  metric("report", { outcome: "filed" });
  return outcome.report;
}

type ReleaseState = { allowed: true } | { allowed: false; releasableAt: string | null };

/** The release table, from the report row alone. */
export function releaseStateOf(report: Report, at: Date): ReleaseState {
  if (report.ncmecFiledAt) {
    const date = releasableAt(report.ncmecFiledAt);
    return at.getTime() >= date.getTime()
      ? { allowed: true }
      : { allowed: false, releasableAt: date.toISOString() };
  }
  if (report.status === "dismissed") return { allowed: true };
  if (report.status === "actioned") {
    // Cannot exist (section 5's invariant): a defect, treated as "never" and logged.
    captureError(new Error("a csam report is actioned without ncmecFiledAt"), {
      kind: "admin",
      reason: "invariant",
    });
  }
  return { allowed: false, releasableAt: null };
}

type ReleaseDecision = {
  releaseNode: boolean;
  nodeKeptBecause: string | null;
  release: string[];
  kept: ReleaseHoldsResponse["kept"];
};

async function decideRelease(
  dbx: Parameters<typeof adminQ.subjectOfAny>[0],
  report: Report,
  node: Node,
  subjectIds: string[],
  at: Date,
): Promise<ReleaseDecision> {
  const others = await adminQ.unreleasableCsamReports(dbx, report.id, at);
  const otherNodes = others.flatMap((other) =>
    other.nodeId && other.nodeId !== node.id ? [other.nodeId] : [],
  );
  const lockedElsewhere = await adminQ.otherLockedNodes(dbx, node.id);
  const nodeNamedAgain = others.some((other) => other.nodeId === node.id);
  const release: string[] = [];
  const kept: ReleaseHoldsResponse["kept"] = [];
  for (const userId of subjectIds) {
    const account = await adminQ.adminUser(dbx, userId);
    if (!account || !account.legalHold) continue;
    if (await adminQ.subjectOfAny(dbx, userId, lockedElsewhere))
      kept.push({ userId, because: "other_locked_node" });
    else if (
      (nodeNamedAgain && subjectIds.includes(userId)) ||
      (await adminQ.subjectOfAny(dbx, userId, otherNodes))
    ) {
      kept.push({ userId, because: "other_csam_report" });
    } else if (await adminQ.legalHoldSetByHand(dbx, userId)) kept.push({ userId, because: "set_by_hand" });
    else release.push(userId);
  }
  return {
    releaseNode: node.legalHold && !nodeNamedAgain,
    nodeKeptBecause: node.legalHold && nodeNamedAgain ? "other_csam_report" : null,
    release,
    kept,
  };
}

const subjectIdsOf = (subjects: Awaited<ReturnType<typeof csamSubjects>>) =>
  subjects
    ? [...new Set([...(subjects.ownerId ? [subjects.ownerId] : []), ...subjects.uploaderIds])].sort()
    : [];

/**
 * "Release holds" — the one release (section 6). Allowed per the release table, read from the
 * report row; what it releases is decided from the rows INSIDE the transaction, after the locks:
 * (1) the owner's tree lock, (2) the subject users ascending, (3) the node — then the decision,
 * then `setNodeLegalHold`, `setUserLegalHold`, `releaseForNode`. Kept and named: a user another
 * locked node or another unreleasable `csam` report names, or whose hold was set by hand; the
 * node when another such report names it. No status changes; nothing is deleted.
 */
export async function releaseHolds(c: C, reportId: string, reason: string, confirm: boolean) {
  const at = now(c);
  const seen = await adminQ.reportRow(db(c), reportId);
  if (!seen || seen.category !== "csam") throw new AppError("not_found");
  const state = releaseStateOf(seen, at);
  if (!state.allowed)
    throw new AppError("conflict", undefined, {
      reason: "hold_not_releasable",
      ...(state.releasableAt ? { releasableAt: state.releasableAt } : {}),
    });
  const node = seen.nodeId ? await adminQ.nodeRow(db(c), seen.nodeId) : null;
  const empty = {
    confirmed: confirm,
    node: { released: false, keptBecause: null },
    releasedUserIds: [],
    kept: [],
    uploadIpsReleased: 0,
    nothingToRelease: true,
  };
  if (!node) return empty;
  // m3: a report that was never filed releases nothing while its own node is still locked (the
  // lock's case is elsewhere — another report, or T22's unrecorded-lock repair). A FILED report's
  // node stays locked for good (Clear lock refuses it): the filed row of the table applies.
  if (!seen.ncmecFiledAt && node.scanStatus === "suspected_csam") throw conflict("node_locked");

  if (!confirm) {
    const decision = await decideRelease(
      db(c),
      seen,
      node,
      subjectIdsOf(await csamSubjects(db(c), node.id)),
      at,
    );
    return preview(decision);
  }

  const done = await onceMore(() =>
    retryOnDeadlock(db(c), async (tx) => {
      const planned = subjectIdsOf(await csamSubjects(tx, node.id));
      await lockOwnerTree(tx, node.ownerId);
      await adminQ.lockUsers(tx, planned);
      const lockedNode = await adminQ.lockNodeRow(tx, node.id);
      if (!lockedNode) return null;
      if (!seen.ncmecFiledAt && lockedNode.scanStatus === "suspected_csam") throw conflict("node_locked");
      const subjects = subjectIdsOf(await csamSubjects(tx, node.id));
      if (subjects.some((id) => !planned.includes(id))) throw new Retry();
      const report = (await adminQ.lockReportAndNode(tx, reportId))!.report;
      const again = releaseStateOf(report, at);
      if (!again.allowed)
        throw new AppError("conflict", undefined, {
          reason: "hold_not_releasable",
          ...(again.releasableAt ? { releasableAt: again.releasableAt } : {}),
        });
      const decision = await decideRelease(tx, report, lockedNode, subjects, at);
      if (decision.releaseNode) await setNodeLegalHold(tx, node.id, false);
      for (const userId of decision.release) await setUserLegalHold(tx, userId, false);
      const uploadIps = decision.nodeKeptBecause === null ? await releaseForNode(tx, node.id) : 0;
      return { decision, uploadIps };
    }),
  );
  if (!done) return empty;
  const { decision, uploadIps } = done;
  const nothing = !decision.releaseNode && decision.release.length === 0 && uploadIps === 0;
  audit(
    c,
    "admin.csam_holds_released",
    { type: "report", id: reportId },
    {
      nodeId: node.id,
      reason,
      nodeReleased: decision.releaseNode,
      releasedUserIds: decision.release,
      kept: decision.kept,
      uploadIps,
    },
  );
  return {
    confirmed: true,
    node: { released: decision.releaseNode, keptBecause: decision.nodeKeptBecause },
    releasedUserIds: decision.release,
    kept: decision.kept,
    uploadIpsReleased: uploadIps,
    nothingToRelease: nothing,
  } satisfies ReleaseHoldsResponse;

  function preview(decision: ReleaseDecision): ReleaseHoldsResponse {
    return {
      confirmed: false,
      node: { released: decision.releaseNode, keptBecause: decision.nodeKeptBecause },
      releasedUserIds: decision.release,
      kept: decision.kept,
      uploadIpsReleased: 0,
      nothingToRelease: !decision.releaseNode && decision.release.length === 0,
    };
  }
}

/** The blocklist outcome of a clear, as one short value for the audit row. */
function blocklistOutcome(result: CsamClearResult): string {
  if (result.blocklistRemoved) return "removed";
  if (result.blocklistRestoredTo) return `restored:${result.blocklistRestoredTo}`;
  if (result.blocklistKept) return `kept:${result.blocklistKept}`;
  return "none";
}

/**
 * "Clear lock (false positive)", two steps. The confirmed call runs T05's `clearSuspectedCsam`
 * as the FIRST statement of its transaction (it locks the node, the hash's entry, every report
 * on the node); a refusal is `409 not_locked` / `409 reported` with nothing written. After the
 * commit: the audit row and ONE rescan. Holds are NOT touched ("Release holds" does that).
 */
export async function clearLock(
  c: C,
  reportId: string,
  reason: string,
  confirm: boolean,
): Promise<ClearLockResponse> {
  const report = await adminQ.reportRow(db(c), reportId);
  if (!report || report.category !== "csam" || !report.nodeId) throw new AppError("not_found");
  const nodeId = report.nodeId;
  if (!confirm) {
    const node = await adminQ.nodeRow(db(c), nodeId);
    if (!node || node.scanStatus !== "suspected_csam") throw conflict("not_locked");
    const filed = (await adminQ.csamReportsOn(db(c), nodeId)).some((r) => r.status === "actioned");
    if (filed) throw conflict("reported");
    return { confirmed: false, result: null, nodeStatus: node.scanStatus };
  }
  const result = await retryOnDeadlock(db(c), (tx) => clearSuspectedCsam(tx, nodeId));
  if (!result.cleared) throw conflict(result.refused ?? "not_locked");
  audit(
    c,
    "admin.csam_lock_cleared",
    { type: "node", id: nodeId },
    {
      reportId,
      reason,
      blocklist: blocklistOutcome(result),
      reportIds: result.reportIds,
    },
  );
  await rescanQuietly(c, nodeId);
  const after = await adminQ.nodeRow(db(c), nodeId);
  return { confirmed: true, result, nodeStatus: after?.scanStatus ?? null };
}

/** What "find, then lock" accepts, and the node id it carries. Never a token. */
export async function resolveReference(
  c: C,
  reference: string,
): Promise<{ kind: LockCsamResponse["referenceKind"]; nodeId: string } | null> {
  const value = reference.trim();
  if (isUuid(value.toLowerCase())) return { kind: "node_id", nodeId: value.toLowerCase() };
  if (/^u\/[A-Za-z0-9]{32}\/[0-9a-f-]{36}\/[A-Za-z0-9_-]+$/.test(value)) {
    const found = await keyReference(db(c), value);
    if (!found || found.kind === "upload") return null;
    return { kind: "object_key", nodeId: found.nodeId };
  }
  let path = value;
  try {
    if (/^[a-z]+:\/\//i.test(value)) path = new URL(value).pathname;
  } catch {
    return null;
  }
  path = path.split(/[?#]/)[0]!;
  // The files host's three forms. `/s/<token>` (a public link) is deliberately not one of them.
  const match =
    /^\/(?:d|i)\/([0-9a-f-]{36})\/[^/]+\/?$/.exec(path) ??
    /^\/t\/([0-9a-f-]{36})\/[^/]+\/[^/]+\/?$/.exec(path);
  if (match && isUuid(match[1]!)) return { kind: "files_url", nodeId: match[1]! };
  return null;
}

/**
 * "Lock from an outside notice" — `POST /api/admin/moderation/lock-csam`, two steps. The lookup
 * shows the match (metadata only); the confirm calls T10's `lockSuspectedCsam` (`source: admin`).
 * A folder is `409 folder` on both calls, nothing written; no match is `404`.
 */
export async function lockFromNotice(
  c: C,
  reference: string,
  reason: string,
  confirm: boolean,
): Promise<LockCsamResponse> {
  const resolved = await resolveReference(c, reference);
  if (!resolved) throw new AppError("not_found");
  const node = await adminQ.nodeRow(db(c), resolved.nodeId);
  if (!node || node.system !== null) throw new AppError("not_found");
  if (node.kind !== "file") throw conflict("folder");
  const versions = await adminQ.versionsOf(db(c), node);
  const ips = await forNode(db(c), node.id);
  const uploaderOf = (versionId: string, createdBy: string | null) =>
    ips.filter((row) => row.versionId === versionId).at(-1)?.uploaderId ?? createdBy;
  const names = await adminQ.namesOf(db(c), [
    node.ownerId,
    ...versions.flatMap((v) => (v.createdBy ? [v.createdBy] : [])),
    ...ips.map((row) => row.uploaderId),
  ]);
  const ref = (id: string | null) => (id && names.has(id) ? { id, displayName: names.get(id)! } : null);
  const match: LockCsamResponse["match"] = {
    nodeId: node.id,
    name: node.name,
    mimeSniffed: node.mimeSniffed,
    size: node.size,
    sha256: node.scanStatus !== "pending" ? node.sha256 : null,
    owner: ref(node.ownerId) ?? { id: node.ownerId, displayName: "" },
    uploaders: versions.map((v) => ({
      versionId: v.versionId,
      uploader: ref(uploaderOf(v.versionId, v.createdBy)),
    })),
    scanStatus: node.scanStatus,
  };
  if (!confirm) return { confirmed: false, referenceKind: resolved.kind, match, reportId: null };
  const { reportId } = await lockSuspectedCsam(deps(c), node.id, { source: "admin" });
  audit(
    c,
    "admin.csam_lock_manual",
    { type: "node", id: node.id },
    { referenceKind: resolved.kind, reportId, reason },
  );
  const after = await adminQ.nodeRow(db(c), node.id);
  return {
    confirmed: true,
    referenceKind: resolved.kind,
    match: { ...match, scanStatus: after?.scanStatus ?? match.scanStatus },
    reportId,
  };
}

// ── quarantine (section 4) ──────────────────────────────────────────────────────────────────

/**
 * Mark false positive → `clean`. ONLY an `infected` node that is not taken down, decided on the
 * row locked in the writing transaction (`409 conflict` otherwise, nothing written). The blocklist
 * entry goes only if THIS node's verdict added it as malware (`remove` with both options).
 */
export async function markFalsePositive(c: C, nodeId: string, reason: string) {
  const done = await retryOnDeadlock(db(c), async (tx) => {
    const node = await adminQ.lockNodeRow(tx, nodeId);
    if (!node || node.system !== null) throw new AppError("not_found");
    if (node.scanStatus !== "infected" || node.takedownAt !== null) {
      throw conflict("not_infected", { scanStatus: node.scanStatus, takenDown: node.takedownAt !== null });
    }
    const row = await adminQ.markClean(tx, nodeId);
    if (!row) throw conflict("not_infected");
    const removed = node.sha256
      ? await blocklist.remove(tx, node.sha256, { onlyIfReason: "malware", onlyIfSourceNodeId: node.id })
      : false;
    return { row, removed, uploader: node.createdBy };
  });
  audit(c, "admin.false_positive", { type: "node", id: nodeId }, { reason, blocklistRemoved: done.removed });
  return {
    node: done.row,
    blocklistRemoved: done.removed,
    malwareStrikeId: await adminQ.malwareStrikeFor(db(c), done.uploader, nodeId),
  };
}

/**
 * Confirm delete: purge now through T14's `purgeRoot` (`"account"` — the one rule that takes a
 * root that is not in the trash), keeping the hash in the blocklist. FIRST `readsRolledBack`
 * (rolled back or paused → `409 destroy_paused`, nothing written: an admin is the operator, so
 * the refusal needs no disguise). A held node is `409 held` with every cause.
 */
export async function confirmDelete(c: C, nodeId: string, reason: string) {
  const node = await adminQ.nodeRow(db(c), nodeId);
  if (!node || node.system !== null) throw new AppError("not_found");
  if (await readsRolledBack(c.env, db(c))) {
    throw conflict(
      "destroy_paused",
      {},
      "Deleting is stopped: the database reads as rolled back or the pause switch is on.",
    );
  }
  const causes = await heldCauses(c, nodeId);
  if (causes.length > 0) throw conflict("held", { holds: causes });
  const result = await purgeRoot(c, nodeId, "account");
  if (result.outcome === "held") throw conflict("held", { holds: await heldCauses(c, nodeId) });
  if (result.outcome !== "purged") throw new AppError("not_found");
  audit(
    c,
    "admin.node_purged",
    { type: "node", id: nodeId },
    {
      reason,
      objects: result.objects,
      bytes: result.freedBytes,
    },
  );
  return { purged: true };
}

/** The node's own and inherited causes, and its subtree's (the gate's view), by the console's names. */
async function heldCauses(c: C, nodeId: string): Promise<adminQ.ConsoleHoldCause[]> {
  const own = await adminQ.holdCausesOf(db(c), nodeId);
  const found = new Set<adminQ.ConsoleHoldCause>(own);
  try {
    await assertPurgeable(db(c), [nodeId]);
  } catch (error) {
    if (!(error instanceof LegalHoldError)) throw error;
    for (const cause of error.causes[nodeId] ?? []) {
      // The gate merges own and inherited; an inherited one is already named apart above.
      if (
        cause === "node_legal_hold" &&
        found.has("inherited_legal_hold") &&
        !own.includes("node_legal_hold")
      )
        continue;
      if (cause === "open_notice" && found.has("inherited_open_notice") && !own.includes("open_notice"))
        continue;
      found.add(cause as adminQ.ConsoleHoldCause);
    }
  }
  return [...found];
}

// ── copyright notices (section 7) ───────────────────────────────────────────────────────────

/** `n` business days after `from` (weekends skipped; US federal holidays are NOT modelled). */
export function addBusinessDays(from: Date, n: number): Date {
  const at = new Date(from.getTime());
  let left = n;
  while (left > 0) {
    at.setTime(at.getTime() + DAY_MS);
    const day = at.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return at;
}

export const RESTORE_AFTER_BUSINESS_DAYS = 10;
export const RESTORE_BY_BUSINESS_DAYS = 14;

type NoticeInput = Omit<adminQ.NewNotice, "receivedAt"> & { receivedAt?: Date };

/**
 * Intake. One notice per alleged infringer: the nodes are grouped by the uploader of their current
 * version and each group is a notice of its own, with the nodes snapshotted. Each insert holds the
 * tree locks of its nodes' owners (an open notice protects what it names).
 */
export async function createNotices(c: C, admin: Admin, input: NoticeInput, nodeIds: string[]) {
  const rows: Node[] = [];
  for (const id of [...new Set(nodeIds)]) {
    const node = await adminQ.nodeRow(db(c), id);
    if (!node || node.system !== null)
      throw new AppError("validation", "A named file does not exist.", {
        reason: "unknown_node",
        nodeId: id,
      });
    rows.push(node);
  }
  const groups = new Map<string, Node[]>();
  for (const node of rows) {
    const key = (await currentUploader(c, node)) ?? "unknown";
    groups.set(key, [...(groups.get(key) ?? []), node]);
  }
  if (groups.size === 0) groups.set("none", []);
  const created: DmcaNotice[] = [];
  for (const group of groups.values()) {
    const notice = await retryOnDeadlock(db(c), async (tx) => {
      await adminQ.lockOwnerTrees(
        tx,
        group.map((node) => node.ownerId),
      );
      return adminQ.insertNotice(
        tx,
        { ...input, receivedAt: input.receivedAt ?? now(c) },
        group.map((node) => ({
          id: node.id,
          name: node.name,
          sha256: node.scanStatus !== "pending" ? node.sha256 : null,
        })),
        admin.id,
      );
    });
    created.push(notice);
    audit(
      c,
      "admin.dmca_notice_created",
      { type: "dmca_notice", id: notice.id },
      { nodes: group.length, split: groups.size > 1 },
    );
  }
  return created;
}

/** The statuses a takedown may start from. */
const TAKEDOWN_FROM: readonly DmcaNotice["status"][] = ["received", "incomplete"];

/**
 * Take down (status → `actioned`). ONE transaction: (0) the tree locks of every owner the notice
 * names, ascending; (1) the transition as a conditional write — no row = already actioned (a
 * double-click, a retry) or never allowed, and nothing below runs; (2) `takedownNode` and the
 * subtree's links paused `moderation` (paused, not revoked), the `dmca` blocklist rows; (3) the
 * strike in the same transaction (`addStrike(…, { tx })`) and `strikeId` on the notice;
 * `ownerNotifiedAt` is set with the transition. After the commit: the strike's audit row and
 * threshold, then the owner's mail — sent by this call only. A repeat answers the notice as it stands.
 */
async function takedownNotice(c: C, admin: Admin, notice: adminQ.NoticeWithNodes, note: string | null) {
  const uploader = await firstUploader(c, notice);
  const outcome = await retryOnDeadlock(db(c), async (tx) => {
    await adminQ.lockOwnerTrees(tx, await adminQ.noticeOwners(tx, notice.id));
    const moved = await adminQ.transitionNotice(tx, notice.id, TAKEDOWN_FROM, {
      status: "actioned",
      takedownAt: now(c),
      // Claimed WITH the transition: a request that lost the race reads the notice after this
      // commit, so both answer the same body — and only the winner mails (`notifyOwner`).
      ownerNotifiedAt: now(c),
      handledBy: admin.id,
    });
    if (!moved) return null;
    for (const { nodeId } of notice.nodes) {
      // A notice changes only what it changes (M1): a node already taken down — for abuse, by an
      // admin, as csam, or by another notice — keeps its takedown and its reason as they are.
      const before = await adminQ.nodeRow(tx, nodeId);
      if (!before || before.takedownAt !== null) continue;
      if (!(await takedownNode(tx, nodeId, { reason: "dmca", by: admin.id }))) continue;
      await pauseLinks(tx, { subtreeOf: nodeId }, "moderation");
      // The hash is listed `dmca` only when it is listed for nothing yet: an entry another
      // reason made is never rewritten (and so never removed by this notice's restore).
      if (before.sha256 && before.scanStatus !== "pending" && !(await blocklist.lookup(tx, before.sha256))) {
        await blocklist.upsert(tx, {
          sha256: before.sha256,
          reason: "dmca",
          sourceNodeId: nodeId,
          addedBy: admin.id,
        });
      }
    }
    const strike = uploader
      ? await addStrike(
          deps(c),
          { userId: uploader, kind: "dmca", issuedBy: admin.id, ...(note ? { note } : {}) },
          { tx: tx as Tx },
        )
      : null;
    if (strike) await adminQ.updateNotice(tx, notice.id, { strikeId: strike.strikeId });
    return { strike };
  });
  const current = (await adminQ.noticeById(db(c), notice.id))!;
  if (!outcome) {
    if (current.status === "actioned") return current;
    throw conflict("state", { status: current.status });
  }
  await outcome.strike?.applySuspension?.();
  audit(
    c,
    "admin.dmca_takedown",
    { type: "dmca_notice", id: notice.id },
    {
      nodes: notice.nodes.map((n) => n.nodeId),
      strikeId: outcome.strike?.strikeId ?? null,
      reason: note,
    },
  );
  await notifyOwner(c, current);
  return (await adminQ.noticeById(db(c), notice.id))!;
}

async function firstUploader(c: C, notice: adminQ.NoticeWithNodes): Promise<string | null> {
  for (const { nodeId } of notice.nodes) {
    const node = await adminQ.nodeRow(db(c), nodeId);
    if (node) {
      const who = await currentUploader(c, node);
      if (who) return who;
    }
  }
  return null;
}

async function ownerOf(c: C, notice: adminQ.NoticeWithNodes) {
  for (const { nodeId, nodeName } of notice.nodes) {
    const node = await adminQ.nodeRow(db(c), nodeId);
    if (node) {
      const owner = await adminQ.adminUser(db(c), node.ownerId);
      if (owner) return { owner, itemName: nodeName ?? node.name };
    }
  }
  return null;
}

/** The "content removed" mail — sent by the one takedown that moved the notice. */
async function notifyOwner(c: C, notice: adminQ.NoticeWithNodes) {
  // Only the call whose transition moved the notice gets here: `ownerNotifiedAt` was set with it.
  const found = await ownerOf(c, notice);
  if (!found) return;
  deps(c).defer(
    sendContentRemovedCopyright(deps(c), {
      to: found.owner.email,
      name: found.owner.name,
      itemName: found.itemName,
      noticeText: notice.infringingDescription ?? notice.rawText ?? "",
    }),
  );
}

/**
 * Restore — only from `restoreNotBefore` (compared with `now(c)` HERE, not only in the UI) and
 * only while no lawsuit notice is recorded. One transaction under the owners' tree locks:
 * `restoreTakedown`, the subtree's `moderation` pause lifted (T05 keeps it where the node is still
 * hidden otherwise), the `dmca` entry removed only if it is still `dmca`; status → `restored`.
 * After the commit: the strike lifted, a rescan for a node left `pending`, the owner's mail.
 * `withdraw` is the same restore with `closeNotice(…, 'withdrawn')` as the status change.
 */
async function restoreNotice(
  c: C,
  admin: Admin,
  notice: adminQ.NoticeWithNodes,
  mode: "restore" | "withdraw",
  note: string | null,
) {
  if (mode === "restore") {
    if (notice.lawsuitNoticeAt) throw conflict("lawsuit");
    if (notice.status !== "counter_received" || !notice.restoreNotBefore)
      throw conflict("state", { status: notice.status });
    if (now(c).getTime() < notice.restoreNotBefore.getTime()) {
      throw conflict("before_window", { restoreNotBefore: notice.restoreNotBefore.toISOString() });
    }
  }
  const moved = await retryOnDeadlock(db(c), async (tx) => {
    if (mode === "withdraw") {
      // closeNotice takes every owner's tree lock itself, FIRST.
      if (!(await closeNotice(tx, notice.id, "withdrawn"))) return false;
      await adminQ.updateNotice(tx, notice.id, { restoredAt: now(c), restoredBy: admin.id });
    } else {
      await adminQ.lockOwnerTrees(tx, await adminQ.noticeOwners(tx, notice.id));
      const row = await adminQ.transitionNotice(tx, notice.id, ["counter_received"], {
        status: "restored",
        restoredAt: now(c),
        restoredBy: admin.id,
      });
      if (!row) return false;
    }
    const ours = new Set(notice.nodes.map((n) => n.nodeId));
    for (const { nodeId } of notice.nodes) {
      // Lifted only when no other cause remains (M1): a DMCA takedown, and no OTHER notice that
      // still holds a takedown on the node — by its recorded effect, whatever its status
      // (upheld and closed-after-takedown count). Read under the tree locks this transaction holds.
      const node = await adminQ.nodeRow(tx, nodeId);
      if (!node || node.takedownAt === null || node.takedownReason !== "dmca") continue;
      if (await adminQ.otherActiveNoticeNames(tx, notice.id, { nodeId })) continue;
      await restoreTakedown(tx, nodeId);
      await unpauseLinks(tx, { subtreeOf: nodeId }, "moderation");
      // The `dmca` entry goes only if a node of THIS notice put it there and no other notice in
      // force names the same content.
      if (node.sha256) {
        const entry = await blocklist.lookup(tx, node.sha256);
        if (
          entry?.reason === "dmca" &&
          entry.sourceNodeId !== null &&
          ours.has(entry.sourceNodeId) &&
          !(await adminQ.otherActiveNoticeNames(tx, notice.id, { sha256: node.sha256 }))
        ) {
          await blocklist.remove(tx, node.sha256, {
            onlyIfReason: "dmca",
            onlyIfSourceNodeId: entry.sourceNodeId,
          });
        }
      }
    }
    return true;
  });
  if (!moved) throw conflict("state", { status: notice.status });
  // Recorded now that it has committed — before the steps that follow, which may fail (m5).
  audit(c, `admin.dmca_${mode}`, { type: "dmca_notice", id: notice.id }, { reason: note });
  if (notice.strikeId) {
    try {
      await liftStrike(deps(c), notice.strikeId, admin.id);
    } catch (error) {
      // Already lifted (by hand): nothing to do. Anything else is reported: the restore stands.
      if (!(error instanceof AppError)) captureError(error, { kind: "admin", reason: "dmca_lift_strike" });
    }
  }
  for (const { nodeId } of notice.nodes) {
    const node = await adminQ.nodeRow(db(c), nodeId);
    if (node?.scanStatus === "pending") await rescanQuietly(c, nodeId);
  }
  const found = await ownerOf(c, notice);
  if (found) {
    deps(c).defer(
      sendContentRestored(deps(c), {
        to: found.owner.email,
        name: found.owner.name,
        itemName: found.itemName,
      }),
    );
  }
}

/** One DMCA action. Each answers the notice as it now stands; a state that does not allow it is `409 state`. */
export async function noticeAction(
  c: C,
  admin: Admin,
  noticeId: string,
  body: { action: string; checklist?: Record<string, unknown>; note?: string },
) {
  const notice = await adminQ.noticeById(db(c), noticeId);
  if (!notice) throw new AppError("not_found");
  const note = body.note?.trim() || null;
  const simple = async (
    from: readonly DmcaNotice["status"][],
    patch: Partial<DmcaNotice>,
    leavesOpen: boolean,
  ) => {
    const row = await retryOnDeadlock(db(c), async (tx) => {
      // A change into or out of the open statuses ends a cause that reaches down: tree locks first.
      if (leavesOpen) await adminQ.lockOwnerTrees(tx, await adminQ.noticeOwners(tx, noticeId));
      return adminQ.transitionNotice(tx, noticeId, from, { ...patch, handledBy: admin.id });
    });
    if (!row) throw conflict("state", { status: notice.status });
  };
  switch (body.action) {
    case "mark_incomplete":
      await simple(
        ["received", "incomplete"],
        { status: "incomplete", ...(body.checklist ? { checklist: body.checklist } : {}) },
        false,
      );
      break;
    case "reject":
      await simple(
        ["received", "incomplete"],
        { status: "rejected", ...(body.checklist ? { checklist: body.checklist } : {}) },
        true,
      );
      break;
    case "takedown":
      if (body.checklist) await adminQ.updateNotice(db(c), noticeId, { checklist: body.checklist });
      return takedownNotice(c, admin, notice, note);
    case "forward_counter": {
      const at = now(c);
      await simple(
        ["counter_received"],
        {
          counterForwardedAt: at,
          restoreNotBefore: addBusinessDays(at, RESTORE_AFTER_BUSINESS_DAYS),
          restoreNotAfter: addBusinessDays(at, RESTORE_BY_BUSINESS_DAYS),
        },
        false,
      );
      break;
    }
    case "lawsuit_notice":
      await simple(["actioned", "counter_received"], { status: "upheld", lawsuitNoticeAt: now(c) }, true);
      break;
    case "uphold":
      await simple(["counter_received"], { status: "upheld" }, true);
      break;
    case "restore":
      await restoreNotice(c, admin, notice, "restore", note);
      return (await adminQ.noticeById(db(c), noticeId))!;
    case "withdraw":
      if (notice.status === "received" || notice.status === "incomplete") {
        // It took no action: closed as withdrawn, and nothing on the nodes changes (M1).
        const closed = await retryOnDeadlock(db(c), (tx) => closeNotice(tx, noticeId, "withdrawn"));
        if (!closed) throw conflict("state", { status: notice.status });
      } else {
        await restoreNotice(c, admin, notice, "withdraw", note);
        return (await adminQ.noticeById(db(c), noticeId))!;
      }
      break;
    case "close": {
      const closed = await retryOnDeadlock(db(c), (tx) => closeNotice(tx, noticeId, "closed"));
      if (!closed) throw conflict("state", { status: notice.status });
      break;
    }
    default:
      throw new AppError("validation");
  }
  audit(c, `admin.dmca_${body.action}`, { type: "dmca_notice", id: noticeId }, { reason: note });
  return (await adminQ.noticeById(db(c), noticeId))!;
}

/** The counter-notice (§512(g)) on a notice that was acted on: status → `counter_received`. */
export async function counterNotice(
  c: C,
  admin: Admin,
  noticeId: string,
  counter: Record<string, unknown> & { counterReceivedAt?: string },
) {
  const { counterReceivedAt, ...fields } = counter;
  const row = await retryOnDeadlock(db(c), (tx) =>
    adminQ.transitionNotice(tx, noticeId, ["actioned"], {
      ...(fields as Partial<DmcaNotice>),
      status: "counter_received",
      counterReceivedAt: counterReceivedAt ? new Date(counterReceivedAt) : now(c),
      handledBy: admin.id,
    }),
  );
  if (!row) {
    const notice = await adminQ.noticeById(db(c), noticeId);
    if (!notice) throw new AppError("not_found");
    throw conflict("state", { status: notice.status });
  }
  audit(c, "admin.dmca_counter_received", { type: "dmca_notice", id: noticeId }, null);
  return (await adminQ.noticeById(db(c), noticeId))!;
}

// ── the rollback detector and the generation (section 11) ───────────────────────────────────

type DetectorReading = DetectorDto & { rawObject: string | null; rawDatabase: string | null };

/** How the two copies read — read only, nothing written, nothing mailed. */
export async function readDetector(c: C): Promise<DetectorReading> {
  const pauseSwitch = await readPauseSwitch(c.env);
  const fresh = await adminQ.orphanDeleteSetting(db(c));
  let objectText: string | null = null;
  let databaseText: string | null = null;
  let unreadable = false;
  try {
    const found = await storage(c.env).get(GENERATION_KEY);
    objectText = found && found.kind === "body" ? await found.object.text() : null;
  } catch {
    unreadable = true;
  }
  try {
    databaseText = (await readDetectorFields(db(c))).generation;
  } catch {
    unreadable = true;
  }
  const objectNumber = objectText === null ? null : parseGeneration(objectText);
  const databaseNumber = databaseText === null ? 0 : parseGeneration(databaseText);
  let reading: DetectorDto["reading"];
  if (unreadable) reading = "unreadable";
  else if ((objectText !== null && objectNumber === null) || databaseNumber === null) reading = "anomaly";
  else if (objectText === null) reading = databaseNumber === 0 ? "first" : "object_missing";
  else if (databaseNumber === 0 && objectNumber === 1) reading = "first";
  else reading = objectNumber! > databaseNumber ? "object_ahead" : "level";
  return {
    object: { raw: objectText, number: objectNumber },
    database: { raw: databaseText, number: databaseText === null ? 0 : databaseNumber },
    reading,
    pauseSwitch,
    orphanDeleteEnabled: fresh,
    rawObject: objectText,
    rawDatabase: databaseText,
  };
}

/** The reading as the contract carries it (without the raw texts the action compares from). */
export function publicReading(reading: DetectorReading): DetectorDto {
  return {
    object: reading.object,
    database: reading.database,
    reading: reading.reading,
    pauseSwitch: reading.pauseSwitch,
    orphanDeleteEnabled: reading.orphanDeleteEnabled,
  };
}

function plannedLevel(reading: DetectorReading): AcceptGenerationResponse["action"] {
  if (reading.reading === "object_ahead") return "advance_database";
  if (reading.reading === "anomaly" && reading.object.number !== null && reading.database.number === null) {
    return "advance_database";
  }
  if (
    (reading.reading === "object_missing" || reading.reading === "anomaly") &&
    reading.database.number !== null
  ) {
    return "rewrite_object";
  }
  return "none";
}

/**
 * "Accept the database's generation" — one audited, two-step action that levels the two numbers,
 * holding the generation lock (so it cannot interleave with `restore-heartbeat` or a reconcile
 * run). Object ahead → the database's `generation` FIELD moved by compare-and-set from the raw
 * text just read (`advanceGenerationRow` — never the whole `reconcileCursor`); object missing or
 * not a number → the object rewritten with the database's number. Unreadable is refused.
 */
export async function acceptGeneration(
  c: C,
  reason: string,
  confirm: boolean,
): Promise<AcceptGenerationResponse> {
  const first = await readDetector(c);
  if (first.reading === "unreadable") throw conflict("unreadable");
  const action = plannedLevel(first);
  const before = { object: first.rawObject, database: first.rawDatabase };
  if (!confirm) return { confirmed: false, action, before, after: null, detector: publicReading(first) };
  // Levelling RE-ARMS every destroyer: it is done only with the pause switch ON (m7) — checked
  // here, not trusted from the checklist the console ticks.
  if (first.pauseSwitch !== "on") throw conflict("not_paused");
  if (action === "none") throw conflict("level");

  const locked = await withJobLock(db(c), GENERATION_LOCK, GENERATION_LOCK_HOLD_MS, async () => {
    // Decided again under the lock, from a fresh reading: never from the preview.
    const reading = await readDetector(c);
    const planned = plannedLevel(reading);
    if (reading.reading === "unreadable") throw conflict("unreadable");
    if (planned === "none") throw conflict("level");
    if (planned === "advance_database") {
      const moved = await advanceGenerationRow(db(c), reading.rawDatabase, String(reading.object.number));
      if (!moved) throw conflict("changed_meanwhile");
    } else {
      const body = new TextEncoder().encode(String(reading.database.number));
      await storage(c.env).put(GENERATION_KEY, body, { size: body.byteLength, contentType: "text/plain" });
    }
    return { reading, planned };
  });
  if (!locked.held) throw conflict("lock_held");
  const after = await readDetector(c);
  audit(
    c,
    "admin.generation_accepted",
    { type: "system", id: "generation" },
    {
      reason,
      action: locked.value.planned,
      before: { object: locked.value.reading.rawObject, database: locked.value.reading.rawDatabase },
      after: { object: after.rawObject, database: after.rawDatabase },
    },
  );
  return {
    confirmed: true,
    action: locked.value.planned,
    before: { object: locked.value.reading.rawObject, database: locked.value.reading.rawDatabase },
    after: { object: after.rawObject, database: after.rawDatabase },
    detector: publicReading(after),
  };
}

/**
 * The pause switch, two steps for on AND off. On: the object is put; off: it is deleted — the
 * one object delete that does NOT ask `readsRolledBack` (that predicate reads this very object:
 * asking it would make the switch impossible to turn off; it is no content and no row's).
 */
export async function setDestroyPause(c: C, admin: Admin, on: boolean, reason: string, confirm: boolean) {
  const before: PauseSwitch = await readPauseSwitch(c.env);
  const wanted: PauseSwitch = on ? "on" : "off";
  if (!confirm) return { confirmed: false, before, after: wanted, changed: before !== wanted };
  const store = storage(c.env);
  if (on) {
    const body = new TextEncoder().encode(`paused by ${admin.id} at ${now(c).toISOString()}`);
    await store.put(DESTROY_PAUSED_KEY, body, { size: body.byteLength, contentType: "text/plain" });
  } else {
    await store.delete([DESTROY_PAUSED_KEY]);
  }
  const after = await readPauseSwitch(c.env);
  audit(
    c,
    on ? "admin.destroy_pause_set" : "admin.destroy_pause_cleared",
    { type: "system", id: "destroy_pause" },
    {
      reason,
      before,
      after,
    },
  );
  return { confirmed: true, before, after, changed: before !== after };
}

// ── uploads kept under "keep and alert" (Addendum 0, 14:50) ─────────────────────────────────

/**
 * Resolve a kept upload, two steps:
 *  - `relist`: the session's hash (the server's, for an owed session) becomes a CONFIRMED `csam`
 *    listing — permanent — and the repair sweep locks it on its next run;
 *  - `false_positive`: the session is ended and its object deleted — refused while the owner or
 *    the uploader is held, and while the database reads as rolled back or paused (rule 17).
 */
export async function resolveKeptUpload(
  c: C,
  admin: Admin,
  uploadId: string,
  resolution: "relist" | "false_positive",
  reason: string,
  confirm: boolean,
) {
  const kept = await adminQ.keptUpload(db(c), uploadId);
  if (!kept || kept.status !== "completing") throw new AppError("not_found");
  if (resolution === "relist") {
    if (!kept.expectedSha256) throw conflict("no_hash");
    if (!confirm) return { confirmed: false, kept, ended: false };
    await blocklist.upsert(db(c), {
      sha256: kept.expectedSha256,
      reason: "csam",
      addedBy: admin.id,
      note: reason,
    });
    audit(c, "admin.kept_upload_relisted", { type: "upload", id: uploadId }, { reason });
    return { confirmed: true, kept: (await adminQ.keptUpload(db(c), uploadId)) ?? kept, ended: false };
  }
  // B2 (Addendum 3): bytes the server proved csam are NEVER ended while their hash is listed —
  // for ANY reason — or a node with it is locked; nor while held, paused or rolled back.
  if (kept.expectedSha256 && (await adminQ.hashKeepsBytes(db(c), kept.expectedSha256)))
    throw conflict("listed");
  await refuseHeldOrPaused(c, kept);
  if (!confirm) return { confirmed: false, kept, ended: false };
  await adminHooks.afterKeptRead?.();

  const ended = await retryOnDeadlock(db(c), async (tx) => {
    // The owner's row (the reservation) and the uploader's, ascending; then the session; then —
    // decided again under the locks — the hash's entry.
    await adminQ.lockUsers(tx, [kept.ownerId, kept.uploaderId]);
    const session = await adminQ.lockKeptSession(tx, uploadId);
    if (!session) return null;
    if (session.expectedSha256 && (await adminQ.hashKeepsBytes(tx, session.expectedSha256))) {
      throw conflict("listed");
    }
    const owner = await adminQ.adminUser(tx, session.ownerId);
    const uploader = await adminQ.adminUser(tx, session.uploaderId);
    if (owner?.legalHold || uploader?.legalHold) throw conflict("held");
    const reference = await keyReference(tx, session.r2Key);
    if (reference && reference.kind !== "upload") {
      return (await markDone(tx, session.id)) ? { session, as: "done" as const } : null;
    }
    if (!(await markAborted(tx, session.id))) return null;
    if (session.purpose === "file") await release(tx, session.ownerId, session.size);
    return { session, as: "aborted" as const };
  });
  if (!ended) throw conflict("state");
  const deleted = ended.as === "aborted" ? await deleteSessionObject(c, ended.session) : false;
  audit(
    c,
    "admin.kept_upload_ended",
    { type: "upload", id: uploadId },
    { reason, as: ended.as, objectDeleted: deleted },
  );
  return { confirmed: true, kept: (await adminQ.keptUpload(db(c), uploadId)) ?? kept, ended: true };
}

async function refuseHeldOrPaused(c: C, kept: Upload) {
  const owner = await adminQ.adminUser(db(c), kept.ownerId);
  const uploader = await adminQ.adminUser(db(c), kept.uploaderId);
  if (owner?.legalHold || uploader?.legalHold) throw conflict("held");
  if (await readsRolledBack(c.env, db(c))) {
    throw conflict(
      "destroy_paused",
      {},
      "Deleting is stopped: the database reads as rolled back or the pause switch is on.",
    );
  }
}

/** The ended session's multipart upload and object — asked of `readsRolledBack` right before. */
async function deleteSessionObject(c: C, session: Upload): Promise<boolean> {
  if (await readsRolledBack(c.env, db(c))) return false;
  const store = storage(c.env);
  if (session.r2UploadId) await store.abort(store.resumeMultipart(session.r2Key, session.r2UploadId));
  await store.delete([session.r2Key]);
  return true;
}

// ── users (section 2) ───────────────────────────────────────────────────────────────────────

/**
 * Lift a suspension — refused while the account is at the strike threshold (ruling 2026-10-12):
 * the count comes from T10's `enforceStrikeThreshold`, which changes nothing on an account that is
 * already suspended. At ≥ STRIKES_TO_SUSPEND: `409 strikes_at_threshold`, nothing written.
 */
export async function unsuspend(c: C, admin: Admin, userId: string) {
  const { activeStrikes } = await enforceStrikeThreshold(deps(c), userId);
  if (activeStrikes >= STRIKES_TO_SUSPEND) {
    throw conflict("strikes_at_threshold", { activeStrikes });
  }
  return unsuspendUser(deps(c), userId, { userId: admin.id, type: "admin" });
}

/**
 * The Users legal-hold toggle. Clearing is refused (`409 hold_not_releasable`) while the user is a
 * subject of a `csam` report that "Release holds" would refuse; the release of those holds is on
 * the report detail. Every use is audited (`admin.legal_hold_set` / `_cleared`, `{ reason }`).
 */
export async function setLegalHold(c: C, userId: string, held: boolean, reason: string) {
  // ONE transaction in the CSAM lock path's order (M2): the user's row FIRST — a lock that wants
  // to hold this user (it takes the user rows before the node) either committed before, and is
  // seen by the check below, or waits for this write and then sets the hold again.
  const found = await retryOnDeadlock(db(c), async (tx) => {
    await adminQ.lockUsers(tx, [userId]);
    if (!(await adminQ.adminUser(tx, userId))) return false;
    if (!held && (await adminQ.userHeldByCsamCase(tx, userId, now(c)))) throw conflict("hold_not_releasable");
    await adminHooks.afterHoldUserLock?.(tx as Tx);
    return setUserLegalHold(tx, userId, held);
  });
  if (!found) throw new AppError("not_found");
  audit(
    c,
    held ? "admin.legal_hold_set" : "admin.legal_hold_cleared",
    { type: "user", id: userId },
    { reason },
  );
}
