// "Download as zip", built in the browser. The server gives a manifest (no URLs); download URLs
// are minted lazily, one window of ZIP_URL_BATCH just ahead of the stream, so no token has to
// outlive the whole archive. Progress goes to the shared transfer ribbon under `zip:<id>`.
import { downloadZip } from "client-zip";
import { useSyncExternalStore } from "react";
import { ZIP_MAX_ENTRIES, ZIP_URL_BATCH } from "../../../shared/constants";
import type { ZipEntry, ZipManifest, ZipManifestBody } from "../../../shared/schemas/node";
import { toast } from "../../components/Toaster";
import { publish } from "../../components/TransferRibbon";
import { ApiError } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { formatBytes } from "../../lib/format";
import { accountEpoch, sameAccount } from "../../lib/query";
import { batchDownloadUrls, zipManifest } from "./api";
import { isFilesUrl, saveBlob } from "./download";
import { t } from "./strings";

/** The in-memory sink's ceiling: 1 GB, decimal, like every size the UI shows. */
export const ZIP_BLOB_MAX_BYTES = 1_000_000_000;
/** The ceiling as the engine reads it — an object so that a test can lower it and send real bytes past it. */
export const ZIP_LIMITS = { blobMax: ZIP_BLOB_MAX_BYTES };
/** How many left-out items one toast names before "and N more". */
const NAMED_IN_TOAST = 3;
const PUBLISH_EVERY_MS = 200;

/** Roots one manifest request may name (`ZipManifestBody`); a larger selection is asked for in parts. */
export const ZIP_MANIFEST_ROOTS = 100;
/** Tries for one file when the files host fails (`5xx`) or the network drops: the first and two more. */
export const ZIP_FETCH_ATTEMPTS = 3;
/** Waits for a window of URLs on the API's own `429` (same origin: its `Retry-After` is readable). */
export const ZIP_RATE_WAITS = 5;
/** A `Retry-After` longer than this is a daily ceiling, not a busy minute: the zip stops. */
export const ZIP_RATE_WAIT_MAX_MS = 60_000;
/**
 * The files host's `429`. It is another origin: unless it lists `Retry-After` in
 * `Access-Control-Expose-Headers` the page cannot read it, and its per-address limiter sends none
 * at all — so the header is used when it can be read and never relied on. One file is asked for
 * at most ZIP_RATE_TRIES times; a `429` on the last try stops the WHOLE zip (every later file
 * would be refused too), and the archive is saved with what it already holds, the rest named.
 */
export const ZIP_RATE_TRIES = 3;
/**
 * The waits between those tries when no `Retry-After` can be read: together a full minute, the
 * period of the files host's per-address limiter, so a busy minute has passed before giving up.
 */
export const ZIP_RATE_BACKOFF_MS = [15_000, 45_000] as const;
/** How long a finished zip stays on the ribbon. */
const DONE_LINGER_MS = 4_000;

/**
 * "saved" is said only of an archive that holds every file the manifest listed. One that lacks a
 * file the files host would not give is "partial" — and says which.
 */
export type ZipOutcome =
  "saved" | "partial" | "cancelled" | "empty" | "too_large" | "busy" | "limited" | "failed";

export type LeftOutReason = "scan_pending" | "scan_blocked" | "unscanned";

export interface ZipResult {
  outcome: ZipOutcome;
  /** What the manifest itself left out, and why. */
  leftOut: Array<{ path: string; reason: LeftOutReason }>;
  /** Files the manifest listed that could not be fetched: the archive is incomplete without them. */
  missing: string[];
  truncated: boolean;
}

interface Job {
  id: number;
  controller: AbortController;
  /** "Zipping 3 of 12" — the plain count the selection bar shows. */
  label: string;
  /** Built in memory (no save picker): only one of these at a time. */
  inMemory: boolean;
}

// Waiting, replaceable by tests (a retry waits seconds).
const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
let sleep: (ms: number, signal: AbortSignal) => Promise<void> = realSleep;

