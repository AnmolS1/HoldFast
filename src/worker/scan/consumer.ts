// The scan queue's consumer (T21; it took over T10's stub). `queue(batch, env, ctx, bg)`: the
// Worker entry calls it inside `runBackground`; `bg` is the run's context (`bg.db`, `bg.defer`,
// `bg.metric`) — this file opens no client of its own, and `runBackground` drains everything
// deferred (the CSAM handler's record and alert) before the invocation ends.
//
// THE MAIN QUEUE, per message (`max_batch_size` 1, `max_concurrency` 2, `max_retries` 5):
//  a. `normalizeScanMessage`; not a scan message → ack. Then the node by key; with none:
//        an upload session with this key is open or completing   → retry in 10 s
//        the key is a superseded version, or its upload aborted   → ack (metric `orphan`)
//        nothing references the key: attempts 1–2 → retry in 10 s, then ack (metric `orphan`)
//     Nothing is ever deleted here; unreferenced objects are the orphan sweep's.
//  b. Claim the job (one row per key). `done` → ack — after re-establishing the strike threshold
//     for an `infected` node's uploader (the first delivery may have died before it); `running`
//     → retry with the backoff, never ack: if that delivery dies, this message takes it over.
//  c. Above `SCAN_MAX_BYTES` → `skipped`/`size`, no scanner (unreachable in v1: the file cap is
//     the scan cap, D4 — a test pins it).
//  d. Sniff the first 8,192 bytes (`mime.sniff`).
//  e. Scan: the R2 body itself streamed to the scanner. A typed scanner error fails the job and
//     retries the message (below); `ScannerRefusedError` ends the scan `error`/`engine` at once.
//  f–g. PhotoDNA (flag off in v1), image dimensions, then the verdict (scan/verdict.ts).
//  h. Ack only after the verdict's transaction has committed and its after-commit work is done.
//
// FAILURES — the job is finished `failed` first, so the redelivery reclaims at once:
//   ScannerNotReadyError                     not_ready   retry(max(backoff, Retry-After))
//   ScannerBusyError                         busy        retry(max(backoff, Retry-After))
//   ScannerTransportError, cause "Durable    reset       retry(backoff) — a deploy; never why a file
//     Object reset because its code was                   ends `error` (the DLQ re-sends it once)
//     updated."
//   ScannerTransportError / verdict `error`  timeout | engine   retry(backoff)
//   PhotoDnaTransientError                   photodna    retry(backoff)
//   anything else (the database, the store)  its message retry(backoff)
// The backoff by `message.attempts` is 30 s, 2 min, 5 min, 10 min, 15 min — about 32 minutes in
// all, deliberately longer than the 20-minute claim takeover (`SCAN_CLAIM_STALE_MINUTES`): a
// message is still being retried when a dead claim becomes claimable. A unit test holds the
// inequality.
//
// THE DEAD-LETTER QUEUE (same Worker, per message):
//   no node for the key                      ack SILENTLY: metric dlq/no_node, nothing else
//   job `done`                               ack
//   job `running`, younger than 20 min       retry in 21 min (let the claim resolve first)
//   job `failed` with `reset` or `busy`,     re-send once (`enqueueScan`, forced), mark the job
//     node still `pending`, not re-sent yet    `requeuedFromDlq`; ack — no `error`, no Sentry error
//   anything else (failed, stale, no job)    job → failed; node, if still `pending` on this key and
//                                            not taken down → `error`/`timeout`|`engine`; Sentry
//                                            error tagged with the key; ack
//   … and OPERATOR_CRITICAL `scanner_down` when the SCANNER is unhealthy — never because of one
//   file: a `not_ready` dead letter (or a delivery still `not_ready` 10 min after its message was
//   first sent), or `engine`/`timeout` dead letters from ≥ 3 distinct owners within 30 min (one
//   crafted file can cause those). At most one mail per 6 h across episodes; a real verdict ends
//   the episode (audit `system.scanner_recovered`) only once the last scanner error is ≥ 10 min
//   old. State: one settings row (`changeScannerAlert`).
//
// LOGS carry keys and node ids only — never a file name or an address.

