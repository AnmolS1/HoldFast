// Uploads: a session per file, its bytes through this Worker — one PUT up to SINGLE_PUT_MAX,
// parts above it — and the completion that turns the stored object into a node.
//
//   POST   /uploads                 init: admission (ceilings, open-session cap, quota) or a resume
//   GET    /uploads/open            the caller's open sessions
//   PUT    /uploads/:id/parts/:n    one part of a multipart session
//   PUT    /uploads/:id/single      the whole file of a single session
//   POST   /uploads/:id/complete    everything re-checked, then the node
//   DELETE /uploads/:id             abort, and the reservation back
//
// Paths are relative to /api.
//
// A SESSION BELONGS TO ITS UPLOADER. Every `:id` route reads the row and answers `404 not_found`
// unless `uploaderId` is the caller — before it looks at anything else of the request. No route
// takes an owner or uploader id from the client.
//
// NOTHING IS BUFFERED. A part and a single PUT hand the request's body stream to the store with
// the length the header declared; a body of another length stores nothing.
//
// THE ADMISSION (init) is one transaction, in this order: `enforceUploadCeilings` (it takes the
// `user` row locks — this file takes none and decides no lock order), the resume lookup again,
// the open-session cap, the quota reservation, the INSERT. A refusal rolls all of it back.
//
// COMPLETE, in this order and no other (the store's own event for the object is on the queue
// before `complete()` has returned, and what the consumer finds then is the session row):
//   the body is validated (session still `open`) → the claim (`completing`) → every init check
//   again → the store's `complete` and `head` → the hash blocklist → ONE database transaction
//   (the node, the session `done`, the day's usage, the uploader's address) → the audit row, the
//   metric and the scan message. No database transaction is open across a call to the store.
//
// AN ABORT is one transaction: the reservation is released FIRST (the owner's `user` row), then
// the session leaves `open` / `completing`; when it did not, the release is rolled back.
//
// THE BLOCKLIST IS ACTED ON ONLY FOR BYTES THIS SERVER HASHED. `sha256` in the body is the
// client's word: a hit on it makes `complete` read the stored object back and hash it, and what
// happens next is decided by that hash — nobody is struck or locked on a declared one. A listed
// hash declared for other bytes is answered like any other wrong hash (the upload completes; the
// scanner finds the mismatch): the answer never says whether a value is on the list.
// AN OBJECT WHOSE HASH IS ON THE BLOCKLIST AS CSAM IS NEVER DELETED by `complete`: the lookup is
// made right after the claim, and while the declared hash says so a path that gives the upload
// up hashes the object first; one that really is listed becomes a locked node of the UPLOADER's.
// A real hit on a healthy upload writes the node where it was meant to go and hands it to
// `lockSuspectedCsam`; the caller gets the same `403` as for any other blocked content.
//
// ONE AVATAR PER USER: the transaction that makes an avatar current removes the others (a held
// one stays), so avatars — which never count against the quota — cannot pile up.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import {
  AVATAR_MAX_BYTES,
  MAX_OPEN_UPLOADS,
  MAX_PART_BYTES,
  MAX_PARTS,
  MIN_PART_BYTES,
  SINGLE_PUT_MAX,
  THUMB_SIZES,
} from "../../shared/constants";
import { UUID_PARAM } from "../../shared/ids";
import {
  CompleteUploadBody,
  InitUploadBody,
  type InitUploadResponse,
  type OpenUploadsResponse,
  type PartResponse,
  type SinglePutResponse,
} from "../../shared/schemas/upload";
import type { SessionUser } from "../auth/types";
import type { Db } from "../db/client";
import { asQueryError, LegalHoldError, QueryError } from "../db/errors";
import { uuidv7 } from "../db/ids";
import * as blocklist from "../db/queries/blocklist";
import { findByR2Key, getNode, replaceVersion } from "../db/queries/nodes";
import { assertPurgeable, deleteSubtreeRows, type DeletedRows } from "../db/queries/trash";
import { lockOwnerTree } from "../db/queries/tree";
import * as uploadIps from "../db/queries/upload-ips";
import * as sessions from "../db/queries/upload-sessions";
import { claimCompleting, countOpen, findResumable, markAborted, markDone } from "../db/queries/uploads";
import { retryOnDeadlock } from "../db/retry";
import type { Node, Upload } from "../db/schema";
import { requireVerified } from "../middleware/guards";
import { requireSwitch } from "../middleware/kill-switch";
import { readsRolledBack } from "../jobs/reconcile";
import { captureError } from "../sentry";
import { audit } from "../services/audit";
import { jsonBody } from "../services/body";
import { enforceUploadCeilings, recordUsage } from "../services/ceilings";
import { now } from "../services/clock";
import { AppError } from "../services/errors";
import { extOf, nameKeyOf, sanitizeName } from "../services/filename";
import { metric } from "../services/metrics";
import { sendOperatorCritical } from "../services/email";
import { sniff, SNIFF_PREFIX_BYTES, thumbEligible } from "../services/mime";
import { toNodeDto, toOwnAvatarDto } from "../services/node-dto";
import { requireRole, requireUpload, type Role } from "../services/permissions";
import * as quotaRows from "../db/queries/quota";
import * as quota from "../services/quota";
import { db, deps, type AppEnv } from "../services/request-context";
import { adminListOf } from "../services/signup-policy";
import { enqueueScan, lockSuspectedCsam, scanSmallObject, type ScanVerdict } from "../services/scanning";
import { avatarKey, keyFor, storage, thumbKey, type Storage, type UploadedPart } from "../services/storage";
import { addStrike } from "../services/strikes";
import { sealIp } from "../services/tokens";

export const router = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

const ID = `:id{${UUID_PARAM}}`;
const PART_NUMBER = ":n{[0-9]{1,5}}";

const HOUR_MS = 3_600_000;
/** One day per started 100 GB (decimal), never less than a day … */
const EXPIRY_STEP_BYTES = 100_000_000_000;
/** … and never more than six: the store aborts an unfinished multipart upload at seven. */
const EXPIRY_MAX_DAYS = 6;
/** Names tried for one file before a collision is given up on. */
const NAME_ATTEMPTS = 6;
/** How many "name (n)" candidates one query asks about. */
const NAME_BATCH = 50;
const MAX_NAME_LENGTH = 255;

export const REPLACE_REFUSED_MESSAGE = "This file can't be replaced right now.";
export const BLOCKED_MESSAGE = "This file can't be stored here.";

const verified: MiddlewareHandler<AppEnv> = async (c, next) => {
  requireVerified(c);
  return next();
};
const uploadsOn = requireSwitch("uploadsEnabled");

const isSingle = (session: Pick<Upload, "size">) => session.size <= SINGLE_PUT_MAX;
const modeOf = (session: Pick<Upload, "size">) => (isSingle(session) ? "single" : "multipart");

// ── small readers ───────────────────────────────────────────────────────────────────────────

