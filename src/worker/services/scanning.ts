// The scanning interface: what a scan message is, how one is sent, what a scanner answers, and
// the one handler for suspected CSAM.
//
// The exported signatures are fixed. The scanner behind `getScanner` is a STUB until the real
// scan pipeline replaces this file's body: with `SCAN_STUB=1` outside production it finds the
// EICAR test string and calls everything else clean; anywhere else there is no scanner at all,
// and code that needs one fails ("scanner unavailable") instead of calling a file clean.
//
// NO HONO CONTEXT in anything that runs from the queue or a job: those functions take a
// `ServiceDeps` — routes pass `deps(c)`, the consumer and jobs pass `bg`.
//
// SCAN MESSAGES. Two shapes arrive on the queue and nothing else is accepted:
//   - the explicit message this file sends: `{ v: 1, nodeId?, key, etag?, force? }`;
//   - the object store's own event for every object written under `u/`:
//     `{ account, bucket, eventTime, action, object: { key, size, eTag } }`.
// On a deployed environment BOTH arrive for one upload, the store's event first — before the
// upload's request has even inserted the node. The consumer treats "no node yet" as normal.
// The event's `eTag` identifies CONTENT, not an upload (the same bytes under another key have the
// same value): it is recorded with the scan job and never compared or de-duplicated on.
//
// DELIVERY IS ASYNCHRONOUS — `send()` resolves before the consumer runs — and on a deployed queue
// it usually takes seconds and sometimes about a minute. Nothing may assume a scan starts within
// N seconds: wait for the row.

import { UUID } from "../../shared/ids";
import { addUsageIfUnder, totalsOn, utcDay } from "../db/queries/ledger";
import { csamReportsToAnnounce, lockSuspectedCsam as lockRows } from "../db/queries/moderation";
import { findByR2Key, getNode, resetToPending, restoreScanState, type ScanState } from "../db/queries/nodes";
import type { ScanReason } from "../db/schema";
import { captureError } from "../sentry";
import { audit } from "./audit";
import { sendOperatorCritical } from "./email";
import { AppError } from "./errors";
import { writeMetric } from "./metrics";
import type { ServiceDeps } from "./request-context";
import { adminListOf } from "./signup-policy";
import { UPLOAD_PREFIX } from "./storage";

export type { ScanReason };

export interface ScanVerdict {
  status: "clean" | "infected" | "skipped" | "error";
  /** Why, for `skipped` and `error`. */
  reason?: ScanReason;
  signatures: string[];
  /** Potentially unwanted applications: reported, not blocking. */
  pua: string[];
  sha256?: string;
  bytes?: number;
  engine: string;
  dbVersion?: string;
  durationMs?: number;
}

export interface Scanner {
  scanStream(body: ReadableStream<Uint8Array>, meta: { key: string; size: number }): Promise<ScanVerdict>;
  scanBytes(bytes: Uint8Array): Promise<ScanVerdict>;
}

export type ScanMessage = { v: 1; nodeId?: string; key: string; etag?: string; force?: boolean };

/** The stub reads at most this much of an object. */
export const STUB_SCAN_MAX_BYTES = 1_048_576;
export const STUB_ENGINE = "stub";
export const STUB_SIGNATURE = "Stub.EICAR";
export const SCANNER_UNAVAILABLE = "scanner unavailable";

