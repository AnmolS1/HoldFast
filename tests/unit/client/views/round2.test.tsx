// Round 2 of the review: what a failed page, a rate limit and a late answer must NOT lead to
// while the page is being refreshed, used and left alone by turns.
import { focusManager, onlineManager } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { INVALIDATE_WAIT_MS, viewKeys } from "../../../../src/client/features/starred/view-queries";
import {
  clearPageFailures,
  pageFailureOf,
  useBlockedUntil,
} from "../../../../src/client/features/starred/view-state";
import { getEmptyRun, resetEmptyRun, startEmptyTrash } from "../../../../src/client/features/trash/empty-run";
import * as contracts from "../../../../src/client/lib/contracts";
import { emitNodesChanged } from "../../../../src/client/lib/contracts";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import { sessionOf, setupShell } from "../shell/helpers";
import {
  node,
  nodeId,
  remaining,
  restored,
  STARRED,
  TRASH,
  trashItem,
  trashItems,
  trashPage,
  USAGE,
} from "./fixtures";
import {
  deferred,
  envelope,
  json,
  openView,
  pathOf,
  queryOf,
  recordNodesChanged,
  requests,
  rowNames,
  type AnswerFn,
} from "./helpers";

setupShell();
const events = recordNodesChanged();

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
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  onlineManager.setOnline(true);
  focusManager.setFocused(undefined);
  resetEmptyRun();
  clearPageFailures();
});

const NO_CONTENT = () => new Response(null, { status: 204 });
const limited = (seconds?: string) =>
  envelope("rate_limited", 429, undefined, seconds === undefined ? {} : { "retry-after": seconds });
const settle = () =>
  act(async () => {
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  });
const notice = (view: string) => document.querySelector<HTMLElement>(`[data-list-notice="${view}"]`);
const cursorCalls = (calls: Parameters<typeof requests>[0], api: string, cursor: string | null) =>
  requests(calls, "GET", api).filter((call) => queryOf(call).get("cursor") === cursor).length;

/** Everything that refreshes a list without the user asking for the next page. */
async function refreshEveryWay() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  // 8 tree-changed events, each given time to become a round of reads.
  for (let index = 0; index < 8; index++) {
    emitNodesChanged([null]);
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS * 2));
  }
  vi.useRealTimers();
  // 4 returns to the tab.
  for (let index = 0; index < 4; index++) {
    act(() => focusManager.setFocused(false));
    act(() => focusManager.setFocused(true));
    await settle();
  }
  // 3 reconnects.
  for (let index = 0; index < 3; index++) {
    act(() => onlineManager.setOnline(false));
    act(() => onlineManager.setOnline(true));
    await settle();
  }
}

