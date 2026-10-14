// M3 — a failed optimistic action undoes ITS change, on whatever the cache holds by then, and the
// parent is read again; a refetch under way cannot overwrite an optimistic edit.
// M5 — many items never means many requests at once.
import { focusManager } from "@tanstack/react-query";
import { act, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot, subscribeRibbon } from "../../../../src/client/components/TransferRibbon/store";
import {
  MAX_IN_FLIGHT,
  moveNodes,
  PROGRESS_FROM,
  renameNode,
  setStarred,
  trashNodes,
} from "../../../../src/client/features/explorer/actions";
import { explorerKeys, type Listing } from "../../../../src/client/features/explorer/queries";
import { emitNodesChanged } from "../../../../src/client/lib/contracts";
import { queryClient } from "../../../../src/client/lib/query";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { envelope, intersect, json, type MockCall } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode, manyNodes, pageOf } from "./fixtures/nodes";
import {
  deferred,
  recordNodesChanged,
  renderExplorer,
  rowOf,
  rows,
  serveDrive,
  setupExplorer,
  toastMessages,
  waitForRows,
} from "./helpers";

setupExplorer();

const ALPHA = folderNode(1, { name: "Alpha" });
const A = fileNode(2, { name: "a.pdf" });
const B = fileNode(3, { name: "b.pdf" });
const C = fileNode(4, { name: "c.pdf" });
const KEY = explorerKeys.listing(null, "name", "asc");

const seed = (nodes: NodeDto[], key = KEY) =>
  queryClient.setQueryData<Listing>(key, { pages: [pageOf(nodes)], pageParams: [undefined] });
const listed = (key = KEY) => queryClient.getQueryData<Listing>(key)!.pages.flatMap((page) => page.items);
const names = (key = KEY) => listed(key).map((node) => node.name);
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
const answerOf = (drive: FakeDrive, call: MockCall) => {
  const answer = drive.handle(call)!;
  return json(answer.body, answer.status);
};

