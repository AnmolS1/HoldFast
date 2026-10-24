import "fake-indexeddb/auto";
// Second review round: empty folders are rows of the queue, a sent `complete` and the device's
// row, the ceiling, the panel's order, the scan bound, a `complete` answer nobody can read, a
// rate limit and the bodies in flight.
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import {
  addFiles,
  cancelItem,
  forgetUploadsForTests,
  pauseAll,
  removeItem,
  restoreUploads,
  resumeAll,
  retryItem,
} from "../../../../src/client/features/upload/manager";
import {
  PANEL_ROWS,
  SCAN_FOLLOW_LIMIT_MS,
  SCAN_MIN_ASKS,
  SCAN_BATCH_MAX,
} from "../../../../src/client/features/upload/plan";
import { readResumeRows } from "../../../../src/client/features/upload/resume-list";
import { getUploads, type UploadItem } from "../../../../src/client/features/upload/store";
import { describeItem, rowsToDraw, summarise } from "../../../../src/client/features/upload/summary";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { UploadsPage } from "../../../../src/client/features/upload/UploadsPage";
import { ApiError } from "../../../../src/client/lib/api";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { renderRoutes, renderShell, setupShell } from "../shell/helpers";
import { EXISTING_ID, FOLDER_ID, folderDto, nodeDto, rowId } from "./fixtures";
import {
  bigFile,
  envelope,
  FAKED_TIMERS,
  freshUploader,
  installServer,
  json,
  keepResumeListInMemory,
  type Server,
  settle,
  smallFile,
  scanAsks,
} from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  await freshUploader();
  server = installServer();
  window.history.replaceState({}, "", "/");
});

const items = () => getUploads().items;
const said = () => getUploads().announcements.map((entry) => entry.text);
const folderCalls = () =>
  server.calls
    .filter((call) => call.method === "POST" && call.path === "/api/nodes/folder")
    .map((call) => call.body as { parentId: string | null; name: string });
const emptyFolders = (count: number) => Array.from({ length: count }, (_, n) => `tree/empty${n}`);

