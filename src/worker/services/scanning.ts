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

import { parseAdminList } from "../../shared/admin-emails";
import { UUID } from "../../shared/ids";
import { lockSuspectedCsam as lockRows } from "../db/queries/moderation";
import { findByR2Key, getNode, resetToPending } from "../db/queries/nodes";
import type { ScanReason } from "../db/schema";
import { audit } from "./audit";
import { sendOperatorCritical } from "./email";
import { AppError } from "./errors";
import { metric } from "./metrics";
import type { ServiceDeps } from "./request-context";
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

export type RescanResult = { queued: boolean; reason?: "taken_down" | "locked" };

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
 * The message carries `force` unless the caller says otherwise, because the finished job of the
 * earlier scan is only taken over by a forced claim. The message and the audit row follow the
 * commit, and only when something was queued.
 *
 * `404 not_found` for an id that is not a file. The one-per-hour owner throttle is the route's.
 */
export async function enqueueRescan(
  deps: ServiceDeps,
  nodeId: string,
  opts: { force?: boolean; by: "owner" | "admin" },
): Promise<RescanResult> {
  const seen = await getNode(deps.db, nodeId);
  if (!seen || seen.kind !== "file" || !seen.r2Key) throw new AppError("not_found");

  type Decision = { key: string } | { reason: "taken_down" | "locked" } | null;
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
        // The statement has the same guard: it changes nothing for the two locked statuses.
        return (await resetToPending(tx, nodeId)) ? { key: r2Key } : { reason: "locked" };
      }
      r2Key = (await getNode(tx, nodeId))?.r2Key ?? null;
    }
    return null;
  });
  // Gone, or replaced faster than it could be locked: there is no such file to rescan.
  if (decision === null) throw new AppError("not_found");
  if ("reason" in decision) return { queued: false, reason: decision.reason };

  const force = opts.force ?? true;
  await enqueueScan(deps, { nodeId, key: decision.key, force });
  audit(deps, "scan.rescan_requested", { type: "node", id: nodeId }, { by: opts.by, force });
  return { queued: true };
}

// ── suspected CSAM ──────────────────────────────────────────────────────────────────────────

/**
 * The one handler for suspected CSAM — the upload route (blocklist hit), the scan consumer and
 * the admin console all call this, so there is one code path.
 *
 * The database half (db/queries/moderation.ts): the node becomes `suspected_csam`, the node and
 * its owner go on legal hold, the node's links are paused, its upload addresses are held, its
 * hash is blocklisted and a report is filed. Then, here: the audit row, a critical operator
 * alert that carries the report id and nothing else, and a metric.
 *
 * It never deletes anything, never notifies the owner and issues no strike. Safe to repeat: a
 * second call for a node that is already locked returns the same report and alerts nobody again.
 * `404 not_found` when there is no such node.
 */
export async function lockSuspectedCsam(
  deps: ServiceDeps,
  nodeId: string,
  opts: { source: "photodna" | "system" | "admin" },
): Promise<{ reportId: string }> {
  const before = await getNode(deps.db, nodeId);
  const locked = await lockRows(deps.db, nodeId, opts);
  if (!locked) throw new AppError("not_found");
  const { reportId } = locked;
  if (before?.scanStatus !== "suspected_csam") {
    audit(deps, "scan.suspected_csam", { type: "node", id: nodeId }, { source: opts.source, reportId });
    for (const to of parseAdminList(deps.env.ADMIN_EMAILS).addresses) {
      deps.defer(sendOperatorCritical(deps, { to, event: "csam_lock", id: reportId }));
    }
    metric("scan", { outcome: "suspected_csam", kind: opts.source });
  }
  return { reportId };
}
