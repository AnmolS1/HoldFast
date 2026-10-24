// The upload manager: the queue's scheduler and the one writer of `store.ts`.
//
//   queued → (its folder) → uploading → (hashing, when the digest lags) → completing → scanning → done
//
// Three files at a time, three parts per file. A request that fails on the network or with a 5xx
// is tried again on the schedule in `plan.ts`; every other answer has one meaning (see `fail`).
// Pausing aborts what is in flight and keeps what the server already has: resuming sends only the
// missing parts, with no new init.
//
// `complete` is the one step that cannot be taken back: once it has been SENT the file may have
// landed whatever comes back, so from then on the item is neither paused nor cancelled, the same
// `complete` is asked again until the server says what happened, and nothing is uploaded a
// second time unless the server says the session is gone.
//
// The queue belongs to the signed-in account. `purgeUploads` — registered with the shell — aborts
// everything, empties the queue and the resume list, and moves the epoch on. Every step that
// outlives a request takes a `Mark` when it starts and does nothing once the mark is stale: no
// write, no announcement, no request.
import { NodeId } from "../../../shared/schemas/common";
import { ScanStatusResponse, type NodeDto } from "../../../shared/schemas/node";
import type {
  CompleteUploadBody,
  InitUploadBody,
  InitUploadResponse,
  UploadedPart,
} from "../../../shared/schemas/upload";
import { toast } from "../../components/Toaster";
import { api, ApiError, AUTH_EXPIRED_EVENT, AUTH_RESTORED_EVENT, currentAccount } from "../../lib/api";
import { emitNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { formatBytes } from "../../lib/format";
import { accountEpoch, getCachedSession, publicConfigQuery, queryClient, sameAccount } from "../../lib/query";
import { reportError } from "../../lib/sentry";
import { startHashInWorker, type HashJob, type StartHash } from "./hashing";
import { resetPicker } from "./picker";
import {
  COMPLETE_WAIT_LIMIT_MS,
  COMPLETE_WAIT_MS,
  FILE_CONCURRENCY,
  foldersToCreate,
  lastModifiedIso,
  lastSegment,
  matchesResume,
  missingParts,
  parentPath,
  PART_CONCURRENCY,
  partRange,
  partSize,
  preflight,
  RATE_PAUSE_DEFAULT_MS,
  RATE_PAUSE_MAX_MS,
  RETRY_AFTER_CAP_MS,
  RETRY_DELAYS_MS,
  SAY_EACH_FILE_MAX,
  SCAN_BACKOFF_MAX_MS,
  SCAN_BATCH_MAX,
  SCAN_FILE_WAIT_MS,
  SCAN_FOLLOW_LIMIT_MS,
  SCAN_HARD_LIMIT_MS,
  SCAN_INTERVAL_MS,
  SCAN_MIN_ASKS,
  sortedParts,
  VERDICT_CLAIM_MS,
} from "./plan";
import {
  abortUpload,
  completeUpload,
  createFolder,
  getNode,
  getUsage,
  initUpload,
  openUploads,
  putBody,
  putPart,
  putSingle,
  type PutBody,
} from "./protocol";
import {
  clearResumeRows,
  dropResumeRow,
  isExpired,
  readResumeRows,
  saveResumeRow,
  type ResumeRow,
} from "./resume-list";
import {
  addItems,
  announce,
  currentItems,
  findItem,
  isRestored,
  patchItem,
  removeItems,
  resetStore,
  type PauseReason,
  type UploadItem,
  type UploadState,
} from "./store";
import { t } from "./strings";

// ---------------------------------------------------------------------------------------------
// What a test replaces: the body transport and the hasher. Everything else is the real code.

export interface UploadRuntime {
  put: PutBody;
  startHash: StartHash;
}

const realRuntime: UploadRuntime = { put: putBody, startHash: startHashInWorker };
let runtime: UploadRuntime = realRuntime;

/** Tests only. `null` puts the real transport and the worker back. */
export function setUploadRuntimeForTests(patch: Partial<UploadRuntime> | null): void {
  runtime = patch ? { ...realRuntime, ...patch } : realRuntime;
}

// ---------------------------------------------------------------------------------------------
// Whose work is this? The feature's own epoch and the shell's account epoch, read together when
// a piece of work starts.

interface Mark {
  epoch: number;
  account: number;
}

let epoch = 0;
const mark = (): Mark => ({ epoch, account: accountEpoch() });
const live = (then: Mark): boolean => then.epoch === epoch && sameAccount(then.account);
/** The account the queue's contents belong to: taken again each time the purger empties it. */
let queueOwner: Mark = mark();

/**
 * Whose action this is. Taken in the handler of the user's action — the drop, the picker's
 * change, the paste, `requestUpload` — BEFORE anything asynchronous, and handed to `addFiles`:
 * files that took time to arrive (the walk of a dropped folder) are discarded when the account
 * they were chosen under is gone.
 */
export type ActionMark = Mark;
export function actionMark(): ActionMark {
  return mark();
}
export function sameActor(then: ActionMark): boolean {
  return live(then);
}

// ---------------------------------------------------------------------------------------------
// Module state. Every one of these is emptied by `dropQueue` (the purger).

/** Per-item working state that no component reads. */
interface Work {
  /** Aborts the run in flight; null when none is. */
  controller: AbortController | null;
  running: boolean;
  phase: "init" | "send" | "complete";
  /** The hash worker while it runs; null before it starts and once it is done or stopped. */
  hash: HashJob | null;
  sha256: string | null;
  hashFailed: boolean;
  /** Bytes of each body in flight, by part number (0 = the single PUT). */
  inFlight: Map<number, number>;
  sample: { at: number; bytes: number } | null;
  started: boolean;
  /** What is on the device for this upload (written again when `complete` is sent). */
  row: ResumeRow | null;
  /** An init that is still on its way, with the body it was sent with: never asked twice at once. */
  init: { body: string; asked: Promise<InitUploadResponse> } | null;
  /** The account this upload was started for: every body names it (the identity pin). */
  account: string | null;
  /**
   * The version the file landed as (the node's `etag`). A replace keeps the node's id, so a
   * listing's verdict is this file's only when it is about this version.
   */
  etag: string | null;
}

interface FolderFlight {
  promise: Promise<string | null>;
  controller: AbortController;
  waiters: number;
}

/** One `addFiles` call: the folders it creates and its "do the same for every other". */
interface Batch {
  id: string;
  rootId: string | null;
  policy: ConflictChoice | null;
  /** Folder path → the folder's id. */
  made: Map<string, string>;
  /**
   * Folder requests on their way. Each belongs to the rows that wait for it: when the last of
   * them stops waiting (paused, cancelled, offline, purged) the request is stopped too.
   */
  flying: Map<string, FolderFlight>;
  /** Folder path → why it could not be made. Forgotten when a file of it is tried again. */
  failed: Map<string, FolderProblem>;
  mark: Mark;
}

const works = new Map<string, Work>();
const batches = new Map<string, Batch>();
/** Reasons the whole queue is paused for. */
const queuePauses = new Set<PauseReason>();
/** Timers that end a queue pause by themselves (a rate limit, the daily ceiling). */
const pauseTimers = new Map<PauseReason, ReturnType<typeof setTimeout>>();
/** Resolved at the next end of a queue pause. */
let pauseWaiters: Array<() => void> = [];
/** A landed file whose scan is being followed. */
interface ScanEntry {
  id: string;
  /**
   * When it landed (or was checked again), moved forward by every pause of the loop since:
   * `now - since` is the time the loop could have asked about it.
   */
  since: number;
  /** How often it has been asked about. */
  asks: number;
  /** Not asked about before this. */
  nextAt: number;
}
/** In the order they are asked about. */
let scanQueue: ScanEntry[] = [];
/** False while the frame (and with it every progress surface) is not on screen. */
let frameUp = true;
let scanTimer: ReturnType<typeof setTimeout> | undefined;
let scanBusy = false;
/** The files whose request is on its way (they are out of the queue meanwhile). */
let scanAsking: ScanEntry[] = [];
/**
 * Verdicts this queue has said (or will say, from the listing), by node: the explorer's own poll
 * asks `scanVerdictOwned` before it says one, so a verdict is spoken ONCE (R1 a11y-3). Kept
 * `VERDICT_CLAIM_MS`, and taken by the first question about it.
 */
const verdictsSaid = new Map<string, { etag: string | null; at: number }>();
/** Since when the loop cannot ask (tab hidden, frame gone); null while it can. */
let scanPausedSince: number | null = null;
let scanBackoff = 0;
/** The scan loop does not ask before this (its backoff, a `Retry-After`) — also after a remount or a tab switch. */
let scanNotBefore = 0;
let localRestore: Promise<void> | null = null;
let serverRestore: Promise<void> | null = null;
let authProbe: Promise<void> | null = null;
let authGateSeen = false;
let nextId = 0;

function workOf(id: string): Work {
  let work = works.get(id);
  if (!work) {
    work = {
      controller: null,
      running: false,
      phase: "init",
      hash: null,
      sha256: null,
      hashFailed: false,
      inFlight: new Map(),
      sample: null,
      started: false,
      row: null,
      init: null,
      account: currentAccount(),
      etag: null,
    };
    works.set(id, work);
  }
  return work;
}

function newId(): string {
  nextId += 1;
  return `u${Date.now().toString(36)}-${nextId}-${Math.random().toString(36).slice(2, 10)}`;
}

function newBatch(rootId: string | null): Batch {
  const batch: Batch = {
    id: newId(),
    rootId,
    policy: null,
    made: new Map(),
    flying: new Map(),
    failed: new Map(),
    mark: mark(),
  };
  batches.set(batch.id, batch);
  return batch;
}

const LIVE: ReadonlySet<UploadState> = new Set([
  "queued",
  "hashing",
  "uploading",
  "completing",
  "scanning",
  "conflict",
]);
/** What a pause may stop. `completing` is not among them: `complete` is never taken back. */
const PAUSABLE: ReadonlySet<UploadState> = new Set(["queued", "hashing", "uploading"]);

/** Still on its way: not finished, not failed, and not a restored row waiting for its file. */
function isLive(item: UploadItem): boolean {
  return LIVE.has(item.state) || (item.state === "paused" && !isRestored(item));
}

const shownName = (item: UploadItem): string => item.finalName ?? item.name;

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The upload was stopped.", "AbortError");
}

