// The verdict (T21 step 2f–2g): what a finished scan MEANS for its node, written in ONE
// transaction, with every side effect applied exactly once.
//
// THE OUTCOME (first match wins — `deriveOutcome`):
//   1. a PhotoDNA match, or the SERVER hash listed `csam`            → suspected_csam
//   2. the scanner says infected, or the server hash listed `malware` → infected
//   3. the server hash listed `dmca` / `admin`                        → the engine's verdict, plus a
//                                                                      takedown, a link pause and a
//                                                                      report for an admin
//   4. the server hash ≠ the hash the client DECLARED                 → error / hash_mismatch
//      (the session's `uploads.expected_sha256`; with no session left, `nodes.sha256` once the key
//      was verified before; a key never verified is not compared — see `expectedHash`)
//   5. otherwise the scanner's status and reason
// The SERVER hash is the only hash anything is decided on; the client's is only compared with.
//
// WHERE IT IS WRITTEN — decided on the row as LOCKED here, never on an earlier read:
//   outcome suspected_csam, any state    the shared handler `lockSuspectedCsam`, AFTER the commit
//                                          (a PhotoDNA match listed csam and recorded as owed on
//                                          the key BEFORE this transaction — `recordDetection`)
//   pending, not taken down              the status (and reason); the side effects below
//   taken down (itself or a folder       status untouched; the outcome is kept in the detail and
//     above it — `effectiveHidden`)        the job's verdict only
//   under_review                         `scanStatusPrev` (what dismissing the report restores), and
//                                          the infected / takedown effects all the same (Addendum 2)
//   suspected_csam, or already settled   untouched (a late or duplicate message: metric `stale`)
// In every row the server hash, the sniffed type, the detail and the scan time are written (the
// record of what the scanner saw; none of them opens or closes access) — except when the key is no
// longer the node's current version (replaced or purged during the scan): then nothing is.
//
// SIDE EFFECTS EXACTLY ONCE. The key's `scan_jobs` row survives rescans, so it is the ledger:
// `verdict.effects` records each effect in the same transaction, and an effect already recorded is
// skipped. `finish('done')` REPLACES the job's verdict, so the ledger (and the dead-letter mark) is
// read from the LOCKED row and carried into every verdict written. Mails are recorded inside the
// transaction and sent after the commit: a crash can lose a mail, never duplicate a strike.
//
// LOCK ORDER (PLAN §6 rule 15): the owner's tree lock FIRST, then the node row, then the job row,
// then the blocklist, then strike / report / link rows. `moderation.takedownNode` takes the tree
// lock again (re-entrant in one session) and runs as a savepoint. `lockSuspectedCsam` opens its own
// transaction on `bg` and takes the same locks, so it runs only after this one has committed.
// Audit rows go through `audit(bg, …)` after the commit; the strike row alone joins the
// transaction (`addStrike(bg, …, { tx })`), its `applySuspension()` is awaited after it.
// Nothing here relies on `waitUntil` outliving the invocation: everything is awaited.

import { and, eq, inArray, sql } from "drizzle-orm";
import { THUMB_INPUT_MAX_BYTES } from "../../shared/constants";
import * as blocklist from "../db/queries/blocklist";
import { pauseLinks } from "../db/queries/links";
import { insertReport, listAsLocked, takedownNode } from "../db/queries/moderation";
import { findByR2Key, setScanResult } from "../db/queries/nodes";
import { declaredHashOf, emailsOf, lockJob, recordScan } from "../db/queries/scan";
import { finish } from "../db/queries/scan-jobs";
import { effectiveHidden, lockOwnerTree } from "../db/queries/tree";
import { auditLog, type Node, type ScanDetail } from "../db/schema";
import { captureError } from "../sentry";
import { audit, auditInTx } from "../services/audit";
import { sendQuarantineNotice, sendUploadNotIntact } from "../services/email";
import { AppError } from "../services/errors";
import type { Executor, Tx } from "../db/client";
import type { BackgroundContext, ServiceDeps } from "../services/request-context";
import { lockSuspectedCsam, type ScanReason, type ScanVerdict } from "../services/scanning";
import { storage } from "../services/storage";
import { addStrike, type StrikeResult } from "../services/strikes";
import { photodnaNote, type PhotoDnaResult } from "./photodna";