/** The file cap: the `MAX_FILE_BYTES` var. Unreadable → 0, and every file is too large. */
function maxFileBytes(env: Pick<Env, "MAX_FILE_BYTES">): number {
  const value = Number(env.MAX_FILE_BYTES === "" ? Number.NaN : env.MAX_FILE_BYTES);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/**
 * The one part size issued: the `PART_BYTES` var. `validation` when it is not a whole number
 * the store's part rules and this API's own limit allow.
 */
function issuedPartBytes(env: Pick<Env, "PART_BYTES">): number {
  const value = Number(env.PART_BYTES === "" ? Number.NaN : env.PART_BYTES);
  if (!Number.isSafeInteger(value) || value < MIN_PART_BYTES || value > MAX_PART_BYTES) {
    throw new AppError("validation", "Uploads are not configured correctly.", { reason: "part_size" });
  }
  return value;
}

/** `Content-Length` as a number. `validation` when it is absent or not a plain decimal. */
function contentLength(c: Ctx): number {
  const header = c.req.header("content-length");
  if (header === undefined || !/^[0-9]{1,15}$/.test(header)) {
    throw new AppError("validation", "Content-Length is required.", { reason: "content_length" });
  }
  return Number(header);
}

function expiresAtFor(at: Date, size: number): Date {
  const days = Math.min(Math.max(Math.ceil(size / EXPIRY_STEP_BYTES), 1), EXPIRY_MAX_DAYS);
  return new Date(at.getTime() + days * 24 * HOUR_MS);
}

const accountOf = (user: SessionUser) => ({ quotaBytes: user.quotaBytes, createdAt: user.createdAt });

/** "name (n).ext", cut so that it still fits a name. A name that already ends "(m)" is counted on. */
function suffixed(name: string, n: number): string {
  const ext = extOf(name);
  const tail = ext === "" ? "" : name.slice(-ext.length - 1);
  const suffix = ` (${n})`;
  const stem = name.slice(0, name.length - tail.length).replace(/ \(\d{1,4}\)$/, "");
  return stem.slice(0, Math.max(1, MAX_NAME_LENGTH - suffix.length - tail.length)).trimEnd() + suffix + tail;
}

/** The first "name (n)" nothing live in the folder holds, counting from `from`. */
async function freeName(
  exec: Parameters<typeof sessions.takenNameKeys>[0],
  ownerId: string,
  parentId: string | null,
  name: string,
  from = 1,
): Promise<string> {
  for (let start = from; start < from + NAME_BATCH * 20; start += NAME_BATCH) {
    const candidates = Array.from({ length: NAME_BATCH }, (_, i) => suffixed(name, start + i));
    const taken = await sessions.takenNameKeys(exec, ownerId, parentId, candidates.map(nameKeyOf));
    const free = candidates.find((candidate) => !taken.has(nameKeyOf(candidate)));
    if (free) return free;
  }
  throw new AppError("conflict", "A file with that name already exists here.");
}

// ── the session of an `:id` route ───────────────────────────────────────────────────────────

/**
 * The caller's own session, or `404 not_found` — the same for a missing row, another user's,
 * and a finished one past the trim age: such a row is deleted by the trim UNLESS a hold keeps
 * it, so answering it would tell a held file from one that is gone. One statement in every case.
 */
async function loadSession(c: Ctx): Promise<Upload> {
  const user = requireVerified(c);
  const session = await sessions.get(db(c), c.req.param("id") ?? "");
  if (!session || session.uploaderId !== user.id || sessions.pastTrim(session, now(c))) {
    throw new AppError("not_found");
  }
  return session;
}

/** `409 conflict` unless the session still takes bytes: `open` and not past `expiresAt`. */
function assertOpen(c: Ctx, session: Upload): void {
  if (session.status !== "open" || session.expiresAt.getTime() <= now(c).getTime()) {
    throw new AppError("conflict", "This upload is no longer open.");
  }
}

// ── where a file may go ─────────────────────────────────────────────────────────────────────

/** `viewRootId`: where the caller's view of the tree starts — what an answer is rooted at. */
type Place = { ownerId: string; role: Role; shareRootId: string | null; viewRootId: string | null };

/**
 * The init check on the parent, run again at complete: the caller may upload there (an editor or
 * the owner, and allowed to add files), and it is a folder that is not in the trash. `404` when
 * the caller has no access, also to a hidden folder.
 */
async function placeFor(c: Ctx, user: SessionUser, parentId: string | null): Promise<Place> {
  if (parentId === null) {
    await requireUpload(c, null);
    return OWN_ROOT(user);
  }
  // `requireUpload`'s rule, with the trash asked by the same statements as the role: a folder in
  // the trash (itself or above) costs exactly what an unknown id costs.
  const access = await requireRole(c, parentId, "editor", { notTrashed: true });
  if (access.role !== "owner" && !access.canUpload) {
    throw new AppError("forbidden", undefined, { reason: "upload_not_allowed" });
  }
  const parent = await getNode(db(c), parentId);
  if (!parent || parent.kind !== "folder" || parent.system !== null) throw new AppError("not_found");
  return {
    ownerId: parent.ownerId,
    role: access.role,
    shareRootId: access.shareRootId,
    viewRootId: access.viewRootId,
  };
}

/** The caller's own top level — also where an avatar "is". */
const OWN_ROOT = (user: SessionUser): Place => ({
  ownerId: user.id,
  role: "owner",
  shareRootId: null,
  viewRootId: null,
});

const replaceRefused = () => new AppError("conflict", REPLACE_REFUSED_MESSAGE);

/**
 * The replace guard, at init and again at complete. A target the caller cannot see at all — an
 * unknown id, a taken-down or locked file — is `404 not_found`, thrown by `requireRole`. Every
 * other reason is the same `409` with the same words: a hold is never told apart from a scan.
 */
async function replaceGuard(
  c: Ctx,
  target: { replaceNodeId: string; parentId: string | null; ownerId: string },
): Promise<Node> {
  const access = await requireRole(c, target.replaceNodeId, "viewer");
  const node = await getNode(db(c), target.replaceNodeId);
  if (!node) throw new AppError("not_found");
  const allowed =
    access.role !== "viewer" &&
    node.kind === "file" &&
    node.system === null &&
    node.parentId === target.parentId &&
    node.ownerId === target.ownerId &&
    node.deletedAt === null &&
    (node.scanStatus === "clean" || node.scanStatus === "skipped" || node.scanStatus === "error");
  if (!allowed) throw replaceRefused();
  try {
    await assertPurgeable(db(c), [node.id]);
  } catch (error) {
    if (error instanceof LegalHoldError) throw replaceRefused();
    throw error;
  }
  return node;
}

// ── giving a session up ────────────────────────────────────────────────────────────────────

const NOT_ABORTED = Symbol("not aborted");

/**
 * FAIL SAFE: a path gives an upload up (and so destroys its bytes) only on a DEFINITIVE answer —
 * the place or the target is not there for the caller, the caller may not, the state forbids
 * it, the request is invalid. An app error or a query error of one of these codes is one; a
 * connection error, a deadlock after its retries, a timeout or a store failure is not: the
 * session stays `completing` with its key, for the client's retry or the stale-upload job.
 */
const DEFINITIVE = new Set<string>(["not_found", "forbidden", "conflict", "validation"]);
function definitive(error: unknown): boolean {
  const code = error instanceof AppError ? error.code : asQueryError(error)?.code;
  return code !== undefined && DEFINITIVE.has(code);
}

/**
 * The database half of an abort, one transaction: the reservation back, then the session
 * `aborted` and its part rows gone. `open`: only a session nobody is completing (a `DELETE`);
 * `claimed`: the session this request has claimed. False — and nothing changed — when the
 * session was not in that state. `keepReservation`: the bytes stay counted (they became a node
 * of the same owner).
 */
async function releaseAndAbort(
  exec: Db,
  session: Upload,
  state: "open" | "claimed",
  opts: { keepReservation?: boolean } = {},
): Promise<boolean> {
  try {
    await exec.transaction(async (tx) => {
      if (session.purpose === "file" && !opts.keepReservation) {
        await quota.release(tx, session.ownerId, session.size);
      }
      const aborted =
        state === "open"
          ? await sessions.abortOpen(tx, session.id, session.uploaderId)
          : await markAborted(tx, session.id);
      if (!aborted) throw NOT_ABORTED;
    });
    return true;
  } catch (error) {
    if (error === NOT_ABORTED) return false;
    throw error;
  }
}

/**
 * Removes what a given-up session left in the store: the unfinished multipart upload, or the
 * object. Best effort — the database is already right, and what stays behind is unreferenced.
 * While the database reads as rolled back (a restore — jobs/reconcile.ts, the detector) nothing
 * is removed: it stays unreferenced, for the orphan sweep once the rollback is cleared.
 */
async function discardStored(c: Ctx, session: Upload, assembled: boolean): Promise<void> {
  if (await readsRolledBack(c.env, db(c))) return;
  const store = storage(c.env);
  try {
    if (session.r2UploadId && !assembled) {
      await store.abort(store.resumeMultipart(session.r2Key, session.r2UploadId));
    } else {
      await store.delete([session.r2Key]);
    }
  } catch (error) {
    captureError(error, { kind: "upload_discard" });
    metric("error", { kind: "upload_discard" });
  }
}

/** What the server found when it hashed the stored object. */
type Verified = { sha256: string; hit: Awaited<ReturnType<typeof blocklist.lookup>> };

/**
 * Complete gives the claimed session up: reservation released, session `aborted`, and what it
 * stored removed — EXCEPT bytes the server itself has matched against the blocklist as CSAM.
 * Those are never deleted: they are preserved and locked (`preserveCsam`).
 *
 * `verified`: the server's hash and what it is listed as, when this request has computed it.
 * `declaredCsam` without `verified`: the declared hash is listed as CSAM and the object has not
 * been hashed yet — an object that exists is hashed here first. A declared hash alone keeps
 * nothing (bytes kept on a client's word would be storage outside every quota), and an
 * unfinished multipart upload has no object: it is aborted.
 */
async function abandonClaimed(
  c: Ctx,
  session: Upload,
  opts: { assembled: boolean; declaredCsam: boolean; verified?: Verified | null; reason: string },
): Promise<void> {
  let csamSha: string | null = opts.verified?.hit?.reason === "csam" ? opts.verified.sha256 : null;
  if (!opts.verified && opts.declaredCsam && (opts.assembled || !session.r2UploadId)) {
    const actual = await storedSha256(storage(c.env), session.r2Key);
    if (actual !== null && (await blocklist.lookup(db(c), actual))?.reason === "csam") csamSha = actual;
  }
  metric("upload", { outcome: "aborted", kind: modeOf(session), reason: opts.reason });
  if (csamSha !== null) {
    await preserveAndEnd(c, session, csamSha);
    return;
  }
  await releaseAndAbort(db(c), session, "claimed");
  await discardStored(c, session, opts.assembled);
}

/**
 * The suspected-CSAM handler, for a node this route has just written ALREADY LOCKED. It files
 * the report, holds the owner and every uploader, pauses links and — through the request's
 * deferred work — records and announces the lock. If it fails the node is still hidden and
 * held (nothing can turn it `clean`: a verdict is written only to a `pending` node); the
 * failure is recorded and the operators are told by the session's id, and the handler completes
 * the job when it is called again for the node.
 */
async function lockOrRecord(c: Ctx, nodeId: string, session: Upload): Promise<void> {
  try {
    await lockSuspectedCsam(deps(c), nodeId, { source: "system" });
  } catch (error) {
    captureError(error, { kind: "upload_csam_lock" });
    metric("error", { kind: "upload_csam_lock" });
    audit(c, "upload.csam_lock_owed", { type: "node", id: nodeId }, { uploadId: session.id });
    await tellOperators(c, session);
  }
}

/** How the critical operator alert is sent. Exported for the tests that make it fail. */
export const operatorAlert = { send: sendOperatorCritical };

/**
 * The critical operator alert, by the session's id, to every operator. Its own failure is logged,
 * never thrown: one address failing does not stop the next, and nothing fails the request.
 */
async function tellOperators(c: Ctx, session: Upload): Promise<void> {
  try {
    for (const to of adminListOf(c.env).addresses) {
      await operatorAlert
        .send(deps(c), { to, event: "csam_lock", id: session.id })
        .catch((error: unknown) => captureError(error, { kind: "upload_csam_alert" }));
    }
  } catch (error) {
    captureError(error, { kind: "upload_csam_alert" });
  }
}

/**
 * Verified CSAM bytes whose node could not be written: the NODE IS OWED. The session is left
 * `completing` — its key referenced, its declared (listed) hash on it since the claim — which
 * keeps the object from every sweep until the repair (T22) writes the node; the audit row comes
 * first, then the operators are told by the session's id.
 */
async function oweNode(c: Ctx, session: Upload, error: unknown): Promise<void> {
  captureError(error, { kind: "upload_csam_preserve" });
  audit(c, "upload.csam_node_owed", { type: "upload", id: session.id }, { nodeId: session.nodeId });
  metric("upload", { outcome: "csam_node_owed", kind: modeOf(session) });
  await tellOperators(c, session);
}

/** `suspected_csam` and held from the row's first commit — never `pending`, not for an instant. */
const LOCKED = { scanStatus: "suspected_csam", legalHold: true } as const;

/**
 * An upload that complete gives up — or whose place or session is gone — whose stored bytes the
 * server has hashed and found on the blocklist as CSAM. They are evidence now: never deleted,
 * and not left without a row (the orphan sweep would remove them). The object becomes a node of
 * the UPLOADER's own — at their top level, whatever folder the upload was meant for: the
 * folder's owner is not held for something uploaded into a folder the uploader no longer has —
 * written already locked, and the one shared handler does the rest.
 *
 * The bytes are counted where the row is: an owner's own reservation stays (the meter does not
 * move); an editor's are reserved on the editor in the transaction that writes the node, and
 * the folder owner's reservation goes back. (An editor with no room left is not refused: the
 * node is written uncounted and the next reconcile counts it.)
 *
 * There is no "object kept without a node": the uploader's row exists while their session does
 * (an account purge removes the sessions first; the lock's hold stops the purge). If the node's
 * transaction itself fails, the session is NOT ended — it stays `completing`, its key referenced
 * and its declared (listed) hash on it from the claim, which is what keeps the object from every
 * sweep — and the operators are told by the session's id; the node is still owed.
 */
async function preserveAndEnd(c: Ctx, session: Upload, sha256: string): Promise<void> {
  const uploader = requireVerified(c);
  const own = session.ownerId === uploader.id;
  let written = false;
  try {
    const store = storage(c.env);
    const size = (await store.head(session.r2Key))?.size ?? session.size;
    const sealed = await sealIp(c.env, c.get("ip"));
    const values: NodeValues = {
      ...nodeValues(session, uploader, sha256, session.replaceNodeId === null ? session.nodeId : uuidv7()),
      ...LOCKED,
      ownerId: uploader.id,
      parentId: null,
      size,
    };
    const node = await retryOnDeadlock(db(c), async (tx) => {
      // The `user` row before the node.
      if (!own && session.purpose === "file") await quotaRows.reserve(tx, uploader.id, size);
      const row = await insertNamed(tx, values);
      await uploadIps.record(tx, {
        nodeId: row.id,
        versionId: session.versionId,
        uploaderId: uploader.id,
        ipEncrypted: sealed.ciphertext,
        iv: sealed.iv,
        keyVersion: sealed.keyVersion,
      });
      return row;
    });
    written = true;
    audit(c, "upload.csam_preserved", { type: "node", id: node.id }, { uploadId: session.id });
    metric("upload", { outcome: "csam_preserved", kind: modeOf(session) });
    await lockOrRecord(c, node.id, session);
  } catch (error) {
    if (written) throw error;
    await oweNode(c, session, error);
    return;
  }
  // The node is written: the session ends (it may already be gone — a purge of its folder).
  await releaseAndAbort(db(c), session, "claimed", { keepReservation: own });
}

// ── init ────────────────────────────────────────────────────────────────────────────────────

const OPEN_UPLOADS = "open_uploads";

/**
 * A multipart session with its upload in the store. Init creates it right after the admission's
 * commit; a session that was left without one (the invocation ended in between) gets it here,
 * when the same file is initialised again. Whichever request records its id first wins — the
 * other's upload is aborted. If the store refuses, nothing is given up (see below).
 */
async function withMultipart(c: Ctx, session: Upload): Promise<Upload> {
  if (isSingle(session) || session.r2UploadId !== null) return session;
  const store = storage(c.env);
  // A store failure gives nothing up: the session stays `open` without its store upload, and
  // the next init of the same file (a retry) creates one.
  const mpu = await store.createMultipart(session.r2Key);
  if (await sessions.setR2UploadId(db(c), session.id, mpu.uploadId)) {
    return { ...session, r2UploadId: mpu.uploadId };
  }
  // Not recorded: the session was aborted meanwhile, or another init recorded its own first.
  // (Not while the database reads as rolled back: the store ends an unfinished upload at 7 days.)
  if (!(await readsRolledBack(c.env, db(c)))) {
    await store.abort(mpu).catch((error: unknown) => captureError(error, { kind: "upload_discard" }));
  }
  const current = await sessions.get(db(c), session.id);
  if (current?.status !== "open" || current.r2UploadId === null) {
    throw new AppError("conflict", "This upload is no longer open.");
  }
  return current;
}

async function initResponse(c: Ctx, session: Upload, fallbackPartBytes: number): Promise<InitUploadResponse> {
  const parts = isSingle(session) ? [] : await sessions.listParts(db(c), session.id);
  return {
    uploadId: session.id,
    mode: modeOf(session),
    partBytes: session.partBytes ?? fallbackPartBytes,
    partCount: session.partCount ?? 1,
    resumedParts: parts.map((part) => ({ n: part.n, etag: part.etag })),
    finalName: session.name,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** `409 conflict` for a taken name; `details.existingId` only for a FILE the caller may see. */
async function nameTaken(c: Ctx, holder: { id: string; kind: "file" | "folder" }): Promise<AppError> {
  const message = "A file or folder with that name already exists here.";
  if (holder.kind !== "file") return new AppError("conflict", message);
  try {
    await requireRole(c, holder.id, "viewer");
  } catch (error) {
    if (error instanceof AppError) return new AppError("conflict", message);
    throw error;
  }
  return new AppError("conflict", message, { existingId: holder.id });
}

router.post("/uploads", verified, uploadsOn, async (c) => {
  const user = requireVerified(c);
  const body = InitUploadBody.parse(await jsonBody(c));
  if (body.size > maxFileBytes(c.env)) throw new AppError("file_too_large");
  const name = sanitizeName(body.name);
  const partBytes = issuedPartBytes(c.env);
  const avatar = body.purpose === "avatar";
  const replaceNodeId = body.replaceNodeId ?? null;

  if ((body.onConflict === "replace") !== (replaceNodeId !== null)) {
    throw new AppError("validation", "replaceNodeId goes with onConflict: replace.");
  }
  if (avatar) {
    if (body.parentId !== null || replaceNodeId !== null) {
      throw new AppError("validation", "An avatar has no folder and replaces nothing.");
    }
    if (body.size > AVATAR_MAX_BYTES) throw new AppError("file_too_large");
    if (!body.mimeDeclared.toLowerCase().startsWith("image/")) {
      throw new AppError("validation", "An avatar is an image.");
    }
  }
  const partCount = body.size <= SINGLE_PUT_MAX ? 1 : Math.ceil(body.size / partBytes);
  if (partCount > MAX_PARTS) throw new AppError("file_too_large");

  const place: Place = avatar ? OWN_ROOT(user) : await placeFor(c, user, body.parentId);
  const uploaderIsOwner = place.ownerId === user.id;

  // Resume first: an open session for the same local file is answered as it is. Nothing is
  // reserved, counted or created on this path.
  const match = {
    uploaderId: user.id,
    parentId: body.parentId,
    nameKey: nameKeyOf(name),
    size: body.size,
    fileLastModified: new Date(body.fileLastModified),
    purpose: body.purpose,
    replaceNodeId,
  };
  const open = await findResumable(db(c), match);
  if (open) return c.json(await initResponse(c, await withMultipart(c, open), partBytes), 200);

  let finalName = name;
  if (replaceNodeId !== null) {
    finalName = (await replaceGuard(c, { replaceNodeId, parentId: body.parentId, ownerId: place.ownerId }))
      .name;
  } else if (!avatar) {
    const holder = await sessions.nameHolder(db(c), place.ownerId, body.parentId, nameKeyOf(name));
    if (holder && body.onConflict === "fail") throw await nameTaken(c, holder);
    if (holder) finalName = await freeName(db(c), place.ownerId, body.parentId, name);
  }

  const ownerAccount = uploaderIsOwner ? accountOf(user) : await sessions.ownerAccount(db(c), place.ownerId);
  if (!ownerAccount) throw new AppError("not_found");
  const nodeId = replaceNodeId ?? uuidv7();
  const versionId = uuidv7();
  const r2Key = avatar ? avatarKey(user.id, nodeId) : keyFor(place.ownerId, nodeId, versionId);
  const at = now(c);
  // The uploader's address, sealed as for `upload_ips`: kept on the session while it is unfinished,
  // for the repair sweep that may finish it without a request (T22). Sealed here, outside the
  // admission: its callback is database statements only.
  const sealedIp = await sealIp(c.env, c.get("ip"));

  // The admission. Database statements only: a transaction Postgres ends as a deadlock victim is
  // run again (a refusal throws, and is never run twice).
  const admit = () =>
    retryOnDeadlock(db(c), async (tx) => {
      await enforceUploadCeilings(
        c,
        {
          owner: { id: place.ownerId, account: ownerAccount },
          ...(uploaderIsOwner ? {} : { editor: { id: user.id, account: accountOf(user) } }),
        },
        { bytes: body.size, count: 1 },
        { tx },
      );
      // Under the uploader's row lock: the same file initialised twice at once is one session.
      const again = await findResumable(tx, match);
      if (again) return { session: again, created: false };
      if ((await countOpen(tx, user.id)) >= MAX_OPEN_UPLOADS) {
        throw new AppError("ceiling_exceeded", "Too many uploads are in progress.", { kind: OPEN_UPLOADS });
      }
      if (!avatar) await quota.reserve(tx, place.ownerId, body.size, { forEditor: !uploaderIsOwner });
      const session = await sessions.create(tx, {
        ownerId: place.ownerId,
        uploaderId: user.id,
        parentId: body.parentId,
        nodeId,
        versionId,
        replaceNodeId,
        name: finalName,
        nameKey: match.nameKey,
        size: body.size,
        mimeDeclared: body.mimeDeclared,
        r2Key,
        partBytes,
        partCount,
        purpose: body.purpose,
        fileLastModified: match.fileLastModified,
        expiresAt: expiresAtFor(at, body.size),
        sealedIp,
      });
      return { session, created: true };
    });
  let admitted: Awaited<ReturnType<typeof admit>>;
  try {
    admitted = await admit();
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "ceiling_exceeded") throw error;
    // Counted here, after the transaction: its callback is database statements only.
    if (error.details?.kind === OPEN_UPLOADS) {
      metric("ceiling", { kind: OPEN_UPLOADS, outcome: "refused", reason: "count" });
    }
    // The same file initialised twice at once, with room for one: the second was refused while
    // the first was being written. It is a resume, not a refusal.
    const raced = await findResumable(db(c), match);
    if (!raced) throw error;
    admitted = { session: raced, created: false };
  }
  const session = await withMultipart(c, admitted.session);
  if (admitted.created) metric("upload", { outcome: "init", kind: modeOf(session) });
  return c.json(await initResponse(c, session, partBytes), admitted.created ? 201 : 200);
});

// ── open sessions ───────────────────────────────────────────────────────────────────────────

router.get("/uploads/open", verified, async (c) => {
  const user = requireVerified(c);
  const open = await sessions.listOpen(db(c), user.id);
  const body: OpenUploadsResponse = open.map(({ session, uploadedParts }) => ({
    uploadId: session.id,
    parentId: session.parentId,
    name: session.name,
    size: session.size,
    partBytes: session.partBytes ?? session.size,
    partCount: session.partCount ?? 1,
    uploadedParts,
    fileLastModified: session.fileLastModified?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
    expiresAt: session.expiresAt.toISOString(),
  }));
  return c.json(body);
});

// ── bytes ───────────────────────────────────────────────────────────────────────────────────

router.put(`/uploads/${ID}/parts/${PART_NUMBER}`, verified, uploadsOn, async (c) => {
  const session = await loadSession(c);
  assertOpen(c, session);
  if (isSingle(session)) throw new AppError("validation", "This upload takes one PUT, not parts.");
  const partBytes = session.partBytes ?? 0;
  const partCount = session.partCount ?? 0;
  const n = Number(c.req.param("n"));
  if (!Number.isInteger(n) || n < 1 || n > partCount) throw new AppError("validation", "No such part.");
  const length = contentLength(c);
  // Before the body is touched; the next check implies it for a session this API issued.
  if (length > MAX_PART_BYTES) throw new AppError("validation", "The part is too large.");
  // Uniform parts: the store checks its part rules only when the upload is completed.
  const expected = n < partCount ? partBytes : session.size - (partCount - 1) * partBytes;
  if (length !== expected) throw new AppError("validation", "The part is not the size this upload uses.");
  const body = c.req.raw.body;
  if (!body) throw new AppError("validation", "The part is empty.");
  // Init stores the multipart id right after its commit; until then there is nowhere to put a part.
  if (!session.r2UploadId) throw new AppError("conflict", "This upload is not ready yet.");

  const store = storage(c.env);
  let part: UploadedPart;
  try {
    part = await store.uploadPart(store.resumeMultipart(session.r2Key, session.r2UploadId), n, body, length);
  } catch (error) {
    // Aborted or completed while the bytes were on their way: the store has no such upload.
    const current = await sessions.get(db(c), session.id);
    if (current?.status !== "open") throw new AppError("conflict", "This upload is no longer open.");
    // The body was not as long as it said (or the client went away): the stream's own error, a
    // TypeError — the store's failures are plain Errors with its code. Nothing was stored.
    if (error instanceof TypeError) throw bodyNotAsDeclared();
    throw error;
  }
  if (!(await sessions.upsertPart(db(c), session.id, { n, etag: part.etag, size: length }))) {
    throw new AppError("conflict", "This upload is no longer open.");
  }
  const answer: PartResponse = { n, etag: part.etag };
  return c.json(answer);
});

const bodyNotAsDeclared = () =>
  new AppError("validation", "The body is not as long as its Content-Length says.", {
    reason: "content_length",
  });

/** Thrown inside the body stream when the gate is closed: the store then keeps nothing. */
class GateClosed extends Error {}

router.put(`/uploads/${ID}/single`, verified, uploadsOn, async (c) => {
  const session = await loadSession(c);
  assertOpen(c, session);
  if (!isSingle(session)) throw new AppError("validation", "This upload takes parts, not one PUT.");
  const length = contentLength(c);
  if (length !== session.size) throw new AppError("validation", "The body is not the size of this upload.");
  const source = c.req.raw.body;
  if (!source && session.size > 0) throw new AppError("validation", "The body is empty.");

  // THE GATE. The key of a session never changes and the store cannot be told "only if absent",
  // so a PUT may FINISH only while the session is open and no other PUT is finishing. The store
  // has the whole object once it has `size` bytes, so the gate stands in front of the LAST CHUNK:
  // closed, the stream is errored one chunk short and nothing is stored. After `complete` has
  // claimed the session no PUT gets through — what it looked at is what is scanned.
  const token = uuidv7();
  const gate: { state: "untried" | "passed" | "closed" } = { state: "untried" };
  const passGate = async () => {
    gate.state = (await sessions.beginSinglePut(db(c), session.id, token)) ? "passed" : "closed";
    if (gate.state === "closed") throw new GateClosed();
  };
  const store = storage(c.env);
  let stored: { etag: string };
  // Bytes of the body that have arrived. An empty file has none to wait for.
  let seen = session.size === 0 ? 0 : -1;
  try {
    if (source && session.size > 0) {
      seen = 0;
      const gated = source.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            seen += chunk.byteLength;
            if (seen >= session.size && gate.state === "untried") await passGate();
            controller.enqueue(chunk);
          },
        }),
      );
      // No hash in the object's metadata: it is not verified yet.
      stored = await store.put(session.r2Key, gated, { size: session.size });
    } else {
      await passGate();
      stored = await store.put(session.r2Key, new Uint8Array(0), { size: 0 });
    }
  } catch (error) {
    // The store failed after the gate: the marker goes, so that the client can try again.
    if (gate.state === "passed") await sessions.clearSinglePut(db(c), session.id, token);
    // A body shorter or longer than it said (or a client that went away): nothing was stored.
    if (gate.state !== "closed" && seen !== session.size) throw bodyNotAsDeclared();
    if (gate.state === "closed") {
      throw new AppError("conflict", "This upload is no longer open, or is being written.");
    }
    throw error;
  }
  if (!(await sessions.finishSinglePut(db(c), session.id, token, { etag: stored.etag, size: length }))) {
    // Aborted while the store was finishing the object: nothing references what was just written.
    if ((await sessions.get(db(c), session.id))?.status === "aborted") await discardStored(c, session, true);
    throw new AppError("conflict", "This upload is no longer open.");
  }
  const answer: SinglePutResponse = { etag: stored.etag };
  return c.json(answer);
});