describe("folders that hold no file are rows of the queue", () => {
  it("50 empty folders, the folder route answering 429 with Retry-After 30: three asks, then nothing for 30 seconds", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    let limited = true;
    server.onJson = (call) =>
      limited && call.method === "POST" && call.path === "/api/nodes/folder"
        ? envelope("rate_limited", 429, undefined, { "retry-after": "30" })
        : undefined;
    await addFiles([], null, emptyFolders(50));
    await settle(0);
    const asked = folderCalls().length;
    // The three rows that started together share the one request for their parent.
    expect(asked).toBeLessThanOrEqual(3);
    await settle(29_900);
    expect(folderCalls().length).toBe(asked);
    expect(items().length).toBe(50);
    expect(items().every((item) => item.kind === "folder" && item.state !== "error")).toBe(true);

    limited = false;
    await settle(200);
    for (let turn = 0; turn < 80; turn += 1) await settle(0);
    // "tree" once and each empty folder once.
    expect(folderCalls().length).toBe(asked + 51);
    expect(items()).toEqual([]);
    // Folders are not counted as uploads.
    expect(getUploads().finished).toBe(0);
  });

  it("a folder that cannot be made is a visible row with a new try — the file beside it still uploads", async () => {
    let refused = true;
    server.onJson = (call) => {
      if (call.method !== "POST" || call.path !== "/api/nodes/folder") return undefined;
      const { name } = call.body as { name: string };
      return refused && name.startsWith("empty") ? envelope("forbidden", 403) : undefined;
    };
    renderShell(<UploadPanel />);
    await act(() =>
      addFiles([{ file: smallFile("a.txt"), path: "tree" }], null, ["tree/empty0", "tree/empty1"]),
    );
    await act(() => settle());

    expect(server.completes.length).toBe(1);
    expect(items().map((item) => [item.kind, item.name, item.state, item.canRetry])).toEqual([
      ["folder", "empty0", "error", true],
      ["folder", "empty1", "error", true],
    ]);
    expect(items()[0]!.message).toBe("Couldn't create the folder empty0. Nothing in it was uploaded.");
    expect(said()).toContain("empty0 didn't finish");
    expect(said()).toContain("empty1 didn't finish");
    expect(summarise(getUploads())).toMatchObject({ sentence: "2 uploads didn't finish", status: "error" });

    refused = false;
    await act(async () => screen.getByRole("button", { name: "Try empty0 again" }).click());
    await act(async () => screen.getByRole("button", { name: "Try empty1 again" }).click());
    await act(() => settle());
    expect(items()).toEqual([]);
    expect(folderCalls().map((body) => body.name)).toEqual(["tree", "empty0", "empty1", "empty0", "empty1"]);
  });

  it("only the deepest empty folders are rows; their parents are made on the way, each once", async () => {
    const changed: Array<(string | null)[]> = [];
    const stop = onNodesChanged((detail) => changed.push(detail.parentIds));
    await addFiles([{ file: smallFile("a.txt"), path: "tree/full" }], FOLDER_ID, [
      "tree",
      "tree/a",
      "tree/a/b",
      "tree/c",
    ]);
    await settle();
    stop();
    expect(
      folderCalls()
        .map((body) => body.name)
        .sort(),
    ).toEqual(["a", "b", "c", "full", "tree"]);
    expect(folderCalls()[0]).toEqual({ parentId: FOLDER_ID, name: "tree" });
    expect(changed).toContainEqual([FOLDER_ID]);
    expect(items()).toEqual([]);
  });

  it("Pause all and offline stop them; Resume all and online go on; cancelling them makes no more", async () => {
    server.hold = true;
    let made = 0;
    let answer: Array<() => void> = [];
    server.onJson = (call) => {
      if (call.method !== "POST" || call.path !== "/api/nodes/folder") return undefined;
      const body = call.body as { name: string; parentId: string | null };
      return new Promise<Response>((resolve) =>
        answer.push(() => resolve(json(folderDto({ id: rowId(0x8000 + ++made), ...body })))),
      );
    };
    const release = async () => {
      const waiting = answer;
      answer = [];
      for (const go of waiting) go();
      await settle();
    };
    await addFiles([], null, emptyFolders(8));
    await settle();
    expect(folderCalls().length).toBe(1);
    pauseAll();
    await release();
    await settle();
    // The parent arrived; nothing more is asked while every row is paused.
    const paused = folderCalls().length;
    expect(items().every((item) => item.state === "paused")).toBe(true);
    await settle();
    expect(folderCalls().length).toBe(paused);

    resumeAll();
    await settle();
    expect(folderCalls().length).toBeGreaterThan(paused);
    expect(folderCalls().length).toBeLessThanOrEqual(paused + 4);
    window.dispatchEvent(new Event("offline"));
    await release();
    await settle();
    const offline = folderCalls().length;
    expect(items().some((item) => item.state === "paused" && item.pauseReason === "offline")).toBe(true);
    await settle();
    expect(folderCalls().length).toBe(offline);

    for (const item of items()) cancelItem(item.id);
    window.dispatchEvent(new Event("online"));
    await release();
    await settle();
    expect(folderCalls().length).toBe(offline);
    expect(items()).toEqual([]);
  });

  it("a folder row says what it is doing", () => {
    const row = { kind: "folder", state: "uploading", file: null } as UploadItem;
    expect(describeItem(row)).toBe("Creating the folder");
    expect(describeItem({ ...row, state: "done" })).toBe("Folder created");
    expect(describeItem({ ...row, state: "queued" })).toBe("Waiting");
  });
});

describe("the ceiling", () => {
  it("Retry-After: 0 is not a loop: the queue stays stopped", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onInit = () => envelope("ceiling_exceeded", 429, undefined, { "retry-after": "0" });
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    await settle(60_000);
    expect(server.inits.length).toBe(1);
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "ceiling" });
  });
});

describe("a taken name on a rename init", () => {
  it("is one more init and then an error — proven without relying on the test ending", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    // After a handful of inits the stand-in stops answering at all: a loop would show as a
    // count, not as a hang.
    server.onInit = (_body, nth) => {
      if (nth > 6) throw new TypeError("the stand-in has had enough");
      return envelope("conflict", 409, { existingId: EXISTING_ID });
    };
    renderShell(<UploadDropOverlay />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle(0));
    await act(async () => screen.getByRole("checkbox").click());
    await act(async () => screen.getByRole("button", { name: "Keep both" }).click());
    await act(() => settle(0));
    expect(server.inits.length).toBe(2);
    expect(items()[0]).toMatchObject({
      state: "error",
      message: "Couldn't find a free name for this file here.",
    });
  });
});