export type BlocklistReason = blocklist.BlocklistReason;

export type Outcome = {
  status: "clean" | "infected" | "skipped" | "error" | "suspected_csam";
  reason: ScanReason | null;
  /** The blocklist reason the server hash matched, if it did. */
  blocklist: BlocklistReason | null;
  /** For `suspected_csam`: who found it. */
  csamSource: "photodna" | "system" | null;
  /** Step f.3: the takedown a `dmca` / `admin` listing adds to the engine's verdict. */
  takedown: "dmca" | "admin" | null;
};

/** What the job row's verdict carries from one scan to the next. */
export type Effects = {
  /** A `malware` blocklist row was written for this key. */
  blocklist?: true;
  /** The strike row (id) issued for this key. */
  strike?: string;
  /** The quarantine notice (and `scan.infected` audit row) was recorded for sending. */
  quarantineNotice?: true;
  /** The "did not arrive intact" notice (and `scan.hash_mismatch` audit row) was recorded. */
  notIntactNotice?: true;
  /** Step f.3's takedown, link pause and report. */
  takedown?: true;
  /** The suspected-CSAM lock's report. */
  csamLock?: string;
};

/**
 * The hash a verdict is compared with (step f.4), or null for "do not compare":
 *   the session's `expected_sha256` when a session row has one;
 *   else `nodes.sha256`, when this key was VERIFIED before — `nodes.scannedAt` set, or an earlier
 *     verdict of this key on its job row (every verdict overwrites `nodes.sha256` with the server's
 *     hash; `resetToPending` clears `scannedAt` but the job row keeps the earlier verdict);
 *   else nothing: `nodes.sha256` still holds the client's unverified claim, and a mismatch with it
 *     proves nothing.
 */
export function expectedHash(
  declared: { session: boolean; sha256: string | null },
  node: { sha256: string | null; scannedAt: Date | null },
  earlierVerdictSha256: unknown,
): string | null {
  if (declared.sha256) return declared.sha256;
  const verifiedBefore = node.scannedAt !== null || typeof earlierVerdictSha256 === "string";
  return verifiedBefore ? node.sha256 : null;
}

/** Steps f.1–f.5. `sha256` is the scanner's (server) hash; absent only for the size guard. */
export function deriveOutcome(input: {
  verdict: ScanVerdict;
  photodna: PhotoDnaResult | null;
  listed: BlocklistReason | null;
  expected: string | null;
}): Outcome {
  const { verdict, listed } = input;
  const none = { blocklist: listed, csamSource: null, takedown: null } as const;
  const photodnaMatch = input.photodna !== null && "match" in input.photodna && input.photodna.match;
  if (photodnaMatch || listed === "csam") {
    return {
      status: "suspected_csam",
      reason: null,
      blocklist: listed,
      csamSource: photodnaMatch ? "photodna" : "system",
      takedown: null,
    };
  }
  if (verdict.status === "infected" || listed === "malware")
    return { status: "infected", reason: null, ...none };
  const engine = { status: verdict.status, reason: verdict.reason ?? null };
  if (listed === "dmca" || listed === "admin") return { ...engine, ...none, takedown: listed };
  const sha = verdict.sha256?.toLowerCase();
  if (sha && input.expected && input.expected.toLowerCase() !== sha) {
    return { status: "error", reason: "hash_mismatch", ...none };
  }
  return { ...engine, ...none };
}

// ── image dimensions ────────────────────────────────────────────────────────────────────────

export type Dimensions = { width: number; height: number };

const u16be = (b: Uint8Array, at: number) => (b[at]! << 8) | b[at + 1]!;
const u16le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u24le = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((b[at]! << 24) >>> 0) + (b[at + 1]! << 16) + (b[at + 2]! << 8) + b[at + 3]!;
const ascii = (b: Uint8Array, at: number, text: string) =>
  text.split("").every((ch, i) => b[at + i] === ch.charCodeAt(0));
