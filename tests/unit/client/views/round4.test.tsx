// Round 4 of the review: a wait the API named lives in one registry (waits.ts) that no write to
// the cache can lift; an expired session before a run's first batch goes through re-auth; the
// "cancelled" note goes with the next act.
import { focusManager, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { INVALIDATE_WAIT_MS, viewKeys } from "../../../../src/client/features/starred/view-queries";
import {
  clearPageFailures,
  usePagedView,
  type PagedQueryLike,
} from "../../../../src/client/features/starred/view-state";
import { clearWaits, holdUntil, waitKey, waitUntil } from "../../../../src/client/features/starred/waits";
import { getEmptyRun, resetEmptyRun, startEmptyTrash } from "../../../../src/client/features/trash/empty-run";
import { cancelReauth, completeReauth, isReauthPending } from "../../../../src/client/lib/api";
import { emitNodesChanged } from "../../../../src/client/lib/contracts";
import {
  confirmReauthIdentity,
  getKnownUserId,
  purgeUserState,
  queryClient,
} from "../../../../src/client/lib/query";
import { sessionOf, setupShell } from "../shell/helpers";
import { remaining, STARRED, TRASH } from "./fixtures";
import { deferred, envelope, json, openView, queryOf, requests, rowNames } from "./helpers";

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
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  resetEmptyRun();
  clearPageFailures();
  clearWaits();
});

const NO_CONTENT = () => new Response(null, { status: 204 });
const limited = (seconds: string) => envelope("rate_limited", 429, undefined, { "retry-after": seconds });
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  });
const TRASH_WAIT = waitKey(viewKeys.trash);
const trashReads = (calls: Parameters<typeof requests>[0]) => requests(calls, "GET", "/api/trash").length;
const refreshFailed = () => screen.queryByText(/Couldn't refresh this list/);
const rateToasts = () => getToasts().filter((toast) => toast.message.startsWith("Too many requests"));

/** Everything that refreshes a list without the user asking. */
async function refreshEveryWay() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  for (let index = 0; index < 8; index++) {
    emitNodesChanged([null]);
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS * 2));
  }
  vi.useRealTimers();
  for (let index = 0; index < 4; index++) {
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await settle();
  }
  for (let index = 0; index < 3; index++) {
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await settle();
  }
}

/** `/trash` whose first read answers the rows and every later read `429` with `Retry-After: 30`. */
async function openTrashThenLimited(answers: Parameters<typeof openView>[1] = {}) {
  let reads = 0;
  const view = await openView("/trash", {
    "GET /api/trash": () => (++reads === 1 ? json(TRASH) : limited("30")),
    ...answers,
  });
  await waitFor(() => expect(rowNames()).toHaveLength(3));
  return view;
}

/** Make the list's OWN refresh answer `429`: an event, gathered into a round of reads. */
async function holdTheListByItsOwnRefresh() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  emitNodesChanged([null]);
  await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS * 2));
  vi.useRealTimers();
  await waitFor(() => expect(waitUntil(TRASH_WAIT)).toBeGreaterThan(0));
}

