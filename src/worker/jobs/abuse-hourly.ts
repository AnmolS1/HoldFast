// The hourly abuse checks (cron 3 * * * *, after stale-uploads in the same slot). Its parts, in
// this order — EACH ONE CALL IN ITS OWN `try`, with its own `reason` tag: a failing part is
// reported and counted (`job{kind: abuse-hourly, outcome: error, reason}`) and stops nothing
// after it.
//
//   (0)  csam_alert_sweep       sweepCsamAlerts — an open csam report on a LOCKED file nobody was
//                               told about today gets the critical operator mail
//   (0b) unrecorded_lock_sweep  sweepUnrecordedCsamLocks — a lock whose invocation died between
//                               the node and its case is completed, recorded and announced
//   (0c) owed_node_sweep        sweepOwedNodes (below) — a `completing` upload whose node is owed
//   (a)  strike_sweep           sweepStrikeThresholds — three strikes not yet enforced
//   (b)  anomaly_report         reportAnomalies (below) — findings filed and digested, nothing paused
//   then the admin digest, one mail per operator per run, when there is anything in it.
// (A pending-scan sweep is inserted after (a) by the scanner task's integration: one more call in
// its own `try`, nothing else changes.)
//
// NOT `guarded` (ruling T22-a): the registry's rollback reading would stop the whole job during a
// restore — and with it the CSAM steps, which matter most then. The one part that may delete an
// object, (0c), asks `mayDestroy` itself, right before it would.
//
// THE OWED-NODE SWEEP. A `completing` upload session older than COMPLETING_STALE_MINUTES (the
// clock the stale job uses, so a request still hashing is never raced) that carries the route's
// `upload.csam_node_owed` audit row or whose DECLARED hash is listed as csam. The declared hash
// is the client's word and is never acted on: every session the sweep takes is hashed here, from
// the stored bytes (streamed), and THE SERVER'S hash decides —
//   listed csam          the node the upload route would have written (`writeLockedNode`: the
//                        UPLOADER's, top level, locked from its first commit, the uploader's
//                        sealed address recorded when the session holds one), the csam lock, the
//                        session ended (`endPreserved`) — the object is kept, now referenced;
//   listed otherwise     the upload route's refusal (`refuseBlockedSession`): the object deleted
//                        only when `mayDestroy` allows, the session aborted, the uploader struck;
//   not listed, or gone  ended like a stale session (`aborted`, the reservation back; the
//                        multipart upload aborted and its object deleted only when `mayDestroy`
//                        allows — else the session waits for the next run).
// Every decision is made again under the session's row lock: one that is no longer `completing`
// is skipped. "Already written" is a NODE on the session's key — never "a node with the session's
// id": for a replace upload that id is the existing file. A hash that fails leaves the session
// for the next run. At most `limit` sessions, and none started past the soft deadline.

import { getNode, keyReference } from "../db/queries/nodes";
import * as blocklist from "../db/queries/blocklist";
import {
  busyLinksLastHour,
  busyNewUploadersLastHour,
  guessedLinksLastHour,
  linkCreatorsOn,
  lockOwedSession,
  owedSessions,
  ownersNearEgressCap,
  suspendedForStrikesSince,
} from "../db/queries/abuse";
import { addUsageIfUnder, utcDay } from "../db/queries/ledger";
import { insertReport, type ReportInput } from "../db/queries/moderation";
import { release } from "../db/queries/quota";
import { markAborted, markDone, sealedIpOf } from "../db/queries/uploads";
import { lockUser } from "../db/queries/users";
import { retryOnDeadlock } from "../db/retry";
import type { Upload } from "../db/schema";
import {
  endPreserved,
  RaisedToCsam,
  refuseBlockedSession,
  storedSha256,
  writeLockedNode,
} from "../routes/uploads";
import { captureError } from "../sentry";
import { audit } from "../services/audit";
import { effectiveLimits } from "../services/ceilings";
import { sendAdminDigest } from "../services/email";
import type { BackgroundContext } from "../services/request-context";
import { lockSuspectedCsam, sweepCsamAlerts, sweepUnrecordedCsamLocks } from "../services/scanning";
import { adminListOf } from "../services/signup-policy";
import { storage } from "../services/storage";
import { STRIKE_SUSPENSION_REASON, sweepStrikeThresholds } from "../services/strikes";
import type { Job } from "./index";
import { mayDestroy } from "./reconcile";

const KIND = "abuse-hourly";
const DEFAULT_SOFT_DEADLINE_MS = 60_000;