/** The file cannot be read (moved, changed, or the hasher failed). */
class UnreadableFile extends Error {}
/** Nobody could say whether `complete` took effect. */
class Unconfirmed extends Error {}
/** A folder of a folder upload could not be made; `message` is the sentence to show. */
class FolderProblem extends Error {
  /** The answer will be the same next time (something else holds the name): no new try. */
  constructor(
    message: string,
    readonly final: boolean,
  ) {
    super(message);
  }
}
/** `complete` was answered 200 with a body the contract refuses: the file landed, unseen. */
class LandedUnseen extends Error {}

// ---------------------------------------------------------------------------------------------
// Retry: network failures and 5xx only.

function isRetryable(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  if (cause.code === "network") return true;
  if (cause.status < 500) return false;
  // A kill switch is an answer, not a blip.
  return cause.code !== "feature_disabled" && cause.code !== "read_only";
}

function retryAfterMs(cause: unknown, cap: number): number {
  if (!(cause instanceof ApiError) || cause.retryAfter === undefined) return 0;
  return Math.min(cap, cause.retryAfter * 1000);
}

/**
 * Whether the work that waits is still wanted: the run's `current`, or the batch's mark. Asked at
 * the moment a wait ends, before anything is sent — a timer does not trust the purger to have
 * aborted it in time (the shell moves the account epoch before the purgers run).
 */
type Wanted = () => boolean;

function sleep(ms: number, signal: AbortSignal, wanted: Wanted): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const stop = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      if (wanted()) resolve();
      else reject(abortError());
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Run `request`; on a retryable failure wait and run it again, through the whole schedule. */
async function retrying<T>(request: () => Promise<T>, signal: AbortSignal, wanted: Wanted): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (cause) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(cause)) throw cause;
      await sleep(Math.max(delay, retryAfterMs(cause, RETRY_AFTER_CAP_MS)), signal, wanted);
    }
  }
}

/** Wait for `promise`, but stop waiting when the run is aborted. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const stop = () => reject(abortError());
    signal.addEventListener("abort", stop, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", stop);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", stop);
        // Rejections here are always Errors of ours (ApiError, FolderProblem, a DOMException).
        reject(cause as Error);
      },
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Progress.

function measure(id: string): void {
  const item = findItem(id);
  if (!item) return;
  const work = workOf(id);
  // A single PUT keeps one mark in `parts` once its body is with the server.
  let sent =
    item.mode === "multipart"
      ? item.parts.reduce((sum, part) => sum + partSize(part.n, item.partBytes, item.size), 0)
      : item.parts.length > 0
        ? item.size
        : 0;
  for (const loaded of work.inFlight.values()) sent += loaded;
  sent = Math.min(item.size, sent);
  const now = Date.now();
  let speed = item.speed;
  if (!work.sample) work.sample = { at: now, bytes: sent };
  else if (now - work.sample.at >= 500) {
    const rate = (Math.max(0, sent - work.sample.bytes) * 1000) / (now - work.sample.at);
    speed = speed > 0 ? speed * 0.7 + rate * 0.3 : rate;
    work.sample = { at: now, bytes: sent };
  }
  patchItem(
    id,
    {
      sentBytes: sent,
      progress: item.size > 0 ? sent / item.size : 0,
      speed,
      eta: speed > 0 ? Math.ceil((item.size - sent) / speed) : null,
    },
    true,
  );
}

// ---------------------------------------------------------------------------------------------
// Hashing. A worker runs only for a file that is being sent: never for one that waits in a
// question, is paused, has failed or was cancelled — so there are never more workers than files
// in flight.

function startHash(work: Work, file: File): void {
  if (work.hash || work.sha256) return;
  work.hashFailed = false;
  try {
    const job = runtime.startHash(file);
    work.hash = job;
    job.promise.then(
      (sha256) => {
        if (work.hash !== job) return;
        work.sha256 = sha256;
        work.hash = null;
      },
      () => {
        if (work.hash !== job) return;
        work.hashFailed = true;
        work.hash = null;
      },
    );
  } catch {
    work.hashFailed = true;
  }
}

/** Stop the worker if it is still running. A digest that is already in is kept. */
function stopHash(work: Work): void {
  work.hash?.cancel();
  work.hash = null;
}

/** Hash workers running right now (tests assert the bound). */
export function liveHashJobs(): number {
  let count = 0;
  for (const work of works.values()) if (work.hash) count += 1;
  return count;
}

// ---------------------------------------------------------------------------------------------
// The scheduler.

function pump(): void {
  if (queuePauses.size > 0) return;
  let running = 0;
  for (const work of works.values()) if (work.running) running += 1;
  if (running >= FILE_CONCURRENCY) return;
  for (const item of currentItems()) {
    if (running >= FILE_CONCURRENCY) return;
    if (item.state !== "queued" || isRestored(item)) continue;
    const work = workOf(item.id);
    if (work.running) continue;
    running += 1;
    start(item.id);
  }
}

function start(id: string): void {
  // The queue belongs to the account it was filled under (the purger empties it on every change).
  // Started by an event (online, Retry, Resume) after the shell's epoch moved and before the
  // purger ran: the account is no longer the queue's, and nothing starts.
  const then = queueOwner;
  if (!live(then)) return;
  const work = workOf(id);
  const controller = new AbortController();
  work.controller = controller;
  work.running = true;
  void run(id, controller.signal, then)
    .catch((cause: unknown) => {
      if (live(then)) fail(id, cause);
    })
    .finally(() => {
      if (!live(then)) return;
      if (work.controller === controller) work.controller = null;
      work.running = false;
      sweep();
      pump();
    });
}

function initBodyOf(item: UploadItem, file: File): InitUploadBody {
  if (item.resumeBody) return { ...item.resumeBody, mimeDeclared: item.resumeBody.mimeDeclared || file.type };
  const body: InitUploadBody = {
    parentId: item.parentId,
    name: item.name,
    size: item.size,
    mimeDeclared: file.type.slice(0, 255),
    fileLastModified: lastModifiedIso(item),
    onConflict: item.onConflict,
    purpose: "file",
  };
  if (item.onConflict === "replace" && item.replaceNodeId) body.replaceNodeId = item.replaceNodeId;
  return body;
}

function keepForResume(item: UploadItem, body: InitUploadBody, init: InitUploadResponse): void {
  const userId = getCachedSession()?.user.id;
  // Without a known account there is nobody the row could belong to.
  if (!userId) return;
  const row: ResumeRow = {
    id: item.id,
    userId,
    uploadId: init.uploadId,
    body,
    path: item.path,
    finalName: init.finalName,
    expiresAt: init.expiresAt,
  };
  workOf(item.id).row = row;
  void saveResumeRow(row);
}

/**
 * A wait that a soft queue pause imposes on work that is already running. A rate limit does not
 * abort the bodies in flight (they would only be sent again): they finish, and nothing NEW is
 * asked until the pause ends. `complete` also waits out being offline this way.
 */
async function gate(signal: AbortSignal, reasons: readonly PauseReason[], wanted: Wanted): Promise<void> {
  while (reasons.some((reason) => queuePauses.has(reason))) {
    await unlessAborted(new Promise<void>((resolve) => pauseWaiters.push(resolve)), signal);
  }
  if (!wanted()) throw abortError();
}
const SOFT: readonly PauseReason[] = ["limited"];

/** A folder of a folder upload that holds no file: a row of the queue like any other. */
async function runFolder(
  id: string,
  item: UploadItem,
  signal: AbortSignal,
  current: () => UploadItem | null,
): Promise<void> {
  workOf(id).phase = "init";
  patchItem(id, { state: "uploading", pauseReason: null, message: null, requestId: null });
  const batch = batches.get(item.batchId);
  if (!batch) throw new FolderProblem(t("folder.failed", { name: item.name }), false);
  await gate(signal, SOFT, () => current() !== null);
  await ensureFolder(batch, folderPathOf(item), signal);
  if (!current()) return;
  patchItem(id, { state: "done", progress: 1 });
}

