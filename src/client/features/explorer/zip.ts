// "Download as zip", built in the browser. The server gives a manifest (no URLs); download URLs
// are minted lazily, one window of ZIP_URL_BATCH just ahead of the stream, so no token has to
// outlive the whole archive. Progress goes to the shared transfer ribbon under `zip:<id>`.
import { downloadZip } from "client-zip";
import { useSyncExternalStore } from "react";
import { ZIP_MAX_ENTRIES, ZIP_URL_BATCH } from "../../../shared/constants";
import type { ZipEntry, ZipManifest } from "../../../shared/schemas/node";
import { toast } from "../../components/Toaster";
import { publish } from "../../components/TransferRibbon";
import { ApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { formatBytes } from "../../lib/format";
import { batchDownloadUrls, zipManifest } from "./api";
import { saveBlob } from "./download";
import { t } from "./strings";

/** The in-memory sink's ceiling: 1 GB, decimal, like every size the UI shows. */
export const ZIP_BLOB_MAX_BYTES = 1_000_000_000;
/** How many left-out items one toast names before "and N more". */
const NAMED_IN_TOAST = 3;
const PUBLISH_EVERY_MS = 200;

export type ZipOutcome = "saved" | "cancelled" | "empty" | "too_large" | "failed";

export type LeftOutReason = "scan_pending" | "scan_blocked" | "unscanned" | "unavailable";

export interface ZipResult {
  outcome: ZipOutcome;
  /** What the archive does not hold, and why. */
  leftOut: Array<{ path: string; reason: LeftOutReason }>;
  truncated: boolean;
}

interface Job {
  id: number;
  controller: AbortController;
  /** "Zipping 3 of 12" — the plain count the selection bar shows. */
  label: string;
}

// Running transfers belong to the account that started them.
const jobs = new Map<number, Job>();
const listeners = new Set<() => void>();
let nextId = 1;
let snapshot: readonly Job[] = [];

function emit(): void {
  snapshot = Array.from(jobs.values());
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const getSnapshot = () => snapshot;

/** The zips in progress, for the plain count next to the selection. */
export function useZipJobs(): readonly Job[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function getZipJobs(): readonly Job[] {
  return snapshot;
}

export function cancelZip(id: number): void {
  jobs.get(id)?.controller.abort();
}

/** Stop every running zip and forget them: run by `purgeUserState()` and by tests. */
export function resetZipForTests(): void {
  for (const job of jobs.values()) job.controller.abort();
  jobs.clear();
  emit();
}

registerUserStatePurger(resetZipForTests);

// ---------------------------------------------------------------------------------------------

interface SaveFileHandle {
  createWritable(): Promise<WritableStream<Uint8Array>>;
}
type SaveFilePicker = (options: {
  suggestedName: string;
  types: Array<{ description: string; accept: Record<string, string[]> }>;
}) => Promise<SaveFileHandle>;

function saveFilePicker(): SaveFilePicker | null {
  const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
  return typeof picker === "function" ? picker.bind(globalThis) : null;
}

// By name: an abort raised by a stream or by `fetch` is not always the page's own DOMException class.
const isAbort = (cause: unknown) => (cause as { name?: unknown } | null)?.name === "AbortError";

const REASON_TEXT = {
  scan_pending: "explorer.zip.reason.pending",
  scan_blocked: "explorer.zip.reason.blocked",
  unscanned: "explorer.zip.reason.unscanned",
  unavailable: "explorer.zip.reason.unavailable",
} as const;

/** "2 items were left out: a.txt (still scanning), b.exe (blocked)". */
export function leftOutSentence(leftOut: ZipResult["leftOut"]): string | null {
  if (leftOut.length === 0) return null;
  const named = leftOut
    .slice(0, NAMED_IN_TOAST)
    .map((item) => t("explorer.zip.leftOut.item", { path: item.path, reason: t(REASON_TEXT[item.reason]) }))
    .join(", ");
  const more = leftOut.length - NAMED_IN_TOAST;
  const list = more > 0 ? t("explorer.zip.leftOut.more", { list: named, count: more }) : named;
  return leftOut.length === 1
    ? t("explorer.zip.leftOut.one", { list })
    : t("explorer.zip.leftOut.many", { count: leftOut.length, list });
}

function finish(result: ZipResult, message: string, requestId?: string): ZipResult {
  const parts = [
    message,
    leftOutSentence(result.leftOut),
    result.truncated ? t("explorer.zip.truncated", { count: ZIP_MAX_ENTRIES.toLocaleString("en") }) : null,
  ];
  toast({ message: parts.filter(Boolean).join(" "), requestId, key: "zip", duration: 8000 });
  return result;
}

/**
 * Zip the given files and folders into one download. `suggestedName` is the archive's name
 * without the extension. Never throws: every way it can end is a `ZipOutcome` and one toast.
 */
export async function startZip(nodeIds: readonly string[], suggestedName: string): Promise<ZipResult> {
  const result: ZipResult = { outcome: "failed", leftOut: [], truncated: false };
  const fileName = `${suggestedName}.zip`;

  // The picker needs the click that started this, so it is asked before anything is fetched.
  let handle: SaveFileHandle | null = null;
  const picker = saveFilePicker();
  if (picker) {
    try {
      handle = await picker({
        suggestedName: fileName,
        types: [{ description: t("explorer.zip.fileType"), accept: { "application/zip": [".zip"] } }],
      });
    } catch (cause) {
      if (isAbort(cause)) return { ...result, outcome: "cancelled" };
      // Refused for another reason (no user activation, a blocked folder): the in-memory sink.
      handle = null;
    }
  }

  const job: Job = { id: nextId++, controller: new AbortController(), label: t("explorer.zip.preparing") };
  const sourceId = `zip:${job.id}`;
  const { signal } = job.controller;
  jobs.set(job.id, job);
  emit();
  publish(sourceId, { progress: 0, sentence: job.label, status: "active" });
  const close = () => {
    jobs.delete(job.id);
    emit();
  };

  try {
    const manifest: ZipManifest = await zipManifest({ nodeIds: [...nodeIds] }, signal);
    result.leftOut = manifest.skipped.map((item) => ({ path: item.path, reason: item.reason }));
    result.truncated = manifest.truncated;
    if (manifest.entries.length === 0) {
      publish(sourceId, null);
      return finish({ ...result, outcome: "empty" }, t("explorer.zip.empty"));
    }
    if (!handle && manifest.totalBytes > ZIP_BLOB_MAX_BYTES) {
      publish(sourceId, null);
      return finish(
        { ...result, outcome: "too_large", leftOut: [], truncated: false },
        t("explorer.zip.tooLarge"),
      );
    }

    const total = manifest.entries.length;
    let doneBytes = 0;
    let fileIndex = 0;
    let published = 0;
    const report = (force = false) => {
      const now = Date.now();
      if (!force && now - published < PUBLISH_EVERY_MS) return;
      published = now;
      job.label = t("explorer.zip.count", { done: fileIndex, total });
      emit();
      publish(sourceId, {
        progress: manifest.totalBytes > 0 ? doneBytes / manifest.totalBytes : fileIndex / total,
        sentence: t("explorer.zip.progress", {
          done: fileIndex,
          total,
          left: formatBytes(Math.max(0, manifest.totalBytes - doneBytes)),
        }),
        status: "active",
      });
    };

    // The count is known as soon as the manifest is.
    report(true);

    const urls = new Map<string, string>();
    const reminted = new Set<string>();
    const mint = async (ids: string[]) => {
      const answer = await batchDownloadUrls({ nodeIds: ids }, signal);
      for (const item of answer.items) {
        if ("url" in item) urls.set(item.nodeId, item.url);
        else urls.delete(item.nodeId);
      }
    };
    /** One more URL for one node — once per node, whatever the reason. */
    const remint = async (id: string): Promise<string | undefined> => {
      if (reminted.has(id)) return undefined;
      reminted.add(id);
      await mint([id]);
      return urls.get(id);
    };
    const open = async (entry: ZipEntry): Promise<Response | null> => {
      let url = urls.get(entry.nodeId) ?? (await remint(entry.nodeId));
      if (!url) return null;
      let response = await fetch(url, { signal });
      // The files host answers a token that no longer verifies with 403: mint once more.
      if (response.status === 403) {
        url = await remint(entry.nodeId);
        if (!url) return null;
        response = await fetch(url, { signal });
      }
      return response.ok && response.body ? response : null;
    };

    async function* files() {
      for (let index = 0; index < manifest.entries.length; index += 1) {
        signal.throwIfAborted();
        const entry = manifest.entries[index]!;
        // Lazily: the next window is asked for only when the stream reaches it.
        if (index % ZIP_URL_BATCH === 0) {
          await mint(manifest.entries.slice(index, index + ZIP_URL_BATCH).map((item) => item.nodeId));
        }
        const response = await open(entry);
        fileIndex = index + 1;
        if (!response?.body) {
          result.leftOut.push({ path: entry.path, reason: "unavailable" });
          report(true);
          continue;
        }
        report(true);
        const counted = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              doneBytes += chunk.byteLength;
              report();
              controller.enqueue(chunk);
            },
          }),
        );
        yield { name: entry.path, lastModified: new Date(entry.modifiedAt), input: counted };
      }
    }

    const archive = downloadZip(files());
    if (handle) {
      const writable = await handle.createWritable();
      await archive.body!.pipeTo(writable, { signal });
    } else {
      saveBlob(await archive.blob(), fileName);
    }
    publish(sourceId, { progress: 1, sentence: t("explorer.zip.saved"), status: "done" });
    return finish({ ...result, outcome: "saved" }, t("explorer.zip.saved"));
  } catch (cause) {
    publish(sourceId, null);
    if (signal.aborted || isAbort(cause)) return { ...result, outcome: "cancelled" };
    return finish(
      { ...result, outcome: "failed", leftOut: [], truncated: false },
      t("explorer.zip.failed"),
      cause instanceof ApiError ? cause.requestId : undefined,
    );
  } finally {
    close();
  }
}
