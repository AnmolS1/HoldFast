import "fake-indexeddb/auto";
// Fourth review round: files given up by the scan bound are counted, not drawn (4m1); a paused
// drop of empty folders keeps its ribbon and Resume all (4m2); nothing of the old account starts
// inside the shell's purge window (4m3) and the part lanes stay at their gate there (4m5); the
// scan loop's backoff outlives a remount and a tab switch (4m4).
import { act, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRibbonSnapshot, TransferRibbon } from "../../../../src/client/components/TransferRibbon";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import { addFiles, pauseAll, resumeItem } from "../../../../src/client/features/upload/manager";
import { PANEL_ROWS, SCAN_HARD_LIMIT_MS } from "../../../../src/client/features/upload/plan";
import { getUploads, subscribeUploads, type UploadItem } from "../../../../src/client/features/upload/store";
import { rowsToDraw } from "../../../../src/client/features/upload/summary";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import { renderShell, setupShell } from "../shell/helpers";
import {
  bigFile,
  envelope,
  FAKED_TIMERS,
  freshUploader,
  installServer,
  keepResumeListInMemory,
  type Server,
  settle,
  smallFile,
  SCAN_ASK,
} from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  await freshUploader();
  server = installServer();
  window.history.replaceState({}, "", "/");
});

const items = () => getUploads().items;

/** The shell's purge has started (its epoch moved) and holds in `cancelQueries`: this feature's purger has not run. */
function openWindow(): () => Promise<void> {
  let finish!: () => void;
  const cancelling = vi
    .spyOn(queryClient, "cancelQueries")
    .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
  const purging = purgeUserState({ keepSession: true });
  return async () => {
    cancelling.mockRestore();
    finish();
    await purging;
  };
}

describe("files the scan bound gave up on (4m1)", () => {
  const item = (id: number, state: UploadItem["state"], patch: Partial<UploadItem> = {}) =>
    ({ id: `i${id}`, kind: "file", file: {} as File, state, scanStatus: null, ...patch }) as UploadItem;

  it("1,000 rows still being checked after the bound are counted, not drawn; a blocked file and the rows in flight are drawn", () => {
    const queue = [
      ...Array.from({ length: 1_000 }, (_, n) => item(n, "done", { scanStatus: "pending" })),
      item(1_000, "done", { scanStatus: "infected" }),
      item(1_001, "uploading"),
      item(1_002, "paused"),
    ];
    const drawn = rowsToDraw(queue, PANEL_ROWS);
    expect(drawn.length).toBe(PANEL_ROWS);
    const ids = new Set(drawn.map((row) => row.id));
    for (const must of ["i1000", "i1001", "i1002"]) expect(ids.has(must)).toBe(true);
  });

  it("after the hard bound the panel draws its cap and says how many are still being checked", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    keepResumeListInMemory();
    const count = PANEL_ROWS + 30;
    await addFiles(
      Array.from({ length: count }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
      null,
    );
    for (let turn = 0; turn < count + 50 && items().some((row) => row.state !== "scanning"); turn += 1) {
      await settle(0);
    }
    await settle(SCAN_HARD_LIMIT_MS + 5_000);
    expect(items().every((row) => row.state === "done" && row.scanStatus === "pending")).toBe(true);
    vi.useRealTimers();
    renderShell(<UploadPanel />);
    expect(document.querySelectorAll("[data-upload-row]").length).toBe(PANEL_ROWS);
    expect(document.querySelector("[data-upload-more]")).toBeNull();
    expect(document.querySelector("[data-upload-checking]")!.textContent).toBe(
      "30 files are still being checked — they will appear when ready",
    );
  });
});

describe("a paused drop of empty folders only (4m2)", () => {
  it("keeps the ribbon, which opens the panel with Resume all; resuming makes the folders", async () => {
    let hold = true;
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/nodes/folder" && hold
        ? new Promise<Response>(() => {})
        : undefined;
    renderShell(
      <>
        <UploadDropOverlay />
        <TransferRibbon />
      </>,
    );
    await act(() => addFiles([], null, ["one", "two"]));
    await act(() => settle());
    expect(getRibbonSnapshot().current?.sentence).toBe("Creating 2 folders");
    await act(async () => pauseAll());
    await act(() => settle());
    expect(items().map((row) => [row.state, row.pauseReason])).toEqual([
      ["paused", "user"],
      ["paused", "user"],
    ]);
    expect(getRibbonSnapshot().current).toMatchObject({
      sentence: "Creating 2 folders — paused",
      status: "paused",
    });
    await act(async () => screen.getByRole("button", { name: /Creating 2 folders — paused/ }).click());
    const panel = screen.getByRole("region", { name: "Transfers" });
    hold = false;
    await act(async () => within(panel).getByRole("button", { name: "Resume all" }).click());
    for (let turn = 0; turn < 5 && server.count("POST", /^\/api\/nodes\/folder$/) < 4; turn += 1) {
      await act(() => settle());
    }
    expect(items().some((row) => row.state === "paused")).toBe(false);
  });
});