import { findByR2Key, keyReference } from "../db/queries/nodes";
import { abortedUploadOf, failJob, jobOf, markRequeuedFromDlq, markScanError } from "../db/queries/scan";
import { claim, finish, SCAN_CLAIM_STALE_MINUTES, type ClaimResult } from "../db/queries/scan-jobs";
import {
  changeScannerAlert,
  endScannerEpisode,
  noteScannerError,
  releaseScannerDownMail,
  SCANNER_ALERT_KEY,
} from "../db/queries/trash-jobs";
import { effectiveHidden, lockOwnerTree } from "../db/queries/tree";
import type { Node } from "../db/schema";
import { mailOperators, ROLLBACK_MAIL_EVERY_MS } from "../jobs/reconcile";
import { captureError } from "../sentry";
import { auditInTx } from "../services/audit";
import { sniff, SNIFF_PREFIX_BYTES } from "../services/mime";
import type { BackgroundContext } from "../services/request-context";
import {
  enqueueScan,
  getScanner,
  normalizeScanMessage,
  type ScanMessage,
  type ScanVerdict,
} from "../services/scanning";
import { storage } from "../services/storage";
import { adminListOf } from "../services/signup-policy";
import { enforceStrikeThreshold } from "../services/strikes";
import {
  SCAN_MAX_BYTES,
  ScannerBusyError,
  ScannerNotReadyError,
  ScannerRefusedError,
  ScannerTransportError,
} from "./container";
import { checkPhotoDna, PhotoDnaTransientError } from "./photodna";
import { applyVerdict, imageDimensions } from "./verdict";

/** How long to wait for the upload's request to insert the node. */
export const NO_NODE_RETRY_SEC = 10;
/** A key nothing references is given up on at this delivery attempt. */
export const UNKNOWN_KEY_MAX_ATTEMPTS = 3;
/** The main queue's `max_retries` (wrangler.jsonc); the backoff below has one delay per retry. */
export const SCAN_MAX_RETRIES = 5;
/** The retry delay by attempt: 30 s, 2 min, 5 min, 10 min, 15 min. */
export const SCAN_BACKOFF_SEC = [30, 120, 300, 600, 900] as const;
/** The dead-letter consumer's wait for a `running` claim younger than the takeover time. */
export const DLQ_RUNNING_RETRY_SEC = (SCAN_CLAIM_STALE_MINUTES + 1) * 60;
/** The message `scanObject` wraps a deploy's reset in (spike S9) — matched on the CAUSE. */
export const DEPLOY_RESET_MESSAGE = "Durable Object reset because its code was updated.";

/** The retry delay for a message on its `attempts`-th delivery. */
export function backoff(attempts: number): number {
  const index = Math.min(Math.max(Math.trunc(attempts), 1), SCAN_BACKOFF_SEC.length) - 1;
  return SCAN_BACKOFF_SEC[index]!;
}

type Claimed = Extract<ClaimResult, { claimed: true }>;

/** The `lastError` codes of step e; anything else is a message, reported as `failed`. */
const RETRY_REASONS = new Set(["not_ready", "busy", "reset", "timeout", "engine", "photodna"]);

/** A key (ids only, never a secret) made safe for one log line. */
function loggable(value: unknown): string {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
  return typeof value === "string" ? value.slice(0, 200).replace(/[\u0000-\u001f\u007f]/g, "?") : "(no key)";
}

function keyOf(body: unknown): unknown {
  if (body === null || typeof body !== "object") return undefined;
  const record = body as { key?: unknown; object?: { key?: unknown } | null };
  return record.key ?? record.object?.key;
}

/** Why a scan could not finish: the job's `lastError`, and the least the message must wait. */
type Failure = { error: string; minDelay: number };