// ── complete ────────────────────────────────────────────────────────────────────────────────

const blocked = () => new AppError("forbidden", BLOCKED_MESSAGE, { reason: "blocked_content" });
/** One answer for "what is stored is not what this upload declared" — a size, or a hash. */
const notAsDeclared = () => new AppError("validation", "What was uploaded is not what this upload declared.");

type NodeValues = sessions.NewNode;

/** Inserts the node under its session's name, or under the next free "name (n)". */
async function insertNamed(
  tx: Parameters<typeof sessions.insertFileNode>[0],
  values: NodeValues,
): Promise<Node> {
  let name = values.name;
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt++) {
    const node = await sessions.insertFileNode(tx, {
      ...values,
      name,
      nameKey: nameKeyOf(name),
      ext: extOf(name),
    });
    if (node) return node;
    // A finished upload is never failed for a name that was taken meanwhile.
    name = await freeName(tx, values.ownerId, values.parentId ?? null, values.name);
  }
  throw new AppError("conflict", "A file with that name already exists here.");
}

/**
 * What the upload becomes:
 *   replace   a new version of the session's replace target;
 *   new       a row with these values;
 *   avatar    a row with these values; `current`: it becomes the user's avatar and every other
 *             avatar node of theirs goes — otherwise only the ones that are not their avatar.
 */