/** What one run does at most, per part. */
export const ABUSE_HOURLY_LIMITS = {
  csamAlerts: 50,
  unrecordedLocks: 50,
  owedNodes: 50,
  strikes: 200,
  /** Findings per anomaly kind. */
  findings: 100,
} as const;

/** The anomaly thresholds (product decisions 2026-10-12). */
export const ANOMALY = {
  /** An owner's link egress today, as a share of their effective `download_owner` cap. */
  ownerEgressShare: 0.5,
  linkDownloadsPerHour: 500,
  linkAddressesPerHour: 50,
  linksPerDay: 50,
  newAccountUploadsPerHour: 200,
  passwordAddressesPerHour: 20,
} as const;

export type DigestLine = { label: string; value: string | number };

/**
 * The parts, as one object a test may replace a member of (to make one part throw). The job calls
 * them only through here.
 */
export const parts = {
  sweepCsamAlerts,
  sweepUnrecordedCsamLocks,
  sweepOwedNodes,
  sweepStrikeThresholds,
  reportAnomalies,
};

// ── (0c) the owed-node repair sweep ─────────────────────────────────────────────────────────

export type OwedResult = {
  checked: number;
  /** A node written (or found already written) and locked, the session ended. */
  locked: number;
  /** Listed for another reason: refused as the upload route refuses. */
  refused: number;
  /** Not listed, or no object: ended as a stale session. */
  stale: number;
  /** Moved on meanwhile, or left for the next run (a delete not allowed now). */
  skipped: number;
  failed: number;
};

type Outcome = Exclude<keyof OwedResult, "checked">;

/** `mayDestroy`, read at most once per run and only when a delete is about to happen. */
function destroyGate(bg: BackgroundContext) {
  let reading: Promise<boolean> | null = null;
  return () => (reading ??= mayDestroy(bg, undefined, KIND));
}

/** The server hash is csam: the node (unless it is there already), the lock, the session ended. */
async function preserveOwed(bg: BackgroundContext, listed: Upload, sha256: string): Promise<Outcome> {
  const size = (await storage(bg.env).head(listed.r2Key))?.size ?? listed.size;
  const decided = await retryOnDeadlock(bg.db, async (tx) => {
    // The uploader's `user` row (the editor's reservation, the node's owner), then the session.
    await lockUser(tx, listed.uploaderId);
    const session = await lockOwedSession(tx, listed.id);
    if (!session) return null;
    const reference = await keyReference(tx, session.r2Key);
    if (reference?.kind === "node") return { session, nodeId: reference.nodeId, written: false, ip: null };
    if (reference?.kind === "version") return { session, nodeId: null, written: false, ip: null };
    const sealed = sealedIpOf(session);
    const node = await writeLockedNode({ db: tx }, session, {
      uploaderId: session.uploaderId,
      sha256,
      size,
      sealed,
    });
    return { session, nodeId: node.id, written: true, ip: sealed ? "recorded" : "absent" };
  });
  if (!decided) return "skipped";
  const { session, nodeId } = decided;
  if (nodeId === null) {
    // A kept old version holds the key: not an owed node. Nothing is touched; reported.
    captureError(new Error("owed session: its key is a kept version"), { kind: "job", job: KIND });
    bg.metric("job", { kind: KIND, outcome: "error", reason: "owed_version_key" });
    return "skipped";
  }
  if (decided.written) {
    audit(
      bg,
      "upload.csam_preserved",
      { type: "node", id: nodeId },
      { uploadId: session.id, via: "sweep", ...(decided.ip === "absent" ? { ip: "absent" } : {}) },
    );
  } else {
    const found = await getNode(bg.db, nodeId);
    if (found?.scanStatus !== "suspected_csam") {
      bg.metric("job", { kind: KIND, outcome: "error", reason: "owed_found_unlocked" });
    }
  }
  try {
    await lockSuspectedCsam(bg, nodeId, { source: "system" });
  } catch (error) {
    // The node is written and hidden; the unrecorded-lock sweep (0b) completes it next run.
    captureError(error, { kind: "job", job: KIND, reason: "owed_lock" });
    bg.metric("job", { kind: KIND, outcome: "error", reason: "owed_lock" });
  }
  await endPreserved(bg.db, session, session.ownerId === session.uploaderId);
  return "locked";
}

