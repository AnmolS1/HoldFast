import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, selectionReducer, type SelectionAction, type SelectionState } from "../../../../src/client/components/FileList";

const ORDER = ["a", "b", "c", "d", "e"];
const state = (selected: string[], anchor: string | null): SelectionState => ({ selected: new Set(selected), anchor });
const ids = (s: SelectionState) => Array.from(s.selected).sort();

describe("selectionReducer", () => {
  const table: Array<{ name: string; from: SelectionState; action: SelectionAction; selected: string[]; anchor: string | null }> = [
    { name: "click selects only that item", from: state(["a", "b"], "a"), action: { type: "click", id: "d" }, selected: ["d"], anchor: "d" },
    { name: "click on the only selected item keeps it", from: state(["d"], "d"), action: { type: "click", id: "d" }, selected: ["d"], anchor: "d" },
    { name: "toggle adds", from: state(["a"], "a"), action: { type: "toggle", id: "c" }, selected: ["a", "c"], anchor: "c" },
    { name: "toggle removes", from: state(["a", "c"], "c"), action: { type: "toggle", id: "a" }, selected: ["c"], anchor: "a" },
    { name: "range forward from the anchor", from: state(["b"], "b"), action: { type: "range", id: "d", order: ORDER }, selected: ["b", "c", "d"], anchor: "b" },
    { name: "range backward from the anchor", from: state(["d"], "d"), action: { type: "range", id: "b", order: ORDER }, selected: ["b", "c", "d"], anchor: "d" },
    { name: "range replaces an earlier range and keeps the anchor", from: state(["b", "c", "d"], "b"), action: { type: "range", id: "a", order: ORDER }, selected: ["a", "b"], anchor: "b" },
    { name: "range with no anchor is a click", from: EMPTY_SELECTION, action: { type: "range", id: "c", order: ORDER }, selected: ["c"], anchor: "c" },
    { name: "range whose anchor left the list is a click", from: state(["z"], "z"), action: { type: "range", id: "c", order: ORDER }, selected: ["c"], anchor: "c" },
    { name: "range to an unknown id changes nothing", from: state(["b"], "b"), action: { type: "range", id: "zz", order: ORDER }, selected: ["b"], anchor: "b" },
    { name: "all selects everything", from: state(["b"], "b"), action: { type: "all", order: ORDER }, selected: ORDER, anchor: "b" },
    { name: "all on an empty list selects nothing", from: EMPTY_SELECTION, action: { type: "all", order: [] }, selected: [], anchor: null },
    { name: "clear empties and drops the anchor", from: state(["a", "b"], "b"), action: { type: "clear" }, selected: [], anchor: null },
    { name: "long-press adds", from: state(["a"], "a"), action: { type: "longpress", id: "c" }, selected: ["a", "c"], anchor: "c" },
    { name: "long-press on a selected item keeps it selected", from: state(["a"], "a"), action: { type: "longpress", id: "a" }, selected: ["a"], anchor: "a" },
  ];

  it.each(table)("$name", ({ from, action, selected, anchor }) => {
    const next = selectionReducer(from, action);
    expect(ids(next)).toEqual([...selected].sort());
    expect(next.anchor).toBe(anchor);
  });

  it("never mutates its input", () => {
    const before = state(["a"], "a");
    selectionReducer(before, { type: "toggle", id: "b" });
    selectionReducer(before, { type: "all", order: ORDER });
    expect(ids(before)).toEqual(["a"]);
  });

  it("clear on an already-empty selection returns the same object (no needless change)", () => {
    expect(selectionReducer(EMPTY_SELECTION, { type: "clear" })).toBe(EMPTY_SELECTION);
  });
});