async function run(id: string, signal: AbortSignal, then: Mark): Promise<void> {
  const work = workOf(id);
  /** The item, or null when this run is no longer the one that counts. */
  const current = (): UploadItem | null => {
    if (!live(then) || signal.aborted) return null;
    return findItem(id) ?? null;
  };
  const wanted: Wanted = () => current() !== null;
  let item = current();
  if (!item) return;
  if (item.kind === "folder") {
    await runFolder(id, item, signal, current);
    return;
  }
  const file = item.file;
  if (!file) return;

  if (!work.started) {
    work.started = true;
    if (saysEachFile(item)) announce(t("live.start", { name: item.name }));
  }
  patchItem(id, {
    state: item.completeSent ? "completing" : "uploading",
    pauseReason: null,
    message: null,
    requestId: null,
    unconfirmed: false,
  });

  if (!item.completeSent) {
    // Its folder first (a folder upload): made once per folder, shared by the files of it.
    if (item.waitingFolder) {
      work.phase = "init";
      const batch = batches.get(item.batchId);
      const parentId = batch ? await ensureFolder(batch, item.path, signal) : item.parentId;
      if (!current()) return;
      patchItem(id, { parentId, waitingFolder: false });
    }

    item = current();
    if (!item) return;
    if (!item.uploadId) {
      work.phase = "init";
      const body = initBodyOf(item, file);
      // Not tied to the run's signal: an init that is cancelled half-way may already have opened
      // a session, and then its id is needed to close it again.
      const sent = JSON.stringify(body);
      let flying = work.init?.body === sent ? work.init : null;
      if (!flying) {
        await gate(signal, SOFT, wanted);
        const asked = initUpload(body);
        flying = { body: sent, asked };
        work.init = flying;
        const settled = () => {
          if (work.init?.asked === asked) work.init = null;
        };
        asked.then((init) => {
          settled();
          if (!live(then)) return;
          const now = findItem(id);
          if (!now || now.state === "cancelled") abortUpload(init.uploadId).catch(() => {});
        }, settled);
      }
      const first = flying.asked;
      // The first try is the one in flight; later tries (a 5xx, the network) are the run's own.
      let tries = 0;
      const init = await unlessAborted(
        retrying(() => (tries++ === 0 ? first : initUpload(body, signal)), signal, wanted),
        signal,
      );
      item = current();
      if (!item) return;
      patchItem(id, {
        uploadId: init.uploadId,
        expiresAt: init.expiresAt,
        mode: init.mode,
        partBytes: init.partBytes,
        partCount: init.partCount,
        parts: init.mode === "multipart" ? sortedParts(init.resumedParts) : [],
        finalName: init.finalName,
        resumeBody: null,
      });
      keepForResume(item, body, init);
      absorbRestored(id, init.uploadId);
    }
    measure(id);
    // Only now: a file that met a conflict, a refusal or a full quota at init is never read.
    startHash(work, file);

    work.phase = "send";
    item = current();
    if (!item?.uploadId) return;
    const sending = item.uploadId;
    if (item.mode === "single") {
      if (item.parts.length === 0) {
        await gate(signal, SOFT, wanted);
        const { etag } = await retrying(
          () =>
            putSingle(runtime.put, sending, file, {
              signal,
              account: work.account,
              onProgress: (loaded) => {
                if (!current()) return;
                work.inFlight.set(0, loaded);
                measure(id);
              },
            }),
          signal,
          wanted,
        );
        if (!current()) return;
        // The mark that the body is with the server; `complete` sends no parts for a single PUT.
        work.inFlight.delete(0);
        patchItem(id, { parts: [{ n: 1, etag }] });
        measure(id);
      }
    } else {
      await sendParts(id, sending, file, signal, current);
    }
  }

  item = current();
  if (!item?.uploadId) return;
  // The body is built once and asked with unchanged from then on (a restored row brings its own).
  let body = item.completeBody;
  if (!body) {
    if (!work.sha256) {
      startHash(work, file);
      if (!work.hash || work.hashFailed) throw new UnreadableFile();
      patchItem(id, { state: "hashing" });
      try {
        work.sha256 = await unlessAborted(work.hash.promise, signal);
      } catch (cause) {
        if (isAbort(cause)) throw cause;
        throw new UnreadableFile();
      }
    }
    item = current();
    if (!item?.uploadId) return;
    body = { sha256: work.sha256, parts: item.mode === "single" ? [] : sortedParts(item.parts) };
  }

  // From here the file may land whatever comes back: no pause, no cancel, and the same body is
  // asked again until the server says what happened.
  work.phase = "complete";
  patchItem(id, {
    state: "completing",
    completeSent: true,
    completeBody: body,
    progress: 1,
    sentBytes: item.size,
    speed: 0,
    eta: null,
  });
  // The device's row says so too: after a reload it is a question to ask again, not an upload
  // to resume.
  if (work.row && !work.row.complete) {
    work.row = { ...work.row, complete: body };
    void saveResumeRow(work.row);
  }
  let node: NodeDto;
  try {
    node = await confirmComplete(item.uploadId, body, signal, wanted);
  } catch (cause) {
    if (!(cause instanceof LandedUnseen)) throw cause;
    if (current()) landedUnseen(id, item.uploadId);
    return;
  }
  if (!current()) return;
  landed(id, node);
}

/**
 * Send `complete` until the server says what happened. `200` is "landed" — whichever attempt did
 * it. `409` with `state: "completing"` is "another attempt is at it": wait and ask again, for a
 * bounded time. A lost answer (network, 5xx) is asked again on the retry schedule. When neither
 * ends in an answer the upload is unconfirmed — not failed, and never sent again by itself.
 */
async function confirmComplete(
  uploadId: string,
  body: CompleteUploadBody,
  signal: AbortSignal,
  wanted: Wanted,
): Promise<NodeDto> {
  const began = Date.now();
  let lost = 0;
  let waits = 0;
  for (;;) {
    // Not into a rate limit, and not into a connection the browser says is gone: offline is
    // waited out here instead of counting the tries down.
    await gate(signal, ["limited", "offline"], wanted);
    try {
      return await completeUpload(uploadId, body, signal);
    } catch (cause) {
      if (isAbort(cause)) throw cause;
      // Answered, and with 2xx: it landed. What came back is not the contract's shape.
      if (
        cause instanceof ApiError &&
        cause.code === "invalid_response" &&
        cause.status >= 200 &&
        cause.status < 300
      ) {
        throw new LandedUnseen();
      }
      if (cause instanceof ApiError && cause.status === 409 && cause.details?.state === "completing") {
        if (Date.now() - began >= COMPLETE_WAIT_LIMIT_MS) throw new Unconfirmed();
        await sleep(COMPLETE_WAIT_MS[Math.min(waits, COMPLETE_WAIT_MS.length - 1)]!, signal, wanted);
        waits += 1;
        continue;
      }
      if (!isRetryable(cause)) throw cause;
      const delay = RETRY_DELAYS_MS[lost];
      if (delay === undefined) throw new Unconfirmed();
      lost += 1;
      await sleep(Math.max(delay, retryAfterMs(cause, RETRY_AFTER_CAP_MS)), signal, wanted);
    }
  }
}

async function sendParts(
  id: string,
  uploadId: string,
  file: File,
  signal: AbortSignal,
  current: () => UploadItem | null,
): Promise<void> {
  const item = current();
  if (!item) return;
  const work = workOf(id);
  const { partBytes, size } = item;
  const waiting = missingParts(item.partCount, item.parts);
  // One part failing for good stops its siblings; the run's own abort stops them too.
  const group = new AbortController();
  const stop = () => group.abort();
  signal.addEventListener("abort", stop, { once: true });
  let failure: unknown;
  let failed = false;
  const lane = async (): Promise<void> => {
    for (;;) {
      const still = await gate(group.signal, SOFT, () => current() !== null).then(
        () => true,
        () => false,
      );
      const n = waiting.shift();
      if (n === undefined || failed || group.signal.aborted || !still) return;
      const { start: from, end: to } = partRange(n, partBytes, size);
      try {
        const answer = await retrying(
          () =>
            putPart(runtime.put, uploadId, n, file.slice(from, to), {
              signal: group.signal,
              account: work.account,
              onProgress: (loaded) => {
                if (!current()) return;
                work.inFlight.set(n, Math.min(loaded, to - from));
                measure(id);
              },
            }),
          group.signal,
          () => current() !== null,
        );
        const now = current();
        if (!now) return;
        work.inFlight.delete(n);
        const parts: UploadedPart[] = [...now.parts.filter((part) => part.n !== n), { n, etag: answer.etag }];
        patchItem(id, { parts: sortedParts(parts) }, true);
        measure(id);
      } catch (cause) {
        work.inFlight.delete(n);
        if (!failed) {
          failed = true;
          failure = cause;
          group.abort();
        }
        return;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, waiting.length) }, lane));
  } finally {
    signal.removeEventListener("abort", stop);
  }
  if (signal.aborted) throw abortError();
  if (failed) throw failure;
}

// ---------------------------------------------------------------------------------------------
// Folders of a folder upload. A folder is made when the first file of it is about to start — so
// it waits, stops and is tried again with the files: paused or offline nothing is asked, a
// cancelled upload makes no more folders, and a failure is the file's to try again.

/** These answers are about the whole queue (the session, a limit, a switch): `fail` reads them. */
function isQueueAnswer(cause: unknown): boolean {
  return (
    cause instanceof ApiError &&
    (cause.status === 401 ||
      cause.status === 429 ||
      cause.code === "feature_disabled" ||
      cause.code === "read_only")
  );
}