/** Listed for another reason: the upload route's refusal, the delete behind `mayDestroy`. */
async function refuseOwed(
  bg: BackgroundContext,
  session: Upload,
  reason: "malware" | "dmca" | "admin",
  sha256: string,
  mayDelete: () => Promise<boolean>,
): Promise<Outcome> {
  // Decided again before anything is deleted: a session that moved on since it was listed is
  // not this sweep's any more. (No transaction is held across the store's delete.)
  const current = await retryOnDeadlock(bg.db, (tx) => lockOwedSession(tx, session.id));
  if (!current) return "skipped";
  try {
    await refuseBlockedSession(bg, current, reason, sha256, {
      mayDelete,
      onEnded: () => {
        audit(
          bg,
          "upload.blocked",
          { type: "upload", id: session.id },
          { reason, nodeId: session.nodeId, via: "sweep" },
        );
      },
    });
    return "refused";
  } catch (error) {
    if (error instanceof RaisedToCsam) return preserveOwed(bg, session, sha256);
    throw error;
  }
}

/**
 * Not listed (or no object): ended the way the stale-upload job ends a `completing` session — a
 * node or kept version on the key means it did commit (`done`); otherwise `aborted`, the owner's
 * reservation back, then the multipart upload aborted and the object it may have become deleted.
 * A multipart session waits for the next run while `mayDestroy` says no.
 */
async function endStale(
  bg: BackgroundContext,
  listed: Upload,
  sha256: string | null,
  mayDelete: () => Promise<boolean>,
): Promise<Outcome> {
  if (listed.r2UploadId !== null && !(await mayDelete())) return "skipped";
  const ended = await retryOnDeadlock(bg.db, async (tx) => {
    // The owner's row before the session's (lock order), and before the reservation is released.
    await lockUser(tx, listed.ownerId);
    const session = await lockOwedSession(tx, listed.id);
    if (!session) return null;
    // Asked again under the lock: an entry put on the list since the hash was looked up.
    if (sha256 !== null && (await blocklist.lookup(tx, sha256)) !== null) return "raced" as const;
    const reference = await keyReference(tx, session.r2Key);
    if (reference && reference.kind !== "upload") {
      return (await markDone(tx, session.id)) ? { session, as: "done" as const } : null;
    }
    if (!(await markAborted(tx, session.id))) return null;
    if (session.purpose === "file") await release(tx, session.ownerId, session.size);
    return { session, as: "aborted" as const };
  });
  if (ended === null || ended === "raced") return "skipped";
  const { session } = ended;
  if (ended.as === "done" || session.r2UploadId === null) return "stale";
  const store = storage(bg.env);
  let failure: unknown = null;
  try {
    await store.abort(store.resumeMultipart(session.r2Key, session.r2UploadId));
  } catch (error) {
    failure = error;
  }
  try {
    await store.delete([session.r2Key]);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  return "stale";
}

/**
 * One listed session: hashed from the stored bytes, then the server hash decides. Exported for the
 * tests that change the row between the listing and this call.
 */
export async function settleOwedSession(
  bg: BackgroundContext,
  listed: { session: Upload; owedRow: boolean },
  mayDelete: () => Promise<boolean>,
): Promise<Outcome> {
  const { session } = listed;
  let sha256: string | null;
  try {
    sha256 = await storedSha256(storage(bg.env), session.r2Key);
  } catch (error) {
    // Nothing is decided on a hash nobody computed: the session waits for the next run.
    captureError(error, { kind: "job", job: KIND, reason: "owed_hash" });
    return "failed";
  }
  const hit = sha256 === null ? null : await blocklist.lookup(bg.db, sha256);
  if (listed.owedRow && hit?.reason !== "csam") {
    // The route found these bytes listed as csam; the list (or the object) says otherwise now.
    captureError(new Error("owed session: the stored bytes are not listed as csam"), {
      kind: "job",
      job: KIND,
      reason: "owed_not_csam",
    });
    bg.metric("job", { kind: KIND, outcome: "error", reason: "owed_not_csam" });
  }
  if (sha256 !== null && hit?.reason === "csam") return preserveOwed(bg, session, sha256);
  if (sha256 !== null && hit)
    return refuseOwed(bg, session, hit.reason as "malware" | "dmca" | "admin", sha256, mayDelete);
  return endStale(bg, session, sha256, mayDelete);
}

/** (0c) — see the head of this file. */
export async function sweepOwedNodes(
  bg: BackgroundContext,
  opts: { limit?: number; stopAt?: number } = {},
): Promise<OwedResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? ABUSE_HOURLY_LIMITS.owedNodes, 1_000));
  const listed = await owedSessions(bg.db, limit);
  const result: OwedResult = { checked: 0, locked: 0, refused: 0, stale: 0, skipped: 0, failed: 0 };
  const mayDelete = destroyGate(bg);
  for (const entry of listed) {
    if (opts.stopAt !== undefined && Date.now() >= opts.stopAt) break;
    result.checked += 1;
    try {
      result[await settleOwedSession(bg, entry, mayDelete)] += 1;
    } catch (error) {
      // One session must not stop the ones behind it; it is found again next run.
      result.failed += 1;
      captureError(error, { kind: "job", job: KIND, reason: "owed_node" });
    }
  }
  return result;
}

