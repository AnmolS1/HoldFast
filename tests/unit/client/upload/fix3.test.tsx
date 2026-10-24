import "fake-indexeddb/auto";
// Third review round: a remount of the frame is not the user pausing (3M1); every timer asks
// whether its work is still wanted at the moment it sends (3m2); the panel caps the rows waiting
// on the scanner and the scan has a hard time bound (3m1); the ribbon counts files only (3m3).
import { act } from "@testing-library/react";
import { Fragment, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import { addFiles, liveHashJobs } from "../../../../src/client/features/upload/manager";
import { PANEL_ROWS, SCAN_HARD_LIMIT_MS } from "../../../../src/client/features/upload/plan";
import { getUploads, type UploadItem } from "../../../../src/client/features/upload/store";
import { rowsToDraw, summarise } from "../../../../src/client/features/upload/summary";
import { completeReauth, isReauthPending } from "../../../../src/client/lib/api";
import {
  confirmReauthIdentity,
  purgeUserState,
  queryClient,
  refreshSession,
} from "../../../../src/client/lib/query";
import { AccountKeyed } from "../../../../src/client/routes/frame/Frame";
import { renderShell, sessionOf, setupShell } from "../shell/helpers";
import { folderDto } from "./fixtures";
import {
  apiError,
  envelope,
  FAKED_TIMERS,
  freshUploader,
  installServer,
  json,
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
const rows = () => items().map((item) => [item.name, item.state, item.pauseReason]);

describe("a remount of the frame is not the user pausing (3M1)", () => {
  it("the reviewer's order with the shell's real timing: a body 401, the session read as null, the same account signs in again — the host is remounted and the queue goes on and lands", async () => {
    // No identity adopted beforehand, as in the reviewer's R2: the null read and the re-auth each
    // remount the frame (with one adopted, the shell's AccountKeyed keeps it mounted — its own test).
    server.hold = true;
    renderShell(
      <AccountKeyed>
        <UploadDropOverlay />
      </AccountKeyed>,
    );
    await act(() =>
      addFiles(
        Array.from({ length: 5 }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
        null,
      ),
    );
    await act(() => settle());
    const host = document.querySelector('input[data-upload-input="files"]');
    let current: unknown = sessionOf();
    let expired = true;
    server.onJson = (call) => {
      if (call.path === "/api/auth/get-session") return json(current);
      // The body's 401 is checked with a JSON request through the API client: that opens the gate.
      if (expired && call.path === "/api/uploads/open") return envelope("unauthorized", 401);
      return undefined;
    };
    await act(async () => server.held[0]!.reject(apiError(401, "unauthorized")));
    await act(() => settle());
    expect(isReauthPending()).toBe(true);
    expect(items().every((item) => item.state === "paused" && item.pauseReason === "auth")).toBe(true);
    // A focus refetch while the dialog is up: the server says nobody.
    current = null;
    await act(async () => {
      await refreshSession();
    });
    await act(() => settle());
    // The dialog: the same account confirms, then the gate closes.
    current = sessionOf();
    expired = false;
    await act(async () => {
      if ((await confirmReauthIdentity(sessionOf().user.id)) === "same") completeReauth();
    });
    // The observers are told on a later macrotask: give every remount its chance.
    await act(() => settle());
    await act(() => settle());
    expect(document.querySelector('input[data-upload-input="files"]')).not.toBe(host);
    expect(items().some((item) => item.pauseReason === "user")).toBe(false);
    expect(items().every((item) => item.state === "queued" || item.state === "uploading")).toBe(true);
    server.hold = false;
    for (const call of [...server.held]) call.resolve();
    for (let turn = 0; turn < 10 && server.completes.length < 5; turn += 1) await act(() => settle());
    expect(server.completes.length).toBe(5);
  });

  it("the reviewer's R1: the session read as null for a moment remounts the host, and no row changes", async () => {
    server.hold = true;
    renderShell(
      <AccountKeyed>
        <UploadDropOverlay />
      </AccountKeyed>,
    );
    await act(() =>
      addFiles(
        Array.from({ length: 5 }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
        null,
      ),
    );
    await act(() => settle());
    const before = rows();
    const input = document.querySelector('input[data-upload-input="files"]');
    let current: unknown = null;
    server.onJson = (call) => (call.path === "/api/auth/get-session" ? json(current) : undefined);
    await act(async () => {
      await refreshSession();
    });
    await act(() => settle());
    // No identity was ever adopted here, so the frame did remount: the host is a new one.
    expect(document.querySelector('input[data-upload-input="files"]')).not.toBe(input);
    current = sessionOf();
    await act(async () => {
      await refreshSession();
    });
    await act(() => settle());
    expect(rows()).toEqual(before);
    expect(server.held.every((call) => !call.signal?.aborted)).toBe(true);
  });

  it("a remount of the host while files are hashing and sending changes no row, stops no worker and aborts no body", async () => {
    server.hold = true;
    server.holdHash = true;
    const Keyed = ({ k, children }: { k: string; children: ReactNode }) => (
      <Fragment key={k}>{children}</Fragment>
    );
    const view = renderShell(
      <Keyed k="a">
        <UploadDropOverlay />
      </Keyed>,
    );
    await act(() =>
      addFiles(
        Array.from({ length: 5 }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
        null,
      ),
    );
    await act(() => settle());
    const before = rows();
    const workers = liveHashJobs();
    expect(workers).toBe(3);
    expect(server.held.length).toBe(3);
    view.rerender(
      <Keyed k="b">
        <UploadDropOverlay />
      </Keyed>,
    );
    await act(() => settle());
    expect(rows()).toEqual(before);
    expect(liveHashJobs()).toBe(workers);
    expect(server.held.every((call) => !call.signal?.aborted)).toBe(true);
  });

  it("the frame leaving and coming back changes no row either: the uploads went on meanwhile", async () => {
    const view = renderShell(<UploadDropOverlay />);
    server.hold = true;
    await act(() =>
      addFiles(
        Array.from({ length: 2 }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
        null,
      ),
    );
    await act(() => settle());
    const before = rows();
    view.unmount();
    await settle();
    expect(rows()).toEqual(before);
    server.hold = false;
    for (const call of [...server.held]) call.resolve();
    for (let turn = 0; turn < 10 && server.completes.length < 2; turn += 1) await settle();
    // Both landed while the frame was away, with no one pressing anything.
    expect(server.completes.length).toBe(2);
    expect(items().some((item) => item.state === "paused")).toBe(false);
  });
});

describe("a timer asks whether its work is still wanted when it sends (3m2)", () => {
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

  it("an init in its retry wait when the window opens is not sent again", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onInit = (_, n) => (n <= 2 ? envelope("internal", 503) : undefined);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle(0));
    // Two tries answered 503; the third waits for its turn.
    const before = server.inits.length;
    expect(before).toBe(2);
    const close = openWindow();
    await act(() => settle(30_000));
    expect(server.inits.length).toBe(before);
    await act(close);
    await act(() => settle(60_000));
    expect(server.inits.length).toBe(before);
    expect(server.puts).toEqual([]);
  });

  it("a complete in its retry wait is not sent again", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onComplete = (_, n) => (n === 1 ? envelope("internal", 503) : undefined);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    for (let turn = 0; turn < 5 && server.completes.length === 0; turn += 1) await act(() => settle(0));
    expect(server.completes.length).toBe(1);
    const close = openWindow();
    await act(() => settle(30_000));
    expect(server.completes.length).toBe(1);
    await act(close);
    await act(() => settle(60_000));
    expect(server.completes.length).toBe(1);
  });

  it("a complete waiting at the offline gate is not sent when the connection comes back inside the window", async () => {
    let answer!: (response: Response) => void;
    server.onComplete = (_, n) =>
      n === 1 ? new Promise<Response>((resolve) => (answer = resolve)) : undefined;
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    for (let turn = 0; turn < 5 && server.completes.length === 0; turn += 1) await act(() => settle());
    expect(server.completes.length).toBe(1);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    // The answer is lost; the next try waits at the gate until the browser is back online.
    await act(async () => answer(envelope("internal", 503)));
    await act(() => settle());
    expect(server.completes.length).toBe(1);
    const close = openWindow();
    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });
    await act(() => settle());
    expect(server.completes.length).toBe(1);
    await act(close);
    await act(() => settle());
    expect(server.completes.length).toBe(1);
  });

  it("a folder whose parent is answered inside the window is not asked for, nor is a folder in its retry wait", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    let answer!: () => void;
    let asked = 0;
    server.onJson = (call) => {
      if (call.method !== "POST" || call.path !== "/api/nodes/folder") return undefined;
      asked += 1;
      const { name } = call.body as { name: string };
      if (name === "top") {
        return new Promise<Response>(
          (resolve) => (answer = () => resolve(json(folderDto({ name: "top" }), 201))),
        );
      }
      return envelope("internal", 503);
    };
    await act(() => addFiles([], null, ["top/inner", "other"]));
    await act(() => settle(0));
    // "top" is held; "other" was answered 503 twice and waits for its next try.
    expect(asked).toBe(3);
    const close = openWindow();
    answer();
    await act(() => settle(30_000));
    expect(asked).toBe(3);
    await act(close);
    await act(() => settle(60_000));
    expect(asked).toBe(3);
  });

  it("a scan ask scheduled before the window is not sent inside it", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    for (let turn = 0; turn < 5 && items()[0]?.state !== "scanning"; turn += 1) await act(() => settle(0));
    expect(items()[0]!.state).toBe("scanning");
    const polls = () => server.count("POST", SCAN_ASK);
    const before = polls();
    const close = openWindow();
    await act(() => settle(30_000));
    expect(polls()).toBe(before);
    await act(close);
    await act(() => settle(60_000));
    expect(polls()).toBe(before);
  });
});