describe("nothing of the old account starts inside the purge window (4m3, 4m5)", () => {
  it("the reviewer's S7: a file queued while offline is not started by the 'online' event inside the window", async () => {
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle());
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "offline" });
    expect(server.inits).toEqual([]);
    const close = openWindow();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(() => settle());
    expect(server.inits).toEqual([]);
    expect(server.completes).toEqual([]);
    await act(close);
    await act(() => settle());
    expect(server.inits).toEqual([]);
    expect(items()).toEqual([]);
  });

  it("a part lane waiting at the rate-limit gate takes no further part when the limit is ended inside the window", async () => {
    server.hold = true;
    server.partBytes = 5_242_880;
    server.onInit = (body) =>
      body.name === "b.txt" ? envelope("rate_limited", 429, undefined, { "retry-after": "30" }) : undefined;
    await act(() =>
      addFiles([{ file: bigFile("a.bin", 10 * 5_242_880) }, { file: smallFile("b.txt") }], null),
    );
    await act(() => settle());
    const limited = items().find((row) => row.name === "b.txt")!;
    expect(limited).toMatchObject({ state: "paused", pauseReason: "limited" });
    // The bodies in flight finish (a rate limit is soft); their lanes then wait at the gate.
    for (const call of [...server.held]) call.resolve();
    await act(() => settle());
    const sent = server.puts.length;
    expect(sent).toBeGreaterThan(0);
    expect(server.held).toEqual([]);
    const close = openWindow();
    // Trying again by hand ends the rate-limit pause for the whole queue.
    await act(async () => resumeItem(limited.id));
    await act(() => settle());
    expect(server.puts.length).toBe(sent);
    expect(server.inits.filter((body) => body.name === "b.txt").length).toBe(1);
    await act(close);
    await act(() => settle());
    expect(server.puts.length).toBe(sent);
  });
});

describe("the scan loop's wait outlives a remount and a tab switch (4m4)", () => {
  const polls = () => server.count("GET", SCAN_ASK);

  async function limitedOnce(): Promise<void> {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    let limit = false;
    const scanAnswer = server.onJson;
    server.onJson = (call) => {
      if (call.method === "GET" && SCAN_ASK.test(call.path) && limit) {
        limit = false;
        return envelope("rate_limited", 429, undefined, { "retry-after": "30" });
      }
      return scanAnswer?.(call);
    };
    await act(() => addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null));
    for (let turn = 0; turn < 5 && items().some((row) => row.state !== "scanning"); turn += 1) {
      await act(() => settle(0));
    }
    limit = true;
    const before = polls();
    for (let turn = 0; turn < 10 && polls() === before; turn += 1) await act(() => settle(1_000));
    expect(limit).toBe(false);
  }

  it("a frame remount after a 429 with Retry-After 30 asks nothing before the 30 seconds are over", async () => {
    const view = renderShell(<UploadDropOverlay />);
    await limitedOnce();
    const at429 = polls();
    view.unmount();
    renderShell(<UploadDropOverlay />);
    await act(() => settle(29_000));
    expect(polls()).toBe(at429);
    await act(() => settle(2_000));
    expect(polls()).toBeGreaterThan(at429);
  });

  it("a tab switch after a 429 with Retry-After 30 asks nothing before the 30 seconds are over", async () => {
    await limitedOnce();
    const at429 = polls();
    const visibility = (state: string) => {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    visibility("hidden");
    visibility("visible");
    await act(() => settle(29_000));
    expect(polls()).toBe(at429);
    await act(() => settle(2_000));
    expect(polls()).toBeGreaterThan(at429);
  });
});

describe("the snapshot a reader gets", () => {
  it("shows a change at once, though the listeners are told once at the end of the burst", async () => {
    server.hold = true;
    await addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null);
    await settle();
    let told = 0;
    const stop = subscribeUploads(() => (told += 1));
    pauseAll();
    expect(items().map((row) => [row.state, row.pauseReason])).toEqual([
      ["paused", "user"],
      ["paused", "user"],
    ]);
    expect(told).toBe(0);
    await Promise.resolve();
    expect(told).toBe(1);
    stop();
  });
});