describe("the device's row once complete has been sent", () => {
  const lost = () => {
    throw new TypeError("network");
  };

  it("Remove of an upload nobody could confirm sends no DELETE — the file may be there — and takes the row off the device", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onComplete = lost;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    await settle(60_000);
    expect(items()[0]).toMatchObject({ state: "error", unconfirmed: true });
    expect((await readResumeRows()).length).toBe(1);
    removeItem(items()[0]!.id);
    await settle(0);
    expect(items()).toEqual([]);
    expect(server.count("DELETE", /^\/api\/uploads\//)).toBe(0);
    expect(await readResumeRows()).toEqual([]);
  });

  it("a reload while complete is on its way: the row says complete was sent, and the file selected again asks complete — no init, no body, no second upload", async () => {
    // The answer to complete never arrives in this page's life.
    server.onComplete = () => new Promise<Response>(() => {});
    server.partBytes = 100;
    const file = bigFile("video.mp4", 250, 1_760_000_000_000);
    await addFiles([{ file }], null);
    await settle();
    expect(items()[0]!.state).toBe("completing");
    const [row] = await readResumeRows();
    expect(row!.complete).toEqual(server.completes[0]);
    expect(row!.complete!.parts.map((part) => part.n)).toEqual([1, 2, 3]);

    forgetUploadsForTests();
    server.onComplete = undefined;
    await restoreUploads();
    expect(items()[0]).toMatchObject({ completeSent: true, state: "paused" });
    const inits = server.inits.length;
    const puts = server.puts.length;
    await addFiles([{ file }], null);
    await settle();
    expect(server.inits.length).toBe(inits);
    expect(server.puts.length).toBe(puts);
    expect(server.completes.length).toBe(2);
    expect(server.completes[1]).toEqual(server.completes[0]);
    expect(items()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("and when the server says that session is gone, nothing is uploaded until the user asks", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    let held = true;
    server.onJson = (call) =>
      held && /\/complete$/.test(call.path) ? new Promise<Response>(() => {}) : undefined;
    const file = smallFile("a.txt", 10, 1_760_000_000_000);
    await addFiles([{ file }], null);
    await settle(0);
    forgetUploadsForTests();
    held = false;
    await restoreUploads();
    server.onComplete = () => envelope("not_found", 404);
    await addFiles([{ file }], null);
    await settle(0);
    await settle(60_000);
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(1);
    expect(items()[0]).toMatchObject({ state: "error", uploadId: null, completeSent: false, canRetry: true });
    expect(await readResumeRows()).toEqual([]);
    server.onComplete = undefined;
    retryItem(items()[0]!.id);
    await settle(0);
    expect(server.inits.length).toBe(2);
    expect(items()).toEqual([]);
  });
});

describe("complete answered 200 with a body nobody can read", () => {
  it("the file landed: uploaded, said so, the listing told — never 'didn't finish', never sent again", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    const changed: Array<(string | null)[]> = [];
    const stop = onNodesChanged((detail) => changed.push(detail.parentIds));
    server.onComplete = () => json({ id: "not-a-node", scanStatus: "a-status-of-next-year" });
    await addFiles([{ file: smallFile("a.txt") }], FOLDER_ID);
    await settle(0);
    await settle(120_000);
    stop();
    expect(server.completes.length).toBe(1);
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(1);
    expect(items()).toEqual([]);
    expect(getUploads().finished).toBe(1);
    expect(said()).toEqual(["Uploading a.txt", "a.txt uploaded — refresh the folder to see it"]);
    expect(getToasts().map((toast) => toast.message)).toEqual([
      "a.txt uploaded — refresh the folder to see it",
    ]);
    expect(changed).toContainEqual([FOLDER_ID]);
    expect(await readResumeRows()).toEqual([]);
  });
});

describe("offline at the moment of complete", () => {
  it("waits for the connection instead of counting its tries down", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    let down = true;
    server.onComplete = () => {
      if (down) throw new TypeError("offline");
      return undefined;
    };
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    window.dispatchEvent(new Event("offline"));
    await settle(600_000);
    // Still on its way — not "couldn't confirm" after 52 seconds.
    expect(items()[0]).toMatchObject({ state: "completing", unconfirmed: false });
    const asked = server.completes.length;
    expect(asked).toBeLessThanOrEqual(3);
    down = false;
    window.dispatchEvent(new Event("online"));
    await settle(0);
    expect(server.completes.length).toBe(asked + 1);
    expect(items()).toEqual([]);
  });
});

describe("a rate limit and the bodies in flight", () => {
  it("what is being sent finishes — it is not thrown away and sent again — and nothing new is asked until the wait ends", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.hold = true;
    server.partBytes = 100;
    await addFiles([{ file: bigFile("big.bin", 600) }], null);
    await settle(0);
    const flying = [...server.held];
    expect(flying.map((call) => call.n)).toEqual([1, 2, 3]);

    // Another file's init is told to slow down.
    server.onInit = () => envelope("rate_limited", 429, undefined, { "retry-after": "20" });
    await addFiles([{ file: smallFile("other.txt") }], null);
    await settle(0);
    expect(items().map((item) => [item.name, item.state])).toEqual([
      ["big.bin", "uploading"],
      ["other.txt", "paused"],
    ]);
    expect(flying.every((call) => !call.signal?.aborted)).toBe(true);

    // The three bodies arrive; the next three are not asked for yet.
    for (const call of flying) call.resolve();
    await settle(0);
    await settle(19_000);
    expect(server.puts.length).toBe(3);

    server.onInit = undefined;
    server.hold = false;
    await settle(1_100);
    await settle(0);
    expect(server.puts.filter((call) => call.uploadId === flying[0]!.uploadId).map((call) => call.n)).toEqual(
      [1, 2, 3, 4, 5, 6],
    );
    expect(server.completes.length).toBe(2);
  });
});