type Becomes =
  | { as: "replace"; sha256: string }
  | { as: "new"; values: NodeValues }
  | { as: "avatar"; values: NodeValues; current: boolean };

type Finished = {
  node: Node;
  previousVersionId: string | null;
  /** Avatar nodes removed in the transaction: their objects are deleted after it. */
  removed: DeletedRows[];
  /** Avatar nodes a hold kept. */
  keptHeld: number;
};

class ReplaceRefused extends Error {}
/** Thrown by `refuseBlocked` when the entry it was to act on has become a CSAM entry. */
export class RaisedToCsam extends Error {}

/**
 * The one database transaction of a completion. DATABASE STATEMENTS ONLY: it runs through
 * `retryOnDeadlock` and may run several times.
 */
async function finish(
  c: Ctx,
  session: Upload,
  uploader: SessionUser,
  becomes: Becomes,
  sealed: Awaited<ReturnType<typeof sealIp>>,
  declaredSha256: string,
): Promise<Finished> {
  return retryOnDeadlock(db(c), async (tx) => {
    let node: Node;
    let previousVersionId: string | null = null;
    const removed: DeletedRows[] = [];
    let keptHeld = 0;
    if (becomes.as === "replace") {
      // First: it takes the owner's `user` row, then the node.
      try {
        ({ previousVersionId } = await replaceVersion(tx, session.nodeId, {
          r2Key: session.r2Key,
          versionId: session.versionId,
          size: session.size,
          sha256: becomes.sha256,
          createdBy: uploader.id,
        }));
      } catch (error) {
        // `replaceVersion`'s own refusals (not found, pending, blocked) — every one definitive, thrown
        // by its checks and never by a statement. Anything else is not a refusal.
        if (error instanceof QueryError) throw new ReplaceRefused();
        throw error;
      }
      const replaced = await getNode(tx, session.nodeId);
      if (!replaced) throw new ReplaceRefused();
      node = replaced;
    } else {
      if (becomes.as === "avatar") {
        // ONE AVATAR PER USER. First in the transaction: the owner's tree lock — taken here so
        // that two avatar uploads at once run one after the other and the second sees the
        // first's node — then (in the delete) the `user` row, then the nodes. A held one stays.
        await lockOwnerTree(tx, uploader.id);
        const others = await sessions.otherAvatarNodes(tx, uploader.id, { keepCurrent: !becomes.current });
        for (const id of others) {
          try {
            removed.push(await deleteSubtreeRows(tx, id));
          } catch (error) {
            if (!(error instanceof LegalHoldError)) throw error;
            keptHeld += 1;
          }
        }
        if (becomes.current) await sessions.setAvatarNode(tx, uploader.id, becomes.values.id!);
      }
      node = await insertNamed(tx, becomes.values);
    }
    if (session.purpose === "file") await quota.commit(tx, session.ownerId, session.size);
    await sessions.setDeclaredHash(tx, session.id, declaredSha256);
    // Not `completing` any more: the stale-upload job gave this session up. Nothing is kept.
    if (!(await markDone(tx, session.id))) throw new AppError("conflict", "This upload is no longer open.");
    // A charge, not an enforcement: these bytes were counted as open work until this commit.
    await recordUsage(c, "upload_user", session.ownerId, { bytes: session.size, count: 1 }, { tx });
    if (session.ownerId !== uploader.id) {
      await recordUsage(c, "upload_editor", uploader.id, { bytes: session.size }, { tx });
    }
    await uploadIps.record(tx, {
      nodeId: node.id,
      versionId: session.versionId,
      uploaderId: uploader.id,
      ipEncrypted: sealed.ciphertext,
      iv: sealed.iv,
      keyVersion: sealed.keyVersion,
    });
    return { node, previousVersionId, removed, keptHeld };
  });
}

