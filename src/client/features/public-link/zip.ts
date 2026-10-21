// "Download all as zip" on a folder link, built in the browser with client-zip. The manifest call
// is the zip's ONE download (it hands out a grant); the per-file URLs are then minted lazily, one
// window of `ZIP_URL_BATCH` at a time just ahead of the archive, each mint carrying the grant (so
// none of them counts again) — one request in flight, one window at a time.
//
// It never ends half done: when the link locks while a zip runs (the owner changed the password),
// the zip stops at its next mint and NOTHING is saved; the page shows the password form.
import { downloadZip } from "client-zip";
import { ZIP_URL_BATCH } from "../../../shared/constants";
import type { ZipEntry } from "../../../shared/schemas/node";
import { ApiError } from "../../lib/api";
import { isPasswordRequired, type LinkClient } from "./client";

/** What the browser holds in memory for one archive: 1 GB, decimal. */
export const ZIP_MAX_BYTES = 1_000_000_000;
/** Waits for a minute's per-address limit (`429 rate_limited`) before a mint gives up. */
export const ZIP_RATE_WAITS = 3;
const MAX_WAIT_MS = 60_000;

export type ZipOutcome = "saved" | "partial" | "empty" | "too_large" | "locked" | "cancelled" | "failed";

export interface ZipRun {
  outcome: ZipOutcome;
  /** Entries the manifest listed as not available (never why). */
  unavailable: number;
  /** Entries that could not be fetched. */
  missing: string[];
  /** The error that ended it, for `failed` (a request id to show). */
  error?: unknown;
}

export interface ZipHooks {
  signal: AbortSignal;
  /** Files done of all files, as the archive is built. */
  progress(done: number, total: number): void;
  /** A dangerous type: show the warning first; resolves whether to go on with this file. */
  confirmDangerous(fileName: string): Promise<boolean>;
  /** Hand the finished archive to the browser. */
  save(blob: Blob, fileName: string): void;
  /** Waits (replaceable by tests); rejects when the signal aborts. */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
}

const realSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });

class Locked extends Error {}

const isAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

export async function zipFolder(client: LinkClient, name: string, hooks: ZipHooks): Promise<ZipRun> {
  const sleep = hooks.sleep ?? realSleep;
  const missing: string[] = [];
  let manifest;
  try {
    manifest = await client.zipManifest();
  } catch (error) {
    if (isPasswordRequired(error)) return { outcome: "locked", unavailable: 0, missing };
    return { outcome: "failed", unavailable: 0, missing, error };
  }
  const unavailable = manifest.skipped.length;
  if (manifest.entries.length === 0) return { outcome: "empty", unavailable, missing };
  if (manifest.totalBytes > ZIP_MAX_BYTES) return { outcome: "too_large", unavailable, missing };
  const grant = manifest.zipGrant;
  const entries = manifest.entries;

  /** The URL of one entry under the grant, or null to leave it out. Throws `Locked`. */
  const mintOne = async (entry: ZipEntry): Promise<string | null> => {
    let acknowledged = false;
    for (let waits = 0; ;) {
      try {
        const minted = await client.mint(entry.nodeId, "download", {
          zipGrant: grant,
          dangerousAck: acknowledged,
        });
        return minted.url;
      } catch (error) {
        if (isPasswordRequired(error)) throw new Locked();
        if (!(error instanceof ApiError)) throw error;
        if (error.code === "forbidden" && error.details?.reason === "dangerous_ack" && !acknowledged) {
          if (!(await hooks.confirmDangerous(entry.path.slice(entry.path.lastIndexOf("/") + 1)))) return null;
          acknowledged = true;
          continue;
        }
        if (error.code === "rate_limited" && waits < ZIP_RATE_WAITS) {
          waits += 1;
          await sleep(Math.min(MAX_WAIT_MS, (error.retryAfter ?? 60) * 1000), hooks.signal);
          continue;
        }
        return null;
      }
    }
  };

  let done = 0;
  async function* files() {
    for (let start = 0; start < entries.length; start += ZIP_URL_BATCH) {
      const window = entries.slice(start, start + ZIP_URL_BATCH);
      const urls: (string | null)[] = [];
      // One mint at a time: a window is never a burst.
      for (const entry of window) urls.push(await mintOne(entry));
      for (const [index, entry] of window.entries()) {
        const url = urls[index];
        done += 1;
        hooks.progress(done, entries.length);
        if (!url) {
          missing.push(entry.path);
          continue;
        }
        const response = await fetch(url, { signal: hooks.signal });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          missing.push(entry.path);
          continue;
        }
        yield { name: entry.path, lastModified: new Date(entry.modifiedAt), input: response };
      }
    }
  }

  try {
    hooks.progress(0, entries.length);
    const blob = await downloadZip(files()).blob();
    if (hooks.signal.aborted) return { outcome: "cancelled", unavailable, missing };
    hooks.save(blob, `${name || "download"}.zip`);
    return { outcome: missing.length > 0 ? "partial" : "saved", unavailable, missing };
  } catch (error) {
    // The generator's own error may reach here wrapped by the stream: the lock is the client's.
    if (error instanceof Locked || isPasswordRequired(error) || client.isLocked()) {
      return { outcome: "locked", unavailable, missing };
    }
    if (isAbort(error) || hooks.signal.aborted) return { outcome: "cancelled", unavailable, missing };
    return { outcome: "failed", unavailable, missing, error };
  }
}
