// Recent and Starred: what they ask for, how they group, what opening a row does, and that they
// refresh when another feature says the tree changed.
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INVALIDATE_WAIT_MS } from "../../../../src/client/features/starred/view-queries";
import { emitNodesChanged } from "../../../../src/client/lib/contracts";
import { setupShell } from "../shell/helpers";
import { node, nodeId, RECENT, RECENT_NOW, SEARCH, STARRED, TRASH } from "./fixtures";
import { json, openView, queryOf, requests, rowNames } from "./helpers";

setupShell();
afterEach(() => vi.useRealTimers());

const groupLabels = () =>
  Array.from(document.querySelectorAll("[data-group-label]"), (label) => label.textContent);
const row = (id: string) => document.querySelector<HTMLElement>(`[data-item-id="${id}"]`)!;

function freezeNow(iso: string) {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(iso) });
}

describe("/recent", () => {
  it("asks for the most the API gives and groups Today / Yesterday / This week / Earlier", async () => {
    freezeNow(RECENT_NOW);
    const { calls } = await openView("/recent", { "GET /api/recent": RECENT });
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    expect(queryOf(requests(calls, "GET", "/api/recent")[0]!).get("limit")).toBe("50");
    expect(groupLabels()).toEqual(["Today", "Yesterday", "This week", "Earlier"]);
    expect(screen.getByRole("grid", { name: "Recently opened files" })).toBeTruthy();
  });

  it("groups in the ACCOUNT's time zone: 20:00 UTC yesterday is already today in Tokyo", async () => {
    freezeNow(RECENT_NOW);
    await openView("/recent", { "GET /api/recent": RECENT }, { timezone: "Asia/Tokyo" });
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    // today.pdf and yesterday.pdf share the heading; the list has one fewer.
    expect(groupLabels()).toEqual(["Today", "This week", "Earlier"]);
  });

  it("a row with no opened-at time is placed by when it last changed", async () => {
    freezeNow(RECENT_NOW);
    await openView("/recent", {
      "GET /api/recent": {
        items: [node(1, { lastAccessedAt: null, updatedAt: "2026-10-12T09:00:00.000Z" })],
      },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(1));
    expect(groupLabels()).toEqual(["Yesterday"]);
  });

  it("opening a file goes to its preview with the list's files as siblings and this page to return to", async () => {
    const { router } = await openView("/recent", { "GET /api/recent": RECENT });
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    fireEvent.keyDown(row(nodeId(12)), { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/preview/${nodeId(12)}`));
    expect(router.state.location.state).toMatchObject({
      siblingIds: RECENT.items.map((item) => item.id),
      from: "/recent",
    });
  });

  it("nothing opened yet: its empty state", async () => {
    await openView("/recent", { "GET /api/recent": { items: [] } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Nothing opened yet" })).toBeTruthy());
  });
});

describe("/starred", () => {
  it("lists the starred nodes; a folder opens in the explorer, a file in the preview", async () => {
    const { router } = await openView("/starred", { "GET /api/starred": STARRED });
    await waitFor(() => expect(rowNames()).toEqual(STARRED.items.map((item) => item.id)));
    expect(screen.getByRole("grid", { name: "Starred files and folders" })).toBeTruthy();
    fireEvent.keyDown(row(nodeId(21)), { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${nodeId(21)}`));
  });

  it("opening a file names only the files as siblings", async () => {
    const { router } = await openView("/starred", { "GET /api/starred": STARRED });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    fireEvent.keyDown(row(nodeId(22)), { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/preview/${nodeId(22)}`));
    expect(router.state.location.state).toMatchObject({ siblingIds: [nodeId(22)], from: "/starred" });
  });

  it("pages with the cursor", async () => {
    const { intersect } = await import("../shell/helpers");
    const { calls } = await openView("/starred", {
      "GET /api/starred": (call) =>
        json(
          queryOf(call).get("cursor") === "page-2"
            ? { items: [node(23, { starred: true })], nextCursor: null }
            : { ...STARRED, nextCursor: "page-2" },
        ),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    act(() => intersect());
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(requests(calls, "GET", "/api/starred").map((call) => queryOf(call).get("cursor"))).toEqual([
      null,
      "page-2",
    ]);
  });

  it("nothing starred: its empty state", async () => {
    await openView("/starred", { "GET /api/starred": { items: [], nextCursor: null } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Nothing starred" })).toBeTruthy());
  });
});

describe("staying fresh: the tree-changed event", () => {
  const PAGES = [
    ["/starred", "/api/starred", STARRED],
    ["/recent", "/api/recent", RECENT],
    ["/trash", "/api/trash", TRASH],
    ["/search?q=report", "/api/search", SEARCH],
  ] as const;

  it.each(PAGES)("%s reads its list and the storage numbers again", async (path, api, fixture) => {
    const { calls } = await openView(path, { [`GET ${api}`]: fixture });
    await waitFor(() => expect(rowNames().length).toBeGreaterThan(0));
    const before = requests(calls, "GET", api).length;
    const usageBefore = requests(calls, "GET", "/api/account/usage").length;
    // What the explorer sends on a star toggle: the parent of the node that changed.
    act(() => emitNodesChanged([null]));
    await waitFor(() => expect(requests(calls, "GET", api).length).toBe(before + 1));
    await waitFor(() => expect(requests(calls, "GET", "/api/account/usage").length).toBe(usageBefore + 1));
  });

  it("a star made elsewhere shows in /starred without a reload", async () => {
    let starred = STARRED.items;
    await openView("/starred", { "GET /api/starred": () => json({ items: starred, nextCursor: null }) });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    starred = [...starred, node(24, { name: "new-star.pdf", starred: true })];
    act(() => emitNodesChanged([nodeId(21)]));
    await waitFor(() => expect(rowNames()).toContain(nodeId(24)));
  });

  it("an event of that name without the contract's detail is ignored", async () => {
    const { calls } = await openView("/starred", { "GET /api/starred": STARRED });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    vi.useFakeTimers();
    act(() => {
      window.dispatchEvent(new CustomEvent("holdfast:nodes-changed", { detail: { parentIds: "all" } }));
    });
    // Far past the wait after which a real event is acted on.
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS * 8));
    expect(requests(calls, "GET", "/api/starred")).toHaveLength(1);
  });

  it("many events are one round of reads: the wait starts at the first and later ones do not push it back", async () => {
    const { calls } = await openView("/starred", { "GET /api/starred": STARRED });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    const lists = () => requests(calls, "GET", "/api/starred").length;
    const usages = () => requests(calls, "GET", "/api/account/usage").length;
    const before = [lists(), usages()];
    vi.useFakeTimers();
    // What an upload of many files does: one event per finished file.
    for (let index = 0; index < 500; index++) emitNodesChanged([nodeId(21)]);
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS - 1));
    for (let index = 0; index < 500; index++) emitNodesChanged([nodeId(21)]);
    expect([lists(), usages()]).toEqual(before);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect([lists(), usages()]).toEqual([before[0]! + 1, before[1]! + 1]);
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS * 8));
    expect([lists(), usages()]).toEqual([before[0]! + 1, before[1]! + 1]);
    // A later event starts a new round.
    emitNodesChanged([null]);
    await act(() => vi.advanceTimersByTimeAsync(INVALIDATE_WAIT_MS));
    expect([lists(), usages()]).toEqual([before[0]! + 2, before[1]! + 2]);
  });
});
