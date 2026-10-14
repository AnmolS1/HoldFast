// `complete` is the one step that cannot be taken back. Once it has been sent the file may have
// landed whatever comes back: the same body is asked again until the server says what happened
// (200 = landed, whichever attempt did it; 409 state "completing" = wait), nothing is paused or
// cancelled, and nothing is uploaded twice unless the server says the session is gone.
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFiles,
  cancelItem,
  pauseAll,
  pauseItem,
  removeItem,
  retryItem,
} from "../../../../src/client/features/upload/manager";
import { COMPLETE_WAIT_LIMIT_MS } from "../../../../src/client/features/upload/plan";
import { getUploads } from "../../../../src/client/features/upload/store";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { renderShell, setupShell } from "../shell/helpers";
import { nodeDto, rowId } from "./fixtures";
import {
  bigFile,
  envelope,
  FAKED_TIMERS,
  freshUploader,
  installServer,
  json,
  settle,
  smallFile,
  type Server,
} from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  await freshUploader();
  server = installServer();
  vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
});

const items = () => getUploads().items;
const stillCompleting = () => envelope("conflict", 409, { state: "completing" });
const requests = () => server.calls.length + server.puts.length;

describe("a lost answer to complete", () => {
  it("is asked again with the same body; the 200 of the second try is the landing — no failure, no second upload", async () => {
    const changed: Array<(string | null)[]> = [];
    const stop = onNodesChanged((detail) => changed.push(detail.parentIds));
    // The first complete reaches the server and its answer is lost on the way back.
    server.onComplete = (_body, nth) => {
      if (nth === 1) throw new TypeError("network");
      return undefined;
    };
    server.partBytes = 100;
    await addFiles([{ file: bigFile("video.mp4", 250) }], null);
    await settle(0);
    stop();

    expect(server.completes.length).toBe(2);
    expect(server.completes[1]).toEqual(server.completes[0]);
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(3);
    expect(items()).toEqual([]);
    expect(getUploads().finished).toBe(1);
    // The listing is told: the file is there.
    expect(changed).toContainEqual([null]);
    expect(getUploads().announcements.map((entry) => entry.text)).toEqual([
      "Uploading video.mp4",
      "video.mp4 uploaded",
    ]);
  });

  it("when no answer ever comes the upload is unconfirmed — not failed — and nothing is sent by itself", async () => {
    server.onComplete = () => {
      throw new TypeError("network");
    };
    renderShell(<UploadPanel />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle(60_000));
    expect(server.completes.length).toBe(6);
    expect(items()[0]).toMatchObject({
      state: "error",
      unconfirmed: true,
      completeSent: true,
      canRetry: true,
      message: "Couldn't confirm this upload. Check the folder before trying again.",
    });
    expect(items()[0]!.uploadId).not.toBeNull();
    expect(getUploads().announcements.at(-1)!.text).toBe("Couldn't confirm a.txt — check the folder");
    expect(
      getUploads()
        .announcements.map((entry) => entry.text)
        .join(" "),
    ).not.toMatch(/didn't finish/);
    const before = requests();
    await act(() => settle(600_000));
    expect(requests()).toBe(before);

    // A new try asks complete again first: the answer is "landed", and nothing was uploaded twice.
    server.onComplete = undefined;
    await act(async () => screen.getByRole("button", { name: "Try a.txt again" }).click());
    await act(() => settle(0));
    expect(server.completes.length).toBe(7);
    expect(server.completes[6]).toEqual(server.completes[0]);
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(1);
    expect(items()).toEqual([]);
  });
});

describe("409 with state completing", () => {
  it("waits and asks again until the other attempt has finished", async () => {
    server.onComplete = (_body, nth) => (nth <= 3 ? stillCompleting() : undefined);
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    expect(server.completes.length).toBe(1);
    expect(items()[0]!.state).toBe("completing");
    await settle(1_000);
    expect(server.completes.length).toBe(2);
    await settle(2_000);
    expect(server.completes.length).toBe(3);
    await settle(3_000);
    expect(server.completes.length).toBe(4);
    expect(items()).toEqual([]);
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(1);
  });

  it("for a bounded time: after it the row says it could not be confirmed, and stops asking", async () => {
    server.onComplete = () => stillCompleting();
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    await settle(COMPLETE_WAIT_LIMIT_MS + 10_000);
    const asked = server.completes.length;
    // 1 + 2 + 3 s, then every 5 s: bounded by the limit.
    expect(asked).toBeGreaterThan(10);
    expect(asked).toBeLessThanOrEqual(4 + COMPLETE_WAIT_LIMIT_MS / 5_000);
    expect(items()[0]).toMatchObject({ state: "error", unconfirmed: true, completeSent: true });
    await settle(600_000);
    expect(server.completes.length).toBe(asked);
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(1);
  });
});

describe("once complete has been sent", () => {
  it("the item is neither paused nor cancelled nor removed — by hand, by Pause all, or by going offline", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      /\/complete$/.test(call.path) ? new Promise<Response>((resolve) => (answer = resolve)) : undefined;
    renderShell(<UploadPanel />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle(0));
    const { id } = items()[0]!;
    expect(items()[0]).toMatchObject({ state: "completing", completeSent: true });

    pauseItem(id);
    pauseAll();
    cancelItem(id);
    removeItem(id);
    await act(async () => {
      window.dispatchEvent(new Event("offline"));
    });
    await act(() => settle(0));
    expect(items()[0]).toMatchObject({ state: "completing" });
    expect(server.count("DELETE", /^\/api\/uploads\//)).toBe(0);
    // The row offers nothing, and says why.
    const row = document.querySelector<HTMLElement>("[data-upload-row]")!;
    expect(row.querySelectorAll("button").length).toBe(0);
    expect(row.textContent).toContain("Finishing — this can no longer be paused or cancelled");
    expect(screen.queryByRole("button", { name: "Pause all" })).toBeNull();

    await act(async () => {
      window.dispatchEvent(new Event("online"));
      answer(json(nodeDto({ id: rowId(0x9001), name: "a.txt", scanStatus: "clean" })));
    });
    await act(() => settle(0));
    expect(items()).toEqual([]);
    expect(getUploads().finished).toBe(1);
  });
});

describe("the server says the session is gone", () => {
  it.each([
    ["409 (no longer open)", () => envelope("conflict", 409)],
    ["404", () => envelope("not_found", 404)],
  ])("%s at complete: only then does a new try start from the top", async (_name, answer) => {
    server.onComplete = (_body, nth) => (nth === 1 ? answer() : undefined);
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    await settle(60_000);
    expect(server.completes.length).toBe(1);
    expect(items()[0]).toMatchObject({
      state: "error",
      uploadId: null,
      completeSent: false,
      unconfirmed: false,
      canRetry: true,
    });
    retryItem(items()[0]!.id);
    await settle(0);
    expect(server.inits.length).toBe(2);
    expect(server.puts.length).toBe(2);
    expect(server.completes.length).toBe(2);
    expect(items()).toEqual([]);
  });
});
