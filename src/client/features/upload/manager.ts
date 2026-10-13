// The upload manager: the queue's scheduler and the one writer of `store.ts`.
//
//   queued → uploading → (hashing, when the digest lags) → completing → scanning → done
//
// Three files at a time, three parts per file. A request that fails on the network or with a 5xx
// is tried again on the schedule in `plan.ts`; every other answer has one meaning (see `fail`).
// Pausing aborts what is in flight and keeps what the server already has: resuming sends only the
// missing parts, with no new init.
//
// The queue belongs to the signed-in account. `purgeUploads` — registered with the shell — aborts
// everything, empties the queue and the resume list, and moves the epoch on, so a request that
// was in flight for the previous account changes nothing when it comes back.
import type { NodeDto } from "../../../shared/schemas/node";
import type { InitUploadBody, InitUploadResponse, UploadedPart } from "../../../shared/schemas/upload";
import { toast } from "../../components/Toaster";
import { ApiError, AUTH_EXPIRED_EVENT, AUTH_RESTORED_EVENT } from "../../lib/api";
import { emitNodesChanged, registerUserStatePurger } from "../../lib/contracts";
import { formatBytes } from "../../lib/format";
import { getCachedSession, publicConfigQuery, queryClient } from "../../lib/query";
import { startHashInWorker, type HashJob, type StartHash } from "./hashing";
import {
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
  RETRY_DELAYS_MS,
  sortedParts,
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
import { clearResumeRows, dropResumeRow, readResumeRows, saveResumeRow } from "./resume-list";
import {
  addItems,
  announce,
  currentItems,
  findItem,
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
// Per-item working state that no component reads.

interface Work {
  /** Aborts the run in flight; null when none is. */
  controller: AbortController | null;
  running: boolean;
  phase: "init" | "send" | "complete";
  hash: HashJob | null;
  sha256: string | null;
  hashFailed: boolean;
  /** Bytes of each body in flight, by part number (0 = the single PUT). */
  inFlight: Map<number, number>;
  sample: { at: number; bytes: number } | null;
  started: boolean;
  poll: AbortController | null;
}

const works = new Map<string, Work>();
/** Reasons the whole queue is paused for. */
const queuePauses = new Set<PauseReason>();
const folderRuns = new Set<AbortController>();
let epoch = 0;
let ceilingTimer: ReturnType<typeof setTimeout> | undefined;
let conflictPolicy: ConflictChoice | null = null;
let restored = false;
let reconciled = false;
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
      poll: null,
    };
    works.set(id, work);
  }
  return work;
}

function newId(): string {
  nextId += 1;
  return `u${Date.now().toString(36)}-${nextId}-${Math.random().toString(36).slice(2, 10)}`;
}

const LIVE: ReadonlySet<UploadState> = new Set([
  "queued",
  "hashing",
  "uploading",
  "completing",
  "scanning",
  "conflict",
]);
const SENDING: ReadonlySet<UploadState> = new Set(["queued", "hashing", "uploading", "completing"]);

/** Still on its way: not finished, not failed, and not a restored row waiting for its file. */
function isLive(item: UploadItem): boolean {
  return LIVE.has(item.state) || (item.state === "paused" && item.file !== null);
}

const shownName = (item: UploadItem): string => item.finalName ?? item.name;

function isAbort(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === "AbortError";
}

function abortError(): DOMException {
  return new DOMException("The upload was stopped.", "AbortError");
}

// ---------------------------------------------------------------------------------------------
// Retry: network failures and 5xx only.