function nodeValues(session: Upload, uploader: SessionUser, sha256: string, id = session.nodeId): NodeValues {
  return {
    id,
    ownerId: session.ownerId,
    createdBy: uploader.id,
    parentId: session.parentId,
    kind: "file",
    name: session.name,
    nameKey: nameKeyOf(session.name),
    ext: extOf(session.name),
    size: session.size,
    mimeDeclared: session.mimeDeclared,
    r2Key: session.r2Key,
    versionId: session.versionId,
    sha256,
    scanStatus: "pending",
    ...(session.purpose === "avatar" ? { system: "avatar" } : {}),
  };
}

/**
 * The avatar path: no notification is sent for a key outside `u/`, so the object is read back
 * (at most AVATAR_MAX_BYTES) and scanned here, and the node is written with its verdict.
 */
async function avatarVerdict(
  store: Storage,
  env: Env,
  session: Upload,
): Promise<{ verdict: ScanVerdict; mimeSniffed: string }> {
  const read = await store.get(session.r2Key);
  if (read?.kind !== "body") throw new Error("upload: the avatar object is gone");
  const bytes = new Uint8Array(await read.object.arrayBuffer());
  const verdict = await scanSmallObject(env, bytes);
  return { verdict, mimeSniffed: await sniff(bytes.subarray(0, SNIFF_PREFIX_BYTES), session.name) };
}