const sane = (width: number, height: number): Dimensions | null =>
  Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    ? { width, height }
    : null;

/** JPEG start-of-frame markers (SOF0–SOF15 less DHT, JPG and DAC). */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

/**
 * The pixel size from an image's first bytes — PNG, GIF, WebP and JPEG — or null when the prefix
 * does not hold it (a JPEG whose frame header lies past it, another format, a damaged header).
 * No service is called.
 */
export function headerDimensions(prefix: Uint8Array, mime: string): Dimensions | null {
  const b = prefix;
  if (mime === "image/png") {
    if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
    return sane(u32be(b, 16), u32be(b, 20));
  }
  if (mime === "image/gif") {
    if (b.length < 10 || !ascii(b, 0, "GIF8")) return null;
    return sane(u16le(b, 6), u16le(b, 8));
  }
  if (mime === "image/webp") {
    if (b.length < 30 || !ascii(b, 0, "RIFF") || !ascii(b, 8, "WEBP")) return null;
    if (ascii(b, 12, "VP8 ")) return sane(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
    if (ascii(b, 12, "VP8L")) {
      if (b[20] !== 0x2f) return null;
      const width = 1 + (((b[22]! & 0x3f) << 8) | b[21]!);
      const height = 1 + (((b[24]! & 0x0f) << 10) | (b[23]! << 2) | ((b[22]! & 0xc0) >> 6));
      return sane(width, height);
    }
    if (ascii(b, 12, "VP8X")) return sane(1 + u24le(b, 24), 1 + u24le(b, 27));
    return null;
  }
  if (mime === "image/jpeg") {
    if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    let at = 2;
    while (at + 4 <= b.length) {
      if (b[at] !== 0xff) return null;
      const marker = b[at + 1]!;
      if (marker === 0xff) {
        at += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        at += 2; // no length
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan
      const length = u16be(b, at + 2);
      if (length < 2) return null;
      if (JPEG_SOF.has(marker)) {
        if (at + 9 > b.length) return null;
        return sane(u16be(b, at + 7), u16be(b, at + 5));
      }
      at += 2 + length;
    }
    return null;
  }
  return null;
}

/**
 * The pixel size of a stored image, for the preview's pixel cap (T18). The header first; for an
 * image it does not cover, `env.IMAGES.info()` — only for an object of at most
 * `THUMB_INPUT_MAX_BYTES` (larger ones never reach the binding), and ANYTHING thrown by the
 * binding (or by the read) means "no dimensions": never a failed scan, never a retry. `info()` is
 * not a billed unit (Images pricing: "Calls to the Images binding's .info() method are not
 * billed", since 2026-07-01), so nothing is added to the ledger. Null for anything that is not an
 * image, and for SVG (it has no pixel size). Never a source of `mimeSniffed`.
 */
export async function imageDimensions(
  env: Pick<Env, "IMAGES" | "FILES">,
  object: { key: string; size: number; mimeSniffed: string; prefix: Uint8Array },
): Promise<Dimensions | null> {
  const { mimeSniffed: mime } = object;
  if (!mime.startsWith("image/") || mime === "image/svg+xml") return null;
  const fromHeader = headerDimensions(object.prefix, mime);
  if (fromHeader) return fromHeader;
  if (object.size > THUMB_INPUT_MAX_BYTES) return null;
  try {
    const read = await storage(env).get(object.key);
    if (read?.kind !== "body") return null;
    const info = (await env.IMAGES.info(read.object.body)) as { width?: unknown; height?: unknown };
    return typeof info.width === "number" && typeof info.height === "number"
      ? sane(info.width, info.height)
      : null;
  } catch {
    return null;
  }
}

// ── infected content ────────────────────────────────────────────────────────────────────────

/**
 * What infected content costs, in the caller's transaction — shared by `applyVerdict` and the
 * avatar path of the upload route (which scans in the request): when `list`, the SERVER hash is
 * listed `malware` with the node as its source (`upsert` never lowers a csam entry; the caller
 * decides whether the hash was unlisted), and when `strike`, the uploader is struck (`addStrike`
 * in the `tx` form: its `applySuspension()` is the caller's to await after the commit). Upsert
 * first, then the strike. `listed`: a row was written; `strike`: null when none was asked for or
 * there is no uploader.
 */
export async function listInfected(
  deps: ServiceDeps,
  tx: Tx,
  input: {
    nodeId: string;
    uploaderId: string | null;
    sha256: string | undefined;
    list: boolean;
    strike: boolean;
  },
): Promise<{ listed: boolean; strike: StrikeResult | null }> {
  const { nodeId, uploaderId, sha256 } = input;
  let listed = false;
  if (input.list && sha256) {
    await blocklist.upsert(tx, { sha256, reason: "malware", sourceNodeId: nodeId });
    listed = true;
  }
  const strike =
    input.strike && uploaderId
      ? await addStrike(
          deps,
          { userId: uploaderId, kind: "malware", nodeId, ...(sha256 ? { sha256 } : {}) },
          { tx },
        )
      : null;
  return { listed, strike };
}

// ── a PhotoDNA match ────────────────────────────────────────────────────────────────────────

/**
 * A PhotoDNA match puts the SERVER hash on the list BEFORE any write that makes the node locked —
 * so a match whose lock then fails is not owed by an audit row alone: the list says csam, and
 * whatever runs next (the scan's redelivery, T22's owed-node sweep) locks it like any other csam
 * hit. Shared by `applyVerdict` (in its transaction, after the node and job rows) and the avatar
 * path of the upload route (one statement on its own, before the node's transaction).
 *
 * THE LOCK'S OWN STATEMENT (queries/moderation.ts `listAsLocked`, which `lockRows` writes), with
 * `nodeId` the node that is — or is about to be — locked: no entry → created, `sourceNodeId`
 * that node; an entry with another reason → RAISED to `csam` (`raisedFrom`, `raisedByNodeId`);
 * a `csam` entry → untouched. Never `blocklist.upsert(csam)` / `confirmCsam`: those make a
 * CONFIRMED listing, which no clear undoes — a PhotoDNA false positive cleared by an admin must
 * come off the list again (`clearSuspectedCsam` undoes an entry naming the cleared node).
 */
export async function listSuspectedCsam(
  db: Executor | Tx,
  input: { sha256: string; nodeId: string },
): Promise<void> {
  await listAsLocked(db, input.sha256, input.nodeId);
}

/** The held audit row that makes a PhotoDNA detection durable BEFORE the verdict's transaction. */
export const PHOTODNA_DETECTION_ACTION = "scan.photodna_detection";
/** Written once the detection ended in a lock, a preserved node or its record: nothing is owed. */
export const PHOTODNA_SETTLED_ACTION = "scan.photodna_settled";

/**
 * A PhotoDNA detection as recorded before the verdict's transaction — everything a later delivery
 * needs to preserve the bytes when their file is gone: the key, the server hash, and of the file
 * its id (`fileId`: the node the scan was about — what the listing names until a preserved node
 * takes it over), uploader and declared type (never its name: audit rows carry no file names).
 * Nothing here is decided on a read: bytes are always preserved under a FRESH node id
 * (scan/consumer.ts `preserveDetection`).
 */
export type PhotoDnaDetection = {
  key: string;
  sha256: string;
  fileId: string;
  uploaderId: string | null;
  mimeDeclared: string | null;
  /** Known only to the delivery that read the file; a later one names the node "preserved". */
  name: string | null;
  /** When the detection was recorded (its audit row's time); null before it is. */
  recordedAt?: Date | null;
};

/**
 * Makes a detection durable, in ONE transaction of its own and BEFORE the verdict's: the listing
 * (`listSuspectedCsam`, naming the file) and the held audit row (`legalHold`, kept past
 * retention) targeting the KEY — so that a delivery whose verdict never commits leaves an OWED
 * detection the redelivery finds even when no node is on the key any more (scan/consumer.ts).
 */
async function recordDetection(bg: BackgroundContext, detection: PhotoDnaDetection): Promise<void> {
  await bg.db.transaction(async (tx) => {
    await listSuspectedCsam(tx, { sha256: detection.sha256, nodeId: detection.fileId });
    await auditInTx(
      tx,
      bg,
      PHOTODNA_DETECTION_ACTION,
      { type: "scan_key", id: detection.key },
      {
        sha256: detection.sha256,
        nodeId: detection.fileId,
        uploaderId: detection.uploaderId,
        mimeDeclared: detection.mimeDeclared,
        legalHold: true,
      },
    );
  });
}

/** Records that the key's detection is settled (durable: its own transaction). Never throws. */
export async function settleDetection(
  bg: BackgroundContext,
  key: string,
  meta: { outcome: "locked" | "preserved" | "recorded" | "cleared"; nodeId?: string },
): Promise<void> {
  try {
    await bg.db.transaction((tx) =>
      auditInTx(tx, bg, PHOTODNA_SETTLED_ACTION, { type: "scan_key", id: key }, { ...meta, legalHold: true }),
    );
  } catch (error) {
    captureError(error, { kind: "scan", reason: "photodna_settle" });
  }
}

/**
 * The keys of OWED detections — recorded before `olderThan` and never settled — oldest first, at
 * most `limit`: what the hourly sweep (`sweepOwedDetections`, scan/consumer.ts) takes, so that no
 * detection depends on a redelivery happening.
 */
export async function owedDetectionKeys(db: Executor, olderThan: Date, limit: number): Promise<string[]> {
  const rows = await db.execute<{ key: string }>(sql`
    SELECT a.target_id AS key FROM audit_log a
    WHERE a.action = ${PHOTODNA_DETECTION_ACTION} AND a.target_type = 'scan_key' AND a.at < ${olderThan}
      AND NOT EXISTS (SELECT 1 FROM audit_log s
                      WHERE s.target_type = 'scan_key' AND s.target_id = a.target_id
                        AND s.action = ${PHOTODNA_SETTLED_ACTION})
    ORDER BY a.at
    LIMIT ${limit}`);
  return rows.rows.map((row) => row.key);
}

/**
 * The key's OWED detection — recorded and never settled — or null. Read by a delivery that finds
 * no node on its key, before it would acknowledge the key as an orphan (the target index).
 */
export async function owedDetection(db: Executor, key: string): Promise<PhotoDnaDetection | null> {
  const rows = await db
    .select({ action: auditLog.action, meta: auditLog.meta, at: auditLog.at })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.targetType, "scan_key"),
        eq(auditLog.targetId, key),
        inArray(auditLog.action, [PHOTODNA_DETECTION_ACTION, PHOTODNA_SETTLED_ACTION]),
      ),
    );
  if (rows.some((row) => row.action === PHOTODNA_SETTLED_ACTION)) return null;
  const recorded = rows.find((row) => row.action === PHOTODNA_DETECTION_ACTION);
  const meta = recorded?.meta;
  if (!meta || typeof meta.sha256 !== "string" || typeof meta.nodeId !== "string") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  return {
    key,
    sha256: meta.sha256,
    fileId: meta.nodeId,
    uploaderId: text(meta.uploaderId),
    mimeDeclared: text(meta.mimeDeclared),
    name: null,
    recordedAt: recorded!.at,
  };
}