const MAX_KEY_CHARS = 1_024;
/** The store's actions that create an object. */
const CREATE_ACTIONS = ["PutObject", "CompleteMultipartUpload", "CopyObject"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isUploadKey = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_KEY_CHARS && value.startsWith(UPLOAD_PREFIX);

/**
 * A queue message body as a `ScanMessage`, or null. Accepts exactly the two shapes in the header;
 * a key outside `u/` is null in both (the notification rule's prefix already guarantees it — the
 * check keeps a mis-created rule from feeding the pipeline). Fields it does not know are dropped.
 */
export function normalizeScanMessage(body: unknown): ScanMessage | null {
  if (!isRecord(body)) return null;

  if ("action" in body || "object" in body) {
    if (typeof body.action !== "string" || !CREATE_ACTIONS.includes(body.action)) return null;
    if (!isRecord(body.object) || !isUploadKey(body.object.key)) return null;
    const message: ScanMessage = { v: 1, key: body.object.key };
    // `eTag`, capital T. Bare hex, with a `-<parts>` suffix for a multipart object.
    if (typeof body.object.eTag === "string" && body.object.eTag !== "") message.etag = body.object.eTag;
    return message;
  }

  if (body.v !== 1 || !isUploadKey(body.key)) return null;
  const message: ScanMessage = { v: 1, key: body.key };
  if (body.nodeId !== undefined) {
    if (typeof body.nodeId !== "string" || !UUID.test(body.nodeId)) return null;
    message.nodeId = body.nodeId;
  }
  if (body.etag !== undefined) {
    if (typeof body.etag !== "string") return null;
    message.etag = body.etag;
  }
  if (body.force !== undefined) {
    if (typeof body.force !== "boolean") return null;
    message.force = body.force;
  }
  return message;
}

// ── the stub scanner ────────────────────────────────────────────────────────────────────────

// The antivirus test string, in two halves so that this source file is not itself reported.
const EICAR = new TextEncoder().encode(
  "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR" + "-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*",
);

function containsEicar(bytes: Uint8Array): boolean {
  const last = bytes.length - EICAR.length;
  outer: for (
    let at = bytes.indexOf(EICAR[0]!);
    at !== -1 && at <= last;
    at = bytes.indexOf(EICAR[0]!, at + 1)
  ) {
    for (let i = 1; i < EICAR.length; i++) if (bytes[at + i] !== EICAR[i]) continue outer;
    return true;
  }
  return false;
}

function stubVerdict(bytes: Uint8Array, total: number, startedAt: number): ScanVerdict {
  const infected = containsEicar(bytes);
  return {
    status: infected ? "infected" : "clean",
    signatures: infected ? [STUB_SIGNATURE] : [],
    pua: [],
    bytes: total,
    engine: STUB_ENGINE,
    durationMs: Date.now() - startedAt,
  };
}

const stubScanner: Scanner = {
  async scanStream(body, meta) {
    const startedAt = Date.now();
    const head = new Uint8Array(Math.min(Math.max(meta.size, 0), STUB_SCAN_MAX_BYTES));
    let filled = 0;
    const reader = body.getReader();
    try {
      while (filled < head.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, head.length - filled);
        head.set(value.subarray(0, take), filled);
        filled += take;
      }
    } finally {
      // The rest of the object is not read.
      await reader.cancel().catch(() => {});
    }
    return stubVerdict(head.subarray(0, filled), meta.size, startedAt);
  },
  async scanBytes(bytes) {
    return stubVerdict(bytes.subarray(0, STUB_SCAN_MAX_BYTES), bytes.length, Date.now());
  },
};

/**
 * True only where the stub may decide anything: `SCAN_STUB` is exactly "1" AND the environment
 * is not production. The consumer's fail-closed rule and `getScanner` both read this — a deploy
 * without a real scanner leaves files `pending`; it never marks one clean.
 */
export function stubEnabled(env: Pick<Env, "SCAN_STUB" | "SENTRY_ENVIRONMENT">): boolean {
  return env.SCAN_STUB === "1" && env.SENTRY_ENVIRONMENT !== "production";
}

/** The scanner of this environment. Throws `scanner unavailable` where there is none. */
export function getScanner(env: Pick<Env, "SCAN_STUB" | "SENTRY_ENVIRONMENT">): Scanner {
  if (stubEnabled(env)) return stubScanner;
  throw new Error(SCANNER_UNAVAILABLE);
}

