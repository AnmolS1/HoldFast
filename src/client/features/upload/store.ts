// The upload queue: a module-scope store, so it survives route changes without a provider.
// `manager.ts` is the only writer; components read it with `useUploads()`.
import { useSyncExternalStore } from "react";
import type { ScanReason, ScanStatus } from "../../../shared/schemas/common";
import type { InitUploadBody, UploadedPart } from "../../../shared/schemas/upload";

/**
 * `refused` is final (blocked content): never retried, never resumable. `conflict` waits for the
 * user's choice. A file that landed is `scanning` and then `done`; what the scan said is in
 * `scanStatus`.
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

/** Why an item is paused. Every reason but `user` belongs to the whole queue. */
export type PauseReason = "user" | "offline" | "auth" | "ceiling" | "disabled";

export interface UploadConflict {
  /** The file that holds the name, when the server says which. Replace needs it. */
  existingId: string | null;
  /** Set once a replace was refused: the server's sentence, shown as it is. */
  replaceRefused: string | null;
}

export interface UploadItem {
  id: string;
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
  /** Its folder (of a folder upload) is not created yet. */
  waitingFolder: boolean;
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

let working: UploadSnapshot = EMPTY;
let published: UploadSnapshot = EMPTY;
let announcementId = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function flush(): void {
  clearTimeout(timer);
  timer = undefined;
  if (published === working) return;
  published = working;
  for (const listener of Array.from(listeners)) listener();
}

/** `quiet` changes (progress samples) are coalesced; everything else is published at once. */
function touch(quiet: boolean): void {
  if (!quiet) flush();
  else timer ??= setTimeout(flush, PROGRESS_FLUSH_MS);
}

/** The queue as the manager sees it — ahead of `getUploads()` by at most one progress flush. */
export function currentItems(): readonly UploadItem[] {
  return working.items;
}

export function findItem(id: string): UploadItem | undefined {
  return working.items.find((item) => item.id === id);
}

export function addItems(items: UploadItem[]): void {
  if (items.length === 0) return;
  working = { ...working, items: [...working.items, ...items], finished: 0 };
  touch(false);
}

export function patchItem(id: string, patch: Partial<UploadItem>, quiet = false): void {
  if (!findItem(id)) return;
  working = {
    ...working,
    items: working.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  };
  touch(quiet);
}

export function removeItems(ids: ReadonlySet<string>, finished?: number): void {
  const items = working.items.filter((item) => !ids.has(item.id));
  if (items.length === working.items.length && finished === undefined) return;
  working = { ...working, items, finished: finished ?? working.finished };
  touch(false);
}

export function announce(text: string): void {
  const announcements = [...working.announcements, { id: ++announcementId, text }];
  working = { ...working, announcements: announcements.slice(-ANNOUNCEMENTS_KEPT) };
  touch(false);
}

export function resetStore(): void {
  working = EMPTY;
  flush();
}

export function getUploads(): UploadSnapshot {
  return published;
}

export function subscribeUploads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useUploads(): UploadSnapshot {
  return useSyncExternalStore(subscribeUploads, getUploads, getUploads);
}
