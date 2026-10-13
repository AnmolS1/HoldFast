// The uploader's arithmetic and rules, as pure functions.
import type { UploadedPart } from "../../../shared/schemas/upload";

/** Files in flight at once, and parts in flight per file: nine requests at most. */
export const FILE_CONCURRENCY = 3;
export const PART_CONCURRENCY = 3;

/**
 * Waits before each new try of a request that failed on the network or with a 5xx. After the
 * last one the item becomes an error (which can be resumed).
 */
export const RETRY_DELAYS_MS = [0, 2_000, 5_000, 15_000, 30_000] as const;

/**
 * The byte range of part `n` (1-based). `partBytes` is the server's — the client never computes
 * a part size.
 */
export function partRange(n: number, partBytes: number, size: number): { start: number; end: number } {
  return { start: Math.min(size, (n - 1) * partBytes), end: Math.min(size, n * partBytes) };
}

export function partSize(n: number, partBytes: number, size: number): number {
  const { start, end } = partRange(n, partBytes, size);
  return end - start;
}

/** The part numbers still to send, ascending. */
export function missingParts(partCount: number, have: readonly UploadedPart[]): number[] {
  const done = new Set(have.map((part) => part.n));
  const missing: number[] = [];
  for (let n = 1; n <= partCount; n += 1) if (!done.has(n)) missing.push(n);
  return missing;
}

export function sortedParts(parts: readonly UploadedPart[]): UploadedPart[] {
  return [...parts].sort((a, b) => a.n - b.n);
}

/** `File.lastModified` as it crosses the API. */
export function lastModifiedIso(file: { lastModified: number }): string {
  return new Date(file.lastModified).toISOString();
}

export interface ResumeCandidate {
  name: string;
  size: number;
  /** An ISO timestamp; a session without one matches nothing. */
  fileLastModified: string | null;
}

/** Is `file` the one this open upload was started with? Name, size and the exact millisecond. */
export function matchesResume(
  candidate: ResumeCandidate,
  file: { name: string; size: number; lastModified: number },
): boolean {
  if (candidate.fileLastModified === null) return false;
  return (
    candidate.name === file.name &&
    candidate.size === file.size &&
    Date.parse(candidate.fileLastModified) === file.lastModified
  );
}

export interface PreflightFile {
  name: string;
  size: number;
}

export interface Preflight<F extends PreflightFile> {
  accepted: F[];
  rejected: Array<{ file: F; reason: "too_large" | "no_name" }>;
  /** Set when the accepted files do not fit: nothing starts. */
  quota: { needed: number; free: number } | null;
}

/**
 * What can start. `maxFileBytes` and `free` are null when not known (the server validates
 * everything again anyway).
 */
export function preflight<F extends PreflightFile>(
  files: readonly F[],
  maxFileBytes: number | null,
  free: number | null,
): Preflight<F> {
  const accepted: F[] = [];
  const rejected: Preflight<F>["rejected"] = [];
  for (const file of files) {
    if (file.name.trim() === "") rejected.push({ file, reason: "no_name" });
    else if (maxFileBytes !== null && file.size > maxFileBytes) rejected.push({ file, reason: "too_large" });
    else accepted.push(file);
  }
  const needed = accepted.reduce((sum, file) => sum + file.size, 0);
  const quota = free !== null && needed > free ? { needed, free: Math.max(0, free) } : null;
  return { accepted, rejected, quota };
}

/** "a/b/c" → ["a", "a/b", "a/b/c"]. */
function ancestors(path: string): string[] {
  const segments = path.split("/").filter(Boolean);
  return segments.map((_, index) => segments.slice(0, index + 1).join("/"));
}

/** Every folder a set of paths needs, each once, parents before children. */
export function foldersToCreate(paths: Iterable<string>): string[] {
  const all = new Set<string>();
  for (const path of paths) for (const folder of ancestors(path)) all.add(folder);
  return Array.from(all).sort(
    (a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0),
  );
}

export function parentPath(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? "" : path.slice(0, cut);
}

export function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
