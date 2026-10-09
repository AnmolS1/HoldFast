import { describe, expect, it } from "vitest";
import { clampForward, ProgressUnderline } from "../../../../src/client/components/ProgressUnderline";
import { renderShell, setupShell } from "./helpers";

setupShell();

const bar = (container: HTMLElement) => container.querySelector('[role="progressbar"]')!;

describe("clampForward", () => {
  it.each([
    [0, 0.3, 0.3],
    [0.3, 0.2, 0.3],
    [0.3, 0.3, 0.3],
    [0.5, 2, 1],
    [0, -1, 0],
    [0.4, Number.NaN, 0.4],
    [0.4, Number.POSITIVE_INFINITY, 0.4],
  ])("previous %s, next %s → %s", (previous, next, expected) => {
    expect(clampForward(previous, next)).toBe(expected);
  });
});

describe("ProgressUnderline", () => {
  it("is a named progressbar", () => {
    const { container } = renderShell(<ProgressUnderline value={0.25} label="Uploading notes.md" />);
    expect(bar(container).getAttribute("aria-label")).toBe("Uploading notes.md");
    expect(bar(container).getAttribute("aria-valuenow")).toBe("25");
    expect(bar(container).getAttribute("aria-valuemin")).toBe("0");
    expect(bar(container).getAttribute("aria-valuemax")).toBe("100");
  });

  it("never moves backward, whatever order the samples arrive in", () => {
    const { container, rerender } = renderShell(<ProgressUnderline value={0.1} label="x" />);
    const seen: number[] = [];
    for (const value of [0.1, 0.4, 0.2, 0.39, 0.6, 0, 0.59, 1, 0.5]) {
      rerender(<ProgressUnderline value={value} label="x" />);
      seen.push(Number(bar(container).getAttribute("data-progress")));
    }
    expect(seen).toEqual([0.1, 0.4, 0.4, 0.4, 0.6, 0.6, 0.6, 1, 1]);
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThanOrEqual(seen[i - 1]!);
  });

  it("null is indeterminate: no value is announced", () => {
    const { container } = renderShell(<ProgressUnderline value={null} label="Scanning" />);
    expect(bar(container).getAttribute("data-progress")).toBe("indeterminate");
    expect(bar(container).hasAttribute("aria-valuenow")).toBe(false);
  });

  it("an indeterminate spell does not reset what was already reached", () => {
    const { container, rerender } = renderShell(<ProgressUnderline value={0.7} label="x" />);
    rerender(<ProgressUnderline value={null} label="x" />);
    rerender(<ProgressUnderline value={0.2} label="x" />);
    expect(bar(container).getAttribute("data-progress")).toBe("0.7");
  });
});