/** The synchronous path for small objects (avatars, at most 5 MB): scanned before they are stored. */
export async function scanSmallObject(
  env: Pick<Env, "SCAN_STUB" | "SENTRY_ENVIRONMENT">,
  bytes: Uint8Array,
): Promise<ScanVerdict> {
  return getScanner(env).scanBytes(bytes);
}

// ── sending ─────────────────────────────────────────────────────────────────────────────────

/**
 * The ONLY way a scan message is sent: `{ v: 1, nodeId, key, force }` to the scan queue, the same
 * in every environment. It only sends; it resolves before the consumer has run.
 */
export async function enqueueScan(
  deps: ServiceDeps,
  msg: { nodeId: string; key: string; force?: boolean },
): Promise<void> {
  const message: ScanMessage = { v: 1, nodeId: msg.nodeId, key: msg.key, force: msg.force === true };
  if (!normalizeScanMessage(message)) throw new Error("scan message: invalid node id or key");
  await deps.env.SCAN_QUEUE.send(message);
}

/** What an ADMIN's rescan answers. An owner's either queues or is a `404` — never a reason. */
export type RescanResult = { queued: true } | { queued: false; reason: "taken_down" | "locked" };

/**
 * Rescan. What happens depends on the node's state — read from its LOCKED row, in the
 * transaction that resets it, so a takedown that lands while this runs is either seen (nothing
 * happens) or comes after the reset has committed:
 *
 *   taken down, whatever its status   nothing: status and verdict kept      { queued: false, reason: "taken_down" }
 *   `suspected_csam`                  nothing: status and verdict kept      { queued: false, reason: "locked" }
 *   `under_review`                    status KEPT, a message is sent        { queued: true }
 *   any other status                  back to `pending`, a message is sent  { queued: true }
 *
 * A rescan must never be a way to launder a locked file back to `pending` and then `clean`. For
 * an `under_review` file the scan still runs — the real pipeline records its outcome as the status
 * a dismissed review restores; the stub consumer writes nothing for it.
 *
 * The message is ALWAYS forced: the finished job of the earlier scan is only taken over by a
 * forced claim, and an unforced rescan would leave the node `pending` with nothing to scan it —
 * so there is no option for it. The message and the audit row follow the
 * commit, and only when something was queued.
 *
 * A SEND THAT FAILS DOES NOT STRAND THE NODE. The reset has committed when the queue is asked;
 * if the send throws, the node would be `pending` with no message — and an owner's retry would
 * be refused (a `pending` file is not one they may rescan). So what the locked row had — status,
 * reason, detail, scan time — is put back, only while the node is still `pending` on the same
 * object key (a replace, a lock, a report or a verdict in between wins), and the send's error
 * is rethrown: nothing was queued, no audit row. If putting it back fails too (or the process
 * dies between the commit and the send), the node stays `pending`: served to nobody, and found
 * by the pending-scan sweep (T21's `sweepPendingScans`), which re-sends for a node that is
 * `pending` with no live job. The two do not overlap: a node put back is not `pending`.
 *
 * AN OWNER NEVER LEARNS WHY. "Taken down" and "locked" are states an account holder must not be
 * able to observe, so for `by: "owner"` both are the same `404 not_found` — the very error an id
 * that is not a file gets — and no reason is produced at all. Only `by: "admin"` is told.
 *
 * `404 not_found` for an id that is not a file. The one-per-hour owner throttle is the route's.
 */