/** A deploy's reset, recognised on the wrapped CAUSE — never on the wrapper's own message. */
export function isDeployReset(error: unknown): boolean {
  if (!(error instanceof ScannerTransportError)) return false;
  const cause = error.cause as { message?: unknown } | undefined;
  return typeof cause?.message === "string" && cause.message.startsWith(DEPLOY_RESET_MESSAGE);
}

/** The table of step e (and its neighbours): what a thrown error is. */
export function classify(error: unknown): Failure {
  if (error instanceof ScannerNotReadyError) return { error: "not_ready", minDelay: error.retryAfter };
  if (error instanceof ScannerBusyError) return { error: "busy", minDelay: error.retryAfter };
  if (isDeployReset(error)) return { error: "reset", minDelay: 0 };
  if (error instanceof ScannerTransportError) return { error: error.reason, minDelay: 0 };
  if (error instanceof PhotoDnaTransientError) return { error: "photodna", minDelay: 0 };
  if (error instanceof RangeError) return { error: "engine", minDelay: 0 };
  return { error: error instanceof Error ? error.message.slice(0, 200) : "failed", minDelay: 0 };
}

/** A verdict the scanner returned but that is no verdict: retried like a transport failure. */
class VerdictError extends Error {
  constructor(readonly reason: "timeout" | "engine") {
    super(reason);
  }
}

async function readPrefix(env: Env, key: string, size: number): Promise<Uint8Array> {
  if (size === 0) return new Uint8Array(0);
  const head = await storage(env).get(key, {
    range: { offset: 0, length: Math.min(size, SNIFF_PREFIX_BYTES) },
  });
  if (head?.kind !== "body") throw new Error("scan: the object is gone");
  return new Uint8Array(await head.object.arrayBuffer());
}

/** Steps c–h for a claimed job. Resolves with the message's fate. */
async function scanClaimed(
  env: Env,
  bg: BackgroundContext,
  scan: ScanMessage,
  node: Node,
  claimed: Claimed,
  message: Message<unknown>,
): Promise<void> {
  const store = storage(env);
  const head = await store.head(scan.key);
  if (!head) throw new Error("scan: the object is gone");
  const prefix = await readPrefix(env, scan.key, head.size);
  // Awaited: the detector is asynchronous, and a Promise must never be stored as a type.
  const mimeSniffed = await sniff(prefix, node.name);

  let verdict: ScanVerdict;
  if (head.size > SCAN_MAX_BYTES) {
    // The declared hash stays: a Worker-side hash of an object this large does not fit the limits.
    // NOTE: `setScanResult` then sets `scannedAt` over a client hash — the one place the "scannedAt
    // means a server hash" promise (queries/scan.ts) is not kept. Unreachable in v1 (R2 pins
    // MAX_FILE_BYTES ≤ SCAN_MAX_BYTES); a cap raise must revisit f.4's "verified before" here.
    verdict = {
      status: "skipped",
      reason: "size",
      signatures: [],
      pua: [],
      bytes: head.size,
      engine: "none",
    };
  } else {
    const read = await store.get(scan.key);
    if (read?.kind !== "body") throw new Error("scan: the object is gone");
    // The R2 body itself — the runtime sets its length from it (spike S9); never re-wrapped.
    verdict = await getScanner(env).scanStream(read.object.body, { key: scan.key, size: read.object.size });
    if (verdict.status === "error")
      throw new VerdictError(verdict.reason === "timeout" ? "timeout" : "engine");
    // A verdict without the server's hash is not one this pipeline can stand on.
    if (!verdict.sha256) throw new VerdictError("engine");
    await scannerAnswered(bg);
  }

  const photodna = await checkPhotoDna(bg, {
    key: scan.key,
    size: head.size,
    mimeSniffed,
    ownerId: node.ownerId,
  });
  const image = await imageDimensions(env, { key: scan.key, size: head.size, mimeSniffed, prefix });

  const applied = await applyVerdict(bg, {
    key: scan.key,
    nodeId: node.id,
    ownerId: node.ownerId,
    claimed,
    verdict,
    mimeSniffed,
    image,
    photodna,
  });
  const kind = verdict.engine === "stub" ? "stub" : "clamav";
  if (applied.kind === "gone") {
    bg.metric("scan", { outcome: "replaced", kind });
  } else {
    if (photodna && "skipped" in photodna)
      bg.metric("scan", { outcome: "photodna_skipped", reason: photodna.skipped });
    bg.metric(
      "scan",
      {
        outcome: applied.stale ? "stale" : applied.outcome.status,
        reason: applied.outcome.reason ?? undefined,
        kind,
      },
      verdict.durationMs ?? 0,
    );
    if (applied.retry) {
      message.retry({ delaySeconds: backoff(message.attempts) });
      return;
    }
  }
  message.ack();
}