/**
 * The id of the folder at `path` inside the batch, making it (and its parents, first) if it is
 * not there yet. A name a folder already holds is that folder (the server says which); a name
 * something else holds is a problem of that subtree. The folder's children are never listed.
 */
function ensureFolder(batch: Batch, path: string, signal: AbortSignal): Promise<string | null> {
  if (path === "") return Promise.resolve(batch.rootId);
  const made = batch.made.get(path);
  if (made !== undefined) return Promise.resolve(made);
  const failed = batch.failed.get(path);
  if (failed) return Promise.reject(failed);
  let flight = batch.flying.get(path);
  if (!flight) {
    const controller = new AbortController();
    const promise = (async () => {
      const parentId = await ensureFolder(batch, parentPath(path), controller.signal);
      const name = lastSegment(path);
      try {
        // Nobody's any more (the account changed, or everyone stopped waiting): not asked for.
        if (controller.signal.aborted || !live(batch.mark)) throw abortError();
        const node = await retrying(
          () => createFolder({ parentId, name }, controller.signal),
          controller.signal,
          () => live(batch.mark),
        );
        if (live(batch.mark)) emitNodesChanged([parentId]);
        batch.made.set(path, node.id);
        return node.id;
      } catch (cause) {
        if (isAbort(cause) || isQueueAnswer(cause)) throw cause;
        const taken = cause instanceof ApiError && cause.status === 409;
        const existingId = taken ? cause.details?.existingId : undefined;
        if (typeof existingId === "string") {
          batch.made.set(path, existingId);
          return existingId;
        }
        // Remembered, so the other rows of the folder do not each ask again; a new try forgets it.
        const problem = new FolderProblem(t(taken ? "folder.taken" : "folder.failed", { name }), taken);
        batch.failed.set(path, problem);
        throw problem;
      }
    })();
    const made: FolderFlight = { promise, controller, waiters: 0 };
    flight = made;
    batch.flying.set(path, made);
    const done = () => {
      if (batch.flying.get(path) === made) batch.flying.delete(path);
    };
    promise.then(done, done);
  }
  // One more row waits for this request. When the last of them stops waiting, it is stopped.
  const mine = flight;
  mine.waiters += 1;
  return new Promise((resolve, reject) => {
    const leave = () => {
      mine.waiters -= 1;
      if (mine.waiters === 0) mine.controller.abort();
      reject(abortError());
    };
    if (signal.aborted) {
      leave();
      return;
    }
    signal.addEventListener("abort", leave, { once: true });
    mine.promise.then(
      (id) => {
        signal.removeEventListener("abort", leave);
        resolve(id);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", leave);
        reject(cause as Error);
      },
    );
  });
}

/** The path of the folder a folder row stands for. */
function folderPathOf(item: UploadItem): string {
  return item.path === "" ? item.name : `${item.path}/${item.name}`;
}

function forgetFolderProblems(item: UploadItem): void {
  const batch = batches.get(item.batchId);
  if (!batch) return;
  const from = item.kind === "folder" ? folderPathOf(item) : item.path;
  for (let path = from; path !== ""; path = parentPath(path)) batch.failed.delete(path);
}

// ---------------------------------------------------------------------------------------------
// After the file landed: tell the other features, then follow the scan — with ONE loop for the
// whole queue. It asks about one file per interval however many wait, asks each file less often
// the longer it waits, backs off when the server says to, does not ask while the tab is hidden or
// the frame is gone (and that time does not count), and stops asking about a file after a bound —
// where the row offers "Check again". A verdict the explorer's listing learns settles the row too.

function landed(id: string, node: NodeDto): void {
  const item = findItem(id);
  if (!item) return;
  void dropResumeRow(id);
  workOf(id).etag = node.etag;
  patchItem(id, {
    state: "scanning",
    nodeId: node.id,
    finalName: node.name,
    progress: 1,
    sentBytes: item.size,
    speed: 0,
    eta: null,
  });
  emitNodesChanged([item.parentId]);
  if (saysEachFile(item)) announce(t("live.done", { name: node.name }));
  if (node.scanStatus !== "pending") {
    settleScan(id, node);
    return;
  }
  syncScanClock();
  const now = Date.now();
  // A file that lands while the loop cannot ask starts its clock when the loop goes on.
  scanQueue.push({ id, since: scanPausedSince ?? now, asks: 0, nextAt: now + SCAN_FILE_WAIT_MS[0] });
  scheduleScan(SCAN_INTERVAL_MS);
}

/**
 * `complete` said 200 and nothing readable: the file is in the folder, and this page cannot say
 * more about it (no id to follow the scan with). Said as what it is — uploaded — and reported.
 */
function landedUnseen(id: string, uploadId: string): void {
  const item = findItem(id);
  if (!item) return;
  void dropResumeRow(id);
  patchItem(id, { state: "done", scanStatus: null, progress: 1, sentBytes: item.size, speed: 0, eta: null });
  emitNodesChanged([item.parentId]);
  const sentence = t("live.landedUnseen", { name: shownName(item) });
  announce(sentence);
  toast({ message: sentence, key: "upload-unseen" });
  reportError(new Error("upload: complete answered 2xx with a body the contract refuses"), { uploadId });
  sweep();
}

/** Still waiting for its verdict: followed by the loop, or given up as still being checked. */
const awaitsVerdict = (item: UploadItem): boolean =>
  item.state === "scanning" || (item.state === "done" && item.scanStatus === "pending");

/**
 * Uploading and uploaded are said file by file for a few files; a larger drop is told by the
 * ribbon's sentence (R1 a11y-11: a 100-file folder was 200 polite utterances). A verdict that
 * needs telling (blocked, couldn't scan) and a failure are always said for the file.
 */
function saysEachFile(item: UploadItem): boolean {
  let files = 0;
  for (const other of currentItems()) {
    if (other.batchId === item.batchId && other.kind === "file" && ++files > SAY_EACH_FILE_MAX) return false;
  }
  return true;
}

/**
 * The verdict, said once: a row that is no longer waiting for it (the listing or another answer
 * settled it first) takes nothing more, and says nothing more (R1 a11y-3).
 * `fromListing`: the verdict came from the explorer's listing, which needs no telling.
 */
function settleScan(
  id: string,
  node: Pick<NodeDto, "id" | "etag" | "scanStatus" | "scanReason" | "name">,
  { fromListing = false } = {},
): void {
  const item = findItem(id);
  if (!item || !awaitsVerdict(item)) return;
  verdictsSaid.set(node.id, { etag: node.etag, at: Date.now() });
  patchItem(id, { state: "done", scanStatus: node.scanStatus, scanReason: node.scanReason });
  if (node.scanStatus === "infected") announce(t("live.blocked", { name: node.name }));
  else if (node.scanStatus === "error" || node.scanStatus === "skipped")
    announce(t("live.unscanned", { name: node.name }));
  // The listing shows the same status: let it read it now rather than at its next refresh.
  if (!fromListing) emitNodesChanged([item.parentId]);
  sweep();
}

/**
 * What a listing of the explorer shows about files: a row still waiting for the verdict on that
 * version of the file (scanning, or given up as still being checked) takes it, so the listing and
 * the ribbon never disagree. Said as the loop says it (blocked, couldn't scan) — a refetch that
 * shows the verdict first leaves the listing's own poll nothing to say — and the listing is not
 * asked to refresh. Nothing happens once the queue is no longer the account's (the shell's purge
 * has begun): ids are the server's, and the queue is about to be emptied.
 */
export function scanVerdictsSeen(nodes: readonly NodeDto[]): void {
  if (!live(queueOwner)) return;
  const verdicts = new Map<string, NodeDto>();
  for (const node of nodes) {
    if (node.kind === "file" && node.scanStatus !== null && node.scanStatus !== "pending") {
      verdicts.set(node.id, node);
    }
  }
  if (verdicts.size === 0) return;
  for (const item of currentItems()) {
    const node = awaitsVerdict(item) && item.nodeId ? verdicts.get(item.nodeId) : undefined;
    // A listing read before this upload replaced the file shows the old version's verdict.
    if (!node || node.etag !== works.get(item.id)?.etag) continue;
    // Its entry in the loop's queue is dropped when the loop next looks (the row is no longer scanning).
    settleScan(item.id, node, { fromListing: true });
  }
}

/**
 * Is this verdict the upload queue's to say? True while a row waits for the verdict on this
 * version of the file — the listing's patch settles it, and the row says it — and once for a
 * verdict a row said in the last `VERDICT_CLAIM_MS` (an answer of the explorer's poll that was
 * already on its way). The explorer says the verdicts of every other file. Nothing is the queue's
 * once it is no longer the account's.
 */
export function scanVerdictOwned(node: Pick<NodeDto, "id" | "etag">): boolean {
  if (!live(queueOwner)) return false;
  for (const item of currentItems()) {
    if (item.nodeId === node.id && awaitsVerdict(item) && works.get(item.id)?.etag === node.etag) return true;
  }
  const said = verdictsSaid.get(node.id);
  if (!said || said.etag !== node.etag || Date.now() - said.at >= VERDICT_CLAIM_MS) return false;
  verdictsSaid.delete(node.id);
  return true;
}