export async function enqueueRescan(
  deps: ServiceDeps,
  nodeId: string,
  opts: { by: "owner" },
): Promise<{ queued: true }>;
export async function enqueueRescan(
  deps: ServiceDeps,
  nodeId: string,
  opts: { by: "admin" },
): Promise<RescanResult>;
export async function enqueueRescan(
  deps: ServiceDeps,
  nodeId: string,
  opts: { by: "owner" | "admin" },
): Promise<RescanResult> {
  const seen = await getNode(deps.db, nodeId);
  if (!seen || seen.kind !== "file" || !seen.r2Key) throw new AppError("not_found");

  // `before`: what the reset cleared — present only when it reset something.
  type Decision = { key: string; before?: ScanState } | { reason: "taken_down" | "locked" } | null;
  const decision = await deps.db.transaction(async (tx): Promise<Decision> => {
    // The row is locked through its object key. A replace that landed since the read above gave
    // the node a new key: then the node is read again and locked through that one.
    let r2Key: string | null = seen.r2Key;
    for (let attempt = 0; attempt < 3 && r2Key; attempt++) {
      const locked = await findByR2Key(tx, r2Key, { forUpdate: true });
      if (locked?.id === nodeId) {
        if (locked.kind !== "file") return null;
        if (locked.takedownAt !== null) return { reason: "taken_down" };
        if (locked.scanStatus === "suspected_csam") return { reason: "locked" };
        if (locked.scanStatus === "under_review") return { key: r2Key };
        const before: ScanState = {
          scanStatus: locked.scanStatus,
          scanReason: locked.scanReason,
          scanDetail: locked.scanDetail,
          scannedAt: locked.scannedAt,
        };
        // The statement has the same guard: it changes nothing for the two locked statuses.
        return (await resetToPending(tx, nodeId)) ? { key: r2Key, before } : { reason: "locked" };
      }
      r2Key = (await getNode(tx, nodeId))?.r2Key ?? null;
    }
    return null;
  });
  // Gone, or replaced faster than it could be locked: there is no such file to rescan.
  if (decision === null) throw new AppError("not_found");
  if ("reason" in decision) {
    // Anyone but an admin gets exactly what an unknown id gets.
    if (opts.by !== "admin") throw new AppError("not_found");
    return { queued: false, reason: decision.reason };
  }

  try {
    await enqueueScan(deps, { nodeId, key: decision.key, force: true });
  } catch (error) {
    if (decision.before) {
      try {
        await restoreScanState(deps.db, nodeId, decision.key, decision.before);
      } catch (restoreError) {
        // The node stays `pending` (fail closed); the send's error is the one the caller gets.
        captureError(restoreError, { kind: "rescan_restore" });
      }
    }
    throw error;
  }
  audit(deps, "scan.rescan_requested", { type: "node", id: nodeId }, { by: opts.by });
  return { queued: true };
}

// ── suspected CSAM ──────────────────────────────────────────────────────────────────────────

/** Today's "the operators were told" marker of a report: ledger subject `notice`, this id. */
export const csamAlertMarker = (reportId: string) => `csam_alert:${reportId}`;
/** Today's "the lock was recorded" marker of a report: ledger subject `notice`, this id. */
export const csamLockMarker = (reportId: string) => `csam_locked:${reportId}`;
export const CSAM_SWEEP_DEFAULT_LIMIT = 50;
/** Logged, at error level and with no address in it, when there is nobody to alert. */
export const NO_OPERATOR_MESSAGE = "csam alert: no operator address is configured — nobody was told";

const ONCE = { amount: { bytes: 0, count: 1 }, limit: { count: 1 } } as const;

/**
 * Makes sure the operators have been told about a suspected-CSAM report TODAY: at least once per
 * UTC day while it matters. True when at least one operator was reached now; false when today's
 * marker was already claimed (nothing is done then), when there is nobody to tell, or when no
 * mail was actually handed over.
 *
 * SEND, THEN CLAIM — on purpose. The critical operator mail (the report id and nothing else) is
 * sent FIRST, awaited; the day's marker is claimed only when AT LEAST ONE send answered `sent` —
 * a mail that is merely being retried reached nobody yet. A crash between the two repeats the
 * alert on the next call; it can never lose it. The marker is read and claimed on ONE day, the
 * one this call computed.
 *
 * Each claim writes the audit action `scan.csam_alert_sent` (`{ reportId, via, recipients }` —
 * a count, never an address). The LOCK has its own row, written by `lockSuspectedCsam`; this
 * function never writes it.
 *
 * An EMPTY operator list is not silent: an error-level log line with a fixed text, a metric, and
 * the marker is NOT claimed — so the next call and the sweep keep trying.
 *
 * Safe to call at any time and any number of times: `lockSuspectedCsam` calls it on EVERY call,
 * `sweepCsamAlerts` for every open report nobody was told about today.
 */