describe("the panel's rows when there are more than it draws", () => {
  const item = (id: number, state: UploadItem["state"], patch: Partial<UploadItem> = {}) =>
    ({ id: `i${id}`, kind: "file", file: {} as File, state, scanStatus: null, ...patch }) as UploadItem;

  it("260 files, 230 finished: every row in flight is drawn, and a failed one wherever it stands", () => {
    const queue = [
      ...Array.from({ length: 230 }, (_, n) => item(n, "done")),
      item(230, "uploading"),
      item(231, "hashing"),
      item(232, "completing"),
      ...Array.from({ length: 26 }, (_, n) => item(233 + n, "queued")),
      item(259, "error"),
    ];
    const drawn = rowsToDraw(queue, PANEL_ROWS);
    expect(drawn.length).toBe(PANEL_ROWS);
    const ids = new Set(drawn.map((row) => row.id));
    for (const must of ["i230", "i231", "i232", "i259"]) expect(ids.has(must)).toBe(true);
    // Then the waiting ones, then as many finished ones as fit — in the queue's own order.
    expect(drawn.filter((row) => row.state === "queued").length).toBe(26);
    expect(drawn.filter((row) => row.state === "done").length).toBe(PANEL_ROWS - 30);
    expect(drawn.map((row) => row.id)).toEqual(queue.filter((row) => ids.has(row.id)).map((row) => row.id));
  });

  it("refused, flagged and conflicting rows are always drawn; a short queue is drawn whole", () => {
    const queue = [
      ...Array.from({ length: 300 }, (_, n) => item(n, "queued")),
      item(300, "refused"),
      item(301, "done", { scanStatus: "infected" }),
      item(302, "conflict"),
      item(303, "scanning"),
    ];
    const ids = new Set(rowsToDraw(queue, PANEL_ROWS).map((row) => row.id));
    for (const must of ["i300", "i301", "i302", "i303"]) expect(ids.has(must)).toBe(true);
    expect(rowsToDraw(queue.slice(0, 10), PANEL_ROWS).length).toBe(10);
  });

  it("in the panel: the file in flight past row 200 can be paused", async () => {
    keepResumeListInMemory();
    // The panel is drawn once the 230 have landed: drawn during them it is 230 re-renders of
    // 200 rows, and this test is about which rows are drawn, not about drawing them often.
    await act(() =>
      addFiles(
        Array.from({ length: 230 }, (_, n) => ({ file: smallFile(`done${n}.txt`) })),
        null,
      ),
    );
    await act(() => settle());
    // A paused row keeps the finished ones on the list; then one more file starts and is held.
    server.hold = true;
    await act(() => addFiles([{ file: smallFile("moving.txt") }], null));
    await act(() => settle());
    renderShell(<UploadPanel />);
    expect(items().length).toBeLessThanOrEqual(231);
    expect(screen.getByRole("button", { name: "Pause moving.txt" })).toBeTruthy();
  });
});