// ── (b) anomaly reporting ───────────────────────────────────────────────────────────────────

/** A day's "already reported" marker of one finding (ledger subject `notice`). */
export const findingMarker = (kind: string, id: string) => `digest:${kind}:${id}`;

/**
 * Files one finding — once per subject per UTC day: the day's marker is claimed and the report
 * row inserted in ONE transaction, so a finding is never marked without its row. True when filed.
 */
async function fileFinding(
  bg: BackgroundContext,
  day: string,
  marker: string,
  report: Omit<ReportInput, "source" | "category" | "nodeId">,
): Promise<boolean> {
  return retryOnDeadlock(bg.db, async (tx) => {
    const first = await addUsageIfUnder(tx, day, "notice", marker, { bytes: 0, count: 1 }, { count: 1 });
    if (!first) return false;
    // An account- or link-level finding: no node, so it never counts as a report ON a node.
    await insertReport(tx, { ...report, source: "system", category: "other", nodeId: null });
    return true;
  });
}

/** The number of days an account counts as new, as the ceilings read it. */
function newAccountDays(env: Env, ceilings: Record<string, number> | undefined): number {
  const override = ceilings?.NEW_ACCOUNT_DAYS;
  const raw =
    override !== undefined
      ? override
      : Number(env.NEW_ACCOUNT_DAYS === "" ? Number.NaN : env.NEW_ACCOUNT_DAYS);
  // Unreadable: every account is new (the ceilings fail the same way).
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : 36_500;
}

/**
 * (b) — REPORTS AND NEVER PAUSES. Each finding is a `reports` row (`source: system`, no node) and
 * a digest line, at most once per subject per UTC day:
 *   owners whose link egress today (`link_owner` ledger — never a `notice` marker) is at least
 *   half of THEIR effective `download_owner` cap (override and new-account factor honoured);
 *   links with more than 500 downloads or 50 distinct daily address hashes in the last hour;
 *   accounts that created more than 50 links today; new accounts with more than 200 uploads in
 *   the last hour; links whose password failed from more than 20 distinct addresses in the hour.
 */
export async function reportAnomalies(bg: BackgroundContext, at: Date = new Date()): Promise<DigestLine[]> {
  const day = utcDay(at);
  const limit = ABUSE_HOURLY_LIMITS.findings;
  const stored = await bg.settings();
  const lines: DigestLine[] = [];

  // Owner egress: the two caps an owner can have (an old account's, a young one's) bound the
  // query; each owner is then measured against their own.
  const capOf = (account: { quotaBytes: number; createdAt: Date }) =>
    effectiveLimits(bg.env, stored, "download_owner", account, at).bytes ?? 0;
  const minCap = Math.min(
    capOf({ quotaBytes: 0, createdAt: new Date(0) }),
    capOf({ quotaBytes: 0, createdAt: at }),
  );
  for (const owner of await ownersNearEgressCap(bg.db, day, minCap, limit)) {
    const cap = capOf({ quotaBytes: owner.quotaBytes, createdAt: owner.createdAt });
    if (owner.bytes < cap * ANOMALY.ownerEgressShare) continue;
    const share = cap > 0 ? Math.floor((owner.bytes * 100) / cap) : 100;
    if (
      await fileFinding(bg, day, findingMarker("download_owner", owner.ownerId), {
        ownerId: owner.ownerId,
        details: `anomaly owner_egress: ${share}% of today's link cap`,
      })
    ) {
      lines.push({ label: "Owner link egress at 50% of the daily cap", value: owner.ownerId });
    }
  }

  for (const link of await busyLinksLastHour(
    bg.db,
    ANOMALY.linkDownloadsPerHour,
    ANOMALY.linkAddressesPerHour,
    limit,
  )) {
    if (
      await fileFinding(bg, day, findingMarker("link_traffic", link.linkId), {
        ownerId: link.ownerId,
        linkId: link.linkId,
        details: `anomaly link_traffic: ${link.downloads} downloads, ${link.addresses} addresses in an hour`,
      })
    ) {
      lines.push({ label: "Link traffic in the last hour", value: link.linkId });
    }
  }

  for (const creator of await linkCreatorsOn(bg.db, day, ANOMALY.linksPerDay, limit)) {
    if (
      await fileFinding(bg, day, findingMarker("link_creation", creator.userId), {
        ownerId: creator.userId,
        details: `anomaly link_creation: ${creator.links} links today`,
      })
    ) {
      lines.push({ label: "Links created today", value: creator.userId });
    }
  }

  const days = newAccountDays(bg.env, stored.ceilings as Record<string, number> | undefined);
  for (const uploader of await busyNewUploadersLastHour(
    bg.db,
    days,
    ANOMALY.newAccountUploadsPerHour,
    limit,
  )) {
    if (
      await fileFinding(bg, day, findingMarker("new_account_uploads", uploader.userId), {
        ownerId: uploader.userId,
        details: `anomaly new_account_uploads: ${uploader.uploads} uploads in an hour`,
      })
    ) {
      lines.push({ label: "New account uploads in the last hour", value: uploader.userId });
    }
  }

  for (const link of await guessedLinksLastHour(bg.db, ANOMALY.passwordAddressesPerHour, limit)) {
    if (
      await fileFinding(bg, day, findingMarker("link_password", link.linkId), {
        ownerId: link.ownerId,
        linkId: link.linkId,
        details: `anomaly link_password: failures from ${link.addresses} addresses in an hour`,
      })
    ) {
      lines.push({ label: "Link password failures from many addresses", value: link.linkId });
    }
  }
  return lines;
}