function isRetryable(cause: unknown): boolean {
  if (!(cause instanceof ApiError)) return false;
  if (cause.code === "network") return true;
  if (cause.code === "rate_limited") return true;
  if (cause.status < 500) return false;
  // A kill switch is an answer, not a blip.
  return cause.code !== "feature_disabled" && cause.code !== "read_only";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

/** Run `request`; on a retryable failure wait and run it again, through the whole schedule. */
async function retrying<T>(request: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await request();
    } catch (cause) {
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !isRetryable(cause)) throw cause;
      const asked = cause instanceof ApiError && cause.retryAfter ? cause.retryAfter * 1000 : 0;
      await sleep(Math.max(delay, asked), signal);
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
        reject(cause instanceof Error ? cause : new Error(String(cause)));
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
// The scheduler.

function pump(): void {
  if (queuePauses.size > 0) return;
  let running = 0;
  for (const work of works.values()) if (work.running) running += 1;
  for (const item of currentItems()) {
    if (running >= FILE_CONCURRENCY) return;
    if (item.state !== "queued" || item.waitingFolder || item.file === null) continue;
    const work = workOf(item.id);
    if (work.running) continue;
    running += 1;
    start(item.id);
  }
}

function start(id: string): void {
  const work = workOf(id);
  const controller = new AbortController();
  const runEpoch = epoch;
  work.controller = controller;
  work.running = true;
  void run(id, controller.signal, runEpoch)
    .catch((cause: unknown) => {
      if (runEpoch === epoch) fail(id, cause);
    })
    .finally(() => {
      if (runEpoch !== epoch) return;
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
  void saveResumeRow({
    id: item.id,
    userId,
    uploadId: init.uploadId,
    body,
    path: item.path,
    finalName: init.finalName,
  });
}

async function run(id: string, signal: AbortSignal, runEpoch: number): Promise<void> {
  const work = workOf(id);
  /** The item, or null when this run is no longer the one that counts. */
  const current = (): UploadItem | null => {
    if (runEpoch !== epoch || signal.aborted) return null;
    return findItem(id) ?? null;
  };
  let item = current();
  const file = item?.file;
  if (!item || !file) return;

  if (!work.started) {
    work.started = true;
    announce(t("live.start", { name: item.name }));
  }
  if (!work.hash && !work.sha256) {
    work.hashFailed = false;
    try {
      const job = runtime.startHash(file);
      work.hash = job;
      job.promise.then(
        (sha256) => {
          if (work.hash === job) work.sha256 = sha256;
        },
        () => {
          if (work.hash === job) work.hashFailed = true;
        },
      );
    } catch {
      work.hashFailed = true;
    }
  }

  if (!item.uploadId) {
    work.phase = "init";
    patchItem(id, { state: "uploading", pauseReason: null, message: null, requestId: null });
    const body = initBodyOf(item, file);
    const init = await retrying(() => initUpload(body, signal), signal);
    item = current();
    if (!item) return;
    patchItem(id, {
      uploadId: init.uploadId,
      mode: init.mode,
      partBytes: init.partBytes,
      partCount: init.partCount,
      parts: init.mode === "multipart" ? sortedParts(init.resumedParts) : [],
      finalName: init.finalName,
      resumeBody: null,
    });
    keepForResume(item, body, init);
  } else {
    patchItem(id, { state: "uploading", pauseReason: null, message: null, requestId: null });
  }
  measure(id);

  work.phase = "send";
  item = current();
  if (!item?.uploadId) return;
  const uploadId = item.uploadId;
  if (item.mode === "single") {
    if (item.parts.length === 0) {
      const { etag } = await retrying(
        () =>
          putSingle(runtime.put, uploadId, file, {
            signal,
            onProgress: (loaded) => {
              if (!current()) return;
              work.inFlight.set(0, loaded);
              measure(id);
            },
          }),
        signal,
      );
      if (!current()) return;
      // The mark that the body is with the server; `complete` sends no parts for a single PUT.
      work.inFlight.delete(0);
      patchItem(id, { parts: [{ n: 1, etag }] });
      measure(id);
    }
  } else {
    await sendParts(id, uploadId, file, signal, current);
  }

  item = current();
  if (!item) return;
  if (!work.sha256) {
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
  if (!item) return;

  work.phase = "complete";
  patchItem(id, { state: "completing", progress: 1, sentBytes: item.size, eta: null });
  const sha256 = work.sha256;
  const parts = item.mode === "single" ? [] : sortedParts(item.parts);
  const node = await retrying(() => completeUpload(uploadId, { sha256, parts }, signal), signal);
  if (!current()) return;
  landed(id, node, runEpoch);
}

class UnreadableFile extends Error {}

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
      const n = waiting.shift();
      if (n === undefined || failed || group.signal.aborted) return;
      const { start: from, end: to } = partRange(n, partBytes, size);
      try {
        const answer = await retrying(
          () =>
            putPart(runtime.put, uploadId, n, file.slice(from, to), {
              signal: group.signal,
              onProgress: (loaded) => {
                if (!current()) return;
                work.inFlight.set(n, Math.min(loaded, to - from));
                measure(id);
              },
            }),
          group.signal,
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
// After the file landed: tell the other features, then follow the scan.

/** Waits between two reads of the scan state; the last one repeats. */
export const SCAN_POLL_MS = [1_000, 1_000, 2_000, 2_000, 3_000, 5_000] as const;
/** After this long a file still `pending` is left to the listing to show. */
export const SCAN_POLL_LIMIT_MS = 5 * 60_000;

function landed(id: string, node: NodeDto, runEpoch: number): void {
  const item = findItem(id);
  if (!item) return;
  void dropResumeRow(id);
  workOf(id).hash = null;
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
  announce(t("live.done", { name: node.name }));
  if (node.scanStatus !== "pending") settleScan(id, node);
  else void pollScan(id, node.id, runEpoch);
}

function settleScan(id: string, node: Pick<NodeDto, "scanStatus" | "scanReason" | "name">): void {
  const item = findItem(id);
  if (!item) return;
  patchItem(id, { state: "done", scanStatus: node.scanStatus, scanReason: node.scanReason });
  if (node.scanStatus === "infected") announce(t("live.blocked", { name: node.name }));
  else if (node.scanStatus === "error" || node.scanStatus === "skipped")
    announce(t("live.unscanned", { name: node.name }));
  // The listing shows the same status: let it read it now rather than at its next refresh.
  emitNodesChanged([item.parentId]);
  sweep();
}

async function pollScan(id: string, nodeId: string, runEpoch: number): Promise<void> {
  const work = workOf(id);
  const controller = new AbortController();
  work.poll = controller;
  const { signal } = controller;
  const began = Date.now();
  try {
    for (let round = 0; Date.now() - began < SCAN_POLL_LIMIT_MS; round += 1) {
      await sleep(SCAN_POLL_MS[Math.min(round, SCAN_POLL_MS.length - 1)]!, signal);
      let detail;
      try {
        detail = await getNode(nodeId, signal);
      } catch (cause) {
        if (isAbort(cause)) return;
        // The file is gone, or no longer ours to see: there is nothing left to follow.
        if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) break;
        continue;
      }
      if (runEpoch !== epoch || signal.aborted) return;
      if (detail.node.scanStatus !== "pending") {
        settleScan(id, detail.node);
        return;
      }
    }
  } catch (cause) {
    if (isAbort(cause)) return;
  }
  if (runEpoch !== epoch || signal.aborted) return;
  // Not known: the row just completes, and the listing shows the status when there is one.
  patchItem(id, { state: "done", scanStatus: null });
  sweep();
}

// ---------------------------------------------------------------------------------------------
// Failures: one meaning per answer.

function forgetSession(id: string): void {
  void dropResumeRow(id);
  const work = workOf(id);
  work.inFlight.clear();
  work.sample = null;
  patchItem(id, { uploadId: null, mode: null, parts: [], sentBytes: 0, progress: 0, speed: 0, eta: null });
}

function fail(id: string, cause: unknown): void {
  const item = findItem(id);
  if (!item || isAbort(cause)) return;
  const work = workOf(id);
  work.inFlight.clear();
  const name = shownName(item);

  if (cause instanceof UnreadableFile) {
    work.hash = null;
    work.sha256 = null;
    patchItem(id, { state: "error", message: t("row.unreadable"), requestId: null, canRetry: true });
    announce(t("live.failed", { name }));
    return;
  }
  if (!(cause instanceof ApiError)) {
    patchItem(id, { state: "error", message: t("row.failed"), requestId: null, canRetry: true });
    announce(t("live.failed", { name }));
    return;
  }
  const reason = typeof cause.details?.reason === "string" ? cause.details.reason : undefined;

  // No session: the queue waits for the sign-in and then goes on where it was.
  if (cause.status === 401) {
    patchItem(id, { state: "paused", pauseReason: "auth" });
    // A JSON call that ends in 401 has been through the sign-in already (and was given up).
    if (work.phase === "send") probeSession();
    return;
  }
  // Blocked content is final for this file: no retry, no resume, nothing to try again.
  if (cause.status === 403 && reason === "blocked_content") {
    work.hash?.cancel();
    work.hash = null;
    void dropResumeRow(id);
    patchItem(id, {
      state: "refused",
      message: t("row.refused"),
      requestId: cause.requestId ?? null,
      canRetry: false,
      uploadId: null,
      speed: 0,
      eta: null,
    });
    announce(t("live.refused", { name }));
    return;
  }
  if (cause.status === 409 && work.phase === "init") {
    const existingId = typeof cause.details?.existingId === "string" ? cause.details.existingId : null;
    patchItem(id, {
      state: "conflict",
      conflict: {
        existingId: item.onConflict === "replace" ? (item.conflict?.existingId ?? null) : existingId,
        replaceRefused: item.onConflict === "replace" ? cause.message : null,
      },
      onConflict: "fail",
      replaceNodeId: null,
      // A restored row that meets a conflict has lost its session: from here it is a new upload.
      resumeBody: null,
      uploadId: null,
    });
    void dropResumeRow(id);
    if (!applyPolicy(id)) announce(t("live.conflict", { name }));
    return;
  }
  if (cause.code === "ceiling_exceeded") {
    patchItem(id, { state: "paused", pauseReason: "ceiling" });
    pauseQueue("ceiling");
    clearTimeout(ceilingTimer);
    if (cause.retryAfter !== undefined) {
      ceilingTimer = setTimeout(() => resumeQueue("ceiling"), cause.retryAfter * 1000);
    }
    return;
  }
  if (cause.code === "feature_disabled") {
    patchItem(id, { state: "paused", pauseReason: "disabled" });
    pauseQueue("disabled");
    return;
  }
  // The session is gone (expired, aborted, or its folder is): a new try starts from the top.
  if (work.phase !== "init" && (cause.status === 404 || cause.status === 409)) forgetSession(id);
  const ours = cause.code === "network" || cause.code === "invalid_response" || cause.status >= 500;
  patchItem(id, {
    state: "error",
    message: ours || cause.code === "http_error" ? t("row.failed") : cause.message,
    requestId: cause.requestId ?? null,
    canRetry: cause.code !== "file_too_large",
    speed: 0,
    eta: null,
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
  const probeEpoch = epoch;
  authGateSeen = false;
  authProbe = openUploads()
    .then(
      () => true,
      (cause: unknown) => !(cause instanceof ApiError && cause.status === 401),
    )
    .then((answered) => {
      authProbe = null;
      if (probeEpoch !== epoch || authGateSeen || !answered) return;
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
}

function pauseOne(id: string, reason: PauseReason): void {
  const item = findItem(id);
  if (!item || !SENDING.has(item.state)) return;
  halt(id);
  patchItem(id, { state: "paused", pauseReason: reason, speed: 0, eta: null });
  measure(id);
}

export function pauseItem(id: string): void {
  pauseOne(id, "user");
}

export function resumeItem(id: string): void {
  const item = findItem(id);
  if (!item || item.state !== "paused" || item.file === null) return;
  // Trying again by hand is how a ceiling or switch pause is ended before its time.
  if (item.pauseReason === "ceiling" || item.pauseReason === "disabled") {
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
  for (const item of currentItems()) pauseOne(item.id, reason);
}

function resumeQueue(reason: PauseReason): void {
  queuePauses.delete(reason);
  if (reason === "ceiling") clearTimeout(ceilingTimer);
  const blocked = Array.from(queuePauses)[0];
  for (const item of currentItems()) {
    if (item.state !== "paused" || item.pauseReason !== reason || item.file === null) continue;
    if (blocked) patchItem(item.id, { pauseReason: blocked });
    else patchItem(item.id, { state: "queued", pauseReason: null });
  }
  pump();
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
  const work = workOf(item.id);
  halt(item.id);
  work.hash?.cancel();
  work.hash = null;
  work.poll?.abort();
  void dropResumeRow(item.id);
  // The server releases what the session reserved. Best effort: an expired session is gone anyway.
  if (item.uploadId && item.state !== "scanning" && item.state !== "done") {
    abortUpload(item.uploadId).catch(() => {});
  }
}

export function cancelItem(id: string): void {
  const item = findItem(id);
  if (!item || !(isLive(item) || item.state === "error") || item.state === "scanning") return;
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
  if (!item || item.state !== "error" || !item.canRetry || item.file === null) return;
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
  if (!item) return;
  release(item);
  works.delete(id);
  removeItems(new Set([id]));
  sweep();
  pump();
}

/** Once nothing is on its way, the rows that need no attention go. */
function sweep(): void {
  const items = currentItems();
  if (items.length === 0 || items.some(isLive)) return;
  conflictPolicy = null;
  const gone = new Set<string>();
  let finished = 0;
  for (const item of items) {
    const clean = item.state === "done" && (item.scanStatus === null || item.scanStatus === "clean");
    if (clean) finished += 1;
    if (clean || item.state === "cancelled") gone.add(item.id);
  }
  if (gone.size === 0) return;
  for (const id of gone) works.delete(id);
  removeItems(gone, gone.size === items.length ? finished : 0);
}

// ---------------------------------------------------------------------------------------------
// Conflicts.

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

function applyPolicy(id: string): boolean {
  // The run that met the conflict is still unwinding; it pumps the queue when it has.
  return conflictPolicy !== null && choose(id, conflictPolicy);
}

export function resolveConflict(id: string, choice: ConflictChoice, applyToAll: boolean): void {
  if (!choose(id, choice)) return;
  if (applyToAll) {
    conflictPolicy = choice;
    for (const item of currentItems()) if (item.state === "conflict") choose(item.id, choice);
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

function blankItem(
  file: File | null,
  meta: { name: string; size: number; lastModified: number },
  parentId: string | null,
  path: string,
): UploadItem {
  return {
    id: newId(),
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
    waitingFolder: false,
  };
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
    // Init runs again with the body as it was: the server answers with the open session.
    uploadId: null,
  });
  return true;
}

/**
 * A file that was refused and is still on the list is not sent a second time by dropping it
 * again: the answer would be the same refusal.
 */
function refusedBefore(file: File): boolean {
  const again = currentItems().some(
    (item) =>
      item.state === "refused" &&
      item.name === file.name &&
      item.size === file.size &&
      item.lastModified === file.lastModified,
  );
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

/**
 * Queue files for `parentId` (null = the top level). `folders` are the folder paths of a folder
 * upload, including empty ones; they are created first.
 */
export async function addFiles(
  incoming: readonly IncomingFile[],
  parentId: string | null,
  folders: readonly string[] = [],
): Promise<void> {
  const addEpoch = epoch;
  const fresh = incoming.filter((entry) => !rejoin(entry.file) && !refusedBefore(entry.file));
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
  if (addEpoch !== epoch) return;
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

  const blocked = Array.from(queuePauses)[0];
  const items: UploadItem[] = [];
  for (const { entry } of checked.accepted) {
    const item = blankItem(entry.file, entry.file, parentId, entry.path ?? "");
    if (item.path !== "") item.waitingFolder = true;
    if (blocked) Object.assign(item, { state: "paused", pauseReason: blocked });
    items.push(item);
  }
  for (const { file, reason } of checked.rejected) {
    const item = blankItem(file.entry.file, file.entry.file, parentId, file.entry.path ?? "");
    const max = formatBytes(config?.maxFileBytes ?? 0);
    Object.assign(item, {
      state: "error",
      canRetry: false,
      message: reason === "too_large" ? t("preflight.tooLarge", { max }) : t("preflight.noName"),
    });
    items.push(item);
  }
  addItems(items);
  for (const item of items) if (item.state === "error") announce(t("live.failed", { name: item.name }));

  const paths = [...folders, ...items.map((item) => item.path)].filter((path) => path !== "");
  if (paths.length > 0) {
    void makeFolders(foldersToCreate(paths), parentId, new Set(items.map((item) => item.id)), addEpoch);
  }
  pump();
}

/**
 * Create the folders of a folder upload, parents first, each once. A name that a folder already
 * holds is that folder (the server says which); a name something else holds fails that subtree
 * and nothing else. The folder's children are never listed to find out.
 */
async function makeFolders(
  folders: string[],
  rootId: string | null,
  batch: ReadonlySet<string>,
  runEpoch: number,
): Promise<void> {
  const controller = new AbortController();
  folderRuns.add(controller);
  const { signal } = controller;
  type Outcome = { id: string | null } | { error: string };
  const made = new Map<string, Outcome>([["", { id: rootId }]]);
  try {
    for (const folder of folders) {
      const parent = made.get(parentPath(folder)) ?? { error: t("row.failed") };
      const name = lastSegment(folder);
      let outcome: Outcome;
      if ("error" in parent) outcome = parent;
      else {
        try {
          const node = await retrying(() => createFolder({ parentId: parent.id, name }, signal), signal);
          if (runEpoch !== epoch) return;
          emitNodesChanged([parent.id]);
          outcome = { id: node.id };
        } catch (cause) {
          if (isAbort(cause) || runEpoch !== epoch) return;
          const existingId = cause instanceof ApiError ? cause.details?.existingId : undefined;
          if (cause instanceof ApiError && cause.status === 409 && typeof existingId === "string") {
            outcome = { id: existingId };
          } else if (cause instanceof ApiError && cause.status === 409) {
            outcome = { error: t("folder.taken", { name }) };
          } else {
            outcome = { error: t("folder.failed", { name }) };
          }
        }
      }
      made.set(folder, outcome);
      for (const item of currentItems()) {
        if (!batch.has(item.id) || item.path !== folder || !item.waitingFolder) continue;
        if ("error" in outcome) {
          patchItem(item.id, {
            state: "error",
            waitingFolder: false,
            message: outcome.error,
            canRetry: false,
          });
          announce(t("live.failed", { name: item.name }));
        } else {
          patchItem(item.id, { parentId: outcome.id, waitingFolder: false });
        }
      }
      pump();
    }
  } finally {
    folderRuns.delete(controller);
    if (runEpoch === epoch) sweep();
  }
}

// ---------------------------------------------------------------------------------------------
// After a reload.

function restoredItem(row: {
  id: string;
  uploadId: string;
  body: InitUploadBody;
  path: string;
  finalName: string;
}): UploadItem {
  return {
    ...blankItem(
      null,
      { name: row.body.name, size: row.body.size, lastModified: Date.parse(row.body.fileLastModified) },
      row.body.parentId,
      row.path,
    ),
    id: row.id,
    state: "paused",
    pauseReason: "user",
    uploadId: row.uploadId,
    finalName: row.finalName,
    onConflict: row.body.onConflict,
    replaceNodeId: row.body.replaceNodeId ?? null,
    resumeBody: row.body,
  };
}

/**
 * Put the resume list back into the queue as rows that wait for their file ("Select <name> again
 * to resume"). Rows of another account are deleted, never shown. With `server`, the list is
 * checked against the caller's open sessions: a row whose session is gone goes, and an open
 * session this browser has no row for is added.
 */
export async function restoreUploads(options: { server?: boolean } = {}): Promise<void> {
  const runEpoch = epoch;
  const userId = getCachedSession()?.user.id;
  if (!userId) return;
  if (!restored) {
    restored = true;
    const rows = await readResumeRows();
    if (runEpoch !== epoch) return;
    const known = new Set(currentItems().map((item) => item.id));
    const mine = [];
    for (const row of rows) {
      if (row.userId !== userId) void dropResumeRow(row.id);
      else if (!known.has(row.id)) mine.push(restoredItem(row));
    }
    addItems(mine);
  }
  if (!options.server || reconciled) return;
  let sessions;
  try {
    sessions = await openUploads();
  } catch {
    return;
  }
  if (runEpoch !== epoch) return;
  reconciled = true;
  const open = new Set(sessions.map((session) => session.uploadId));
  const gone = new Set<string>();
  const held = new Set<string>();
  for (const item of currentItems()) {
    if (item.uploadId) held.add(item.uploadId);
    if (item.file === null && item.uploadId && !open.has(item.uploadId)) gone.add(item.id);
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
    const body: InitUploadBody = {
      parentId: session.parentId,
      name: session.name,
      size: session.size,
      mimeDeclared: "",
      fileLastModified: session.fileLastModified,
      onConflict: "fail",
      purpose: "file",
    };
    const item = restoredItem({
      id: newId(),
      uploadId: session.uploadId,
      body,
      path: "",
      finalName: session.name,
    });
    added.push(item);
    void saveResumeRow({
      id: item.id,
      userId,
      uploadId: session.uploadId,
      body,
      path: "",
      finalName: session.name,
    });
  }
  addItems(added);
}

// ---------------------------------------------------------------------------------------------
// The account's state ends here.

/** Everything in memory: abort what is in flight and empty the queue. */
function dropQueue(): void {
  epoch += 1;
  for (const work of works.values()) {
    work.controller?.abort();
    work.hash?.cancel();
    work.poll?.abort();
  }
  works.clear();
  for (const controller of folderRuns) controller.abort();
  folderRuns.clear();
  queuePauses.clear();
  clearTimeout(ceilingTimer);
  conflictPolicy = null;
  restored = false;
  reconciled = false;
  authProbe = null;
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

// The connection and the session, for the whole queue.
if (typeof window !== "undefined") {
  window.addEventListener("offline", () => pauseQueue("offline"));
  window.addEventListener("online", () => resumeQueue("offline"));
  window.addEventListener(AUTH_EXPIRED_EVENT, () => {
    authGateSeen = true;
    pauseQueue("auth");
  });
  window.addEventListener(AUTH_RESTORED_EVENT, () => resumeQueue("auth"));
}