/** "Check again" on a row the bound gave up on: the file is followed again, for a whole new bound. */
export function recheckItem(id: string): void {
  // A click after the shell's epoch moved and before the purger ran asks nothing for the old account.
  if (!live(queueOwner)) return;
  const item = findItem(id);
  if (!item || item.state !== "done" || item.scanStatus !== "pending" || !item.nodeId) return;
  patchItem(id, { state: "scanning" });
  syncScanClock();
  const now = Date.now();
  scanQueue.push({ id, since: scanPausedSince ?? now, asks: 0, nextAt: now });
  // Asked at the loop's next turn, not after a wait some other file set (the loop's own
  // `scanNotBefore` still keeps it at one request per interval).
  if (!scanBusy) {
    clearTimeout(scanTimer);
    scanTimer = undefined;
  }
  scheduleScan(0);
}

/** "Check again" for every row the bound gave up on (the panel counts those it does not draw). */
export function recheckAll(): void {
  for (const item of currentItems()) {
    if (item.state === "done" && item.scanStatus === "pending") recheckItem(item.id);
  }
}

const tabHidden = (): boolean => typeof document !== "undefined" && document.visibilityState === "hidden";
const scanPaused = (): boolean => tabHidden() || !frameUp;

/**
 * Time the loop cannot ask (the tab hidden, the frame gone) does not count against any file's
 * bound: when it ends, every file's clock moves forward by it. (A file that was due meanwhile is
 * asked as soon as the loop goes on.) Called wherever the tab or the frame changes.
 */
function syncScanClock(): void {
  const now = Date.now();
  if (scanPaused()) {
    scanPausedSince ??= now;
    return;
  }
  if (scanPausedSince === null) return;
  const pause = now - scanPausedSince;
  scanPausedSince = null;
  for (const entry of [...scanQueue, ...scanAsking]) entry.since += pause;
}

function scheduleScan(wait: number): void {
  if (scanTimer !== undefined || scanBusy || scanQueue.length === 0 || tabHidden() || !frameUp) return;
  // The account whose files these are is the one that schedules the ask: a tick that fires after
  // the shell's epoch moved (before the purger stops it) sends nothing.
  const then = mark();
  scanTimer = setTimeout(() => void scanTick(then), Math.max(wait, scanNotBefore - Date.now()));
}

/**
 * The files that are due — at most `SCAN_BATCH_MAX`, taken out of the queue — or how long until
 * one is. Files that are gone or past their bound are dealt with on the way. The bound is time
 * AND asks — a file is not given up without having been asked about — up to a hard time limit
 * that holds however long the queue.
 */
function nextScan(
  now: number,
): { due: Array<{ entry: ScanEntry; item: UploadItem }> } | { wait: number } | null {
  let soonest = Infinity;
  const due: Array<{ entry: ScanEntry; item: UploadItem }> = [];
  for (let index = 0; index < scanQueue.length;) {
    const entry = scanQueue[index]!;
    const item = findItem(entry.id);
    if (!item || item.state !== "scanning" || !item.nodeId) {
      scanQueue.splice(index, 1);
      continue;
    }
    const waited = now - entry.since;
    if ((waited >= SCAN_FOLLOW_LIMIT_MS && entry.asks >= SCAN_MIN_ASKS) || waited >= SCAN_HARD_LIMIT_MS) {
      // Still running after the bound: the row says so and nothing more is asked.
      scanQueue.splice(index, 1);
      patchItem(entry.id, { state: "done", scanStatus: "pending" });
      continue;
    }
    if (entry.nextAt <= now && due.length < SCAN_BATCH_MAX) {
      scanQueue.splice(index, 1);
      due.push({ entry, item });
      continue;
    }
    // Woken at its bound too, so that the row says "still being checked" then — not up to a
    // whole wait later.
    const bound = entry.since + (entry.asks >= SCAN_MIN_ASKS ? SCAN_FOLLOW_LIMIT_MS : SCAN_HARD_LIMIT_MS);
    soonest = Math.min(soonest, entry.nextAt, bound);
    index += 1;
  }
  if (due.length > 0) return { due };
  return soonest === Infinity ? null : { wait: soonest - now };
}

/** The scan state of these files in one request (`POST /api/nodes/scan-status`). */
async function scanStatuses(ids: string[]): Promise<NodeDto[]> {
  if (ids.length === 0) return [];
  const answer = await api("/api/nodes/scan-status", {
    method: "POST",
    body: { ids },
    schema: ScanStatusResponse,
  });
  return answer.items;
}

/** No longer there for the caller (gone, or no longer theirs to see): there is nothing left to follow. */
function lostSight(id: string): void {
  const item = findItem(id);
  if (item && awaitsVerdict(item)) patchItem(id, { state: "done", scanStatus: null });
}

async function scanTick(then: Mark): Promise<void> {
  scanTimer = undefined;
  if (!live(then)) return;
  const next = nextScan(Date.now());
  if (next === null) {
    sweep();
    return;
  }
  if ("wait" in next) {
    sweep();
    scheduleScan(Math.max(SCAN_INTERVAL_MS, next.wait));
    return;
  }
  // Every file that is due, in ONE request (R1 perfops-2): an id the server leaves out of the
  // answer is not there for this account any more.
  const asked = next.due.filter(({ item }) => NodeId.safeParse(item.nodeId).success);
  for (const { item } of next.due) if (!asked.some((due) => due.item === item)) lostSight(item.id);
  scanBusy = true;
  scanAsking = asked.map(({ entry }) => entry);
  let wait: number = SCAN_INTERVAL_MS;
  try {
    const answered = new Map(
      (await scanStatuses(asked.map(({ item }) => item.nodeId!))).map((node) => [node.id, node]),
    );
    if (!live(then)) return;
    scanAsking = [];
    scanBackoff = 0;
    for (const { entry, item } of asked) {
      const node = answered.get(item.nodeId!);
      if (!node) lostSight(item.id);
      else if (node.scanStatus === "pending") {
        entry.asks += 1;
        entry.nextAt = Date.now() + SCAN_FILE_WAIT_MS[Math.min(entry.asks, SCAN_FILE_WAIT_MS.length - 1)]!;
        scanQueue.push(entry);
      } else settleScan(item.id, node);
    }
  } catch (cause) {
    if (!live(then)) return;
    scanAsking = [];
    const status = cause instanceof ApiError ? cause.status : 0;
    if (status >= 400 && status < 500 && status !== 429) {
      // Refused whole (not ours to ask any more): there is nothing left to follow.
      for (const { item } of asked) lostSight(item.id);
    } else {
      // Told to slow down, or no answer: the whole loop waits longer, and asks about the same files.
      scanQueue.unshift(...asked.map(({ entry }) => entry));
      scanBackoff = Math.min(SCAN_BACKOFF_MAX_MS, Math.max(2 * SCAN_INTERVAL_MS, scanBackoff * 2));
      wait = Math.max(scanBackoff, retryAfterMs(cause, RATE_PAUSE_MAX_MS));
    }
  }
  if (!live(then)) return;
  scanBusy = false;
  sweep();
  scanNotBefore = Date.now() + wait;
  scheduleScan(wait);
}

/**
 * The frame came or went. While it is gone the scan is not asked about (nobody sees the answer).
 * No row changes: the frame also goes and comes back in one commit when it remounts (the session
 * read again, the same account), and a remount is not the user pausing. Uploads go on and are
 * there when the frame is back; what belongs to an account that signed out is stopped by the
 * purger, not here.
 */
export function frameMounted(up: boolean): void {
  frameUp = up;
  syncScanClock();
  if (up) {
    scheduleScan(SCAN_INTERVAL_MS);
    return;
  }
  clearTimeout(scanTimer);
  scanTimer = undefined;
}

// ---------------------------------------------------------------------------------------------
// Failures: one meaning per answer.

function forgetSession(id: string): void {
  void dropResumeRow(id);
  const work = workOf(id);
  work.inFlight.clear();
  work.sample = null;
  patchItem(id, {
    uploadId: null,
    expiresAt: null,
    mode: null,
    parts: [],
    sentBytes: 0,
    progress: 0,
    speed: 0,
    eta: null,
    completeSent: false,
    completeBody: null,
  });
  workOf(id).row = null;
}