// ── the job ─────────────────────────────────────────────────────────────────────────────────

/** One part: its own `try`, its own reason; a failure is reported, counted and contained. */
async function part(bg: BackgroundContext, reason: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    captureError(error, { kind: "job", job: KIND, reason });
    bg.metric("job", { kind: KIND, outcome: "error", reason });
  }
}

export const job: Job = {
  name: "abuse-hourly",
  cron: "3 * * * *",
  async run(bg, _env, _event, opts) {
    const started = new Date();
    const stopAt = Date.now() + (opts?.softDeadlineMs ?? DEFAULT_SOFT_DEADLINE_MS);
    const digest: DigestLine[] = [];
    const ok = (reason: string, value: number) =>
      bg.metric("job", { kind: KIND, outcome: "ok", reason }, value);

    await part(bg, "csam_alert_sweep", async () => {
      const swept = await parts.sweepCsamAlerts(bg, { limit: ABUSE_HOURLY_LIMITS.csamAlerts });
      ok("csam_alert_sweep", swept.alerted);
      if (swept.alerted > 0) digest.push({ label: "Suspected-CSAM alerts sent", value: swept.alerted });
    });

    await part(bg, "unrecorded_lock_sweep", async () => {
      const swept = await parts.sweepUnrecordedCsamLocks(bg, { limit: ABUSE_HOURLY_LIMITS.unrecordedLocks });
      ok("unrecorded_lock_sweep", swept.completed);
      if (swept.failed > 0)
        bg.metric("job", { kind: KIND, outcome: "failed", reason: "unrecorded_lock_sweep" }, swept.failed);
      if (swept.completed > 0) digest.push({ label: "Unrecorded locks completed", value: swept.completed });
    });

    await part(bg, "owed_node_sweep", async () => {
      const swept = await parts.sweepOwedNodes(bg, { limit: ABUSE_HOURLY_LIMITS.owedNodes, stopAt });
      ok("owed_node_sweep", swept.locked);
      if (swept.failed > 0)
        bg.metric("job", { kind: KIND, outcome: "failed", reason: "owed_node_sweep" }, swept.failed);
      if (swept.locked > 0)
        digest.push({ label: "Owed upload nodes written and locked", value: swept.locked });
    });

    await part(bg, "strike_sweep", async () => {
      const swept = await parts.sweepStrikeThresholds(bg, { limit: ABUSE_HOURLY_LIMITS.strikes });
      ok("strike_sweep", swept.suspended);
      if (swept.suspended === 0) return;
      const ids = await suspendedForStrikesSince(
        bg.db,
        started,
        STRIKE_SUSPENSION_REASON,
        ABUSE_HOURLY_LIMITS.strikes,
      );
      for (const id of ids) digest.push({ label: "Suspended for three strikes", value: id });
    });

    await part(bg, "anomaly_report", async () => {
      const lines = await parts.reportAnomalies(bg);
      ok("anomaly_report", lines.length);
      digest.push(...lines);
    });

    await part(bg, "digest", async () => {
      if (digest.length === 0) return;
      for (const to of adminListOf(bg.env).addresses) {
        // One operator's failure does not keep the digest from the next.
        await sendAdminDigest(bg, { to, lines: digest }).catch((error: unknown) => {
          captureError(error, { kind: "job", job: KIND, reason: "digest" });
          bg.metric("job", { kind: KIND, outcome: "error", reason: "digest" });
        });
      }
      ok("digest", digest.length);
    });
  },
};