/**
 * R8: the scanner refused the body for what it is (`ScannerRefusedError` — the same body gets the
 * same answer). The job is finished `failed`/`refused`, the node — if still `pending` on this key
 * and not taken down — `error`/`engine` (no server hash: `scannedAt` is left), and the message
 * acknowledged.
 */
async function refused(
  bg: BackgroundContext,
  scan: ScanMessage,
  node: Node,
  claimed: Claimed,
): Promise<void> {
  await bg.db.transaction(async (tx) => {
    await lockOwnerTree(tx, node.ownerId);
    const locked = await findByR2Key(tx, scan.key, { forUpdate: true });
    if (
      locked?.id === node.id &&
      locked.scanStatus === "pending" &&
      locked.takedownAt === null &&
      !(await effectiveHidden(tx, locked.id))
    ) {
      await markScanError(tx, locked.id, scan.key, "engine");
    }
    await finish(tx, claimed, "failed", null, "refused");
  });
}

async function handle(message: Message<unknown>, env: Env, bg: BackgroundContext): Promise<void> {
  const scan = normalizeScanMessage(message.body);
  if (!scan) {
    console.warn(
      `scan: message ignored (not a scan message, or a key outside u/): ${loggable(keyOf(message.body))}`,
    );
    message.ack();
    return;
  }

  const node = await findByR2Key(bg.db, scan.key);
  if (!node) {
    const reference = await keyReference(bg.db, scan.key);
    if (reference?.kind === "upload") {
      // The event beat the upload's commit (S8: every time), or a single PUT whose complete has
      // not come yet.
      message.retry({ delaySeconds: NO_NODE_RETRY_SEC });
    } else if (
      reference?.kind === "version" ||
      (await abortedUploadOf(bg.db, scan.key)) ||
      message.attempts >= UNKNOWN_KEY_MAX_ATTEMPTS
    ) {
      bg.metric("scan", { outcome: "orphan" });
      message.ack();
    } else {
      // A first miss is never final.
      message.retry({ delaySeconds: NO_NODE_RETRY_SEC });
    }
    return;
  }
  if (scan.nodeId !== undefined && scan.nodeId !== node.id) {
    console.warn(`scan: the message names another node than the key's, ignored: ${loggable(scan.key)}`);
    message.ack();
    return;
  }

  const claimed = await claim(bg.db, {
    nodeId: node.id,
    r2Key: scan.key,
    etag: scan.etag,
    force: scan.force,
  });
  if (!claimed.claimed) {
    if (claimed.status === "done") {
      // The repair (ruling 2026-10-12): the first delivery may have committed `infected` and died
      // before the suspension step. No strike, no mail — the threshold only.
      if (node.scanStatus === "infected" && node.createdBy) {
        try {
          await enforceStrikeThreshold(bg, node.createdBy);
        } catch (error) {
          captureError(error, { kind: "scan", reason: "strike_repair" });
          message.retry({ delaySeconds: backoff(message.attempts) });
          return;
        }
      }
      message.ack();
    } else {
      message.retry({ delaySeconds: backoff(message.attempts) });
    }
    return;
  }

  try {
    await scanClaimed(env, bg, scan, node, claimed, message);
  } catch (error) {
    if (error instanceof ScannerRefusedError) {
      captureError(error, { kind: "scan", reason: "refused", key: loggable(scan.key) });
      bg.metric("scan", { outcome: "error", reason: "refused" });
      try {
        await refused(bg, scan, node, claimed);
        message.ack();
      } catch (inner) {
        captureError(inner, { kind: "scan" });
        message.retry({ delaySeconds: backoff(message.attempts) });
      }
      return;
    }
    const failure = error instanceof VerdictError ? { error: error.reason, minDelay: 0 } : classify(error);
    bg.metric("scan", {
      outcome: "retry",
      reason: RETRY_REASONS.has(failure.error) ? failure.error : "failed",
    });
    // An unexpected failure is reported; the scanner's own states are the normal weather.
    if (!(
      error instanceof ScannerNotReadyError ||
      error instanceof ScannerBusyError ||
      isDeployReset(error)
    )) {
      captureError(error, { kind: "scan" });
    }
    // Best effort: a failed row is claimable at once by the redelivery.
    await finish(bg.db, claimed, "failed", null, failure.error).catch((inner: unknown) =>
      captureError(inner, { kind: "scan" }),
    );
    // The scanner's own errors keep an open episode open (the recovery's quiet period), and
    // `not_ready` — the scanner, never a file — for SCANNER_STUCK_MS since the message was first
    // sent (its own timestamp, kept across retries) alerts now, not ≈ 32 min later at the DLQ.
    if (SCANNER_ERRORS.has(failure.error)) {
      const stuck = Date.now() - message.timestamp.getTime() >= SCANNER_STUCK_MS;
      await scannerError(bg, failure.error === "not_ready" && stuck ? { health: true } : { health: false });
    }
    message.retry({ delaySeconds: Math.max(backoff(message.attempts), failure.minDelay) });
  }
}