describe("rows waiting on the scanner (3m1)", () => {
  const item = (id: number, state: UploadItem["state"], patch: Partial<UploadItem> = {}) =>
    ({ id: `i${id}`, kind: "file", file: {} as File, state, scanStatus: null, ...patch }) as UploadItem;

  it("1,000 files waiting on the scanner are counted, not drawn; what can be acted on is drawn first", () => {
    const queue = [
      ...Array.from({ length: 1_000 }, (_, n) => item(n, "scanning", { scanStatus: "pending" })),
      item(1_000, "uploading"),
      item(1_001, "error"),
      item(1_002, "conflict"),
      item(1_003, "paused"),
      ...Array.from({ length: 5 }, (_, n) => item(1_004 + n, "queued")),
    ];
    const drawn = rowsToDraw(queue, PANEL_ROWS);
    expect(drawn.length).toBe(PANEL_ROWS);
    const ids = new Set(drawn.map((row) => row.id));
    for (const must of ["i1000", "i1001", "i1002", "i1003"]) expect(ids.has(must)).toBe(true);
    expect(drawn.filter((row) => row.state === "scanning").length).toBe(PANEL_ROWS - 4);
    // The queue's own order is kept.
    expect(drawn.map((row) => row.id)).toEqual(queue.filter((row) => ids.has(row.id)).map((row) => row.id));
  });

  it("a long queue on a stuck scanner is followed for at most the hard bound, at one request a second, then every row says still being checked", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    keepResumeListInMemory();
    // More files than three asks each fit in the hard bound (3 × 700 s > 30 min): the bound decides.
    const count = 700;
    await addFiles(
      Array.from({ length: count }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
      null,
    );
    for (let turn = 0; turn < count + 100 && items().some((row) => row.state !== "scanning"); turn += 1) {
      await settle(0);
    }
    expect(items().filter((row) => row.state === "scanning").length).toBe(count);
    const polls = () => server.count("POST", SCAN_ASK);
    await settle(SCAN_HARD_LIMIT_MS + 5_000);
    expect(items().every((row) => row.state === "done" && row.scanStatus === "pending")).toBe(true);
    const asked = polls();
    expect(asked).toBeLessThanOrEqual((SCAN_HARD_LIMIT_MS + 5_000) / 1_000 + 1);
    await settle(10 * 60_000);
    expect(polls()).toBe(asked);
  });
});

describe("the ribbon counts files (3m3)", () => {
  it("one file and fifty empty folders read as one file", async () => {
    server.hold = true;
    await addFiles(
      [{ file: smallFile("only.txt") }],
      null,
      Array.from({ length: 50 }, (_, n) => `empty${n}`),
    );
    await settle();
    expect(items().filter((row) => row.kind === "folder").length).toBe(50);
    const ribbon = summarise(getUploads());
    expect(ribbon?.sentence).toMatch(/^Uploading 1 of 1 /);
  });

  it("while only empty folders are being made, the ribbon says so — not files", async () => {
    let answer!: () => void;
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/nodes/folder"
        ? new Promise<Response>((resolve) => (answer = () => resolve(json(folderDto(), 201))))
        : undefined;
    await addFiles([], null, ["one", "two"]);
    await settle();
    const ribbon = summarise(getUploads());
    expect(ribbon).toMatchObject({ sentence: "Creating 2 folders", status: "active" });
    void answer;
  });
});
