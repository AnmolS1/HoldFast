// The upload queue: a module-scope store, so it survives route changes without a provider.
// `manager.ts` is the only writer; components read it with `useUploads()`.
import { useSyncExternalStore } from "react";
import type { ScanReason, ScanStatus } from "../../../shared/schemas/common";
import type { CompleteUploadBody, InitUploadBody, UploadedPart } from "../../../shared/schemas/upload";

/**
 * `refused` is final (blocked content): never retried, never resumable. `conflict` waits for the
 * user's choice. A file that landed is `scanning` and then `done`; what the scan said is in
 * `scanStatus` (`pending` on a `done` row: the scan was still running when this stopped asking).
 */
export type UploadState =
  | "queued"
  | "hashing"
  | "uploading"
  | "completing"
  | "scanning"
  | "done"
  | "error"
  | "paused"
  | "cancelled"
  | "refused"
  | "conflict";

/**
 * Why an item is paused. Every reason but `user` belongs to the whole queue: no connection, no
 * session, the daily ceiling, the upload switch, a rate limit (`limited`), too many open sessions
 * (`open`).
 */
export type PauseReason = "user" | "offline" | "auth" | "ceiling" | "disabled" | "limited" | "open";

export interface UploadConflict {
  /** The file that holds the name, when the server says which. Replace needs it. */
  existingId: string | null;
  /** Set once a replace was refused: the sentence to show. */
  replaceRefused: string | null;
}

export interface UploadItem {
  id: string;
  /** A file, or a folder of a folder upload that holds no file (it has no bytes, only a name to create). */
  kind: "file" | "folder";
  /** The `addFiles` call it came in with: its folders and its "do the same for every other". */
  batchId: string;
  /** Null for a row restored after a reload, until the file is selected again. */
  file: File | null;
  name: string;
  size: number;
  /** Milliseconds, as `File.lastModified`. */
  lastModified: number;
  parentId: string | null;
  /** The folder path inside a folder upload ("photos/2026"), else "". */
  path: string;
  state: UploadState;
  pauseReason: PauseReason | null;
  /** 0..1 of this file's bytes. */
  progress: number;
  sentBytes: number;
  /** Bytes per second; 0 = not known. */
  speed: number;
  /** Seconds left; null = not known. */
  eta: number | null;
  uploadId: string | null;
  /** When the server's session ends; a restored row past it is dropped. */
  expiresAt: string | null;
  mode: "single" | "multipart" | null;
  partBytes: number;
  partCount: number;
  /** The parts the server has. */
  parts: UploadedPart[];
  /** The name the file gets (after a rename on conflict). */
  finalName: string | null;
  nodeId: string | null;
  scanStatus: ScanStatus | null;
  scanReason: ScanReason | null;
  /** What to show for `error`: the server's sentence, or ours. */
  message: string | null;
  requestId: string | null;
  canRetry: boolean;
  conflict: UploadConflict | null;
  onConflict: InitUploadBody["onConflict"];
  replaceNodeId: string | null;
  /** The init body of a restored row, sent again as it was once the file is back. */
  resumeBody: InitUploadBody | null;
  /** Its folder (of a folder upload) is not created yet; `parentId` is the upload's root until then. */
  waitingFolder: boolean;
  /**
   * `complete` has been sent: the file may have landed whatever came back. From here the item is
   * never paused or cancelled, and a new try asks `complete` again before anything else.
   */
  completeSent: boolean;
  /** The body `complete` was sent with: the same one is asked again, every time. */
  completeBody: CompleteUploadBody | null;
  /** An `error` that is not a failure: nobody could say whether the file landed. */
  unconfirmed: boolean;
}

/** A row put back after a reload that still waits for its file to be selected again. */
export function isRestored(item: UploadItem): boolean {
  return item.kind === "file" && item.file === null;
}

export interface Announcement {
  id: number;
  text: string;
}

export interface UploadSnapshot {
  items: readonly UploadItem[];
  /** The latest per-item announcements, oldest first. */
  announcements: readonly Announcement[];
  /** Files that landed in the batch that just ended (the ribbon's closing sentence). */
  finished: number;
}

const ANNOUNCEMENTS_KEPT = 20;
/** Progress samples reach the components at most this often. */
export const PROGRESS_FLUSH_MS = 200;

const EMPTY: UploadSnapshot = { items: [], announcements: [], finished: 0 };

// Kept by id, in the order added: a change to one item of ten thousand costs one map write, and
// the array the components read is built once per publish.
let items = new Map<string, UploadItem>();
let list: UploadItem[] | null = [];
let announcements: readonly Announcement[] = [];
let finished = 0;
let dirty = false;
let published: UploadSnapshot = EMPTY;
let announcementId = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

/** A change readers must see at once is waiting for the end of the current task's work. */
let loud = false;
/** The snapshot was renewed and the listeners have not been told yet. */
let untold = false;

function renew(): void {
  if (!dirty) return;
  dirty = false;
  untold = true;
  published = { items: currentItems(), announcements, finished };
}

function flush(): void {
  clearTimeout(timer);
  timer = undefined;
  loud = false;
  renew();
  if (!untold) return;
  untold = false;
  for (const listener of Array.from(listeners)) listener();
}

/** `quiet` changes (progress samples) are coalesced; everything else is published at once. */
function touch(quiet: boolean): void {
  dirty = true;
  if (quiet) timer ??= setTimeout(flush, PROGRESS_FLUSH_MS);
  else if (!loud) {
    // One publication for a burst of changes (a run's steps, a pump starting three files):
    // the listeners are told once, at the end of it. A reader in between still sees every change.
    loud = true;
    queueMicrotask(flush);
  }
}

/** The queue as the manager sees it — ahead of `getUploads()` by at most one progress flush. */
export function currentItems(): readonly UploadItem[] {
  return (list ??= Array.from(items.values()));
}

export function findItem(id: string): UploadItem | undefined {
  return items.get(id);
}

export function addItems(added: UploadItem[]): void {
  if (added.length === 0) return;
  for (const item of added) items.set(item.id, item);
  list = null;
  finished = 0;
  touch(false);
}

export function patchItem(id: string, patch: Partial<UploadItem>, quiet = false): void {
  const item = items.get(id);
  if (!item) return;
  items.set(id, { ...item, ...patch });
  list = null;
  touch(quiet);
}

export function removeItems(ids: ReadonlySet<string>, landed?: number): void {
  let removed = false;
  for (const id of ids) removed = items.delete(id) || removed;
  if (!removed && landed === undefined) return;
  list = null;
  if (landed !== undefined) finished = landed;
  touch(false);
}

export function announce(text: string): void {
  announcements = [...announcements, { id: ++announcementId, text }].slice(-ANNOUNCEMENTS_KEPT);
  touch(false);
}

export function resetStore(): void {
  items = new Map();
  list = [];
  announcements = [];
  finished = 0;
  dirty = true;
  flush();
}

export function getUploads(): UploadSnapshot {
  if (loud) renew();
  return published;
}

export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUploads(): UploadSnapshot {
  return useSyncExternalStore(subscribeUploads, getUploads, getUploads);
}