/**
 * The SHA-256 of the object as it is stored, lower-case hex — streamed through the runtime's
 * digest, never held in memory. Null when there is no such object.
 */
export async function storedSha256(store: Storage, key: string): Promise<string | null> {
  const read = await store.get(key);
  if (read?.kind !== "body") return null;
  const digest = new crypto.DigestStream("SHA-256");
  await read.object.body.pipeTo(digest);
  return Array.from(new Uint8Array(await digest.digest), (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

/**
 * Blocked content that is not CSAM: the object is deleted, the reservation released, the session
 * aborted, and the UPLOADER gets a strike — one per content, however often it is tried. Always
 * answers the same `403`. `sha256` is the hash of the stored bytes, computed here — never the
 * client's word. Exported for the test that runs it twice for one session.
 */
export async function refuseBlocked(
  c: Ctx,
  session: Upload,
  reason: "malware" | "dmca" | "admin",
  sha256: string,
): Promise<never> {
  // Asked again right before the delete: a lock elsewhere may have raised this entry to CSAM
  // since the request read it, and such bytes are never deleted.
  if ((await blocklist.lookup(db(c), sha256))?.reason === "csam") throw new RaisedToCsam();
  // While the database reads as rolled back the object is kept (unreferenced: the orphan sweep's
  // once the rollback is cleared); everything else — and the answer — is as usual.
  if (!(await readsRolledBack(c.env, db(c)))) await storage(c.env).delete([session.r2Key]);
  if (await releaseAndAbort(db(c), session, "claimed")) {
    audit(c, "upload.blocked", { type: "upload", id: session.id }, { reason, nodeId: session.nodeId });
    metric("upload", { outcome: "blocked", kind: modeOf(session), reason });
  }
  try {
    await addStrike(deps(c), {
      userId: session.uploaderId,
      kind: reason === "admin" ? "abuse" : reason,
      nodeId: session.nodeId,
      sha256,
    });
  } catch (error) {
    // The suspension step failed: what was done stays done, and the hourly sweep completes it.
    captureError(error, { kind: "upload_strike" });
    metric("error", { kind: "upload_strike" });
  }
  throw blocked();
}

/**
 * After the commit: what the removed avatar nodes left in the store. Best effort. Nothing while
 * the database reads as rolled back (the orphan sweep's once it is cleared).
 */
async function discardRemoved(c: Ctx, store: Storage, removed: DeletedRows[]): Promise<void> {
  if (await readsRolledBack(c.env, db(c))) return;
  try {
    await store.delete(removed.flatMap((rows) => rows.r2Keys));
    for (const prefix of removed.flatMap((rows) => rows.thumbPrefixes)) await store.deletePrefix(prefix);
  } catch (error) {
    // Unreferenced from here on: the orphan sweep's.
    captureError(error, { kind: "upload_discard" });
    metric("error", { kind: "upload_discard" });
  }
}

const stillCompleting = () =>
  new AppError("conflict", "This upload is being completed.", { state: "completing" });
/** The ONE answer for a session that takes nothing more — given up, expired, or whose node is not there for the caller. */
const noLongerOpen = () => new AppError("conflict", "This upload is no longer open.");

/**
 * The node a session wrote, as far as the caller may see it NOW: null when it is hidden (taken
 * down, locked), in the trash, deleted, replaced by a later version, never written (a refused
 * upload) or out of the caller's reach — never told apart, not even by the work done: the SAME
 * reads run in every case (the node by key, then the visibility read on that node or, when there
 * is none, on the id the session reserved), so each costs the statements of every other.
 * `access` is null for the caller's own avatar.
 */
async function sessionNode(
  c: Ctx,
  user: SessionUser,
  session: Upload,
): Promise<{
  node: Node;
  access: { role: Role; shareRootId: string | null; viewRootId: string | null } | null;
} | null> {
  const node = await findByR2Key(db(c), session.r2Key);
  let access: Awaited<ReturnType<typeof requireRole>> | null = null;
  try {
    access = await requireRole(c, node?.id ?? session.nodeId, "viewer", { notTrashed: true });
  } catch (error) {
    if (!(error instanceof AppError && error.code === "not_found")) throw error;
  }
  if (!node) return null;
  if (node.system === "avatar") {
    const mine = node.ownerId === user.id && node.takedownAt === null && node.scanStatus !== "suspected_csam";
    return mine ? { node, access: null } : null;
  }
  return access ? { node, access } : null;
}

/**
 * A complete of a session that is already `done`: the answer the first one gave, and NOTHING
 * done a second time — no node, no audit row, no usage, no scan message, no strike, no lock,
 * and neither the store nor the blocklist is asked again. Everything else — a body that is not
 * what completed, a node that is not there for the caller — is the one plain `409` a given-up
 * session answers: a file that was hidden is not told from one that was deleted, nor a locked
 * upload from a refused one.
 */
async function completedAgain(c: Ctx, user: SessionUser, session: Upload, body: CompleteUploadBody) {
  const parts = isSingle(session) ? [] : await sessions.listParts(db(c), session.id);
  const claimed = new Map(body.parts.map((part) => [part.n, part.etag]));
  // An aborted session's part rows are gone with it: only its declared hash is compared.
  const sameParts =
    session.status === "aborted" ||
    (body.parts.length === parts.length &&
      claimed.size === parts.length &&
      parts.every((part) => claimed.get(part.n) === part.etag));
  // The reads come before every decision: a body that does not match, a refused upload and a
  // node that is not there all cost what a locked upload's repeat costs.
  const found = await sessionNode(c, user, session);
  if (session.expectedSha256 !== body.sha256 || !sameParts) throw noLongerOpen();
  if (!found || session.status === "aborted") throw noLongerOpen();
  if (!found.access) return c.json(await toOwnAvatarDto(db(c), found.node, { viewerId: user.id }), 200);
  const dto = await toNodeDto(db(c), found.node, {
    viewerId: user.id,
    role: found.access.role,
    shareRootId: found.access.viewRootId,
  });
  return c.json(dto, 200);
}

// Uploads switched off: refused here, BEFORE the claim — the session stays open and is completed
// when the switch is back (a switch flipped for ten minutes must not destroy what finishes in them).
router.post(`/uploads/${ID}/complete`, verified, uploadsOn, async (c) => {
  const user = requireVerified(c);
  const open = await loadSession(c);
  const body = CompleteUploadBody.parse(await jsonBody(c));
  // A complete that is sent again — a lost answer, a retry — must be safe.
  if (open.status === "done" || open.status === "aborted") return completedAgain(c, user, open, body);
  if (open.status === "completing") throw stillCompleting();
  assertOpen(c, open);

  // The body by mode — before the claim, so that a refused body leaves the session open.
  const single = isSingle(open);
  if (single ? body.parts.length > 0 : body.parts.length === 0) {
    throw new AppError("validation", single ? "This upload has no parts." : "The parts are missing.");
  }
  const before = await sessions.listParts(db(c), open.id);
  if (single) {
    // The one PUT must be done — not absent, and not still on its way into the store.
    if (!before.some((part) => part.n === 1 && !sessions.isCommitting(part.etag))) {
      throw new AppError("validation", "The file has not been uploaded.");
    }
  } else {
    const claimedEtags = new Map(body.parts.map((part) => [part.n, part.etag]));
    const complete =
      before.length === (open.partCount ?? 0) &&
      claimedEtags.size === body.parts.length &&
      body.parts.length === before.length &&
      before.every((part) => claimedEtags.get(part.n) === part.etag);
    if (!complete) throw new AppError("validation", "The parts do not match what was uploaded.");
    if (!open.r2UploadId) throw new AppError("conflict", "This upload is not ready yet.");
  }

  const session = await claimCompleting(db(c), open.id, user.id);
  if (!session) {
    // Another complete of this session got there first: it is running, or it has finished.
    const current = await sessions.get(db(c), open.id);
    if (current?.status === "done") return completedAgain(c, user, current, body);
    if (current?.status === "completing") throw stillCompleting();
    throw noLongerOpen();
  }
  // What was declared is on the session from the claim on: a session left `completing` by a
  // request that died says what it was about to be checked against.
  await sessions.setDeclaredHash(db(c), session.id, body.sha256);
  const avatar = session.purpose === "avatar";
  const replacing = session.replaceNodeId !== null;
  // What the store holds for this session, read again now that nothing can add to it: a part or
  // a PUT is recorded only while the session is `open`.
  const recorded = await sessions.listParts(db(c), session.id);
  const declared = await blocklist.lookup(db(c), body.sha256);
  const declaredCsam = declared?.reason === "csam";
  const store = storage(c.env);

  let assembled = single;
  let verified: Verified | null = null;
  // From the moment THE SERVER'S hash is known to be listed as CSAM (`evidence`) until the bytes
  // are handed over — to a node, or to the preserve path — any way out ends in the owed state.
  let evidence = false;
  let handedOver = false;
  const giveUp = (reason: string) => {
    if (evidence) handedOver = true;
    return abandonClaimed(c, session, { assembled, declaredCsam, verified, reason });
  };

  /**
   * The object: the multipart upload completed in the store, its size (and, for a single PUT,
   * that it is the one the last PUT stored) — and, when the declared hash is on the blocklist
   * or the bytes are small and already to be read (an avatar), THE SERVER'S OWN HASH of it.
   * From the claim on nothing can change the object, so the hash is of what is acted on.
   */
  const inspect = async () => {
    if (!assembled) {
      try {
        await store.complete(
          store.resumeMultipart(session.r2Key, session.r2UploadId!),
          recorded.map((part) => ({ n: part.n, etag: part.etag })),
        );
      } catch (error) {
        // Not a definitive answer (the store cannot be told apart from a 5xx): nothing is aborted;
        // the session stays `completing` with its parts for the stale-upload job.
        captureError(error, { kind: "upload_store_complete" });
        throw error;
      }
      assembled = true;
    }
    const head = await store.head(session.r2Key);
    // A single PUT that passed its gate just before the claim is still being stored: this is
    // not the object to look at, and there is no way back from `completing`.
    const marker = single ? recorded.find((part) => part.n === 1) : undefined;
    if (single && (!marker || sessions.isCommitting(marker.etag))) {
      await giveUp("put_racing");
      throw new AppError("conflict", "This upload was still being written.");
    }
    if (!head || head.size !== session.size || (marker && head.etag !== marker.etag)) {
      await giveUp("size");
      throw notAsDeclared();
    }
    if (!declared && !avatar) return;
    const actual = await storedSha256(store, session.r2Key);
    if (actual === null) {
      // Gone between the two reads: nothing is decided on a hash nobody computed.
      await giveUp("size");
      throw notAsDeclared();
    }
    const hit = actual === body.sha256 ? declared : await blocklist.lookup(db(c), actual);
    verified = { sha256: actual, hit };
    if (hit?.reason === "csam") evidence = true;
    if (declared && actual !== body.sha256) {
      // The declaration was false. Recorded here only: the answer must not say that the
      // declared value was on a list, and the upload goes on like any other.
      audit(
        c,
        "upload.hash_mismatch",
        { type: "upload", id: session.id },
        { nodeId: session.nodeId, declaredListedAs: declared.reason, actualListedAs: hit?.reason ?? null },
      );
      metric("upload", { outcome: "hash_mismatch", kind: modeOf(session) });
    }
  };

  /** Everything init checked, against the state of now. A refusal gives the upload up. */
  const recheck = async (): Promise<Place> => {
    try {
      if (avatar) return OWN_ROOT(user);
      const place = await placeFor(c, user, session.parentId);
      if (place.ownerId !== session.ownerId) throw new AppError("not_found");
      if (session.replaceNodeId !== null) {
        await replaceGuard(c, {
          replaceNodeId: session.replaceNodeId,
          parentId: session.parentId,
          ownerId: session.ownerId,
        });
      }
      return place;
    } catch (error) {
      // A definitive refusal only — also one the driver wrapped (`asQueryError` finds it).
      if (definitive(error)) await giveUp("recheck");
      throw error;
    }
  };

  // ORDER. Normally the re-check comes first (nothing is assembled for an upload that is
  // refused anyway). When the DECLARED hash is on the blocklist the bytes come first: the
  // multipart upload is completed and the object hashed BEFORE anything is decided — so that a
  // refusal cannot make listed bytes disappear unseen, and the re-check is about the moment the
  // hit is acted on, not about a moment seconds earlier.
  let place!: Place;
  let sha256!: string;
  let hit: Verified["hit"] = null;
  let sealed!: Awaited<ReturnType<typeof sealIp>>;
  try {
    if (declared) {
      await inspect();
      place = await recheck();
    } else {
      place = await recheck();
      await inspect();
    }
    // `verified` is assigned inside `inspect`; the compiler cannot see that across the closure.
    const checked = verified as Verified | null;
    sha256 = checked?.sha256 ?? body.sha256;
    hit = checked?.hit ?? null;

    // THE BLOCKLIST, acted on only for a hash this server computed.
    if (hit && hit.reason !== "csam") {
      try {
        return await refuseBlocked(c, session, hit.reason, sha256);
      } catch (error) {
        if (!(error instanceof RaisedToCsam)) throw error;
        hit = { ...hit, reason: "csam" };
        evidence = true;
      }
    }

    sealed = await sealIp(c.env, c.get("ip"));

    if (hit) {
      // Suspected CSAM: nothing is deleted. The object becomes a node — for a replace a row of its
      // own, the existing file untouched — written ALREADY LOCKED, in the transaction that creates
      // it; the one shared handler then files the report, holds the accounts and tells the
      // operators. Called on the database handle, after this route's transaction.
      const values = {
        ...nodeValues(session, user, sha256, replacing ? uuidv7() : session.nodeId),
        ...LOCKED,
      };
      let node: Node;
      try {
        ({ node } = await finish(c, session, user, { as: "new", values }, sealed, body.sha256));
      } catch (error) {
        // The place or the session went away under the request (a purge of the folder while the
        // object was being hashed): the bytes are evidence all the same.
        captureError(error, { kind: "upload_csam_finish" });
        handedOver = true;
        await preserveAndEnd(c, session, sha256);
        throw blocked();
      }
      handedOver = true;
      audit(c, "node.upload", { type: "node", id: node.id }, { uploadId: session.id, size: session.size });
      await lockOrRecord(c, node.id, session);
      throw blocked();
    }
  } catch (error) {
    // An unexpected error (a key that cannot seal, a database error in the re-check) after the
    // server found the bytes listed as CSAM: the node is owed — never a bare object, never silent.
    if (evidence && !handedOver) await oweNode(c, session, error);
    throw error;
  }

  let becomes: Becomes;
  if (replacing) {
    becomes = { as: "replace", sha256 };
  } else if (avatar) {
    const { verdict, mimeSniffed } = await avatarVerdict(store, c.env, session);
    // An avatar is a picture the image service takes — decided from the bytes, not the declared
    // type. Anything else is not stored at all.
    if (!thumbEligible({ mimeSniffed, size: session.size, scanStatus: "clean" })) {
      await giveUp("not_image");
      throw new AppError("validation", "An avatar is an image.");
    }
    becomes = {
      as: "avatar",
      current: verdict.status === "clean",
      values: {
        ...nodeValues(session, user, sha256),
        scanStatus: verdict.status,
        scanReason: verdict.reason ?? null,
        scanDetail: {
          engine: verdict.engine,
          ...(verdict.signatures.length > 0 ? { signatures: verdict.signatures } : {}),
        },
        scannedAt: now(c),
        mimeSniffed,
      },
    };
  } else {
    becomes = { as: "new", values: nodeValues(session, user, sha256) };
  }

  let finished: Finished;
  try {
    finished = await finish(c, session, user, becomes, sealed, body.sha256);
  } catch (error) {
    if (!(error instanceof ReplaceRefused)) {
      // The place may have gone while this request held the session — a purge of the folder
      // keeps a `completing` session (and its object) for the request to end. Asked again: a
      // place that is gone gives the upload up (object, reservation) with the plain answer; any
      // other failure is the failure it was.
      await recheck();
      throw error;
    }
    // The target changed under the upload (a scan, a hold, a takedown): the same answer for all.
    await giveUp("replace");
    throw replaceRefused();
  }

  // After the commit, for the attempt that committed.
  const { node, previousVersionId } = finished;
  audit(
    c,
    replacing ? "node.replace" : "node.upload",
    { type: "node", id: node.id },
    { uploadId: session.id, size: session.size, ...(avatar ? { purpose: "avatar" } : {}) },
  );
  metric("upload", { outcome: "ok", kind: modeOf(session) });
  if (becomes.as === "avatar") {
    if (becomes.current) {
      audit(
        c,
        "account.avatar_replaced",
        { type: "user", id: user.id },
        { nodeId: node.id, removed: finished.removed.length, keptHeld: finished.keptHeld },
      );
    }
    if (finished.keptHeld > 0) metric("upload", { outcome: "avatar_kept_held" }, finished.keptHeld);
    await discardRemoved(c, store, finished.removed);
    return c.json(await toOwnAvatarDto(db(c), node, { viewerId: user.id }), 201);
  }
  try {
    await enqueueScan(deps(c), { nodeId: node.id, key: session.r2Key });
  } catch (error) {
    // The node exists and stays `pending`; the store's own event for the key scans it too.
    captureError(error, { kind: "upload_enqueue" });
    metric("error", { kind: "upload_enqueue" });
  }
  // The replaced version's thumbnails — not while the database reads as rolled back.
  if (replacing && previousVersionId !== null && !(await readsRolledBack(c.env, db(c)))) {
    try {
      await store.delete(THUMB_SIZES.map((size) => thumbKey(node.id, previousVersionId, size)));
    } catch (error) {
      captureError(error, { kind: "upload_thumbs" });
    }
  }
  const dto = await toNodeDto(db(c), node, {
    viewerId: user.id,
    role: place.role,
    shareRootId: place.viewRootId,
  });
  return c.json(dto, replacing ? 200 : 201);
});

// ── abort ───────────────────────────────────────────────────────────────────────────────────

router.delete(`/uploads/${ID}`, verified, async (c) => {
  const user = requireVerified(c);
  const session = await loadSession(c);
  if (session.status === "aborted") {
    // The reads a finished upload's DELETE makes: a refused upload is not told from a locked one.
    await sessionNode(c, user, session);
    return c.body(null, 204);
  }
  if (session.status === "done") {
    // A finished upload is not aborted. But when its node is not there for the caller (hidden,
    // trashed, gone), the session answers as one that was given up — which is also what makes a
    // locked upload and a refused one answer alike.
    if (await sessionNode(c, user, session)) throw new AppError("conflict", "This upload is complete.");
    return c.body(null, 204);
  }
  if (session.status !== "open") throw stillCompleting();
  // An expired session is aborted like any other: this is how its reservation comes back early.
  if (!(await releaseAndAbort(db(c), session, "open"))) {
    const current = await sessions.get(db(c), session.id);
    if (current?.status === "aborted") return c.body(null, 204);
    throw stillCompleting();
  }
  await discardStored(c, session, false);
  metric("upload", { outcome: "aborted", kind: modeOf(session), reason: "client" });
  return c.body(null, 204);
});