describe("A2: a failed next page is not asked for again by a refresh of the list", () => {
  beforeEach(() => {
    // Every automatic refetch that CAN happen does: nothing counts as fresh.
    queryClient.setDefaultOptions({ queries: { retry: false, staleTime: 0 } });
  });

  const LISTS = [
    ["/starred", "starred", "/api/starred", { ...STARRED, nextCursor: "c2" }],
    ["/trash", "trash", "/api/trash", trashPage(TRASH.items, "c2")],
  ] as const;

  it.each(LISTS)(
    "%s — page 2 answers 429 with Retry-After: 30; 8 events, 4 returns to the tab, 3 reconnects: that cursor is requested ONCE, and nothing of the list is read during the wait",
    async (path, view, api, first) => {
      const { calls } = await openView(path, {
        [`GET ${api}`]: (call) => (queryOf(call).get("cursor") === "c2" ? limited("30") : json(first)),
      });
      await waitFor(() => expect(notice(view)).not.toBeNull());
      const firstPageReads = cursorCalls(calls, api, null);
      expect(cursorCalls(calls, api, "c2")).toBe(1);
      await refreshEveryWay();
      expect(cursorCalls(calls, api, "c2")).toBe(1);
      // The API named a wait: no read of this list at all meanwhile.
      expect(cursorCalls(calls, api, null)).toBe(firstPageReads);
      // The notice never went away, and its button is still waiting.
      expect(notice(view)!.textContent).toContain("Couldn't load more of this list.");
      expect(
        (within(notice(view)!).getByRole("button", { name: "Try again" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(document.querySelector("[data-load-more-sentinel]")).toBeNull();
    },
  );

  it.each(LISTS)(
    "%s — page 2 answers 500 (no wait named): the pages in hand ARE refreshed, the failed cursor still is not asked for, and the notice stays until 'Try again'",
    async (path, view, api, first) => {
      let fail = true;
      const { calls } = await openView(path, {
        [`GET ${api}`]: (call) => {
          if (queryOf(call).get("cursor") !== "c2") return json(first);
          return fail
            ? envelope("internal", 500)
            : json(view === "trash" ? trashPage([trashItem(77)]) : { items: [node(77)], nextCursor: null });
        },
      });
      await waitFor(() => expect(notice(view)).not.toBeNull());
      const firstPageReads = cursorCalls(calls, api, null);
      await refreshEveryWay();
      expect(cursorCalls(calls, api, "c2")).toBe(1);
      expect(cursorCalls(calls, api, null)).toBeGreaterThan(firstPageReads);
      // The refreshes succeeded — the query's own error is gone — and still: the notice, no trigger.
      expect(queryClient.getQueryState(view === "trash" ? viewKeys.trash : viewKeys.starred)?.status).toBe(
        "success",
      );
      expect(notice(view)).not.toBeNull();
      expect(document.querySelector("[data-load-more-sentinel]")).toBeNull();
      // The user asks: one request, the rows come, the failure is forgotten.
      fail = false;
      fireEvent.click(within(notice(view)!).getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(rowNames()).toHaveLength(first.items.length + 1));
      expect(cursorCalls(calls, api, "c2")).toBe(2);
      expect(notice(view)).toBeNull();
      expect(pageFailureOf(view === "trash" ? viewKeys.trash : viewKeys.starred)).toBeNull();
    },
  );

  it("/trash — an Empty trash run of 8 batches refreshes the list 8 times; the failed cursor is requested once in total", async () => {
    let batches = 0;
    const { calls } = await openView("/trash", {
      "GET /api/trash": (call) =>
        queryOf(call).get("cursor") === "c2" ? envelope("internal", 500) : json(trashPage(TRASH.items, "c2")),
      "DELETE /api/trash": () => (++batches <= 8 ? json(remaining(100 - batches * 10), 202) : NO_CONTENT()),
    });
    await waitFor(() => expect(notice("trash")).not.toBeNull());
    const reads = cursorCalls(calls, "/api/trash", null);
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    await settle();
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(9);
    expect(cursorCalls(calls, "/api/trash", null)).toBeGreaterThan(reads);
    expect(cursorCalls(calls, "/api/trash", "c2")).toBe(1);
    expect(notice("trash")).not.toBeNull();
  });

  it("the FIRST page answering 429 with Retry-After: 30 is not read again by events, focus or reconnects either", async () => {
    const { calls } = await openView("/starred", { "GET /api/starred": () => limited("30") });
    await waitFor(() => expect(document.querySelector('[data-view-error="starred"]')).not.toBeNull());
    await refreshEveryWay();
    expect(requests(calls, "GET", "/api/starred")).toHaveLength(1);
  });

  it("the failure is the account's: a purge forgets it", async () => {
    await openView("/starred", {
      "GET /api/starred": (call) =>
        queryOf(call).get("cursor") === "c2"
          ? envelope("internal", 500)
          : json({ ...STARRED, nextCursor: "c2" }),
    });
    await waitFor(() => expect(pageFailureOf(viewKeys.starred)).not.toBeNull());
    await act(() => purgeUserState({ keepSession: true }));
    expect(pageFailureOf(viewKeys.starred)).toBeNull();
  });
});

describe("A1: a batch stops at the first answer that is about the API", () => {
  const twenty = trashItems(20);
  const openTwenty = async (answers: Record<string, AnswerFn>) => {
    const gone = new Set<string>();
    const view = await openView("/trash", {
      "GET /api/trash": () => json(trashPage(twenty.filter((item) => !gone.has(item.id)))),
      ...answers,
    });
    await waitFor(() => expect(rowNames()).toHaveLength(20));
    fireEvent.keyDown(document.querySelector<HTMLElement>("[data-item-index='0']")!, {
      key: "a",
      ctrlKey: true,
    });
    fireEvent.keyDown(document.querySelector<HTMLElement>("[data-item-index='0']")!, {
      key: "a",
      metaKey: true,
    });
    await waitFor(() => expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(20));
    return { ...view, gone };
  };
  const bar = () => within(document.querySelector<HTMLElement>("[data-selection-bar]")!);
  const nodeCalls = (calls: Parameters<typeof requests>[0], method: string) =>
    calls.filter((call) => call.method === method && pathOf(call).startsWith("/api/nodes/"));
  const everyNode = (answer: AnswerFn): Record<string, AnswerFn> =>
    Object.fromEntries(
      twenty.flatMap((item) => [
        [`POST /api/nodes/${item.id}/restore`, answer],
        [`DELETE /api/nodes/${item.id}`, answer],
      ]),
    );
  const stopped = () => document.querySelector<HTMLElement>("[data-trash-stopped]");

  it("Restore, 20 selected, every answer 429 with Retry-After: 30 → ONE request, one notice, all 20 still selected, the actions off for the wait", async () => {
    const { calls } = await openTwenty(everyNode(() => limited("30")));
    fireEvent.click(bar().getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(stopped()).not.toBeNull());
    expect(nodeCalls(calls, "POST").length).toBe(1);
    expect(nodeCalls(calls, "POST").length).toBeLessThanOrEqual(4);
    expect(stopped()!.getAttribute("role")).toBe("alert");
    expect(stopped()!.textContent).toBe(
      "Restoring stopped: 0 restored, 20 left. Too many requests just now. You can try again shortly. req req-1234",
    );
    expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(20);
    expect((bar().getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    expect((bar().getByRole("button", { name: /Delete forever/ }) as HTMLButtonElement).disabled).toBe(true);
    // Only the API client's own word about the limit — no toast per item.
    expect(getToasts()).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it("Delete forever, 20 selected, every answer 429 → ONE request, one notice", async () => {
    const { calls } = await openTwenty(everyNode(() => limited("30")));
    fireEvent.click(bar().getByRole("button", { name: /Delete forever/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Delete forever" }),
    );
    await waitFor(() => expect(stopped()).not.toBeNull());
    expect(nodeCalls(calls, "DELETE")).toHaveLength(1);
    expect(stopped()!.textContent).toContain("Deleting stopped: 0 deleted forever, 20 left.");
    expect(rowNames()).toHaveLength(20);
  });

  it("every answer a 500 → ONE request and no stack of toasts", async () => {
    const { calls } = await openTwenty(everyNode(() => envelope("internal", 500)));
    fireEvent.click(bar().getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(stopped()).not.toBeNull());
    expect(nodeCalls(calls, "POST")).toHaveLength(1);
    expect(stopped()!.textContent).toBe("Restoring stopped: 0 restored, 20 left. req req-1234");
    expect(getToasts()).toEqual([]);
    // No wait was named: the action is offered again at once.
    expect((bar().getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("three restored, then a 429 with Retry-After: 1 → '3 restored, 17 left', 17 still selected; after the wait the batch can go on", async () => {
    let sent = 0;
    let limit = true;
    const { calls, gone } = await openTwenty({});
    const answer: AnswerFn = (call) => {
      sent += 1;
      if (limit && sent === 4) return limited("1");
      const item = twenty.find((entry) => pathOf(call).includes(entry.id))!;
      gone.add(item.id);
      return json(restored(item));
    };
    const { answering } = await import("./helpers");
    const original = globalThis.fetch;
    const handler = answering(everyNode(answer));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input), "http://localhost:3000");
      if (url.pathname.startsWith("/api/nodes/")) {
        calls.push({
          method: (init.method ?? "GET").toUpperCase(),
          path: url.pathname,
          body: undefined,
          headers: {},
        });
        return (await handler({
          method: (init.method ?? "GET").toUpperCase(),
          path: url.pathname,
          body: undefined,
          headers: {},
        }))!;
      }
      return original(input, init);
    });
    fireEvent.click(bar().getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(stopped()).not.toBeNull());
    expect(stopped()!.textContent).toContain("Restoring stopped: 3 restored, 17 left.");
    expect(nodeCalls(calls, "POST")).toHaveLength(4);
    await waitFor(() => expect(document.querySelectorAll('[aria-selected="true"]')).toHaveLength(17));
    const restore = () => bar().getByRole("button", { name: "Restore" }) as HTMLButtonElement;
    expect(restore().disabled).toBe(true);
    // The API's own second, awaited as the action coming back.
    await waitFor(() => expect(restore().disabled).toBe(false), { timeout: 4000 });
    limit = false;
    fireEvent.click(restore());
    await waitFor(() => expect(rowNames()).toHaveLength(0));
    expect(stopped()).toBeNull();
    expect(nodeCalls(calls, "POST")).toHaveLength(21);
  });

  it("failures about single items (404) do not stop the batch, and are said in ONE toast", async () => {
    const { calls } = await openTwenty(everyNode(() => envelope("not_found", 404)));
    fireEvent.click(bar().getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(nodeCalls(calls, "POST")).toHaveLength(20));
    await waitFor(() => expect(getToasts()).toHaveLength(1));
    expect(stopped()).toBeNull();
  });
});

describe("A3: 'Empty the trash?' opens only as the continuation of its own click", () => {
  const openWithSlowRead = async () => {
    const read = deferred<Response>();
    let hold = false;
    const view = await openView("/trash", { "GET /api/trash": () => (hold ? read.promise : json(TRASH)) });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    fireEvent.click(screen.getByRole("checkbox", { name: "Select report.pdf" }));
    hold = true;
    fireEvent.click(document.querySelector<HTMLElement>("[data-empty-trash-button]")!);
    hold = false;
    return { ...view, read };
  };
  const emptyButton = () => document.querySelector<HTMLButtonElement>("[data-empty-trash-button]")!;
  const dialogs = () =>
    Array.from(document.querySelectorAll('[role="dialog"]'), (dialog) => dialog.textContent ?? "");

  it("while the read is out the button says so, and nothing else destructive can start", async () => {
    const { read } = await openWithSlowRead();
    expect(emptyButton().textContent).toBe("Checking the trash…");
    expect(emptyButton().getAttribute("aria-busy")).toBe("true");
    expect(emptyButton().disabled).toBe(true);
    const bar = within(document.querySelector<HTMLElement>("[data-selection-bar]")!);
    expect((bar.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    expect((bar.getByRole("button", { name: /Delete forever/ }) as HTMLButtonElement).disabled).toBe(true);
    // Left alone, the answer opens the dialog that was asked for.
    read.resolve(json(TRASH));
    expect(await screen.findByRole("dialog", { name: "Empty the trash?" })).toBeTruthy();
    expect(emptyButton().textContent).toBe("Empty trash");
  });

  it("the reviewer's sequence — Delete pressed while the read is out, then again: ONE dialog, the one the user asked for last", async () => {
    const { read } = await openWithSlowRead();
    // The first key withdraws the question (and is not itself a delete).
    fireEvent.keyDown(document.body, { key: "Delete" });
    expect(dialogs()).toEqual([]);
    await waitFor(() => expect(emptyButton().textContent).toBe("Empty trash"));
    fireEvent.keyDown(document.body, { key: "Delete" });
    const first = await screen.findByRole("dialog", { name: "Delete report.pdf forever?" });
    read.resolve(json(TRASH));
    await settle();
    expect(dialogs()).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: "Empty the trash?" })).toBeNull();
    // The two confirmations cannot be mistaken for each other: title and button both differ.
    expect(within(first).getByRole("button", { name: "Delete forever" })).toBeTruthy();
    expect(within(first).queryByRole("button", { name: "Empty trash" })).toBeNull();
  });

  it("the row menu → 'Delete forever' while the read is out: ONE dialog", async () => {
    const { read } = await openWithSlowRead();
    fireEvent.click(screen.getByRole("button", { name: "More actions for notes.txt" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Delete forever/ }));
    await screen.findByRole("dialog", { name: "Delete notes.txt forever?" });
    read.resolve(json(TRASH));
    await settle();
    expect(dialogs()).toHaveLength(1);
  });

  it("any other act withdraws it too — a click elsewhere, leaving the page — and nothing opens later", async () => {
    const first = await openWithSlowRead();
    fireEvent.click(document.querySelector<HTMLElement>("[data-main]")!);
    first.read.resolve(json(TRASH));
    await settle();
    expect(dialogs()).toEqual([]);
    expect(emptyButton().disabled).toBe(false);

    const read = deferred<Response>();
    let hold = true;
    first.calls.length = 0;
    vi.stubGlobal(
      "fetch",
      ((original) => (input: RequestInfo | URL, init?: RequestInit) =>
        hold && String(input).startsWith("/api/trash") ? read.promise : original(input, init))(
        globalThis.fetch,
      ),
    );
    fireEvent.click(emptyButton());
    await act(() => first.router.navigate("/starred"));
    hold = false;
    read.resolve(json(TRASH));
    await settle();
    expect(dialogs()).toEqual([]);
  });
});

describe("a2: the run is checked against the signed-in account before every batch", () => {
  it("another account signed in from another tab while a batch was out: the next DELETE is never sent, and nothing is said", async () => {
    let other = false;
    let batches = 0;
    const { calls } = await openView("/trash", {
      "GET /api/trash": TRASH,
      "GET /api/auth/get-session": () =>
        other ? json(sessionOf({ id: "b".repeat(32), name: "Bo", timezone: "UTC" })) : undefined,
      "DELETE /api/trash": () => {
        batches += 1;
        // While this batch is out, the cookie changes hands.
        other = true;
        return json(remaining(50), 202);
      },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const sessionReads = requests(calls, "GET", "/api/auth/get-session").length;
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    await settle();
    expect(batches).toBe(1);
    expect(requests(calls, "GET", "/api/auth/get-session").length).toBe(sessionReads + 1);
    expect(getToasts()).toEqual([]);
    expect(events).toEqual([]);
    expect(document.querySelector("[data-empty-trash-stopped]")).toBeNull();
  });

  it("the same account: the session is read before every batch after the first, and the run goes on", async () => {
    let batches = 0;
    const { calls } = await openView("/trash", {
      "GET /api/trash": TRASH,
      "DELETE /api/trash": () => (++batches <= 3 ? json(remaining(30 - batches * 10), 202) : NO_CONTENT()),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const sessionReads = requests(calls, "GET", "/api/auth/get-session").length;
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun()).toEqual({ state: "idle" }));
    expect(batches).toBe(4);
    expect(requests(calls, "GET", "/api/auth/get-session").length).toBe(sessionReads + 3);
    expect(events).toEqual([[]]);
  });

  it("a session that cannot be read stops the run — visibly — rather than deleting for an unknown account", async () => {
    let fail = false;
    let batches = 0;
    await openView("/trash", {
      "GET /api/trash": TRASH,
      "GET /api/auth/get-session": () => (fail ? new Response("{}", { status: 500 }) : undefined),
      "DELETE /api/trash": () => {
        batches += 1;
        fail = true;
        return json(remaining(50), 202);
      },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    act(() => startEmptyTrash());
    await waitFor(() => expect(getEmptyRun().state).toBe("stopped"));
    expect(batches).toBe(1);
  });
});

describe("a3: the second locks, each on its own", () => {
  it("the run's account check without the abort: an answer that lands after the purge began and before the purgers ran changes and says nothing", async () => {
    // The purge moves the epoch first and runs the purgers last; here the purgers never run, so
    // nothing aborts the loop — only the run's own check stands between the answer and the page.
    vi.spyOn(contracts, "runUserStatePurgers").mockResolvedValue(undefined);
    const first = deferred<Response>();
    let batches = 0;
    const { calls } = await openView("/trash", {
      "GET /api/trash": TRASH,
      "DELETE /api/trash": () => (++batches === 1 ? first.promise : NO_CONTENT()),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    act(() => startEmptyTrash());
    await waitFor(() => expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1));
    await act(() => purgeUserState({ keepSession: true }));
    expect(getEmptyRun()).toEqual({ state: "running", remaining: null });
    first.resolve(json(remaining(7), 202));
    await settle();
    // Not "Deleting… 7 left", no toast, no event, and no further batch for whoever is there now.
    expect(getEmptyRun()).toEqual({ state: "running", remaining: null });
    expect(getToasts()).toEqual([]);
    expect(events).toEqual([]);
    expect(requests(calls, "DELETE", "/api/trash")).toHaveLength(1);
  });

  it("a round of reads still waiting at the purge is not made for the next account", async () => {
    const { calls } = await openView("/starred", { "GET /api/starred": STARRED });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    emitNodesChanged([null]);
    await act(() => purgeUserState({ keepSession: true }));
    invalidate.mockClear();
    const before = requests(calls, "GET", "/api/starred").length;
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS * 4));
    expect(invalidate).not.toHaveBeenCalled();
    expect(requests(calls, "GET", "/api/starred").length).toBe(before);
  });

  it("mobile: Delete does nothing while the row's sheet is open", async () => {
    await openView("/trash", { "GET /api/trash": TRASH }, { width: 390 });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const row = document.querySelector<HTMLElement>(`[data-item-id="${TRASH.items[1]!.id}"]`)!;
    vi.useFakeTimers();
    fireEvent.pointerDown(row, { pointerType: "touch" });
    act(() => vi.advanceTimersByTime(600));
    vi.useRealTimers();
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "More actions for report.pdf" }));
    await screen.findByRole("dialog", { name: "report.pdf" });
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "Backspace" });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  });
});

describe("a1: a steady stream of events against a slow API still refreshes the view", () => {
  it("an event every 100 ms, answers after 350 ms: rounds finish, the list updates DURING the stream, and no round is cut off", async () => {
    let starred = STARRED.items;
    let slow = false;
    const aborted: string[] = [];
    const { calls } = await openView("/starred", {
      "GET /api/starred": () =>
        slow
          ? new Promise<Response>((resolve) =>
              setTimeout(() => resolve(json({ items: starred, nextCursor: null })), 350),
            )
          : json({ items: starred, nextCursor: null }),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) => {
      init.signal?.addEventListener("abort", () => aborted.push(String(input)));
      return original(input, init);
    });
    slow = true;
    const before = requests(calls, "GET", "/api/starred").length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    starred = [...starred, node(24, { name: "new-star.pdf", starred: true })];
    let seenDuringStream = false;
    for (let tick = 0; tick < 40; tick++) {
      emitNodesChanged([null]);
      await act(() => vi.advanceTimersByTimeAsync(100));
      if (rowNames().includes(nodeId(24))) seenDuringStream = true;
    }
    const during = requests(calls, "GET", "/api/starred").length - before;
    expect(seenDuringStream).toBe(true);
    expect(aborted.filter((url) => url.includes("/api/starred"))).toEqual([]);
    // 4 s of events: a round every 250 ms + the 350 ms the API takes (and never one per event).
    expect(during).toBeGreaterThanOrEqual(4);
    expect(during).toBeLessThanOrEqual(8);
    // …and once more after the last event.
    await act(() => vi.advanceTimersByTimeAsync(2000));
    expect(requests(calls, "GET", "/api/starred").length - before).toBe(during + 1);
  });
});

describe("a4: a wait longer than a timer can hold", () => {
  function Probe({ until }: { until: number }) {
    return <output>{useBlockedUntil(until) ? "blocked" : "open"}</output>;
  }

  it("thirty days of Retry-After do not unblock at once; a wait that has passed does", async () => {
    vi.useFakeTimers();
    const view = render(<Probe until={Date.now() + 30 * 86_400_000} />);
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(view.container.textContent).toBe("blocked");
    await act(() => vi.advanceTimersByTimeAsync(25 * 86_400_000));
    expect(view.container.textContent).toBe("blocked");
    await act(() => vi.advanceTimersByTimeAsync(5 * 86_400_000));
    expect(view.container.textContent).toBe("open");
    view.rerender(<Probe until={0} />);
    expect(view.container.textContent).toBe("open");
  });
});

describe("a5: after a 'Try again' that works, the keyboard focus is on the list — never on the document", () => {
  it("under a list: the first NEW row", async () => {
    let fail = true;
    await openView("/starred", {
      "GET /api/starred": (call) => {
        if (queryOf(call).get("cursor") !== "c2") return json({ ...STARRED, nextCursor: "c2" });
        return fail
          ? envelope("internal", 500)
          : json({ items: [node(77, { starred: true })], nextCursor: null });
      },
    });
    await waitFor(() => expect(notice("starred")).not.toBeNull());
    const retry = within(notice("starred")!).getByRole("button", { name: "Try again" });
    retry.focus();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item-id")).toBe(nodeId(77)));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("in the page's error state: the first row of the list that arrives", async () => {
    let fail = true;
    await openView("/starred", {
      "GET /api/starred": () => (fail ? envelope("internal", 500) : json(STARRED)),
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-item-id")).toBe(STARRED.items[0]!.id),
    );
  });

  it("on a page without a list (Storage): the page's main region", async () => {
    let fail = true;
    await openView("/storage", {
      "GET /api/account/usage": () => (fail ? envelope("internal", 500) : json(USAGE)),
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(document.querySelector("[data-usage-part]")).not.toBeNull());
    await waitFor(() => expect(document.activeElement?.hasAttribute("data-main")).toBe(true));
  });

  it("pressed with the pointer (focus elsewhere): the focus is not moved", async () => {
    let fail = true;
    await openView("/starred", {
      "GET /api/starred": () => (fail ? envelope("internal", 500) : json(STARRED)),
    });
    const retry = await screen.findByRole("button", { name: "Try again" });
    const before = document.activeElement;
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    await settle();
    expect(document.activeElement?.getAttribute("data-item-id")).toBeNull();
    expect(before).not.toBe(retry);
  });
});
