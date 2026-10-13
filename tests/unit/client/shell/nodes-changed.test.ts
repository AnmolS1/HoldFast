// The cross-feature "the tree changed" event of lib/contracts.ts.
import { describe, expect, it, vi } from "vitest";
import {
  emitNodesChanged,
  NODES_CHANGED_EVENT,
  onNodesChanged,
  type NodesChangedDetail,
} from "../../../../src/client/lib/contracts";

describe("nodes-changed", () => {
  it("the name and the detail are the ones the task files agree on", () => {
    expect(NODES_CHANGED_EVENT).toBe("holdfast:nodes-changed");
    const seen: Event[] = [];
    const listener = (event: Event) => seen.push(event);
    window.addEventListener("holdfast:nodes-changed", listener);
    emitNodesChanged(["folder-1", null]);
    window.removeEventListener("holdfast:nodes-changed", listener);
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeInstanceOf(CustomEvent);
    expect((seen[0] as CustomEvent<NodesChangedDetail>).detail).toEqual({ parentIds: ["folder-1", null] });
  });

  it("every listener gets the detail, once per emit", () => {
    const a = vi.fn();
    const b = vi.fn();
    const offA = onNodesChanged(a);
    const offB = onNodesChanged(b);
    emitNodesChanged([null]);
    emitNodesChanged(["p1", "p2"]);
    expect(a.mock.calls).toEqual([[{ parentIds: [null] }], [{ parentIds: ["p1", "p2"] }]]);
    expect(b.mock.calls).toEqual(a.mock.calls);
    offA();
    offB();
  });

  it("the returned function stops that listener only", () => {
    const stopped = vi.fn();
    const kept = vi.fn();
    const off = onNodesChanged(stopped);
    const offKept = onNodesChanged(kept);
    off();
    emitNodesChanged(["p1"]);
    expect(stopped).not.toHaveBeenCalled();
    expect(kept).toHaveBeenCalledTimes(1);
    offKept();
  });

  it("an event typed by hand reaches a listener; one without the detail's list does not", () => {
    const handler = vi.fn();
    const off = onNodesChanged(handler);
    window.dispatchEvent(new CustomEvent("holdfast:nodes-changed", { detail: { parentIds: ["p9"] } }));
    window.dispatchEvent(new CustomEvent("holdfast:nodes-changed"));
    window.dispatchEvent(new CustomEvent("holdfast:nodes-changed", { detail: { parentIds: "p9" } }));
    window.dispatchEvent(new Event("holdfast:nodes-changed"));
    expect(handler.mock.calls).toEqual([[{ parentIds: ["p9"] }]]);
    off();
  });
});