export async function ensureCsamAlerted(
  deps: ServiceDeps,
  reportId: string,
  context: { via?: "lock" | "sweep"; nodeId?: string | null } = {},
): Promise<boolean> {
  if (typeof reportId !== "string" || !UUID.test(reportId)) return false;
  const marker = csamAlertMarker(reportId);
  const day = utcDay();
  if ((await totalsOn(deps.db, day, "notice", marker)).count > 0) return false;

  // The operators' addresses come from the one reader of that list (the sign-up policy's).
  const operators = [...adminListOf(deps.env).addresses];
  if (operators.length === 0) {
    console.error(NO_OPERATOR_MESSAGE);
    writeMetric(deps.env, "error", { kind: "csam_alert", reason: "no_recipient" });
    return false;
  }
  const outcomes = await Promise.all(
    operators.map((to) =>
      sendOperatorCritical(deps, { to, event: "csam_lock", id: reportId }).catch(() => "failed" as const),
    ),
  );
  const reached = outcomes.filter((outcome) => outcome === "sent").length;
  if (reached === 0) {
    // Nobody was reached: the marker stays unclaimed and the next call tries again.
    writeMetric(deps.env, "error", { kind: "csam_alert", reason: "send_failed" });
    return false;
  }

  // Claimed only now. Lost to a concurrent call: both sent — a duplicate, never a gap.
  if (await addUsageIfUnder(deps.db, day, "notice", marker, ONCE.amount, ONCE.limit)) {
    audit(
      deps,
      "scan.csam_alert_sent",
      context.nodeId ? { type: "node", id: context.nodeId } : { type: "report", id: reportId },
      { reportId, via: context.via ?? "sweep", recipients: reached },
    );
  }
  return true;
}

/**
 * Records THE LOCK of a report, once: claims the report's lock marker for today and, when it
 * claimed, writes the audit row `scan.suspected_csam` and the metric. True when it wrote.
 */
async function recordCsamLock(
  deps: ServiceDeps,
  report: { reportId: string; nodeId: string | null; source: string },
  recovered: boolean,
): Promise<boolean> {
  const marker = csamLockMarker(report.reportId);
  if (!(await addUsageIfUnder(deps.db, utcDay(), "notice", marker, ONCE.amount, ONCE.limit))) return false;
  audit(
    deps,
    "scan.suspected_csam",
    report.nodeId ? { type: "node", id: report.nodeId } : { type: "report", id: report.reportId },
    recovered
      ? { source: report.source, reportId: report.reportId, recoveredBy: "sweep" }
      : { source: report.source, reportId: report.reportId },
  );
  writeMetric(deps.env, "scan", { outcome: "suspected_csam", kind: report.source });
  return true;
}

/** One step of the after-lock work: it never throws — a failure is reported and counted. */
async function attempt(deps: ServiceDeps, reason: string, step: () => Promise<unknown>): Promise<void> {
  try {
    await step();
  } catch (error) {
    captureError(error, { kind: "csam_alert" });
    writeMetric(deps.env, "error", { kind: "csam_alert", reason });
  }
}

/**
 * Settles what is still owed for OPEN suspected-CSAM reports (oldest first, at most `limit`):
 *   - a lock that was NEVER recorded (its marker unclaimed on every day — the invocation that
 *     locked died before its deferred work ran) gets its audit row `scan.suspected_csam` now,
 *     with the source the REPORT carries and `recoveredBy: "sweep"`;
 *   - a report nobody was told about today gets `ensureCsamAlerted`.
 * A scheduled job calls it: what was lost with an invocation is made good within the job's
 * interval, and a report nobody handles is announced again once a day. One failing report does
 * not stop the rest. `alerted` counts mails that reached someone, `recorded` recovered lock rows.
 */
