// The trash's requests. Purging is final (objects are deleted, nothing is versioned), so the two
// calls that purge are only ever made from a confirmed dialog.
import { useInfiniteQuery, type InfiniteData } from "@tanstack/react-query";
import {
  EmptyTrashResponse,
  RestoreNodeResponse,
  TrashResponse,
  type TrashItemDto,
} from "../../../shared/schemas/node";
import { api } from "../../lib/api";
import { registerUserStatePurger } from "../../lib/contracts";
import { queryClient } from "../../lib/query";
import { viewKeys } from "../starred/view-queries";

/** The most one request may ask for: the list then knows "100 or 101" from its first page. */
export const TRASH_PAGE = 200;

/** Emptying a trash of more than this many items asks for the word to be typed. */
export const TYPED_CONFIRM_ABOVE = 100;

/** What is typed. A constant of the code, not copy: it is compared with the input. */
export const CONFIRM_WORD = "DELETE";

/** `GET /api/trash`, a page at a time: trashed roots only — children come back with their root. */
export function useTrash() {
  return useInfiniteQuery({
    queryKey: viewKeys.trash,
    queryFn: ({ pageParam, signal }) =>
      api(`/api/trash?limit=${TRASH_PAGE}${pageParam ? `&cursor=${encodeURIComponent(pageParam)}` : ""}`, {
        schema: TrashResponse,
        signal,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

/**
 * What is known about how much the trash holds: `count` is the number of rows loaded (`null` when
 * the list could not be read) and `more` says the server has further pages.
 */
export interface TrashSize {
  count: number | null;
  more: boolean;
}

/**
 * Must the word be typed? Above the threshold, and whenever the size is not known to be at or
 * under it — an unread list or one with further pages is treated as large.
 */
export function needsTypedConfirm({ count, more }: TrashSize): boolean {
  return count === null || more || count > TYPED_CONFIRM_ABOVE;
}

/** `POST /api/nodes/:id/restore` → the node where it now is (maybe the top level, maybe renamed). */
export function restoreNode(id: string): Promise<RestoreNodeResponse> {
  return api(`/api/nodes/${encodeURIComponent(id)}/restore`, { method: "POST", schema: RestoreNodeResponse });
}

/** `DELETE /api/nodes/:id` — a trashed root, for good. */
export function deleteForever(id: string): Promise<void> {
  return api<void>(`/api/nodes/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Take rows out of the cached list once the server has said they left the trash. */
export function dropFromTrashCache(ids: ReadonlySet<string>): void {
  queryClient.setQueryData<InfiniteData<TrashResponse, string | null>>(viewKeys.trash, (current) =>
    current
      ? {
          ...current,
          pages: current.pages.map((page) => ({
            ...page,
            items: page.items.filter((item: TrashItemDto) => !ids.has(item.id)),
          })),
        }
      : current,
  );
}

// ---------------------------------------------------------------------------------------------
// Empty trash: `DELETE /api/trash` purges for a bounded time, then answers `202 { remaining }`
// (call again) or `204` (nothing left).

/** The server kept answering `202` without the number going down. */
export class EmptyTrashStalled extends Error {
  constructor() {
    super("empty trash made no progress");
    this.name = "EmptyTrashStalled";
  }
}

/** Calls in a row that may leave `remaining` where it was before the loop gives up. */
export const STALLED_ROUNDS = 5;

// Runs in flight belong to the signed-in account: sign-out or an account switch stops them.
const running = new Set<AbortController>();
registerUserStatePurger(() => {
  for (const controller of running) controller.abort();
  running.clear();
});

/**
 * Repeat `DELETE /api/trash` until it answers `204`. Rejects with the request's error (the loop
 * stops there — nothing is retried), with `EmptyTrashStalled`, or with an `AbortError` when
 * `signal` fires or the account's state is purged.
 */
export async function emptyTrash(
  onProgress: (remaining: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort);
  running.add(controller);
  try {
    let least = Number.POSITIVE_INFINITY;
    let stalled = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const answer = (await api("/api/trash", {
        method: "DELETE",
        schema: EmptyTrashResponse,
        signal: controller.signal,
      })) as EmptyTrashResponse | undefined;
      // `204`: the API client hands back no body.
      if (answer === undefined) return;
      onProgress(answer.remaining);
      stalled = answer.remaining < least ? 0 : stalled + 1;
      least = Math.min(least, answer.remaining);
      if (stalled >= STALLED_ROUNDS) throw new EmptyTrashStalled();
    }
  } finally {
    running.delete(controller);
    signal?.removeEventListener("abort", abort);
  }
}

export function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