// ── the dead-letter queue ───────────────────────────────────────────────────────────────────

/** The last errors that are a deploy or a capacity wall: re-sent once, never `error`. */
const REQUEUED_ERRORS = new Set(["reset", "busy"]);

async function handleDeadLetter(message: Message<unknown>, bg: BackgroundContext): Promise<void> {
  const scan = normalizeScanMessage(message.body);
  if (!scan) {
    message.ack();
    return;
  }
  const node = await findByR2Key(bg.db, scan.key);
  if (!node) {
    // An abandoned single PUT, a superseded or deleted key: not a fault (ruling S8-a).
    bg.metric("scan", { outcome: "dlq", reason: "no_node" });
    message.ack();
    return;
  }
  const job = await jobOf(bg.db, scan.key);
  if (job?.status === "done") {
    message.ack();
    return;
  }
  const staleAt = Date.now() - SCAN_CLAIM_STALE_MINUTES * 60_000;
  if (job?.status === "running" && job.startedAt.getTime() >= staleAt) {
    message.retry({ delaySeconds: DLQ_RUNNING_RETRY_SEC });
    return;
  }
  const requeuedBefore = (job?.verdict as Record<string, unknown> | null)?.requeuedFromDlq === true;
  if (
    job?.status === "failed" &&
    REQUEUED_ERRORS.has(job.lastError ?? "") &&
    node.scanStatus === "pending" &&
    !requeuedBefore
  ) {
    // Marked FIRST, then sent: the once-guard holds however fast the re-sent message is claimed
    // (review m2). A send that throws after the mark leaves a `pending` node with no live job —
    // the dead letter is retried, and in the end the pending-scan sweep sends it.
    await markRequeuedFromDlq(bg.db, job.id);
    await enqueueScan(bg, { nodeId: node.id, key: scan.key, force: true });
    bg.metric("scan", { outcome: "dlq", reason: "requeued" });
    message.ack();
    return;
  }

  const reason = job?.lastError === "timeout" ? "timeout" : "engine";
  await bg.db.transaction(async (tx) => {
    await lockOwnerTree(tx, node.ownerId);
    const locked = await findByR2Key(tx, scan.key, { forUpdate: true });
    if (job) await failJob(tx, job.id, job.lastError ?? "dead_letter");
    if (
      locked?.id === node.id &&
      locked.scanStatus === "pending" &&
      locked.takedownAt === null &&
      !(await effectiveHidden(tx, locked.id))
    ) {
      await markScanError(tx, locked.id, scan.key, reason);
    }
  });
  captureError(new Error(`scan: dead-lettered (${reason})`), { kind: "scan", key: loggable(scan.key) });
  bg.metric("scan", { outcome: "dlq", reason });
  if (job?.lastError === "not_ready") await scannerError(bg, { health: true });
  else if (job?.lastError === "engine" || job?.lastError === "timeout") {
    await scannerError(bg, { health: false, owner: node.ownerId });
  }
  message.ack();
}

