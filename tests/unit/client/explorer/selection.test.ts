import { describe, expect, it } from "vitest";
import {
  EMPTY_SELECTION,
  explorerSelectionReducer as reduce,
  idsInRect,
  rectOf,
  type ExplorerSelectionAction,
  type SelectionState,
} from "../../../../src/client/features/explorer/selection";

const ORDER = ["a", "b", "c", "d", "e"];
const run = (actions: ExplorerSelectionAction[], from: SelectionState = EMPTY_SELECTION) =>
  actions.reduce(reduce, from);
const ids = (state: SelectionState) => Array.from(state.selected).sort();

describe("the explorer's selection reducer", () => {
  it("click: exactly that item, which becomes the anchor", () => {
    const state = run([
      { type: "click", id: "a" },
      { type: "click", id: "c" },
    ]);
    expect(ids(state)).toEqual(["c"]);
    expect(state.anchor).toBe("c");
  });

  it("shift-click: the range from the anchor, in either direction; the anchor stays", () => {
    const down = run([
      { type: "click", id: "b" },
      { type: "range", id: "d", order: ORDER },
    ]);
    expect(ids(down)).toEqual(["b", "c", "d"]);
    expect(down.anchor).toBe("b");
    const up = reduce(down, { type: "range", id: "a", order: ORDER });
    expect(ids(up)).toEqual(["a", "b"]);
  });

  it("shift-click with no anchor is a plain click", () => {
    expect(ids(run([{ type: "range", id: "c", order: ORDER }]))).toEqual(["c"]);
  });

  it("ctrl/cmd-click: adds and removes one item", () => {
    const added = run([
      { type: "click", id: "a" },
      { type: "toggle", id: "c" },
    ]);
    expect(ids(added)).toEqual(["a", "c"]);
    expect(ids(reduce(added, { type: "toggle", id: "a" }))).toEqual(["c"]);
  });

  it("select-all takes everything listed; clear empties and forgets the anchor", () => {
    const all = run([{ type: "all", order: ORDER }]);
    expect(ids(all)).toEqual(ORDER);
    const cleared = reduce(all, { type: "clear" });
    expect(cleared.selected.size).toBe(0);
    expect(cleared.anchor).toBeNull();
  });

  it("long-press adds and never removes", () => {
    const state = run([
      { type: "longpress", id: "a" },
      { type: "longpress", id: "a" },
      { type: "longpress", id: "b" },
    ]);
    expect(ids(state)).toEqual(["a", "b"]);
  });

  it("set (drag-select) replaces the selection; an empty set clears", () => {
    const state = run([
      { type: "click", id: "a" },
      { type: "set", ids: ["c", "d"] },
    ]);
    expect(ids(state)).toEqual(["c", "d"]);
    expect(state.anchor).toBe("c");
    expect(reduce(state, { type: "set", ids: [] }).selected.size).toBe(0);
  });

  it("prune drops what is no longer listed, and returns the same state when nothing left", () => {
    const state = run([{ type: "all", order: ORDER }]);
    const pruned = reduce(state, { type: "prune", order: ["b", "c"] });
    expect(ids(pruned)).toEqual(["b", "c"]);
    expect(pruned.anchor).toBeNull();
    expect(reduce(pruned, { type: "prune", order: ["a", "b", "c"] })).toBe(pruned);
  });

  it("is pure: the state passed in is never changed", () => {
    const before = run([{ type: "click", id: "a" }]);
    const copy = new Set(before.selected);
    reduce(before, { type: "toggle", id: "b" });
    reduce(before, { type: "set", ids: ["c"] });
    expect(before.selected).toEqual(copy);
  });
});

describe("the marquee", () => {
  const items = [
    { id: "a", rect: { left: 0, top: 0, right: 100, bottom: 100 } },
    { id: "b", rect: { left: 120, top: 0, right: 220, bottom: 100 } },
    { id: "c", rect: { left: 0, top: 120, right: 100, bottom: 220 } },
  ];

  it("spans two corners whichever way it was dragged", () => {
    expect(rectOf({ x: 50, y: 60 }, { x: 10, y: 20 })).toEqual({ left: 10, top: 20, right: 50, bottom: 60 });
  });

  it("takes every item it touches, in list order, and nothing else", () => {
    expect(idsInRect(rectOf({ x: 90, y: 90 }, { x: 130, y: 95 }), items)).toEqual(["a", "b"]);
    expect(idsInRect(rectOf({ x: 101, y: 101 }, { x: 119, y: 119 }), items)).toEqual([]);
    expect(idsInRect(rectOf({ x: 0, y: 0 }, { x: 300, y: 300 }), items)).toEqual(["a", "b", "c"]);
  });
});