// m17 (review round 2): with the page mounted, a listing has an observer, so the tree-changed
// event of a sibling action really reads it again — the seeded-cache tests above cannot see this.
describe("m17/m25 — a read that starts while an optimistic edit is in flight waits for it", () => {
  const listingReads = (calls: MockCall[]) =>
    calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/nodes/root")).length;
  /** A read of the top-level listing has started and is waiting (nothing has been asked yet). */
  const readWaiting = () =>
    vi.waitFor(() =>
      expect(queryClient.isFetching({ queryKey: explorerKeys.children(null) })).toBeGreaterThan(0),
    );
  /** Trash A with its request held until `gate` opens; the page is showing "/". */
  async function heldTrash() {
    const drive = new FakeDrive([ALPHA, A, B, C]);
    const gate = deferred<void>();
    const calls = serveDrive(drive, async (call) => {
      if (call.path.endsWith(`${A.id}/trash`)) await gate.promise;
      return undefined;
    });
    const view = renderExplorer("/");
    await waitForRows(4);
    const trashing = trashNodes([A]);
    // Its optimistic removal is drawn (the request is held).
    await vi.waitFor(() => expect(rowOf(A.id)).toBeNull());
    return { drive, gate, calls, view, trashing, readsBefore: listingReads(calls) };
  }
  /** The list as a remount or a focus sees it once its freshness has passed. */
  const markStale = () =>
    act(async () => {
      await queryClient.invalidateQueries({ queryKey: explorerKeys.children(null), refetchType: "none" });
    });
  async function settle(held: Awaited<ReturnType<typeof heldTrash>>) {
    held.gate.resolve();
    await act(async () => {
      await held.trashing;
    });
    await vi.waitFor(() => expect(listingReads(held.calls)).toBe(held.readsBefore + 1));
    await waitForRows(3);
    expect(rowOf(A.id)).toBeNull();
  }

  it("trash A (held) → trash B (done): A stays out while its trash is pending; the list is read once, after", async () => {
    const held = await heldTrash();
    await act(async () => {
      await trashNodes([B]);
    });
    // B's event started a read of the list; it waits for A — the server still lists A.
    await readWaiting();
    // B's own removal is drawn (the list draws in a transition: wait for it); A stays out.
    await vi.waitFor(() => expect(rowOf(B.id)).toBeNull());
    expect(rowOf(A.id)).toBeNull();
    expect(listingReads(held.calls)).toBe(held.readsBefore);
    held.gate.resolve();
    await act(async () => {
      await held.trashing;
    });
    await waitForRows(2);
    expect(rows().map((row) => row.getAttribute("data-item-id"))).toEqual([ALPHA.id, C.id]);
    // Read again once, after A settled — not once per event.
    expect(listingReads(held.calls)).toBe(held.readsBefore + 1);
  });

  it("a rename in flight is not drawn back to its old name by a sibling's refetch", async () => {
    const drive = new FakeDrive([ALPHA, A, B, C]);
    const gate = deferred<void>();
    serveDrive(drive, async (call) => {
      if (call.method === "PATCH" && call.path.endsWith(A.id)) await gate.promise;
      return undefined;
    });
    renderExplorer("/");
    await waitForRows(4);
    const renaming = renameNode(A, "z.pdf");
    await vi.waitFor(() => expect(rowOf(A.id)!.textContent).toContain("z.pdf"));
    await act(async () => {
      await trashNodes([B]);
    });
    await readWaiting();
    expect(rowOf(A.id)!.textContent).toContain("z.pdf");
    gate.resolve();
    await act(async () => {
      await renaming;
    });
    expect(rowOf(A.id)!.textContent).toContain("z.pdf");
  });

  it("a remount of the list (leave and come back) waits too", async () => {
    const held = await heldTrash();
    held.view.unmount();
    await markStale();
    renderExplorer("/");
    await readWaiting();
    expect(listingReads(held.calls)).toBe(held.readsBefore);
    expect(rowOf(A.id)).toBeNull();
    await settle(held);
  });

  // The refresh-failed Retry cannot be pressed during an edit: the edit writes the list, and with it
  // the banner goes. The button that IS there during an edit is a long folder's Reload — the same
  // read, from the first page.
  it("Reload of a long folder waits too", async () => {
    const nodes = manyNodes(900);
    const target = nodes[5]!;
    const drive = new FakeDrive(nodes);
    const gate = deferred<void>();
    const calls = serveDrive(drive, async (call) => {
      if (call.path.endsWith(`${target.id}/trash`)) await gate.promise;
      return undefined;
    });
    renderExplorer("/");
    const count = () => document.querySelector("[data-item-count]")?.textContent ?? "";
    await vi.waitFor(() => expect(count()).toMatch(/^200 items/));
    for (const loaded of [400, 600, 800]) {
      act(() => intersect((element) => element.hasAttribute("data-load-more-sentinel")));
      await vi.waitFor(() => expect(count()).toMatch(new RegExp(`^${loaded} items`)));
    }
    act(() => emitNodesChanged([null]));
    await vi.waitFor(() => expect(document.querySelector("[data-reload]")).not.toBeNull());
    const trashing = trashNodes([target]);
    await vi.waitFor(() => expect(rowOf(target.id)).toBeNull());
    const reads = listingReads(calls);
    fireEvent.click(document.querySelector<HTMLElement>("[data-reload]")!);
    await readWaiting();
    expect(listingReads(calls)).toBe(reads);
    gate.resolve();
    await act(async () => {
      await trashing;
    });
    await vi.waitFor(() => expect(listingReads(calls)).toBe(reads + 1));
    await vi.waitFor(() => expect(count()).toMatch(/^200 items/));
    expect(rowOf(target.id)).toBeNull();
  });

  it("window focus waits too (the focus refetch goes through the same read)", async () => {
    const held = await heldTrash();
    await markStale();
    act(() => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await readWaiting();
    expect(listingReads(held.calls)).toBe(held.readsBefore);
    expect(rowOf(A.id)).toBeNull();
    await settle(held);
    focusManager.setFocused(undefined);
  });
});

describe("m24 — a failed trash on its own reads the parent again", () => {
  it("one trash, refused, no other action: the row is put back and the list is read again", async () => {
    const drive = new FakeDrive([ALPHA, A, B, C]).fail("POST", new RegExp(`${A.id}/trash$`), 500);
    const calls = serveDrive(drive);
    renderExplorer("/");
    await waitForRows(4);
    const before = calls.filter(
      (call) => call.method === "GET" && call.path.startsWith("/api/nodes/root"),
    ).length;
    await act(async () => {
      await trashNodes([A]);
    });
    await vi.waitFor(() =>
      expect(
        calls.filter((call) => call.method === "GET" && call.path.startsWith("/api/nodes/root")).length,
      ).toBe(before + 1),
    );
    expect(rowOf(A.id)).not.toBeNull();
  });
});

describe("M3 — a rollback undoes one change, never the list", () => {
  it("trash A (held) → trash B (done) → A refused: B stays gone, A is back where it was, the parent is marked stale", async () => {
    const drive = new FakeDrive([ALPHA, A, B, C]);
    const gate = deferred<void>();
    serveDrive(drive, async (call) => {
      if (!call.path.endsWith(`${A.id}/trash`)) return undefined;
      await gate.promise;
      return envelope("rate_limited", 429);
    });
    seed([ALPHA, A, B, C]);
    const first = trashNodes([A]);
    await turn();
    await trashNodes([B]);
    expect(names()).toEqual(["Alpha", "c.pdf"]);
    gate.resolve();
    await first;
    // B is in the server's trash and stays out of the list; A returns to its place before c.
    expect(drive.trashed.has(B.id)).toBe(true);
    expect(names()).toEqual(["Alpha", "a.pdf", "c.pdf"]);
    expect(queryClient.getQueryState(KEY)!.isInvalidated).toBe(true);
  });

  it("rename A (held) → star B (saved) → A refused: B keeps its star, A its old name", async () => {
    const drive = new FakeDrive([A, B]);
    const gate = deferred<void>();
    serveDrive(drive, async (call) => {
      if (call.method !== "PATCH" || !call.path.endsWith(A.id)) return undefined;
      await gate.promise;
      return envelope("conflict", 409);
    });
    seed([A, B]);
    const rename = renameNode(A, "b.pdf");
    await turn();
    expect(names()).toEqual(["b.pdf", "b.pdf"]);
    await setStarred([B], true);
    gate.resolve();
    expect(await rename).toBe(false);
    expect(listed().map((node) => [node.name, node.starred])).toEqual([
      ["a.pdf", false],
      ["b.pdf", true],
    ]);
    expect(drive.nodes.get(B.id)!.starred).toBe(true);
  });

  it("a rename that the user has already replaced by another is not rolled back over it", async () => {
    const drive = new FakeDrive([A]);
    const gate = deferred<void>();
    let first = true;
    serveDrive(drive, async (call) => {
      if (call.method !== "PATCH" || !first) return undefined;
      first = false;
      await gate.promise;
      return envelope("internal", 500);
    });
    seed([A]);
    const one = renameNode(A, "one.pdf");
    await turn();
    await renameNode({ ...A, name: "one.pdf" }, "two.pdf");
    gate.resolve();
    await one;
    expect(names()).toEqual(["two.pdf"]);
  });

  it("a row trashed from another tab meanwhile (404) is not drawn again by the rollback of a neighbour", async () => {
    const drive = new FakeDrive([A, B]);
    serveDrive(drive, (call) =>
      call.path.endsWith(`${A.id}/trash`) ? envelope("not_found", 404) : undefined,
    );
    seed([A, B]);
    // The refetch that follows shows the server's truth; the rollback itself only re-inserts what
    // this action took out and the server did not take.
    await trashNodes([A, B]);
    expect(names()).toEqual(["a.pdf"]);
    expect(queryClient.getQueryState(KEY)!.isInvalidated).toBe(true);
    expect(drive.trashed.has(B.id)).toBe(true);
  });

  it("a rollback never creates a listing that is not in the cache any more", async () => {
    const drive = new FakeDrive([A]).fail("POST", /\/trash$/, 500);
    serveDrive(drive);
    seed([A]);
    const action = trashNodes([A]);
    await turn();
    queryClient.removeQueries({ queryKey: explorerKeys.all });
    await action;
    expect(queryClient.getQueriesData({ queryKey: explorerKeys.all })).toEqual([]);
  });

  it("a read of the listing that is under way is stopped before the optimistic edit: its answer cannot put the row back", async () => {
    const drive = new FakeDrive([A, B]);
    const slowList = deferred<Response>();
    const held = deferred<void>();
    serveDrive(drive, async (call) => {
      if (call.path.startsWith("/api/nodes/root")) return slowList.promise;
      if (call.path.endsWith("/trash")) {
        await held.promise;
        return answerOf(drive, call);
      }
      return undefined;
    });
    seed([A, B]);
    // A refetch starts (window focus, a sibling's event) and is slow.
    const refetch = queryClient.fetchInfiniteQuery({
      queryKey: KEY,
      queryFn: async () =>
        (await (await fetch("/api/nodes/root?sort=name&dir=asc&limit=200")).json()) as never,
      initialPageParam: undefined,
      staleTime: 0,
    });
    refetch.catch(() => {});
    await turn();
    const trash = trashNodes([A]);
    await turn();
    await turn();
    expect(names()).toEqual(["b.pdf"]);
    // The stale answer — read before the trash — arrives now.
    slowList.resolve(json(pageOf([A, B])));
    await turn();
    await turn();
    expect(names()).toEqual(["b.pdf"]);
    held.resolve();
    await trash;
    expect(names()).toEqual(["b.pdf"]);
  });
});

describe("M5 — at most four requests in flight", () => {
  const many = (count: number, parentId: string | null = null) =>
    Array.from({ length: count }, (_, index) => fileNode(100 + index, { name: `f-${index}.pdf`, parentId }));

  /** Serve the drive slowly, counting how many requests matching `pattern` are open at once. */
  function meter(drive: FakeDrive, pattern: RegExp, refuseFrom?: number) {
    const seen = { peak: 0, open: 0, total: 0 };
    serveDrive(drive, async (call) => {
      if (!pattern.test(call.path) || call.method === "GET") return undefined;
      seen.total += 1;
      const mine = seen.total;
      seen.open += 1;
      seen.peak = Math.max(seen.peak, seen.open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      seen.open -= 1;
      if (refuseFrom !== undefined && mine >= refuseFrom)
        return envelope("rate_limited", 429, undefined, { "retry-after": "30" });
      return answerOf(drive, call);
    });
    return seen;
  }

  it.each([
    ["trash", /\/trash$/, (nodes: NodeDto[]) => trashNodes(nodes)],
    ["star", /\/api\/nodes\/[0-9a-f-]+$/, (nodes: NodeDto[]) => setStarred(nodes, true)],
    ["move", /\/move$/, (nodes: NodeDto[]) => moveNodes(nodes, { id: ALPHA.id, name: "Alpha" })],
  ] as const)(
    "%s of 40 items: every one is done, never more than four at a time",
    async (_name, pattern, run) => {
      const nodes = many(40);
      const drive = new FakeDrive([ALPHA, ...nodes]);
      const seen = meter(drive, pattern);
      seed([ALPHA, ...nodes]);
      await run(nodes);
      expect(seen.total).toBe(40);
      expect(seen.peak).toBe(MAX_IN_FLIGHT);
      expect(MAX_IN_FLIGHT).toBe(4);
    },
  );

  it("the Undo of a 40-item trash restores through the same pool", async () => {
    const nodes = many(40);
    const drive = new FakeDrive(nodes);
    const seen = meter(drive, /\/(trash|restore)$/);
    seed(nodes);
    await trashNodes(nodes);
    expect(toastMessages()).toEqual(["40 items moved to trash"]);
    const events = recordNodesChanged();
    getToasts()
      .find((entry) => entry.key === "undo")!
      .action!.onClick();
    // The undo is over when it says so: its one tree-changed event comes after the last restore.
    await vi.waitFor(() => expect(events.events).toHaveLength(1));
    expect(seen.total).toBe(80);
    expect(seen.peak).toBe(MAX_IN_FLIGHT);
    expect(drive.trashed.size).toBe(0);
    // One event for the whole undo, not forty.
    expect(events.events).toEqual([[null]]);
    events.stop();
  });

  it("a 429 stops the rest: nothing more is sent, what was done stays done, the rest is back in the list, one summary", async () => {
    const nodes = many(40);
    const drive = new FakeDrive(nodes);
    const seen = meter(drive, /\/trash$/, 9);
    seed(nodes);
    await trashNodes(nodes);
    // Eight went through; the ninth was refused; at most the three already in flight followed it.
    expect(seen.total).toBeLessThanOrEqual(8 + MAX_IN_FLIGHT);
    expect(drive.trashed.size).toBe(8);
    expect(listed()).toHaveLength(32);
    expect(listed().some((node) => drive.trashed.has(node.id))).toBe(false);
    // In their old order.
    expect(names()).toEqual(nodes.filter((node) => !drive.trashed.has(node.id)).map((node) => node.name));
    const messages = toastMessages();
    expect(messages).toContain("8 of 40 done. The rest were left as they were. Try them again.");
    expect(messages).toContain("8 items moved to trash");
    expect(queryClient.getQueryState(KEY)!.isInvalidated).toBe(true);
  });

  it(`from ${PROGRESS_FROM} items on the ribbon says how far it is, and is cleared at the end`, async () => {
    const nodes = many(PROGRESS_FROM);
    const drive = new FakeDrive(nodes);
    meter(drive, /\/trash$/);
    seed(nodes);
    const sentences: string[] = [];
    const stop = subscribeRibbon(() => {
      const current = getRibbonSnapshot().current;
      if (current) sentences.push(`${current.sourceId.replace(/\d+$/, "n")} ${current.sentence}`);
    });
    await trashNodes(nodes);
    stop();
    expect(sentences[0]).toBe(`explorer:n Moving to trash · 0 of ${PROGRESS_FROM}`);
    expect(sentences.at(-1)).toBe(`explorer:n Moving to trash · ${PROGRESS_FROM} of ${PROGRESS_FROM}`);
    expect(getRibbonSnapshot()).toMatchObject({ current: null, openCount: 0 });
  });

  it("a handful of items shows no progress line", async () => {
    const nodes = many(PROGRESS_FROM - 1);
    const drive = new FakeDrive(nodes);
    meter(drive, /\/trash$/);
    seed(nodes);
    let published = 0;
    const stop = subscribeRibbon(() => (published += 1));
    await trashNodes(nodes);
    stop();
    expect(published).toBe(0);
  });
});