// ── scanner down: the operators' alert, and the recovery ───────────────────────────────────

/** The scanner errors of step e: `not_ready` is the scanner's own; `engine`/`timeout` may be one file's. */
const SCANNER_ERRORS = new Set(["not_ready", "engine", "timeout"]);

/**
 * A delivery still answered `not_ready` this long after its message was first sent alerts before
 * the DLQ. Not shorter: a cold container with clamd loading answers `not_ready` for 1–3 minutes.
 */
export const SCANNER_STUCK_MS = 10 * 60_000;

/** `engine`/`timeout` dead letters count as the scanner's health only from this many owners… */
export const SCANNER_SUSPECT_OWNERS = 3;
/** …within this window. */
export const SCANNER_SUSPECT_WINDOW_MS = 30 * 60_000;
/** A real verdict ends an episode only when the last scanner error is at least this old. */
export const SCANNER_RECOVERY_QUIET_MS = 10 * 60_000;
/** The suspects kept in the row (bounded). */
const SUSPECTS_KEPT = 50;

/** What one locked change decided: send the mail (and what to give back if it reaches nobody). */
type AlertDecision = { mail: boolean; previous: string | null; noRecipient: boolean };

/** Test seam: the settings row the alert keeps. A test file sets its own key (module per file). */
export const scannerAlertScope = { key: SCANNER_ALERT_KEY };

/** The `scanner_down` mail at most this often — across episodes; the detector's 6 h. */
export const SCANNER_DOWN_MAIL_EVERY_MS = ROLLBACK_MAIL_EVERY_MS;

/**
 * One scanner error. `health: true` is the scanner's own (`not_ready`): it opens an episode.
 * `health: false` with an `owner` is an `engine`/`timeout` dead letter: recorded as a suspect,
 * and it opens an episode only when ≥ 3 distinct owners' are within 30 min. Without either, only
 * an open episode's last-error time moves (one statement). The mail is claimed in the same locked
 * change — at most one per 6 h, whatever the episodes — and only with an operator address; a
 * claim that reached nobody is given back. Never throws.
 */