describe("r4-1: no write to the cache lifts the list's own Retry-After", () => {
  it("the run's own refresh draws 429 Retry-After: 30, the run ends in 204: 'Trash emptied', then no read of /api/trash during the wait — no second 'Too many requests', no 'Couldn't refresh'", async () => {
    const last = deferred<Response>();
    let batches = 0;
    const { calls } = await openTrashThenLimited({
      "DELETE /api/trash": () => (++batches === 1 ? json(remaining(3), 202) : last.promise),
    });
    act(() => startEmptyTrash());
    // Batch 1's refresh is answered 429: the list is held by its own wait.
    await waitFor(() => expect(waitUntil(TRASH_WAIT)).toBeGreaterThan(0));
    await waitFor(() => expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(2));
    const reads = trashReads(calls);
    last.resolve(NO_CONTENT());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    await waitFor(() => expect(rowNames()).toEqual([]));
    expect(getToasts().map((toast) => toast.message)).toContain("Trash emptied");
    await refreshEveryWay();
    expect(trashReads(calls)).toBe(reads);
    expect(rateToasts()).toHaveLength(1);
    expect(refreshFailed()).toBeNull();
    expect(rowNames()).toEqual([]);
  });

  it("a single Restore while the list's own refresh is held: the row goes, and nothing reads the list during the wait", async () => {
    const report = TRASH.items[0]!;
    const { calls } = await openTrashThenLimited({
      [`POST /api/nodes/${report.id}/restore`]: () => json({ ...report, deletedAt: null, purgeAfter: null }),
    });
    await holdTheListByItsOwnRefresh();
    const reads = trashReads(calls);
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${report.name}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Restore" }));
    await waitFor(() => expect(rowNames()).not.toContain(report.id));
    await refreshEveryWay();
    expect(trashReads(calls)).toBe(reads);
    expect(rateToasts()).toHaveLength(1);
    expect(refreshFailed()).toBeNull();
  });

  it("a single Delete forever while the list's own refresh is held: the same", async () => {
    const report = TRASH.items[0]!;
    const { calls } = await openTrashThenLimited({ [`DELETE /api/nodes/${report.id}`]: () => NO_CONTENT() });
    await holdTheListByItsOwnRefresh();
    const reads = trashReads(calls);
    fireEvent.click(screen.getByRole("button", { name: `More actions for ${report.name}` }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete forever/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete forever" }),
    );
    await waitFor(() => expect(rowNames()).not.toContain(report.id));
    await refreshEveryWay();
    expect(trashReads(calls)).toBe(reads);
    expect(rateToasts()).toHaveLength(1);
    expect(refreshFailed()).toBeNull();
  });

  it("the waits are the account's: a purge forgets them (the next account's list is read at once)", async () => {
    let limit = true;
    let reads = 0;
    const { calls } = await openView("/trash", {
      "GET /api/trash": () => (limit && ++reads > 1 ? limited("30") : json(TRASH)),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    await holdTheListByItsOwnRefresh();
    limit = false;
    const before = trashReads(calls);
    await act(() => purgeUserState({ keepSession: true }));
    expect(waitUntil(TRASH_WAIT)).toBe(0);
    await waitFor(() => expect(trashReads(calls)).toBeGreaterThan(before));
  });
});

describe("r4-2: a failed page's wait outlives its query", () => {
  it("/starred page 2 answers 429 Retry-After: 30; the list leaves the cache; back on /starred → page 1 is read, page 2 is not asked for inside the wait", async () => {
    const { calls, router } = await openView("/starred", {
      "GET /api/starred": (call) =>
        queryOf(call).get("cursor") === "c2" ? limited("30") : json({ ...STARRED, nextCursor: "c2" }),
    });
    const pageTwo = () =>
      requests(calls, "GET", "/api/starred").filter((call) => queryOf(call).get("cursor") === "c2");
    await waitFor(() => expect(pageTwo()).toHaveLength(1));
    await act(() => router.navigate("/recent"));
    act(() => queryClient.removeQueries({ queryKey: viewKeys.starred }));
    await act(() => router.navigate("/starred"));
    await waitFor(() => expect(rowNames()).toHaveLength(STARRED.items.length));
    await settle();
    expect(pageTwo()).toHaveLength(1);
    expect(document.querySelector("[data-load-more-sentinel]")).toBeNull();
  });
});

describe("r4-2: loadMore on its own", () => {
  it("a list inside a wait asks for no page, even when loadMore is called (not only when the trigger is off)", async () => {
    const KEY = ["views", "probe-wait"] as const;
    const fetchNextPage = vi.fn(async () => ({ isError: false, isFetchNextPageError: false, error: null }));
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
    holdUntil(waitKey(KEY), Date.now() + 30_000);
    const { result } = renderHook(() => usePagedView(fake, KEY, 0));
    expect(result.current.hasMore).toBe(false);
    await act(async () => result.current.loadMore());
    expect(fetchNextPage).not.toHaveBeenCalled();
  });
});

describe("r4-3: a session found expired before the first batch is the re-auth case, never a silent end", () => {
  /** `/trash` signed in as A; then the session ends on the server; the first DELETE answers 401. */
  async function openThenExpire() {
    let expired = false;
    let batches = 0;
    const view = await openView("/trash", {
      "GET /api/trash": TRASH,
      "GET /api/auth/get-session": () => (expired ? json(null) : undefined),
      "DELETE /api/trash": () => (++batches === 1 ? envelope("unauthorized", 401) : NO_CONTENT()),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expired = true;
    return { ...view, back: () => (expired = false) };
  }

  it("re-auth as the SAME account: the confirmed run goes on and ends", async () => {
    const { calls, back } = await openThenExpire();
    act(() => startEmptyTrash());
    await waitFor(() => expect(isReauthPending()).toBe(true));
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
    back();
    act(() => completeReauth());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(2);
    expect(getToasts().map((toast) => toast.message)).toContain("Trash emptied");
  });

  it("re-auth cancelled: the run stops and says so", async () => {
    const { calls } = await openThenExpire();
    act(() => startEmptyTrash());
    await waitFor(() => expect(isReauthPending()).toBe(true));
    act(() => cancelReauth());
    await waitFor(() => expect(getEmptyRun().state).toBe("stopped"));
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
    await waitFor(() =>
      expect(getToasts().map((toast) => toast.message)).toContain(
        "Couldn't finish emptying the trash. Try again.",
      ),
    );
    expect(document.querySelector("[data-empty-trash-stopped]")!.textContent).toContain(
      "Couldn't finish emptying the trash.",
    );
  });

  it("re-auth as ANOTHER account: nothing is replayed for it — the shell starts afresh as that account", async () => {
    const { calls } = await openThenExpire();
    const owner = getKnownUserId();
    act(() => startEmptyTrash());
    await waitFor(() => expect(isReauthPending()).toBe(true));
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    // What the re-auth dialog does after a sign-in that names somebody else.
    const outcome = await act(async () => {
      // The session read after the sign-in names B.
      const original = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
        String(input).startsWith("/api/auth/get-session")
          ? Promise.resolve(json(sessionOf({ id: "b".repeat(32), name: "Bo", timezone: "UTC" })))
          : original(input, init),
      );
      return confirmReauthIdentity(owner);
    });
    expect(outcome).toBe("changed");
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    await settle();
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
    expect(getToasts().filter((toast) => toast.message.includes("emptying the trash"))).toEqual([]);
  });
});

describe("r4-4: 'Empty trash cancelled.' goes with the next act", () => {
  const openAndWithdraw = async () => {
    const read = deferred<Response>();
    let hold = false;
    await openView("/trash", { "GET /api/trash": () => (hold ? read.promise : json(TRASH)) });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    hold = true;
    fireEvent.click(document.querySelector<HTMLElement>("[data-empty-trash-button]")!);
    hold = false;
    fireEvent.keyDown(document.body, { key: "Escape" });
    await waitFor(() => expect(status()).toBe("Empty trash cancelled."));
    read.resolve(json(TRASH));
    await settle();
  };
  const status = () => document.querySelector("[data-empty-trash-progress]")!.textContent;

  it("a key", async () => {
    await openAndWithdraw();
    fireEvent.keyDown(document.body, { key: "Tab" });
    await waitFor(() => expect(status()).toBe(""));
  });

  it("a press", async () => {
    await openAndWithdraw();
    fireEvent.pointerDown(document.querySelector<HTMLElement>("[data-main]")!);
    await waitFor(() => expect(status()).toBe(""));
  });
});
