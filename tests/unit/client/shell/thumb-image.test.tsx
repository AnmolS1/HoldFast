import { act, fireEvent, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EXPIRY_MARGIN_MS, ThumbImage, type ThumbImageProps } from "../../../../src/client/components/ThumbImage";
import { intersect, observedCount, renderShell, setupShell } from "./helpers";

setupShell();

const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

function props(overrides: Partial<ThumbImageProps> = {}): ThumbImageProps {
  let n = 0;
  return {
    nodeId: "n1",
    versionKey: "v1",
    size: 320,
    alt: "A photo",
    eligible: true,
    getUrl: vi.fn(async () => ({ url: `https://files.test/t/n1/${++n}`, expiresAt: inFuture(300_000) })),
    fallback: <span data-testid="fallback">icon</span>,
    ...overrides,
  };
}

const img = (container: HTMLElement) => container.querySelector("img");

describe("ThumbImage", () => {
  it("is lazy: nothing is requested until the box comes near the viewport", async () => {
    const p = props();
    const { container } = renderShell(<ThumbImage {...p} />);
    expect(observedCount()).toBe(1);
    await act(async () => {});
    expect(p.getUrl).not.toHaveBeenCalled();
    expect(img(container)).toBeNull();
    act(() => intersect());
    await waitFor(() => expect(img(container)?.getAttribute("src")).toBe("https://files.test/t/n1/1"));
    expect(p.getUrl).toHaveBeenCalledTimes(1);
    expect(p.getUrl).toHaveBeenCalledWith("n1", 320);
    expect(img(container)?.getAttribute("alt")).toBe("A photo");
  });

  it("never requests when ineligible, and shows the fallback", async () => {
    const p = props({ eligible: false });
    const { container, getByTestId } = renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await act(async () => {});
    expect(p.getUrl).not.toHaveBeenCalled();
    expect(observedCount()).toBe(0);
    expect(getByTestId("fallback")).toBeTruthy();
    expect(container.querySelector("[data-thumb]")?.getAttribute("data-thumb")).toBe("fallback");
  });

  it("caches by (nodeId, versionKey, size) until shortly before expiry", async () => {
    const p = props();
    const first = renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await waitFor(() => expect(img(first.container)).not.toBeNull());
    first.unmount();

    const second = renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await waitFor(() => expect(img(second.container)?.getAttribute("src")).toBe("https://files.test/t/n1/1"));
    expect(p.getUrl).toHaveBeenCalledTimes(1);
    second.unmount();

    // A different size or version is a different entry.
    const third = renderShell(<ThumbImage {...p} size={160} />);
    act(() => intersect());
    await waitFor(() => expect(p.getUrl).toHaveBeenCalledTimes(2));
    third.unmount();
    renderShell(<ThumbImage {...p} versionKey="v2" />);
    act(() => intersect());
    await waitFor(() => expect(p.getUrl).toHaveBeenCalledTimes(3));
  });

  it("re-requests once the cached URL is within the expiry margin", async () => {
    const getUrl = vi.fn(async () => ({ url: `https://files.test/t/${getUrl.mock.calls.length}`, expiresAt: inFuture(EXPIRY_MARGIN_MS - 1000) }));
    const p = props({ getUrl });
    const first = renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await waitFor(() => expect(img(first.container)).not.toBeNull());
    first.unmount();
    renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await waitFor(() => expect(getUrl).toHaveBeenCalledTimes(2));
  });

  it("retries once when the image fails to load, then falls back", async () => {
    const p = props();
    const { container, queryByTestId } = renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await waitFor(() => expect(img(container)).not.toBeNull());
    fireEvent.error(img(container)!);
    await waitFor(() => expect(img(container)?.getAttribute("src")).toBe("https://files.test/t/n1/2"));
    expect(p.getUrl).toHaveBeenCalledTimes(2);
    expect(queryByTestId("fallback")).toBeNull();
    fireEvent.error(img(container)!);
    await waitFor(() => expect(queryByTestId("fallback")).not.toBeNull());
    expect(img(container)).toBeNull();
    expect(p.getUrl).toHaveBeenCalledTimes(2);
  });

  it("a refused URL request (a normal 404) shows the fallback, not an error", async () => {
    const p = props({ getUrl: vi.fn(async () => Promise.reject(new Error("404"))) });
    const { queryByTestId } = renderShell(<ThumbImage {...p} />);
    act(() => intersect());
    await waitFor(() => expect(queryByTestId("fallback")).not.toBeNull());
    expect(p.getUrl).toHaveBeenCalledTimes(1);
  });

  it("keeps a fixed box before and after the image arrives (no layout shift)", async () => {
    const p = props();
    const { container } = renderShell(<ThumbImage {...p} aspectRatio={1.5} />);
    const box = container.querySelector<HTMLElement>("[data-thumb]")!;
    const before = getComputedStyle(box).aspectRatio;
    act(() => intersect());
    await waitFor(() => expect(img(container)).not.toBeNull());
    expect(before).toMatch(/^1\.5( \/ 1)?$/);
    expect(getComputedStyle(box).aspectRatio).toBe(before);
  });
});