// ── applying it ─────────────────────────────────────────────────────────────────────────────

export type VerdictInput = {
  key: string;
  /** As read before the claim; re-read and locked here. */
  nodeId: string;
  ownerId: string;
  claimed: { jobId: string; attempt: number };
  verdict: ScanVerdict;
  mimeSniffed: string;
  image: Dimensions | null;
  photodna: PhotoDnaResult | null;
  /** The file as read before the claim: what preserving its bytes needs once its row is gone. */
  file: Pick<Node, "name" | "mimeDeclared" | "createdBy">;
};

export type Applied =
  /**
   * The key is no longer the node's current version (replaced, purged): nothing was written to any
   * node. `photodna`: PhotoDNA matched these bytes all the same — the detection is recorded and
   * the server hash listed csam (naming the file; null: no server hash, nothing recorded) and
   * the CALLER owes it its preservation or its record (scan/consumer.ts).
   */
  | { kind: "gone"; photodna?: PhotoDnaDetection | null }
  | {
      kind: "applied";
      outcome: Outcome;
      /** What was written: the status, `scanStatusPrev`, a lock, or only the record. */
      wrote: "status" | "prev" | "lock" | "record";
      /** `stale`: a settled node the message came late for. */
      stale: boolean;
      /** An after-commit step failed (the suspension): retry, the `done` row repairs it. */
      retry: boolean;
    };

