// Round 3 of the review: what a stopped batch, a forgotten failure, a withdrawn question and the
// second locks must do on their own — each test here fails when its one guard is taken out.
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { refreshQueries, viewKeys } from "../../../../src/client/features/starred/view-queries";
import {
  clearPageFailures,
  pageFailureOf,
  usePagedView,
  type PagedQueryLike,
} from "../../../../src/client/features/starred/view-state";
import { getEmptyRun, resetEmptyRun, startEmptyTrash } from "../../../../src/client/features/trash/empty-run";
import * as query from "../../../../src/client/lib/query";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import { setupShell } from "../shell/helpers";
import { node, SEARCH, STARRED, TRASH, trashItems, trashPage } from "./fixtures";
import {
  deferred,
  envelope,
  json,
  openView,
  pathOf,
  queryOf,
  requests,
  rowNames,
  type AnswerFn,
} from "./helpers";

setupShell();

beforeEach(() => {
  // An observer that reports a visible target as soon as it is observed, like a browser's.
  class EagerObserver {
    constructor(
      private readonly callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void,
    ) {}
    observe(target: Element) {
      queueMicrotask(() => this.callback([{ isIntersecting: true, target }]));
    }
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  }
  Object.assign(window, { IntersectionObserver: EagerObserver });
  Object.assign(globalThis, { IntersectionObserver: EagerObserver });
  queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await purgeUserState({ keepSession: true });
  resetEmptyRun();
  clearPageFailures();
});

const NO_CONTENT = () => new Response(null, { status: 204 });
const limited = (seconds: string) => envelope("rate_limited", 429, undefined, { "retry-after": seconds });
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  });
const notice = (view: string) => document.querySelector<HTMLElement>(`[data-list-notice="${view}"]`);
const cursorCalls = (calls: Parameters<typeof requests>[0], api: string, cursor: string | null) =>
  requests(calls, "GET", api).filter((call) => queryOf(call).get("cursor") === cursor).length;

