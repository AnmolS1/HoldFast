// R1 a11y-12: a status line's live region is on the page BEFORE its text arrives. A region mounted
// together with its text is not reliably read by screen readers ("Checking your picture…" relies on
// it); one whose text changes is. Empty, it takes no room.
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusLine } from "../../../../src/client/features/account/ui";

describe("StatusLine", () => {
  it.each(["ok", "error"] as const)("%s: the same region stays mounted, empty then with text", (tone) => {
    const view = render(<StatusLine tone={tone}>{null}</StatusLine>);
    const region = view.container.querySelector(`[data-account-status="${tone}"]`);
    expect(region).not.toBeNull();
    expect(region!.getAttribute("role")).toBe(tone === "error" ? "alert" : "status");
    expect(region!.textContent).toBe("");
    expect(getComputedStyle(region!).position).toBe("absolute");
    view.rerender(<StatusLine tone={tone}>Saved.</StatusLine>);
    const after = view.container.querySelector(`[data-account-status="${tone}"]`);
    expect(after).toBe(region);
    expect(after!.textContent).toBe("Saved.");
    expect(getComputedStyle(after!).position).not.toBe("absolute");
  });
});