/** Another delivery took the claim over (it went stale): this one must not commit. */
export class LostClaimError extends Error {
  constructor() {
    super("scan: the claim was taken over");
    this.name = "LostClaimError";
  }
}

type AfterCommit = {
  audit: { action: "scan.infected" | "scan.hash_mismatch"; meta: Record<string, unknown> } | null;
  mail: "quarantine" | "not_intact" | null;
  strike: StrikeResult | null;
};

function detailOf(input: VerdictInput, outcome: Outcome): ScanDetail {
  const { verdict } = input;
  return {
    engine: verdict.engine,
    ...(verdict.dbVersion !== undefined ? { dbVersion: verdict.dbVersion } : {}),
    ...(verdict.durationMs !== undefined ? { durationMs: verdict.durationMs } : {}),
    ...(verdict.signatures.length > 0 ? { signatures: verdict.signatures } : {}),
    ...(verdict.pua.length > 0 ? { pua: verdict.pua } : {}),
    ...(outcome.blocklist ? { blocklist: outcome.blocklist } : {}),
    ...(input.photodna ? { photodna: photodnaNote(input.photodna) } : {}),
    ...(input.image ? { image: input.image } : {}),
  };
}

/** The job row's verdict: the scanner's, the outcome, and the carried ledger. */
function jobVerdict(input: VerdictInput, outcome: Outcome, carried: Record<string, unknown>) {
  const { verdict } = input;
  return {
    status: verdict.status,
    ...(verdict.reason ? { reason: verdict.reason } : {}),
    signatures: verdict.signatures,
    pua: verdict.pua,
    ...(verdict.sha256 ? { sha256: verdict.sha256.toLowerCase() } : {}),
    ...(verdict.bytes !== undefined ? { bytes: verdict.bytes } : {}),
    engine: verdict.engine,
    ...(verdict.dbVersion !== undefined ? { dbVersion: verdict.dbVersion } : {}),
    ...(verdict.durationMs !== undefined ? { durationMs: verdict.durationMs } : {}),
    outcome: outcome.status,
    ...(outcome.reason ? { outcomeReason: outcome.reason } : {}),
    ...(outcome.blocklist ? { blocklist: outcome.blocklist } : {}),
    ...(input.photodna ? { photodna: photodnaNote(input.photodna) } : {}),
    ...carried,
  };
}