describe("n1: a batch's Retry-After outlives the visit to /trash", () => {
  it("Restore stopped by a 429 (Retry-After: 30), then /starred and back, the rows selected again: the actions are still off, the notice is still there, and nothing is sent", async () => {
    const twenty = trashItems(20);
    const answers: Record<string, AnswerFn> = Object.fromEntries(
      twenty.map((item) => [`POST /api/nodes/${item.id}/restore`, () => limited("30")]),
    );
    const { calls, router } = await openView("/trash", {
      "GET /api/trash": () => json(trashPage(twenty)),
      "GET /api/starred": STARRED,
      ...answers,
    });
    const selectAll = async () => {
      await waitFor(() => expect(rowNames()).toHaveLength(20));
      fireEvent.keyDown(document.querySelector<HTMLElement>("[data-item-index='0']")!, {
        key: "a",
        ctrlKey: true,
      });
      await waitFor(() => expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(20));
    };
    const bar = () => within(document.querySelector<HTMLElement>("[data-selection-bar]")!);
    const posts = () =>
      calls.filter((call) => call.method === "POST" && pathOf(call).startsWith("/api/nodes/"));
    await selectAll();
    fireEvent.click(bar().getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(document.querySelector("[data-trash-stopped]")).not.toBeNull());
    expect(posts()).toHaveLength(1);

    await act(() => router.navigate("/starred"));
    await waitFor(() => expect(document.querySelector('[data-view-page="starred"]')).not.toBeNull());
    await act(() => router.navigate("/trash"));
    await selectAll();
    const restore = bar().getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(true);
    expect((bar().getByRole("button", { name: /Delete forever/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector("[data-trash-stopped]")!.textContent).toContain(
      "Restoring stopped: 0 restored, 20 left.",
    );
    fireEvent.click(restore);
    fireEvent.keyDown(document.body, { key: "Delete" });
    await settle();
    expect(posts()).toHaveLength(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("the stop is the account's: a purge forgets it", async () => {
    const twenty = trashItems(2);
    const { calls } = await openView("/trash", {
      "GET /api/trash": () => json(trashPage(twenty)),
      [`POST /api/nodes/${twenty[0]!.id}/restore`]: () => limited("30"),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${twenty[0]!.name}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(document.querySelector("[data-trash-stopped]")).not.toBeNull());
    await act(() => purgeUserState({ keepSession: true }));
    await waitFor(() => expect(document.querySelector("[data-trash-stopped]")).toBeNull());
    expect(requests(calls, "POST", `/api/nodes/${twenty[0]!.id}/restore`)).toHaveLength(1);
  });
});

describe("n5: one announcement for a stopped run, decided as the API client decides", () => {
  it("a 503 the API client does not toast (not read-only, not paused) stops the run with this feature's toast — not in silence", async () => {
    await openView("/trash", {
      "GET /api/trash": TRASH,
      "DELETE /api/trash": () => envelope("unavailable", 503),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun().state).toBe("stopped"));
    await waitFor(() =>
      expect(getToasts().map((toast) => toast.message)).toEqual([
        "Couldn't finish emptying the trash. Try again.",
      ]),
    );
  });

  it("a 503 read_only is the API client's to say: one toast, not two", async () => {
    await openView("/trash", {
      "GET /api/trash": TRASH,
      "DELETE /api/trash": () => envelope("read_only", 503),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun().state).toBe("stopped"));
    await settle();
    expect(getToasts()).toHaveLength(1);
    expect(getToasts()[0]!.message).not.toContain("emptying the trash");
  });
});

describe("n3: a failed page does not outlive its query, nor a search started again", () => {
  it("/starred: page 2 fails (500); the list leaves the cache; back on /starred → a fresh list that asks for page 2 again, with no old notice", async () => {
    let fail = true;
    const { calls, router } = await openView("/starred", {
      "GET /api/starred": (call) => {
        if (queryOf(call).get("cursor") !== "c2") return json({ ...STARRED, nextCursor: "c2" });
        return fail ? envelope("internal", 500) : json({ items: [node(77)], nextCursor: null });
      },
    });
    await waitFor(() => expect(notice("starred")).not.toBeNull());
    await act(() => router.navigate("/recent"));
    act(() => queryClient.removeQueries({ queryKey: viewKeys.starred }));
    expect(pageFailureOf(viewKeys.starred)).toBeNull();
    fail = false;
    await act(() => router.navigate("/starred"));
    await waitFor(() => expect(rowNames()).toHaveLength(STARRED.items.length + 1));
    expect(cursorCalls(calls, "/api/starred", "c2")).toBe(2);
    expect(notice("starred")).toBeNull();
  });

  const searchAnswers = (page2: () => Response) => ({
    "GET /api/search": (call: Parameters<AnswerFn>[0]) =>
      queryOf(call).get("cursor") === "c2" ? page2() : json({ ...SEARCH, nextCursor: "c2" }),
  });

  it("/search: page 2 fails (500); the same search started again from outside the box (the header) asks for page 2 again", async () => {
    let fail = true;
    const { calls, router } = await openView(
      "/search?q=report",
      searchAnswers(() => (fail ? envelope("internal", 500) : json({ items: [], nextCursor: null }))),
    );
    await waitFor(() => expect(notice("search")).not.toBeNull());
    fail = false;
    await act(() => router.navigate("/search?q=report"));
    await waitFor(() => expect(cursorCalls(calls, "/api/search", "c2")).toBe(2));
    await waitFor(() => expect(notice("search")).toBeNull());
  });

  it("/search: but not inside the wait the API named — a 429 with Retry-After: 30 on page 2 is not asked for again by a new start", async () => {
    const { calls, router } = await openView(
      "/search?q=report",
      searchAnswers(() => limited("30")),
    );
    await waitFor(() => expect(notice("search")).not.toBeNull());
    await act(() => router.navigate("/search?q=report"));
    await settle();
    expect(cursorCalls(calls, "/api/search", "c2")).toBe(1);
    expect(notice("search")).not.toBeNull();
  });
});

describe("n4: 'Empty the trash?' and the keys pressed while its read is out", () => {
  const openWithSlowRead = async () => {
    const read = deferred<Response>();
    let hold = false;
    const view = await openView("/trash", { "GET /api/trash": () => (hold ? read.promise : json(TRASH)) });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    hold = true;
    fireEvent.click(document.querySelector<HTMLElement>("[data-empty-trash-button]")!);
    hold = false;
    return { ...view, read };
  };
  const status = () => document.querySelector("[data-empty-trash-progress]")!.textContent;

  it("Tab, Shift and the arrows only move on: the question is still asked", async () => {
    const { read } = await openWithSlowRead();
    for (const key of ["Tab", "Shift", "ArrowDown", "ArrowUp"]) fireEvent.keyDown(document.body, { key });
    read.resolve(json(TRASH));
    expect(await screen.findByRole("dialog", { name: "Empty the trash?" })).toBeTruthy();
    expect(status()).toBe("");
  });

  it("a key that acts (Escape) withdraws it — and the status line says so", async () => {
    const { read } = await openWithSlowRead();
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(status()).toBe("Empty trash cancelled."));
    expect(document.querySelector("[data-empty-trash-progress]")!.getAttribute("role")).toBe("status");
    read.resolve(json(TRASH));
    await settle();
    expect(screen.queryByRole("dialog")).toBeNull();
    // Asked again, the line is cleared.
    fireEvent.click(document.querySelector<HTMLElement>("[data-empty-trash-button]")!);
    await screen.findByRole("dialog", { name: "Empty the trash?" });
    expect(status()).toBe("");
  });
});

describe("n7: the second locks, each on its own", () => {
  /** A paged query whose next page answers what the test says, when it says. */
  const fakeQuery = (next: () => Promise<Awaited<ReturnType<PagedQueryLike["fetchNextPage"]>>>) => {
    const fetchNextPage = vi.fn(next);
    const fake: PagedQueryLike = {
      data: { pages: [] },
      error: null,
      isError: false,
      errorUpdatedAt: 0,
      fetchStatus: "idle",
      refetch: async () => ({ isSuccess: true }),
      hasNextPage: true,
      fetchNextPage,
    };
    return { fake, fetchNextPage };
  };
  const failed = { isError: true, isFetchNextPageError: true, error: new Error("page 2") };
  const KEY = ["views", "probe"] as const;

  it("loadMore with a page failed: no request, even when called (not only when the trigger is off)", async () => {
    const { fake, fetchNextPage } = fakeQuery(async () => failed);
    const { result } = renderHook(() => usePagedView(fake, KEY, 0));
    await act(async () => result.current.loadMore());
    await waitFor(() => expect(pageFailureOf(KEY)).not.toBeNull());
    await act(async () => result.current.loadMore());
    await act(async () => result.current.loadMore());
    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it("a next page that fails after the account's state was purged is not remembered for the next account", async () => {
    const answer = deferred<typeof failed>();
    const { fake } = fakeQuery(() => answer.promise);
    const { result } = renderHook(() => usePagedView(fake, KEY, 0));
    act(() => result.current.loadMore());
    await act(() => purgeUserState({ keepSession: true }));
    answer.resolve(failed);
    await settle();
    expect(pageFailureOf(KEY)).toBeNull();
  });

  it("a refresh while a read of the list is out does not cut it off and send another", async () => {
    const held = deferred<Response>();
    let hold = false;
    const { calls } = await openView("/trash", {
      "GET /api/trash": () => (hold ? held.promise : json(TRASH)),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    hold = true;
    void refreshQueries(viewKeys.trash);
    await waitFor(() => expect(requests(calls, "GET", "/api/trash")).toHaveLength(2));
    void refreshQueries(viewKeys.trash);
    void refreshQueries(viewKeys.trash);
    await settle();
    expect(requests(calls, "GET", "/api/trash")).toHaveLength(2);
    hold = false;
    held.resolve(json(TRASH));
    await settle();
    expect(rowNames()).toHaveLength(3);
  });

  it("a dialog that opened while the read was out — with no key or click the page could see — keeps 'Empty the trash?' shut", async () => {
    const read = deferred<Response>();
    let hold = false;
    await openView("/trash", { "GET /api/trash": () => (hold ? read.promise : json(TRASH)) });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    hold = true;
    fireEvent.click(document.querySelector<HTMLElement>("[data-empty-trash-button]")!);
    hold = false;
    // Something else put a dialog up by itself (another feature, the re-auth dialog).
    const other = render(<div role="dialog" aria-label="Something else" />);
    read.resolve(json(TRASH));
    await settle();
    expect(screen.queryByRole("dialog", { name: "Empty the trash?" })).toBeNull();
    other.unmount();
  });

  it("the run's check of the account this tab knows: when it no longer names the run's owner, no DELETE is sent and nothing is said", async () => {
    const { calls } = await openView("/trash", {
      "GET /api/trash": TRASH,
      "DELETE /api/trash": () => NO_CONTENT(),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const owner = query.getKnownUserId();
    // The session read still names the owner, and the epoch has not moved: only what this tab
    // knows has changed by the time the batch would leave.
    const known = vi
      .spyOn(query, "getKnownUserId")
      .mockReturnValueOnce(owner)
      .mockReturnValue("b".repeat(32));
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    await settle();
    expect(known).toHaveBeenCalled();
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(0);
    expect(getToasts()).toEqual([]);
  });
});
