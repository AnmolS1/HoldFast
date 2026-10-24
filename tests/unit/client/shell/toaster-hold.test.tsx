// R1 a11y-5 (WCAG 2.2.1) and the toast half of a11y-1: a toast does not run out while the keyboard
// focus or the pointer is on it — its time pauses and the rest runs once both have left. Pressing
// one of its buttons gives the focus back to where it came from instead of dropping it on <body>.
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearToasts, getToasts, toast, Toaster } from "../../../../src/client/components/Toaster";
import { undoToast } from "../../../../src/client/components/UndoToast";

beforeEach(() => {
  vi.useFakeTimers();
  clearToasts();
});
afterEach(() => {
  act(() => clearToasts());
  vi.useRealTimers();
});

const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms));

function setup() {
  const outside = document.createElement("button");
  outside.textContent = "a row";
  document.body.appendChild(outside);
  render(<Toaster />);
  return { outside, cleanup: () => outside.remove() };
}

describe("a toast holds while it has focus or the pointer", () => {
  it("focused: an Undo toast stays past its time, then runs out the rest once focus leaves", () => {
    const { outside, cleanup } = setup();
    outside.focus();
    act(() => void undoToast({ message: "1 item moved to trash", onUndo: () => {}, duration: 6000 }));
    advance(2000);
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => undo.focus());
    advance(60_000);
    expect(getToasts()).toHaveLength(1);
    expect(document.activeElement).toBe(undo);
    // Focus moving inside the toast does not resume it.
    act(() => screen.getByRole("button", { name: "Dismiss" }).focus());
    advance(60_000);
    expect(getToasts()).toHaveLength(1);
    act(() => outside.focus());
    advance(3900);
    expect(getToasts()).toHaveLength(1);
    advance(200);
    expect(getToasts()).toHaveLength(0);
    cleanup();
  });

  it("hovered: the pointer on it pauses it; leaving resumes", () => {
    const { cleanup } = setup();
    act(() => void toast({ message: "Saved." }));
    const item = document.querySelector<HTMLElement>("[data-toast]")!;
    advance(1000);
    fireEvent.pointerEnter(item);
    advance(60_000);
    expect(getToasts()).toHaveLength(1);
    fireEvent.pointerLeave(item);
    advance(4900);
    expect(getToasts()).toHaveLength(1);
    advance(200);
    expect(getToasts()).toHaveLength(0);
    cleanup();
  });

  it("pressing Undo gives focus back to where it was before the toast", () => {
    const { outside, cleanup } = setup();
    const onUndo = vi.fn();
    act(() => void undoToast({ message: "1 item moved to trash", onUndo }));
    const undo = screen.getByRole("button", { name: "Undo" });
    act(() => outside.focus());
    act(() => undo.focus());
    fireEvent.click(undo);
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
    expect(document.activeElement).toBe(outside);
    cleanup();
  });

  it("the control: left alone, a toast still goes after its time", () => {
    const { cleanup } = setup();
    act(() => void toast({ message: "Saved." }));
    advance(5900);
    expect(getToasts()).toHaveLength(1);
    advance(200);
    expect(getToasts()).toHaveLength(0);
    cleanup();
  });
});