function fail(id: string, cause: unknown): void {
  const item = findItem(id);
  if (!item || isAbort(cause)) return;
  const work = workOf(id);
  work.inFlight.clear();
  const name = shownName(item);
  const stopped = (patch: Partial<UploadItem>) => {
    // Nothing is sent for it now, so nothing is read for it either.
    stopHash(work);
    patchItem(id, { speed: 0, eta: null, ...patch });
  };

  if (cause instanceof Unconfirmed) {
    stopped({
      state: "error",
      unconfirmed: true,
      message: t("row.unconfirmed"),
      requestId: null,
      canRetry: true,
    });
    announce(t("live.unconfirmed", { name }));
    return;
  }
  if (cause instanceof FolderProblem) {
    stopped({ state: "error", message: cause.message, requestId: null, canRetry: !cause.final });
    announce(t("live.failed", { name }));
    return;
  }
  if (cause instanceof UnreadableFile) {
    work.sha256 = null;
    stopped({ state: "error", message: t("row.unreadable"), requestId: null, canRetry: true });
    announce(t("live.failed", { name }));
    return;
  }
  if (!(cause instanceof ApiError)) {
    stopped({ state: "error", message: t("row.failed"), requestId: null, canRetry: true });
    announce(t("live.failed", { name }));
    return;
  }
  const reason = typeof cause.details?.reason === "string" ? cause.details.reason : undefined;

  // No session: the queue waits for the sign-in and then goes on where it was.
  if (cause.status === 401) {
    stopped({ state: "paused", pauseReason: "auth" });
    // A JSON call that ends in 401 has been through the sign-in already (and was given up).
    if (work.phase === "send") probeSession();
    return;
  }
  // Blocked content is final for this file: no retry, no resume, nothing to try again.
  if (cause.status === 403 && reason === "blocked_content") {
    void dropResumeRow(id);
    stopped({
      state: "refused",
      message: t("row.refused"),
      requestId: cause.requestId ?? null,
      canRetry: false,
      uploadId: null,
      completeSent: false,
      completeBody: null,
    });
    announce(t("live.refused", { name }));
    return;
  }
  // A limit: the whole queue waits. The file has not failed.
  if (cause.status === 429) {
    const kind = typeof cause.details?.kind === "string" ? cause.details.kind : undefined;
    const pause: PauseReason =
      cause.code !== "ceiling_exceeded" ? "limited" : kind === "open_uploads" ? "open" : "ceiling";
    stopped({ state: "paused", pauseReason: pause });
    pauseQueue(pause);
    if (pause === "limited") {
      // Always ends by itself: after what the server asked for, bounded both ways.
      const asked = cause.retryAfter === undefined ? RATE_PAUSE_DEFAULT_MS : cause.retryAfter * 1000;
      resumeQueueIn(pause, Math.min(RATE_PAUSE_MAX_MS, Math.max(SCAN_INTERVAL_MS, asked)));
    }
    // The daily ceiling and the open-sessions cap do not clear in a moment: the queue stays
    // stopped, with its sentence, until the user resumes it. No clock of the server's is trusted
    // to start it again.
    return;
  }
  // The upload switch, and the maintenance switch that stops every write: the queue waits.
  if (cause.code === "feature_disabled" || cause.code === "read_only") {
    stopped({ state: "paused", pauseReason: "disabled" });
    pauseQueue("disabled");
    return;
  }
  // The name is taken (409) — or the replace that was asked for is not allowed: a 409 in the
  // server's own words, or a 403 / 404 because the file there is not the caller's to replace.
  const replacing = work.phase === "init" && item.onConflict === "replace";
  const notReplaceable = replacing && (cause.status === 403 || cause.status === 404);
  if ((cause.status === 409 && work.phase === "init") || notReplaceable) {
    void dropResumeRow(id);
    if (item.onConflict === "rename") {
      // The server was asked to pick a free name and still says taken: that is not a question
      // any more, and asking again would get the same answer. One try, then the file stops.
      stopped({
        state: "error",
        message: t("row.noFreeName"),
        requestId: cause.requestId ?? null,
        canRetry: true,
        resumeBody: null,
        uploadId: null,
      });
      announce(t("live.failed", { name }));
      return;
    }
    const existingId = typeof cause.details?.existingId === "string" ? cause.details.existingId : null;
    stopped({
      state: "conflict",
      conflict: {
        existingId: replacing ? (item.conflict?.existingId ?? null) : existingId,
        replaceRefused: !replacing ? null : notReplaceable ? t("conflict.cannotReplace") : cause.message,
      },
      onConflict: "fail",
      replaceNodeId: null,
      // A restored row that meets a conflict has lost its session: from here it is a new upload.
      resumeBody: null,
      uploadId: null,
    });
    // The run that met the conflict is still unwinding; it pumps the queue when it has.
    const policy = batches.get(item.batchId)?.policy ?? null;
    if (!(policy !== null && choose(id, policy))) announce(t("live.conflict", { name }));
    return;
  }
  // The session is gone (expired, aborted, or its folder is): a new try starts from the top.
  const gone = work.phase !== "init" && (cause.status === 404 || cause.status === 409);
  if (gone) forgetSession(id);
  // Lost on the way, at `complete`: nobody knows. (Reached only through an answer that is not a
  // lost one — `confirmComplete` turns those into Unconfirmed itself.)
  const ours = cause.code === "network" || cause.code === "invalid_response" || cause.status >= 500;
  // An answer that will be the same next time offers no new try.
  const settled =
    cause.code === "file_too_large" ||
    cause.code === "validation" ||
    (!gone && (cause.status === 403 || cause.status === 404));
  stopped({
    state: "error",
    message: ours || cause.code === "http_error" ? t("row.failed") : cause.message,
    requestId: cause.requestId ?? null,
    canRetry: !settled,
  });
  announce(t("live.failed", { name }));
}

/**
 * A body request answered 401. Those do not pass through the API client, so nothing has asked
 * the user to sign in yet: one ordinary request does (the client holds it behind the sign-in and
 * replays it). `auth:restored` then resumes the queue.
 */
function probeSession(): void {
  if (authProbe) return;
  const then = mark();
  authGateSeen = false;
  authProbe = openUploads()
    .then(
      () => true,
      (cause: unknown) => !(cause instanceof ApiError && cause.status === 401),
    )
    .then((answered) => {
      if (!live(then)) return;
      authProbe = null;
      if (authGateSeen || !answered) return;
      // The session is fine after all, so that 401 was not about it: an ordinary failure.
      for (const item of currentItems()) {
        if (item.state === "paused" && item.pauseReason === "auth") {
          patchItem(item.id, {
            state: "error",
            pauseReason: null,
            message: t("row.failed"),
            canRetry: true,
          });
          announce(t("live.failed", { name: shownName(item) }));
        }
      }
    });
}

// ---------------------------------------------------------------------------------------------
// Pause, resume, cancel, retry, remove.

function halt(id: string): void {
  const work = workOf(id);
  work.controller?.abort();
  work.controller = null;
  work.inFlight.clear();
  work.sample = null;
  stopHash(work);
}

function pauseOne(id: string, reason: PauseReason): void {
  const item = findItem(id);
  if (!item || !PAUSABLE.has(item.state) || item.completeSent) return;
  halt(id);
  patchItem(id, { state: "paused", pauseReason: reason, speed: 0, eta: null });
  measure(id);
}

export function pauseItem(id: string): void {
  pauseOne(id, "user");
}

/** Reasons a person may end by hand; `auth` ends with the sign-in. */
const BY_HAND: ReadonlySet<PauseReason> = new Set(["ceiling", "disabled", "limited", "open", "offline"]);

export function resumeItem(id: string): void {
  const item = findItem(id);
  if (!item || item.state !== "paused" || isRestored(item) || item.pauseReason === null) return;
  // Trying again by hand is how a queue pause is ended before its time (or when the browser is
  // wrong about being offline).
  if (BY_HAND.has(item.pauseReason)) {
    resumeQueue(item.pauseReason);
    return;
  }
  if (item.pauseReason !== "user") return;
  const blocked = Array.from(queuePauses)[0];
  if (blocked) patchItem(id, { pauseReason: blocked });
  else patchItem(id, { state: "queued", pauseReason: null });
  pump();
}

function pauseQueue(reason: PauseReason): void {
  queuePauses.add(reason);
  // A rate limit is soft: what is in flight finishes (aborting a body only to send it again
  // would be more traffic, not less) and waits at its next request; nothing new starts.
  const soft = SOFT.includes(reason);
  for (const item of currentItems()) {
    if (soft && works.get(item.id)?.running) continue;
    pauseOne(item.id, reason);
  }
}

function resumeQueue(reason: PauseReason): void {
  queuePauses.delete(reason);
  clearTimeout(pauseTimers.get(reason));
  pauseTimers.delete(reason);
  const blocked = Array.from(queuePauses)[0];
  for (const item of currentItems()) {
    if (item.state !== "paused" || item.pauseReason !== reason || isRestored(item)) continue;
    if (blocked) patchItem(item.id, { pauseReason: blocked });
    else patchItem(item.id, { state: "queued", pauseReason: null });
  }
  // Whoever waits at a gate looks again.
  const waiting = pauseWaiters;
  pauseWaiters = [];
  for (const look of waiting) look();
  pump();
}

function resumeQueueIn(reason: PauseReason, ms: number): void {
  const then = mark();
  clearTimeout(pauseTimers.get(reason));
  pauseTimers.set(
    reason,
    setTimeout(() => {
      if (live(then)) resumeQueue(reason);
    }, ms),
  );
}

export function pauseAll(): void {
  for (const item of currentItems()) pauseOne(item.id, "user");
}

export function resumeAll(): void {
  for (const item of currentItems()) {
    if (item.state === "paused" && item.pauseReason === "user") resumeItem(item.id);
  }
}

function release(item: UploadItem): void {
  halt(item.id);
  void dropResumeRow(item.id);
  // The server releases what the session reserved. Best effort: an expired session is gone anyway.
  if (item.uploadId && item.state !== "scanning" && item.state !== "done") {
    abortUpload(item.uploadId).catch(() => {});
  }
}

/** May this item still be taken back? Not once `complete` has been sent. */
export function canCancel(item: UploadItem): boolean {
  if (item.completeSent || item.state === "scanning") return false;
  return isLive(item) || item.state === "error";
}

export function cancelItem(id: string): void {
  const item = findItem(id);
  if (!item || !canCancel(item)) return;
  release(item);
  patchItem(id, {
    state: "cancelled",
    pauseReason: null,
    conflict: null,
    uploadId: null,
    speed: 0,
    eta: null,
  });
  announce(t("live.cancelled", { name: shownName(item) }));
  sweep();
  pump();
}

