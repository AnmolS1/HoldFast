import { act, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ANNOUNCE_INTERVAL_MS,
  getRibbonSnapshot,
  publish,
  setPanel,
  TransferRibbon,
} from "../../../../src/client/components/TransferRibbon";
import { renderShell, setupShell } from "./helpers";

setupShell();

const active = (progress: number, sentence: string) => ({ progress, sentence, status: "active" as const });

describe("ribbon store", () => {
  it("is idle with no sources", () => {
    expect(getRibbonSnapshot()).toEqual({ current: null, panels: [], openCount: 0 });
  });

  it("two sources: the most recently updated active one owns the line", () => {
    publish("upload", active(0.2, "Uploading 1 of 3"));
    publish("zip:1", active(0.5, "Zipping 10 files"));
    expect(getRibbonSnapshot().current?.sourceId).toBe("zip:1");
    publish("upload", active(0.3, "Uploading 2 of 3"));
    expect(getRibbonSnapshot().current?.sourceId).toBe("upload");
    expect(getRibbonSnapshot().current?.sentence).toBe("Uploading 2 of 3");
    expect(getRibbonSnapshot().openCount).toBe(2);
  });

  it("an active source beats a more recently updated paused one", () => {
    publish("upload", active(0.2, "Uploading"));
    publish("zip:1", { progress: 0.9, sentence: "Zip paused", status: "paused" });
    expect(getRibbonSnapshot().current?.sourceId).toBe("upload");
  });

  it("collapses when every source is null or done", () => {
    publish("upload", active(0.2, "Uploading"));
    publish("zip:1", active(0.5, "Zipping"));
    publish("upload", { progress: 1, sentence: "Uploaded", status: "done" });
    expect(getRibbonSnapshot().current?.sourceId).toBe("zip:1");
    publish("zip:1", null);
    expect(getRibbonSnapshot().current).toBeNull();
    expect(getRibbonSnapshot().openCount).toBe(0);
  });

  it("progress of an open source never moves backward and is clamped to 0..1", () => {
    publish("upload", active(0.6, "a"));
    publish("upload", active(0.4, "b"));
    expect(getRibbonSnapshot().current?.progress).toBe(0.6);
    publish("upload", active(7, "c"));
    expect(getRibbonSnapshot().current?.progress).toBe(1);
  });

  it("a source that finished starts from zero the next time", () => {
    publish("upload", active(0.9, "a"));
    publish("upload", { progress: 1, sentence: "done", status: "done" });
    publish("upload", active(0.1, "again"));
    expect(getRibbonSnapshot().current?.progress).toBe(0.1);
  });

  it("removing an unknown source is a no-op (same snapshot object)", () => {
    const before = getRibbonSnapshot();
    publish("nope", null);
    setPanel("nope", null);
    expect(getRibbonSnapshot()).toBe(before);
  });
});

describe("TransferRibbon", () => {
  it("idle: a hairline, no progressbar", () => {
    const { container } = renderShell(<TransferRibbon />);
    expect(container.querySelector("[data-transfer-ribbon]")?.getAttribute("data-transfer-ribbon")).toBe(
      "idle",
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("active: the line, the sentence, and a panel that expands and collapses", () => {
    renderShell(<TransferRibbon />);
    act(() => {
      publish("upload", active(0.43, "Uploading 3 of 7 · 1.2 GB left"));
      setPanel("upload", <div>panel rows</div>);
    });
    const bar = screen.getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("43");
    expect(bar.getAttribute("aria-label")).toBe("Uploading 3 of 7 · 1.2 GB left");
    const toggle = screen.getByRole("button", { name: /Uploading 3 of 7/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("panel rows")).toBeNull();
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("panel rows")).toBeTruthy();
    act(() => toggle.click());
    expect(screen.queryByText("panel rows")).toBeNull();
  });

  it("collapses by itself when everything is done, and stays collapsed for the next transfer", () => {
    renderShell(<TransferRibbon />);
    act(() => {
      publish("upload", active(0.5, "Uploading"));
      setPanel("upload", <div>panel rows</div>);
    });
    act(() => screen.getByRole("button", { name: /Uploading/ }).click());
    expect(screen.getByText("panel rows")).toBeTruthy();
    act(() => publish("upload", { progress: 1, sentence: "Uploaded", status: "done" }));
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText("panel rows")).toBeNull();
    act(() => publish("upload", active(0.1, "Uploading again")));
    expect(screen.getByRole("button", { name: /Uploading again/ }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("announces sentence changes in a live region, throttled: the latest wins", () => {
    vi.useFakeTimers();
    const { container } = renderShell(<TransferRibbon />);
    const live = container.querySelector("[data-ribbon-live]")!;
    expect(live.getAttribute("aria-live")).toBe("polite");
    act(() => publish("upload", active(0.1, "Uploading 1 of 9")));
    act(() => vi.advanceTimersByTime(1));
    expect(live.textContent).toBe("Uploading 1 of 9");
    act(() => publish("upload", active(0.2, "Uploading 2 of 9")));
    act(() => publish("upload", active(0.3, "Uploading 3 of 9")));
    act(() => vi.advanceTimersByTime(ANNOUNCE_INTERVAL_MS - 100));
    expect(live.textContent).toBe("Uploading 1 of 9");
    act(() => vi.advanceTimersByTime(200));
    expect(live.textContent).toBe("Uploading 3 of 9");
  });
});