/** Tests only: replace the wait between retries (`null` = the real one). */
export function setZipSleepForTests(replacement: typeof realSleep | null): void {
  sleep = replacement ?? realSleep;
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
  /** Chromium: delete the file again. */
  remove?(): Promise<void>;
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

/** Why a zip stopped short of a complete archive, when it is not a plain failure. */
class ZipStop extends Error {
  constructor(readonly outcome: "too_large" | "limited") {
    super(outcome);
  }
}

// ---------------------------------------------------------------------------------------------
// Entry names. The manifest's paths are said to be relative and sanitised; an archive is written
// to the user's disk, so they are checked here as well.

// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** A relative path with no `..`, no absolute or drive prefix, no control character, no empty part. */
export function safeZipPath(path: string): string {
  const parts = path
    .split(/[\\/]+/)
    .map((part) => part.replace(CONTROL, "").trim())
    .filter(
      (part, index) =>
        part !== "" && part !== "." && part !== ".." && !(index === 0 && /^[A-Za-z]:$/.test(part)),
    );
  return parts.length > 0 ? parts.join("/") : "file";
}

/** Give each entry a name no other has, comparing without case: "a.txt", "a (2).txt", … */
export function uniqueZipPath(path: string, taken: Set<string>): string {
  let candidate = path;
  const slash = path.lastIndexOf("/");
  const dot = path.lastIndexOf(".");
  const stem = dot > slash + 1 ? path.slice(0, dot) : path;
  const ext = dot > slash + 1 ? path.slice(dot) : "";
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLowerCase());
  return candidate;
}

// ---------------------------------------------------------------------------------------------

const REASON_TEXT = {
  scan_pending: "explorer.zip.reason.pending",
  scan_blocked: "explorer.zip.reason.blocked",
  unscanned: "explorer.zip.reason.unscanned",
} as const;

const named = (items: string[]) => {
  const list = items.slice(0, NAMED_IN_TOAST).join(", ");
  const more = items.length - NAMED_IN_TOAST;
  return more > 0 ? t("explorer.zip.leftOut.more", { list, count: more }) : list;
};

/** "2 items were left out: a.txt (still scanning), b.exe (blocked)". */
export function leftOutSentence(leftOut: ZipResult["leftOut"]): string | null {
  if (leftOut.length === 0) return null;
  const list = named(
    leftOut.map((item) =>
      t("explorer.zip.leftOut.item", { path: item.path, reason: t(REASON_TEXT[item.reason]) }),
    ),
  );
  return leftOut.length === 1
    ? t("explorer.zip.leftOut.one", { list })
    : t("explorer.zip.leftOut.many", { count: leftOut.length, list });
}

/** "The zip is saved, but 2 files are missing from it: a.jpg, b.jpg. Download them one by one." */
export function missingSentence(missing: string[]): string {
  return missing.length === 1
    ? t("explorer.zip.missing.one", { list: named(missing) })
    : t("explorer.zip.missing.many", { count: missing.length, list: named(missing) });
}

/** "The download limit was reached, so the zip was saved without 38 files: …". */
export function limitedSentence(missing: string[]): string {
  return missing.length === 1
    ? t("explorer.zip.limitedShort.one", { list: named(missing) })
    : t("explorer.zip.limitedShort.many", { count: missing.length, list: named(missing) });
}

/**
 * Every manifest of a selection, asked for ZIP_MANIFEST_ROOTS roots at a time and merged — or, for
 * `{ allOwned: true }` ("Download everything", the account page), the one manifest of the caller's
 * whole tree.
 */
async function readManifest(
  source: readonly string[] | ZipManifestBody,
  signal: AbortSignal,
): Promise<ZipManifest> {
  if (!Array.isArray(source)) {
    const body = source as ZipManifestBody;
    return body.allOwned === true
      ? zipManifest({ allOwned: true }, signal)
      : readManifest(body.nodeIds, signal);
  }
  const nodeIds = source as readonly string[];
  const merged: ZipManifest = { entries: [], totalBytes: 0, skipped: [], truncated: false };
  const seen = new Set<string>();
  for (let start = 0; start < nodeIds.length; start += ZIP_MANIFEST_ROOTS) {
    const part = await zipManifest({ nodeIds: nodeIds.slice(start, start + ZIP_MANIFEST_ROOTS) }, signal);
    merged.truncated ||= part.truncated;
    merged.skipped.push(...part.skipped);
    // The server's own total for this part (it is what the in-memory ceiling is first held against).
    merged.totalBytes += part.totalBytes;
    for (const entry of part.entries) {
      if (seen.has(entry.nodeId)) continue;
      // The archive holds at most what one manifest may: the rest is said, not silently cut.
      if (merged.entries.length >= ZIP_MAX_ENTRIES) {
        merged.truncated = true;
        return merged;
      }
      seen.add(entry.nodeId);
      merged.entries.push(entry);
    }
  }
  return merged;
}

/**
 * Zip the given files and folders — or, given `{ allOwned: true }`, everything the caller owns —
 * into one download. `suggestedName` is the archive's name without the extension. Never throws:
 * every way it can end is a `ZipOutcome` and at most one toast — none at all once the account
 * that started it is no longer the one signed in.
 */