export function retryItem(id: string): void {
  const item = findItem(id);
  if (!item || item.state !== "error" || !item.canRetry || isRestored(item)) return;
  forgetFolderProblems(item);
  const blocked = Array.from(queuePauses)[0];
  patchItem(id, {
    state: blocked ? "paused" : "queued",
    pauseReason: blocked ?? null,
    message: null,
    requestId: null,
  });
  pump();
}

/** Take a row off the list: a finished one, a failed one, or a restored one nobody wants back. */
export function removeItem(id: string): void {
  const item = findItem(id);
  // A file whose `complete` is on its way stays until the answer is in.
  if (!item || item.state === "completing") return;
  // An unconfirmed upload may have landed: its session is left alone. Its row on the device
  // goes all the same — nothing is kept for an upload the user has taken off the list.
  if (item.completeSent) {
    halt(id);
    void dropResumeRow(id);
  } else release(item);
  works.delete(id);
  removeItems(new Set([id]));
  sweep();
  pump();
}

/** Once nothing is on its way, the rows that need no attention go. */
function sweep(): void {
  const items = currentItems();
  if (items.length === 0 || items.some(isLive)) return;
  const gone = new Set<string>();
  let finished = 0;
  for (const item of items) {
    const clean = item.state === "done" && (item.scanStatus === null || item.scanStatus === "clean");
    if (clean && item.kind === "file") finished += 1;
    if (clean || item.state === "cancelled") gone.add(item.id);
  }
  if (gone.size === 0) return;
  for (const id of gone) works.delete(id);
  removeItems(gone, gone.size === items.length ? finished : 0);
  // Batches nothing refers to any more.
  const used = new Set(currentItems().map((item) => item.batchId));
  for (const batchId of batches.keys()) if (!used.has(batchId)) batches.delete(batchId);
}

// ---------------------------------------------------------------------------------------------
// Conflicts. "Do the same for every other file" belongs to the upload it was ticked for (one
// `addFiles` call) and answers each file's question once.

export type ConflictChoice = "replace" | "rename" | "skip";

function choose(id: string, choice: ConflictChoice): boolean {
  const item = findItem(id);
  if (!item || item.state !== "conflict" || !item.conflict) return false;
  if (choice === "skip") {
    cancelItem(id);
    return true;
  }
  if (choice === "replace") {
    // Replace needs the file that is there, and is not offered twice once it was refused.
    if (!item.conflict.existingId || item.conflict.replaceRefused) return false;
    patchItem(id, { state: "queued", onConflict: "replace", replaceNodeId: item.conflict.existingId });
    return true;
  }
  patchItem(id, { state: "queued", onConflict: "rename", replaceNodeId: null, conflict: null });
  return true;
}

export function resolveConflict(id: string, choice: ConflictChoice, applyToAll: boolean): void {
  const batchId = findItem(id)?.batchId;
  if (!choose(id, choice)) return;
  if (applyToAll && batchId !== undefined) {
    const batch = batches.get(batchId);
    if (batch) batch.policy = choice;
    for (const item of currentItems()) {
      if (item.state === "conflict" && item.batchId === batchId) choose(item.id, choice);
    }
  }
  pump();
}

// ---------------------------------------------------------------------------------------------
// Adding files.

export interface IncomingFile {
  file: File;
  /** The folder path inside a folder upload ("photos/2026"); "" or absent for a loose file. */
  path?: string;
}

/** What could not be taken from a drop. */
export interface IntakeProblems {
  unreadable?: readonly string[];
  tooMany?: boolean;
}

function blankItem(
  file: File | null,
  meta: { name: string; size: number; lastModified: number },
  batchId: string,
  parentId: string | null,
  path: string,
): UploadItem {
  return {
    id: newId(),
    kind: "file",
    batchId,
    file,
    name: meta.name,
    size: meta.size,
    lastModified: meta.lastModified,
    parentId,
    path,
    state: "queued",
    pauseReason: null,
    progress: 0,
    sentBytes: 0,
    speed: 0,
    eta: null,
    uploadId: null,
    expiresAt: null,
    mode: null,
    partBytes: 0,
    partCount: 0,
    parts: [],
    finalName: null,
    nodeId: null,
    scanStatus: null,
    scanReason: null,
    message: null,
    requestId: null,
    canRetry: true,
    conflict: null,
    onConflict: "fail",
    replaceNodeId: null,
    resumeBody: null,
    waitingFolder: path !== "",
    completeSent: false,
    completeBody: null,
    unconfirmed: false,
  };
}

const sameFile = (
  a: { name: string; size: number; lastModified: number },
  b: { name: string; size: number; lastModified: number },
): boolean => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;

/** A restored row whose session has run out is dropped where it is met. */
function dropExpired(): void {
  const gone = new Set<string>();
  for (const item of currentItems()) {
    if (isRestored(item) && isExpired(item.expiresAt)) gone.add(item.id);
  }
  for (const id of gone) {
    void dropResumeRow(id);
    works.delete(id);
  }
  removeItems(gone);
}

/**
 * The session a fresh init was answered with is one a restored row was waiting on (a row the
 * device had no record of comes from the server's list under the session's STORED name, which is
 * not the file's after "Keep both"): that row is this upload, so it goes.
 */
function absorbRestored(id: string, uploadId: string): void {
  const twins = new Set<string>();
  for (const item of currentItems()) {
    if (item.id !== id && item.file === null && item.uploadId === uploadId) twins.add(item.id);
  }
  for (const twin of twins) {
    void dropResumeRow(twin);
    works.delete(twin);
  }
  removeItems(twins);
}

/** Give a restored row its file back. Returns whether `file` was one that a row waited for. */
function rejoin(file: File): boolean {
  const row = currentItems().find(
    (item) =>
      item.file === null &&
      item.resumeBody !== null &&
      matchesResume(
        { name: item.name, size: item.size, fileLastModified: item.resumeBody.fileLastModified },
        file,
      ),
  );
  if (!row) return false;
  const blocked = Array.from(queuePauses)[0];
  patchItem(row.id, {
    file,
    state: blocked ? "paused" : "queued",
    pauseReason: blocked ?? null,
    // Init runs again with the body as it was: the server answers with the open session. A row
    // whose `complete` was sent keeps its session: that question is asked again, nothing else.
    uploadId: row.completeSent ? row.uploadId : null,
  });
  return true;
}

/**
 * A file that was refused and is still on the list is not sent a second time by dropping it
 * again: the answer would be the same refusal.
 */
function refusedBefore(file: File): boolean {
  const again = currentItems().some((item) => item.state === "refused" && sameFile(item, file));
  if (again) announce(t("live.refused", { name: file.name }));
  return again;
}

/** Is the target the caller's own tree? Only then is the caller's free space the one that counts. */
async function ownTree(parentId: string | null): Promise<boolean> {
  if (parentId === null) return true;
  const userId = getCachedSession()?.user.id;
  if (!userId) return false;
  try {
    return (await getNode(parentId)).node.owner.id === userId;
  } catch {
    return false;
  }
}

async function freeBytes(parentId: string | null): Promise<number | null> {
  if (!(await ownTree(parentId))) return null;
  try {
    const usage = await getUsage();
    return usage.quotaBytes - usage.usedBytes;
  } catch {
    // Not known: the server checks the quota at init.
    return null;
  }
}

/** "a.jpg, b.jpg, c.jpg and 4 more". */
function listed(names: readonly string[]): string {
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? t("intake.listMore", { names: shown, more: names.length - 3 }) : shown;
}

/**
 * Queue files for `parentId` (null = the top level). `folders` are the folder paths of a folder
 * upload, including empty ones. `problems` is what a drop could not hand over. `then` is the
 * mark of the user's action (`actionMark()`), taken before anything asynchronous.
 */