describe("the scan loop's bound and the queue's length", () => {
  const polls = () => scanAsks(server);

  it("one stuck file costs a handful of requests a minute, not one a second", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    await addFiles([{ file: smallFile("stuck.txt") }], null);
    await settle(0);
    await settle(60_000);
    // 1, 1, 2, 2, 3 s and then every 5 s.
    expect(polls().length).toBeLessThanOrEqual(16);
    await settle(SCAN_FOLLOW_LIMIT_MS);
    expect(polls().length).toBeLessThanOrEqual(70);
    expect(items()[0]).toMatchObject({ state: "done", scanStatus: "pending" });
  });

  it("a queue far longer than one request: none is given up without having been asked about, each at least three times, at most one request a second", async () => {
    keepResumeListInMemory();
    // Five requests' worth (R1 m16: every due file in one request, up to SCAN_BATCH_MAX).
    const count = Math.ceil((SCAN_FOLLOW_LIMIT_MS + 10_000) / 2_000) + 40;
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    await addFiles(
      Array.from({ length: count }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
      null,
    );
    for (let turn = 0; turn < count + 50; turn += 1) await settle(0);
    expect(items().filter((item) => item.state === "scanning").length).toBe(count);
    await settle(SCAN_FOLLOW_LIMIT_MS - 10_000);
    expect(items().every((item) => item.state === "scanning")).toBe(true);
    await settle(20_000 + count * SCAN_MIN_ASKS * 1_000);
    expect(items().every((item) => item.state === "done" && item.scanStatus === "pending")).toBe(true);
    const perFile = new Map<string, number>();
    for (const ids of polls()) for (const id of ids) perFile.set(id, (perFile.get(id) ?? 0) + 1);
    expect(perFile.size).toBe(count);
    expect(Math.min(...perFile.values())).toBeGreaterThanOrEqual(SCAN_MIN_ASKS);
    // At most one request a second in all, and never more than the server's limit in one.
    expect(polls().length).toBeLessThanOrEqual(
      (SCAN_FOLLOW_LIMIT_MS + 10_000 + count * SCAN_MIN_ASKS * 1_000) / 1_000 + 1,
    );
    expect(Math.max(...polls().map((ids) => ids.length))).toBeLessThanOrEqual(SCAN_BATCH_MAX);
  });

  it("when the frame goes, the scan is not asked about either — also for a file that lands meanwhile; it goes on when the frame is back", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    let land!: () => void;
    const view = renderShell(<UploadDropOverlay />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle(0));
    // A second file whose complete is on its way when the frame goes: it still lands.
    const landing = server.completes.length;
    server.onComplete = (_body, nth) =>
      nth === landing + 1
        ? new Promise<Response>((resolve) => {
            land = () => resolve(json(nodeDto({ id: rowId(0x9100), name: "b.txt", scanStatus: "pending" })));
          })
        : undefined;
    await act(() => addFiles([{ file: smallFile("b.txt") }], null));
    await act(() => settle(0));
    view.unmount();
    land();
    await settle(0);
    expect(items().map((item) => item.state)).toEqual(["scanning", "scanning"]);
    await settle(60_000);
    expect(polls().length).toBe(0);
    renderShell(<UploadDropOverlay />);
    await act(() => settle(3_000));
    expect(polls().length).toBeGreaterThan(0);
  });
});

describe("/uploads?parent=", () => {
  it("only a well-formed id is a folder: anything else is the top level, also in the body of init", async () => {
    renderRoutes(
      [{ path: "/uploads", element: <UploadsPage /> }],
      ["/uploads?parent=..%2Fauth%2Fsign-out"],
      <UploadDropOverlay />,
    );
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await act(async () => (await screen.findByRole("button", { name: "Choose files" })).click());
    expect(click).toHaveBeenCalled();
    const input = document.querySelector<HTMLInputElement>('input[data-upload-input="files"]')!;
    Object.defineProperty(input, "files", { value: [smallFile("a.txt")], configurable: true });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(() => settle());
    expect(server.inits.map((body) => body.parentId)).toEqual([null]);
  });
});

// Kept in reach of the controls: an ApiError is what the transport rejects with.
void ApiError;