export async function startZip(
  nodeIds: readonly string[] | ZipManifestBody,
  suggestedName: string,
): Promise<ZipResult> {
  const then = accountEpoch();
  const mine = () => sameAccount(then);
  const result: ZipResult = { outcome: "failed", leftOut: [], missing: [], truncated: false };
  const fileName = `${suggestedName}.zip`;
  /** An archive reached the disk (set just before the outcome is said). */
  let archived = false;
  const finish = (outcome: ZipOutcome, message: string | null, requestId?: string): ZipResult => {
    result.outcome = outcome;
    if (message !== null && mine()) {
      // Said only of an archive that was saved (a limited one too, when it holds what came before
      // the limit) — never of a zip that stopped with nothing saved.
      const complete = outcome === "saved" || outcome === "partial" || outcome === "empty" || archived;
      const parts = [
        message,
        complete ? leftOutSentence(result.leftOut) : null,
        complete && result.truncated
          ? t("explorer.zip.truncated", { count: ZIP_MAX_ENTRIES.toLocaleString("en") })
          : null,
      ];
      toast({ message: parts.filter(Boolean).join(" "), requestId, key: "zip", duration: 8000 });
    }
    return result;
  };

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
      if (isAbort(cause)) return finish("cancelled", null);
      // Refused for another reason (no user activation, a blocked folder): the in-memory sink,
      // with its ceiling.
      handle = null;
    }
  }
  /** A file the picker created and nothing was written to: take it away again where the browser can. */
  const discard = async () => {
    try {
      await handle?.remove?.();
    } catch {
      // It stays, empty; the toast of a failure says so.
    }
  };
  // The account may have changed while the picker was open.
  if (!mine()) {
    await discard();
    return finish("cancelled", null);
  }
  // One archive in memory at a time: each may hold up to the ceiling.
  if (!handle && snapshot.some((other) => other.inMemory)) return finish("busy", t("explorer.zip.busy"));

  const job: Job = {
    id: nextId++,
    controller: new AbortController(),
    label: t("explorer.zip.preparing"),
    inMemory: handle === null,
  };
  const sourceId = `zip:${job.id}`;
  const { signal } = job.controller;
  jobs.set(job.id, job);
  emit();
  publish(sourceId, { progress: 0, sentence: job.label, status: "active" });
  const leftover = handle && typeof handle.remove !== "function" ? ` ${t("explorer.zip.emptyFile")}` : "";

  try {
    const manifest = await readManifest(nodeIds, signal);
    result.leftOut = manifest.skipped.map((item) => ({ path: safeZipPath(item.path), reason: item.reason }));
    result.truncated = manifest.truncated;
    if (manifest.entries.length === 0) {
      publish(sourceId, null);
      await discard();
      return finish("empty", t("explorer.zip.empty"));
    }
    if (!handle && manifest.totalBytes > ZIP_LIMITS.blobMax) throw new ZipStop("too_large");

    const total = manifest.entries.length;
    let doneBytes = 0;
    let fileIndex = 0;
    let published = 0;
    const report = (force = false) => {
      // Nothing is shown for a zip that was stopped, or whose account has gone.
      if (signal.aborted || !mine()) return;
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
      for (let waits = 0; ; waits += 1) {
        try {
          const answer = await batchDownloadUrls({ nodeIds: ids }, signal);
          for (const item of answer.items) {
            if ("url" in item && isFilesUrl(item.url)) urls.set(item.nodeId, item.url);
            else urls.delete(item.nodeId);
          }
          return;
        } catch (cause) {
          // The API's own limiter: wait as long as it says, a few times; a ceiling stops the zip.
          if (!(cause instanceof ApiError) || cause.status !== 429) throw cause;
          const wait = (cause.retryAfter ?? 5) * 1000;
          if (wait > ZIP_RATE_WAIT_MAX_MS || waits >= ZIP_RATE_WAITS) throw new ZipStop("limited");
          await sleep(wait, signal);
        }
      }
    };
    /** One more URL for one node — once per node, whatever the reason. */
    const remint = async (id: string): Promise<string | undefined> => {
      if (reminted.has(id)) return undefined;
      reminted.add(id);
      await mint([id]);
      return urls.get(id);
    };
    const refuse = async (response: Response) => {
      // Not read: let the connection go.
      await response.body?.cancel().catch(() => {});
    };
    /**
     * The file's bytes, or null when the files host will not give them. Never a silent miss for
     * a reason that waiting cures: `429` waits `Retry-After`, `5xx` and a dropped connection are
     * tried again.
     */
    const open = async (entry: ZipEntry): Promise<Response | null> => {
      let url = urls.get(entry.nodeId) ?? (await remint(entry.nodeId));
      let failures = 0;
      let refusals = 0;
      while (url) {
        let response: Response;
        try {
          response = await fetch(url, { signal });
        } catch (cause) {
          if (signal.aborted || isAbort(cause)) throw cause;
          failures += 1;
          if (failures >= ZIP_FETCH_ATTEMPTS) return null;
          await sleep(1000 * 3 ** (failures - 1), signal);
          continue;
        }
        if (response.ok && response.body) return response;
        await refuse(response);
        if (response.status === 403) {
          // The files host answers a token that no longer verifies with 403 and plain text —
          // the status is all there is to go by (PLAN §10): mint once more, fetch once more.
          url = await remint(entry.nodeId);
        } else if (response.status === 429) {
          refusals += 1;
          const header = response.headers.get("retry-after");
          const seconds = header === null ? Number.NaN : Number(header);
          const wait =
            Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : ZIP_RATE_BACKOFF_MS[refusals - 1];
          // A wait of more than a minute is a daily ceiling, and a refusal that outlasts every try
          // is one this zip cannot wait out: every later file would be refused too.
          if (wait === undefined || wait > ZIP_RATE_WAIT_MAX_MS || refusals >= ZIP_RATE_TRIES)
            throw new ZipStop("limited");
          await sleep(wait, signal);
        } else if (response.status >= 500) {
          failures += 1;
          if (failures >= ZIP_FETCH_ATTEMPTS) return null;
          await sleep(1000 * 3 ** (failures - 1), signal);
        } else return null;
      }
      return null;
    };

    const names = new Set<string>();
    let added = 0;
    let limited = false;
    async function* files() {
      for (let index = 0; index < manifest.entries.length; index += 1) {
        signal.throwIfAborted();
        const entry = manifest.entries[index]!;
        const name = uniqueZipPath(safeZipPath(entry.path), names);
        let response: Response | null;
        try {
          // Lazily: the next window is asked for only when the stream reaches it.
          if (index % ZIP_URL_BATCH === 0) {
            await mint(manifest.entries.slice(index, index + ZIP_URL_BATCH).map((item) => item.nodeId));
          }
          response = await open(entry);
        } catch (cause) {
          // Stopped by a limit: nothing more is asked for. With nothing in it yet there is no
          // archive to save; otherwise it ends here, and this file and every later one are named.
          if (!(cause instanceof ZipStop) || cause.outcome !== "limited" || added === 0) throw cause;
          limited = true;
          result.missing.push(name);
          for (const rest of manifest.entries.slice(index + 1))
            result.missing.push(uniqueZipPath(safeZipPath(rest.path), names));
          return;
        }
        fileIndex = index + 1;
        if (!response?.body) {
          result.missing.push(name);
          report(true);
          continue;
        }
        report(true);
        added += 1;
        const counted = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              doneBytes += chunk.byteLength;
              // The ceiling is on what is really held, not on what the manifest promised.
              if (!handle && doneBytes > ZIP_LIMITS.blobMax) {
                controller.error(new ZipStop("too_large"));
                return;
              }
              report();
              controller.enqueue(chunk);
            },
          }),
        );
        yield { name, lastModified: new Date(entry.modifiedAt), input: counted };
      }
    }

    const archive = downloadZip(files());
    if (handle) {
      const writable = await handle.createWritable();
      await archive.body!.pipeTo(writable, { signal });
    } else {
      const blob = await archive.blob();
      // Bytes of the account that asked for them: not handed over once it is gone.
      if (!mine()) return finish("cancelled", null);
      saveBlob(blob, fileName);
    }
    // The ribbon's live region says what the toast says: never "saved" alone for an incomplete archive.
    const short = result.missing.length;
    if (mine()) {
      const sentence =
        short === 0
          ? t("explorer.zip.saved")
          : short === 1
            ? t("explorer.zip.savedShort.one")
            : t("explorer.zip.savedShort.many", { count: short });
      publish(sourceId, { progress: 1, sentence, status: "done" });
      setTimeout(() => publish(sourceId, null), DONE_LINGER_MS);
    }
    archived = true;
    if (limited) return finish("limited", limitedSentence(result.missing));
    return short > 0
      ? finish("partial", missingSentence(result.missing))
      : finish("saved", t("explorer.zip.saved"));
  } catch (cause) {
    if (mine()) publish(sourceId, null);
    await discard();
    if (signal.aborted || isAbort(cause)) return finish("cancelled", null);
    if (cause instanceof ZipStop) {
      return cause.outcome === "too_large"
        ? finish("too_large", t("explorer.zip.tooLarge"))
        : finish("limited", t("explorer.zip.limited") + leftover);
    }
    return finish(
      "failed",
      t("explorer.zip.failed") + leftover,
      cause instanceof ApiError ? cause.requestId : undefined,
    );
  } finally {
    jobs.delete(job.id);
    emit();
  }
}
