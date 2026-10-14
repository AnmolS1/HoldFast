// The resume list: what is needed to pick an upload up again after a reload — metadata only, a
// `File` cannot be kept. A row holds: the queue item's id, the user id, the upload session's id
// and expiry, the init body as sent (folder id, file name, size, declared type, the file's date,
// the conflict choice and the replaced file's id), the folder path inside a folder upload and the
// final name; and, once `complete` was sent, the digest and part list it was sent with. No bytes, no token. A row goes when its upload lands, is cancelled, removed or
// refused, when its session is gone or past its expiry, and with the account (the purger). It lives in the browser's database, reached through `idb-keyval` in a
// store of this feature's own. It belongs to the account: every row carries the user id, and the
// manager's purger empties it.
//
// Nothing here throws or rejects. Where the browser has no database (private modes, the unit-test
// DOM) the list is simply empty and nothing is kept.
import { clear, createStore, del, entries, set, type UseStore } from "idb-keyval";
import { z } from "zod";
import { CompleteUploadBody, InitUploadBody } from "../../../shared/schemas/upload";

export const ResumeRow = z.object({
  /** The queue item's id; also the key. */
  id: z.string().min(1),
  userId: z.string().min(1),
  uploadId: z.string().min(1),
  /** The init body exactly as it was sent: sending it again is what finds the open session. */
  body: InitUploadBody,
  path: z.string(),
  finalName: z.string(),
  /** When the server's session ends. A row past it is deleted, wherever it is met. */
  expiresAt: z.iso.datetime(),
  /**
   * Set once `complete` has been sent: the body it was sent with. Such a row is no longer an
   * upload to resume — its file may have landed — but a question to ask the server again.
   */
  complete: CompleteUploadBody.optional(),
});
export type ResumeRow = z.infer<typeof ResumeRow>;

let store: UseStore | undefined;
const resumeStore = (): UseStore => (store ??= createStore("holdfast-uploads", "resume"));

interface Backend {
  set(key: string, value: ResumeRow): Promise<void>;
  del(key: IDBValidKey): Promise<void>;
  entries(): Promise<Array<[IDBValidKey, unknown]>>;
  clear(): Promise<void>;
}

const onDevice: Backend = {
  set: (key, value) => set(key, value, resumeStore()),
  del: (key) => del(key, resumeStore()),
  entries: () => entries(resumeStore()),
  clear: () => clear(resumeStore()),
};
let backend: Backend = onDevice;

/**
 * Tests only: the list in memory instead of on the device, for tests of hundreds of files (each
 * row in the stand-in database costs a real wait, and those tests are not about the list). Back
 * on the device with `false`.
 */
export function keepResumeListInMemoryForTests(inMemory: boolean): void {
  if (!inMemory) {
    backend = onDevice;
    return;
  }
  const rows = new Map<IDBValidKey, unknown>();
  backend = {
    set: async (key, value) => void rows.set(key, value),
    del: async (key) => void rows.delete(key),
    entries: async () => Array.from(rows.entries()),
    clear: async () => rows.clear(),
  };
}

// One operation at a time, in the order they were asked for: a delete never overtakes the write
// before it.
let chain: Promise<unknown> = Promise.resolve();

/** Tests only: every operation asked for so far has finished. */
export async function resumeListSettledForTests(): Promise<void> {
  for (let seen = chain; ; seen = chain) {
    await seen;
    if (seen === chain) return;
  }
}

function inOrder<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  const next = chain.then(async () => {
    try {
      return await operation();
    } catch {
      return fallback;
    }
  });
  chain = next;
  return next;
}

export function saveResumeRow(row: ResumeRow): Promise<void> {
  return inOrder(() => backend.set(row.id, row), undefined);
}

export function dropResumeRow(id: string): Promise<void> {
  return inOrder(() => backend.del(id), undefined);
}

export function isExpired(expiresAt: string | null, now: number = Date.now()): boolean {
  return expiresAt !== null && Date.parse(expiresAt) <= now;
}

/**
 * Every row that can still be used. A row that no longer has the shape, or whose session has
 * expired, is deleted on the way.
 */
export function readResumeRows(): Promise<ResumeRow[]> {
  return inOrder(async () => {
    const rows: ResumeRow[] = [];
    for (const [key, value] of await backend.entries()) {
      const parsed = ResumeRow.safeParse(value);
      if (parsed.success && !isExpired(parsed.data.expiresAt)) rows.push(parsed.data);
      else await backend.del(key);
    }
    return rows;
  }, []);
}

export function clearResumeRows(): Promise<void> {
  return inOrder(() => backend.clear(), undefined);
}