export async function sweepCsamAlerts(
  deps: ServiceDeps,
  opts: { limit?: number } = {},
): Promise<{ checked: number; alerted: number; recorded: number }> {
  const limit = Math.max(1, Math.min(opts.limit ?? CSAM_SWEEP_DEFAULT_LIMIT, 1_000));
  const due = await csamReportsToAnnounce(deps.db, limit);
  let alerted = 0;
  let recorded = 0;
  for (const report of due) {
    if (!report.lockRecorded) {
      await attempt(deps, "sweep", async () => {
        if (await recordCsamLock(deps, report, true)) recorded += 1;
      });
    }
    await attempt(deps, "sweep", async () => {
      if (await ensureCsamAlerted(deps, report.reportId, { via: "sweep", nodeId: report.nodeId }))
        alerted += 1;
    });
  }
  return { checked: due.length, alerted, recorded };
}

/**
 * The one handler for suspected CSAM — the upload route (blocklist hit), the scan consumer and
 * the admin console all call this, so there is one code path.
 *
 * AWAITED: only the database half (db/queries/moderation.ts) — the node becomes
 * `suspected_csam`, the node, its owner and every uploader of any version of it go on legal
 * hold, the node's links are paused, its
 * upload addresses are held, its hash is blocklisted and a report is filed. When this function
 * resolves the node IS locked; nothing after the lock can reject it, and the caller's answer
 * takes no longer for this reason than for another (no mail is waited for).
 *
 * DEFERRED (`deps.defer`), ON EVERY CALL and whatever state the node was found in — two
 * separate facts, each with its errors captured:
 *   - THE LOCK is recorded: the audit row `scan.suspected_csam` (`{ source, reportId }`, the
 *     caller's own source) and a metric, once per report per UTC day behind a marker of its own.
 *     It does not depend on any mail. A redelivery the same day writes nothing; one on a LATER
 *     day writes a second row (accepted: the marker is a day's).
 *   - THE ALERT: `ensureCsamAlerted` (the critical operator mail, its own audit action).
 * Deferred work can be lost with its invocation. It is re-established two ways: a redelivery
 * repeats it (this function, again), and `sweepCsamAlerts` records a lock whose marker was never
 * claimed and tells the operators about a report nobody was told about.
 *
 * It never deletes anything, never notifies the owner and issues no strike. Safe to repeat: the
 * same report is returned. `404 not_found` when there is no such node.
 */
export async function lockSuspectedCsam(
  deps: ServiceDeps,
  nodeId: string,
  opts: { source: "photodna" | "system" | "admin" },
): Promise<{ reportId: string }> {
  const locked = await lockRows(deps.db, nodeId, opts);
  if (!locked) throw new AppError("not_found");
  const { reportId } = locked;
  // A FIRST lock is always recorded and announced — also when it found a report that was
  // already being reviewed or was filed (an admin opened the case from a user's report): the
  // node is locked NOW, and the sweep, which looks at open reports only, would never make a
  // missing record good. A REPEAT is, only while the report is open (the redelivery that repairs
  // what was lost with an invocation); on a report someone is reviewing, or that was FILED, it
  // mails nobody and writes no second lock row. Decided on what the lock saw under its locks.
  if (locked.alreadyLocked && locked.reportStatus !== "open") return { reportId };
  deps.defer(
    (async () => {
      await attempt(deps, "lock_record", () =>
        recordCsamLock(deps, { reportId, nodeId, source: opts.source }, false),
      );
      await attempt(deps, "alert", () => ensureCsamAlerted(deps, reportId, { via: "lock", nodeId }));
    })(),
  );
  return { reportId };
}
