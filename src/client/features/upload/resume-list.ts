// The resume list: what is needed to pick an upload up again after a reload — metadata only, a
// `File` cannot be kept. It lives in the browser's database, reached through `idb-keyval` in a
// store of this feature's own. It belongs to the account: every row carries the user id, and the
// manager's purger empties it.
//
// Nothing here throws or rejects. Where the browser has no database (private modes, the unit-test
// DOM) the list is simply empty and nothing is kept.
import { clear, createStore, del, entries, set, type UseStore } from "idb-keyval";
import { z } from "zod";
import { InitUploadBody } from "../../../shared/schemas/upload";

export const ResumeRow = z.object({
  /** The queue item's id; also the key. */
  id: z.string().min(1),
  userId: z.string().min(1),
  uploadId: z.string().min(1),
  /** The init body exactly as it was sent: sending it again is what finds the open session. */
  body: InitUploadBody,
  path: z.string(),
  finalName: z.string(),
});
export type ResumeRow = z.infer<typeof ResumeRow>;

let store: UseStore | undefined;
const resumeStore = (): UseStore => (store ??= createStore("holdfast-uploads", "resume"));

// One operation at a time, in the order they were asked for: a delete never overtakes the write
// before it.
let chain: Promise<unknown> = Promise.resolve();

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
  return inOrder(() => set(row.id, row, resumeStore()), undefined);
}

export function dropResumeRow(id: string): Promise<void> {
  return inOrder(() => del(id, resumeStore()), undefined);
}

/** Every readable row. A row that no longer has the shape is dropped. */
export function readResumeRows(): Promise<ResumeRow[]> {
  return inOrder(async () => {
    const rows: ResumeRow[] = [];
    for (const [key, value] of await entries(resumeStore())) {
      const parsed = ResumeRow.safeParse(value);
      if (parsed.success) rows.push(parsed.data);
      else await del(key, resumeStore());
    }
    return rows;
  }, []);
}

export function clearResumeRows(): Promise<void> {
  return inOrder(() => clear(resumeStore()), undefined);
}