/**
 * Steps 2g–2h for a claimed job: the transaction, then what follows its commit. Resolves once
 * everything is done (mails sent, suspension enforced). Throws when the transaction did not
 * commit (`LostClaimError` among others) or the suspected-CSAM lock failed: nothing of the
 * verdict stands then, and the caller fails the job and retries.
 */
export async function applyVerdict(bg: BackgroundContext, input: VerdictInput): Promise<Applied> {
  const { key, verdict } = input;
  const sha256 = verdict.sha256?.toLowerCase();
  // A PhotoDNA match is made durable FIRST, before the transaction below can fail: listed (naming
  // the file the scan is about) and recorded as owed on the key. Nothing is read to decide it.
  const matched = input.photodna !== null && "match" in input.photodna && input.photodna.match;
  let detection: PhotoDnaDetection | null = null;
  if (matched && sha256) {
    detection = {
      key,
      sha256,
      fileId: input.nodeId,
      uploaderId: input.file.createdBy,
      mimeDeclared: input.file.mimeDeclared,
      name: input.file.name,
    };
    await recordDetection(bg, detection);
  }
  type Decided =
    | { kind: "gone"; photodna?: PhotoDnaDetection | null }
    | {
        kind: "applied";
        outcome: Outcome;
        wrote: "status" | "prev" | "lock" | "record";
        stale: boolean;
        after: AfterCommit;
        node: { id: string; name: string; ownerId: string; createdBy: string | null };
        carried: { effects: Effects } & Record<string, unknown>;
      };

  const decided = await bg.db.transaction(async (tx): Promise<Decided> => {
    await lockOwnerTree(tx, input.ownerId);
    const node = await findByR2Key(tx, key, { forUpdate: true });
    const job = await lockJob(tx, key);
    const prior = (job?.verdict ?? {}) as Record<string, unknown>;
    const effects: Effects = { ...((prior.effects as Effects | undefined) ?? {}) };
    const carried: { effects: Effects } & Record<string, unknown> = {
      effects,
      ...(prior.requeuedFromDlq === true ? { requeuedFromDlq: true } : {}),
    };

    if (!node || node.id !== input.nodeId) {
      // Replaced or purged during the scan: nothing is written to any node. A PhotoDNA match is a
      // detection all the same — recorded and listed above — and the caller preserves the bytes,
      // or records the detection (never dropped).
      const gone: Outcome = {
        status: verdict.status,
        reason: null,
        blocklist: null,
        csamSource: null,
        takedown: null,
      };
      if (
        job &&
        !(await finish(tx, input.claimed, "done", {
          ...jobVerdict(input, gone, carried),
          outcome: "replaced",
        }))
      )
        throw new LostClaimError();
      return { kind: "gone", ...(matched ? { photodna: detection } : {}) };
    }

    const listed = sha256 ? ((await blocklist.lookup(tx, sha256))?.reason ?? null) : null;
    const expected = expectedHash(await declaredHashOf(tx, key), node, prior.sha256);
    const outcome = deriveOutcome({ verdict, photodna: input.photodna, listed, expected });
    // The SAME "taken down" as `enqueueRescan`: its own takedown, or a folder above it.
    const takenDown =
      node.takedownAt !== null ||
      (node.scanStatus !== "suspected_csam" && (await effectiveHidden(tx, node.id)));
    const scannedAt = new Date();
    const scanDetail = detailOf(input, outcome);
    const seen = { ...(sha256 ? { sha256 } : {}), mimeSniffed: input.mimeSniffed, scanDetail, scannedAt };
    const after: AfterCommit = { audit: null, mail: null, strike: null };
    let wrote: "status" | "prev" | "lock" | "record" = "record";
    let stale = false;

    if (outcome.status === "suspected_csam") {
      // From ANY state: it only ever raises. The lock itself is the shared handler's, after commit.
      await recordScan(tx, node.id, key, seen);
      wrote = "lock";
    } else if (takenDown) {
      await recordScan(tx, node.id, key, seen);
    } else if (node.scanStatus === "pending" || node.scanStatus === "under_review") {
      // `pending`: the status. `under_review`: `setScanResult` stores the outcome as the status a
      // dismissal restores — and the effects below still apply (Addendum 2): a blocklisted hash
      // is taken down NOW, so dismissing the report can never restore an accessible file, and an
      // infected verdict strikes and notifies as it would on a pending node.
      const reviewed = node.scanStatus === "under_review";
      await setScanResult(tx, node.id, key, {
        scanStatus: outcome.status,
        scanReason: outcome.reason,
        scanDetail,
        mimeSniffed: input.mimeSniffed,
        ...(sha256 ? { sha256 } : {}),
        scannedAt,
      });
      wrote = reviewed ? "prev" : "status";
      const uploader = node.createdBy;
      if (outcome.status === "infected") {
        // A hit that came from the list needs no row; an unlisted infected hash is listed now.
        const infected = await listInfected(bg, tx, {
          nodeId: node.id,
          uploaderId: uploader,
          sha256,
          list: outcome.blocklist === null && !effects.blocklist,
          strike: !effects.strike,
        });
        if (infected.listed) effects.blocklist = true;
        if (infected.strike) {
          after.strike = infected.strike;
          effects.strike = after.strike.strikeId;
        }
        if (!effects.quarantineNotice) {
          effects.quarantineNotice = true;
          after.mail = "quarantine";
          after.audit = {
            action: "scan.infected",
            meta: { signatures: verdict.signatures, blocklist: outcome.blocklist },
          };
        }
      } else if (outcome.status === "error" && outcome.reason === "hash_mismatch" && !reviewed) {
        if (!effects.notIntactNotice) {
          effects.notIntactNotice = true;
          after.mail = "not_intact";
          after.audit = { action: "scan.hash_mismatch", meta: {} };
        }
      }
      if (outcome.takedown && !effects.takedown) {
        // Its node was not taken down when locked, so the verdict above stands.
        await takedownNode(tx, node.id, { reason: outcome.takedown, by: null });
        await pauseLinks(tx, { nodeId: node.id }, "moderation");
        await insertReport(tx, {
          nodeId: node.id,
          ownerId: node.ownerId,
          source: "system",
          category: outcome.takedown === "dmca" ? "copyright" : "other",
          details: `hash blocklist: ${outcome.takedown}`,
        });
        effects.takedown = true;
      }
    } else {
      // `suspected_csam`, or settled already: a duplicate or late message.
      await recordScan(tx, node.id, key, seen);
      stale = node.scanStatus !== "suspected_csam";
    }

    if (outcome.status !== "suspected_csam") {
      if (!(await finish(tx, input.claimed, "done", jobVerdict(input, outcome, carried))))
        throw new LostClaimError();
    }
    return {
      kind: "applied",
      outcome,
      wrote,
      stale,
      after,
      carried,
      node: { id: node.id, name: node.name, ownerId: node.ownerId, createdBy: node.createdBy },
    };
  });

  if (decided.kind === "gone") return decided;
  const { outcome, node, after, carried } = decided;

  if (outcome.status === "suspected_csam") {
    // On `bg`, outside any transaction of this consumer. If it throws the caller retries: the
    // node is not locked yet and nothing of the lock was written.
    let reportId: string;
    try {
      ({ reportId } = await lockSuspectedCsam(bg, node.id, { source: outcome.csamSource ?? "system" }));
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        // Purged between the commit and the lock. A PhotoDNA detection goes back to the caller,
        // which preserves the bytes (or records it) and settles it — the job is not finished
        // here while it is owed (the purge took the job row with the node in any case).
        if (detection) return { kind: "gone", photodna: detection };
        await finish(bg.db, input.claimed, "done", {
          ...jobVerdict(input, outcome, carried),
          outcome: "replaced",
        });
        return { kind: "gone" };
      }
      throw error;
    }
    carried.effects.csamLock = reportId;
    if (detection) await settleDetection(bg, key, { outcome: "locked", nodeId: node.id });
    if (!(await finish(bg.db, input.claimed, "done", jobVerdict(input, outcome, carried)))) {
      throw new LostClaimError();
    }
    return { kind: "applied", outcome, wrote: "lock", stale: false, retry: false };
  }

  // After the commit. Each step is awaited before the message is acknowledged.
  if (after.audit) audit(bg, after.audit.action, { type: "node", id: node.id }, after.audit.meta);
  let retry = false;
  if (after.strike?.applySuspension) {
    try {
      await after.strike.applySuspension();
    } catch (error) {
      // The strike stands un-enforced: the redelivery's `done` row (or the hourly sweep) repairs it.
      captureError(error, { kind: "scan", reason: "suspension" });
      retry = true;
    }
  }
  if (after.mail) {
    const recipients = [
      node.ownerId,
      ...(node.createdBy && node.createdBy !== node.ownerId ? [node.createdBy] : []),
    ];
    const addresses = await emailsOf(bg.db, recipients);
    for (const id of recipients) {
      const to = addresses.get(id);
      if (!to) continue;
      const send = after.mail === "quarantine" ? sendQuarantineNotice : sendUploadNotIntact;
      await send(bg, { to, fileName: node.name }).catch((error: unknown) => {
        captureError(error, { kind: "scan", reason: "mail" });
      });
    }
  }
  return { kind: "applied", outcome, wrote: decided.wrote, stale: decided.stale, retry };
}