export async function addFiles(
  incoming: readonly IncomingFile[],
  parentId: string | null,
  folders: readonly string[] = [],
  problems: IntakeProblems = {},
  then: ActionMark = mark(),
): Promise<void> {
  // Chosen under an account that is gone (a drop that was still being walked when the user
  // signed out, or another signed in): discarded whole — nothing queued, said or sent.
  if (!live(then)) return;
  if (problems.tooMany) {
    const sentence = t("intake.tooMany");
    toast({ message: sentence, key: "upload-too-many" });
    announce(sentence);
    return;
  }
  const unreadable = problems.unreadable ?? [];
  if (unreadable.length > 0) {
    // Said at once and by name: a folder upload that quietly leaves files out is no success.
    const sentence =
      unreadable.length === 1
        ? t("intake.unreadable.one", { names: listed(unreadable) })
        : t("intake.unreadable.other", { count: unreadable.length, names: listed(unreadable) });
    toast({ message: sentence, key: "upload-unreadable", duration: 12_000 });
    announce(sentence);
  }
  // A page that was opened offline never saw the event.
  if (typeof navigator !== "undefined" && navigator.onLine === false) queuePauses.add("offline");
  dropExpired();
  // The same file for the same place twice is one upload (the server would answer the second
  // init with the first one's session, and the two would then fight over it).
  const underway = new Set<string>();
  const keyOf = (
    target: string | null,
    path: string,
    file: { name: string; size: number; lastModified: number },
  ) => `${target ?? ""}\n${path}\n${file.name}\n${file.size}\n${file.lastModified}`;
  for (const item of currentItems()) {
    if (item.file === null || item.state === "cancelled" || item.state === "done" || item.state === "refused")
      continue;
    // Where it was added for: the upload's root (a file of a folder upload moves on to its folder).
    const batch = batches.get(item.batchId);
    underway.add(keyOf(batch ? batch.rootId : item.parentId, item.path, item));
  }
  const fresh = incoming.filter((entry) => {
    if (rejoin(entry.file) || refusedBefore(entry.file)) return false;
    const key = keyOf(parentId, entry.path ?? "", entry.file);
    if (underway.has(key)) return false;
    underway.add(key);
    return true;
  });
  pump();
  if (fresh.length === 0 && folders.length === 0) return;

  const config = queryClient.getQueryData(publicConfigQuery.queryKey);
  if (config && (!config.uploadsEnabled || config.readOnly)) {
    toast({ message: t("page.paused"), key: "upload-paused" });
    return;
  }
  const sized = fresh.map((entry) => ({ entry, name: entry.file.name, size: entry.file.size }));
  const first = preflight(sized, config?.maxFileBytes ?? null, null);
  const free = first.accepted.length > 0 ? await freeBytes(parentId) : null;
  // The account changed while the free space was being read: these files are nobody's now.
  if (!live(then)) return;
  const checked = preflight(sized, config?.maxFileBytes ?? null, free);
  if (checked.quota) {
    const sentence = t("preflight.quota", {
      needed: formatBytes(checked.quota.needed),
      free: formatBytes(checked.quota.free),
    });
    toast({ message: sentence, key: "upload-quota" });
    announce(sentence);
    return;
  }

  const batch = newBatch(parentId);
  const blocked = Array.from(queuePauses)[0];
  const items: UploadItem[] = [];
  for (const { entry } of checked.accepted) {
    const item = blankItem(entry.file, entry.file, batch.id, parentId, entry.path ?? "");
    if (blocked) Object.assign(item, { state: "paused", pauseReason: blocked });
    items.push(item);
  }
  for (const { file, reason } of checked.rejected) {
    const item = blankItem(file.entry.file, file.entry.file, batch.id, parentId, file.entry.path ?? "");
    const max = formatBytes(config?.maxFileBytes ?? 0);
    Object.assign(item, {
      state: "error",
      canRetry: false,
      message: reason === "too_large" ? t("preflight.tooLarge", { max }) : t("preflight.noName"),
    });
    items.push(item);
  }
  // Folders that hold a file are made when that file starts. A folder that holds none is a row
  // of its own — the deepest ones only, their parents are made on the way — so it waits, stops,
  // fails visibly and is tried again exactly like a file.
  const needed = new Set(foldersToCreate([...folders, ...items.map((item) => item.path)]));
  const withFiles = new Set(foldersToCreate(items.map((item) => item.path)));
  for (const path of needed) {
    if (withFiles.has(path)) continue;
    let leaf = true;
    for (const other of needed) if (other.startsWith(`${path}/`)) leaf = false;
    if (!leaf) continue;
    const row = blankItem(
      null,
      { name: lastSegment(path), size: 0, lastModified: 0 },
      batch.id,
      parentId,
      parentPath(path),
    );
    Object.assign(row, { kind: "folder", waitingFolder: false });
    if (blocked) Object.assign(row, { state: "paused", pauseReason: blocked });
    items.push(row);
  }
  addItems(items);
  for (const item of items) if (item.state === "error") announce(t("live.failed", { name: item.name }));

  pump();
}

// ---------------------------------------------------------------------------------------------
// After a reload.

function restoredItem(row: {
  id: string;
  uploadId: string;
  body: InitUploadBody;
  path: string;
  finalName: string;
  expiresAt: string;
  complete?: CompleteUploadBody;
}): UploadItem {
  return {
    ...blankItem(
      null,
      { name: row.body.name, size: row.body.size, lastModified: Date.parse(row.body.fileLastModified) },
      // A batch of its own: nothing of another upload's choices applies to it.
      newBatch(row.body.parentId).id,
      row.body.parentId,
      row.path,
    ),
    id: row.id,
    state: "paused",
    pauseReason: "user",
    uploadId: row.uploadId,
    expiresAt: row.expiresAt,
    // Titled with the name the user has on disk — the one the row asks for and matches.
    finalName: null,
    // `complete` was sent before the reload: the file may be there. Asked again, never re-sent.
    completeSent: row.complete !== undefined,
    completeBody: row.complete ?? null,
    onConflict: row.body.onConflict,
    replaceNodeId: row.body.replaceNodeId ?? null,
    resumeBody: row.body,
    // The body names the folder it was going to; there is nothing left to make.
    waitingFolder: false,
  };
}

/**
 * Put the resume list back into the queue as rows that wait for their file ("Select <name> again
 * to resume"). Rows of another account are deleted, never shown; so are rows whose session has
 * expired. With `server`, the list is checked against the caller's open sessions: a row whose
 * session is gone goes, and an open session this browser has no row for is added.
 */
export async function restoreUploads(options: { server?: boolean } = {}): Promise<void> {
  const then = mark();
  const userId = getCachedSession()?.user.id;
  if (!userId) return;
  // Each half runs once however many callers ask at the same moment (the frame and the page both
  // do): a second run beside the first would show every row twice.
  await (localRestore ??= restoreFromDevice(userId, then));
  if (!options.server || !live(then)) return;
  await (serverRestore ??= restoreFromServer(userId, then).then((done) => {
    // Not answered: the next caller asks again.
    if (!done && live(then)) serverRestore = null;
  }));
}

async function restoreFromDevice(userId: string, then: Mark): Promise<void> {
  const rows = await readResumeRows();
  if (!live(then)) return;
  const known = new Set(currentItems().map((item) => item.id));
  const mine = [];
  for (const row of rows) {
    if (row.userId !== userId) void dropResumeRow(row.id);
    else if (!known.has(row.id)) mine.push(restoredItem(row));
  }
  addItems(mine);
}

async function restoreFromServer(userId: string, then: Mark): Promise<boolean> {
  let sessions;
  try {
    sessions = await openUploads();
  } catch {
    return false;
  }
  if (!live(then)) return false;
  const open = new Set(sessions.map((session) => session.uploadId));
  const gone = new Set<string>();
  const held = new Set<string>();
  for (const item of currentItems()) {
    if (item.uploadId) held.add(item.uploadId);
    if (isRestored(item) && !item.completeSent && item.uploadId && !open.has(item.uploadId))
      gone.add(item.id);
  }
  for (const id of gone) {
    void dropResumeRow(id);
    works.delete(id);
  }
  removeItems(gone);
  const added: UploadItem[] = [];
  for (const session of sessions) {
    // A session without the file's date can never be matched to a file again.
    if (held.has(session.uploadId) || session.fileLastModified === null) continue;
    if (isExpired(session.expiresAt)) continue;
    const body: InitUploadBody = {
      parentId: session.parentId,
      name: session.name,
      size: session.size,
      mimeDeclared: "",
      fileLastModified: session.fileLastModified,
      onConflict: "fail",
      purpose: "file",
    };
    const row = {
      id: newId(),
      userId,
      uploadId: session.uploadId,
      body,
      path: "",
      finalName: session.name,
      expiresAt: session.expiresAt,
    };
    added.push(restoredItem(row));
    void saveResumeRow(row);
  }
  addItems(added);
  return true;
}

// ---------------------------------------------------------------------------------------------
// The account's state ends here.

/** Everything in memory: abort what is in flight and empty the queue. */
function dropQueue(): void {
  epoch += 1;
  queueOwner = mark();
  for (const work of works.values()) {
    work.controller?.abort();
    work.hash?.cancel();
  }
  works.clear();
  for (const batch of batches.values()) for (const flight of batch.flying.values()) flight.controller.abort();
  batches.clear();
  queuePauses.clear();
  for (const timer of pauseTimers.values()) clearTimeout(timer);
  pauseTimers.clear();
  pauseWaiters = [];
  scanQueue = [];
  frameUp = true;
  clearTimeout(scanTimer);
  scanTimer = undefined;
  scanBusy = false;
  scanAsking = [];
  verdictsSaid.clear();
  scanPausedSince = null;
  scanBackoff = 0;
  scanNotBefore = 0;
  localRestore = null;
  serverRestore = null;
  authProbe = null;
  authGateSeen = false;
  resetPicker();
  resetStore();
}

/**
 * Abort what is in flight, empty the queue and empty the resume list. Run by the shell on
 * sign-out and whenever the signed-in identity changes.
 */
export async function purgeUploads(): Promise<void> {
  dropQueue();
  await clearResumeRows();
}

/** Tests only: what a reload does to the page — memory is gone, the device's list is not. */
export function forgetUploadsForTests(): void {
  dropQueue();
}

registerUserStatePurger(purgeUploads);

// The connection, the session and the tab, for the whole queue.
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => pauseQueue("offline"));
  window.addEventListener("online", () => resumeQueue("offline"));
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    authGateSeen = true;
    pauseQueue("auth");
  });
  window.addEventListener(AUTH_RESTORED_EVENT, () => resumeQueue("auth"));
  document.addEventListener("visibilitychange", () => {
    syncScanClock();
    if (tabHidden()) {
      clearTimeout(scanTimer);
      scanTimer = undefined;
    } else {
      scheduleScan(SCAN_INTERVAL_MS);
    }
  });
}