async function scannerError(
  bg: BackgroundContext,
  event: { health: boolean; owner?: string },
): Promise<void> {
  const key = scannerAlertScope.key;
  try {
    const at = new Date();
    if (!event.health && event.owner === undefined) {
      await noteScannerError(bg.db, key, at);
      return;
    }
    const recipients = adminListOf(bg.env).addresses.size > 0;
    const now = at.toISOString();
    const decision = await changeScannerAlert<AlertDecision>(bg.db, key, (state) => {
      const windowStart = at.getTime() - SCANNER_SUSPECT_WINDOW_MS;
      // One entry per owner (the latest), so one owner's dead letters cannot push the others out of
      // the bounded list; filling it then takes distinct owners, which open the episode anyway.
      const suspects = state.suspects.filter(
        (entry) => Date.parse(entry.at) >= windowStart && entry.owner !== event.owner,
      );
      if (event.owner !== undefined) suspects.push({ owner: event.owner, at: now });
      const healthy =
        event.health || new Set(suspects.map((entry) => entry.owner)).size >= SCANNER_SUSPECT_OWNERS;
      const open = state.since !== null && state.endedAt === null;
      const next = {
        ...state,
        suspects: suspects.slice(-SUSPECTS_KEPT),
        lastErrorAt: open || healthy ? now : state.lastErrorAt,
      };
      if (!healthy) return { next, result: { mail: false, previous: null, noRecipient: false } };
      if (!open) Object.assign(next, { since: now, endedAt: null });
      const last = state.mailedAt === null ? Number.NaN : Date.parse(state.mailedAt);
      const due = !Number.isFinite(last) || at.getTime() - last >= SCANNER_DOWN_MAIL_EVERY_MS;
      if (!due || !recipients) {
        return { next, result: { mail: false, previous: null, noRecipient: due && !recipients } };
      }
      return {
        next: { ...next, mailedAt: now },
        result: { mail: true, previous: state.mailedAt, noRecipient: false },
      };
    });
    if (decision.noRecipient) {
      bg.metric("scan", { outcome: "scanner_down", reason: "no_recipient" });
      captureError(new Error("scan: the scanner is down and no operator address is configured"), {
        kind: "scan",
        reason: "scanner_down",
      });
      return;
    }
    if (!decision.mail) return;
    if (await mailOperators(bg, "scanner_down", { kind: "scan", job: "scanner_down" })) {
      bg.metric("scan", { outcome: "scanner_down", reason: "mailed" });
      return;
    }
    await releaseScannerDownMail(bg.db, key, at, decision.previous);
    bg.metric("scan", { outcome: "scanner_down", reason: "send_failed" });
  } catch (error) {
    captureError(error, { kind: "scan", reason: "scanner_down" });
  }
}

/**
 * A real verdict came back: an open episode ends — once its last scanner error is ≥ 10 min old
 * (one statement; nothing when none is open) — with the metric and an audit row. The mail
 * throttle is NOT reset. Never throws: a scan never fails or retries because of this.
 */
async function scannerAnswered(bg: BackgroundContext): Promise<void> {
  const key = scannerAlertScope.key;
  try {
    const ended = await endScannerEpisode(bg.db, key, new Date(), SCANNER_RECOVERY_QUIET_MS);
    if (!ended) return;
    bg.metric("scan", { outcome: "scanner_recovered" });
    await bg.db.transaction((tx) =>
      auditInTx(
        tx,
        bg,
        "system.scanner_recovered",
        { type: "system", id: "scanner" },
        { since: ended.since, key },
      ),
    );
  } catch (error) {
    captureError(error, { kind: "scan", reason: "scanner_recovered" });
  }
}

export async function queue(
  batch: MessageBatch<unknown>,
  env: Env,
  ctx: ExecutionContext,
  bg: BackgroundContext,
): Promise<void> {
  void ctx;
  const deadLetters = batch.queue.endsWith("-dlq");
  // A batch with no scan message in it at all is acknowledged whole (and asks the database nothing).
  if (batch.messages.every((message) => normalizeScanMessage(message.body) === null)) {
    for (const message of batch.messages) {
      console.warn(
        `scan: message ignored (not a scan message, or a key outside u/): ${loggable(keyOf(message.body))}`,
      );
    }
    batch.ackAll();
    return;
  }
  for (const message of batch.messages) {
    try {
      if (deadLetters) await handleDeadLetter(message, bg);
      else await handle(message, env, bg);
    } catch (error) {
      // Before the claim (a database error, say): nothing to mark, try again.
      captureError(error, { kind: "scan" });
      message.retry({ delaySeconds: deadLetters ? DLQ_RUNNING_RETRY_SEC : backoff(message.attempts) });
    }
  }
}
