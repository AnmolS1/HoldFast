// Limits and loops: an answer that says "stop" stops the whole queue for as long as it says, and
// no answer is ever asked for again without bound.
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import {
  addFiles,
  liveHashJobs,
  pauseItem,
  purgeUploads,
  resumeItem,
} from "../../../../src/client/features/upload/manager";
import { getUploads } from "../../../../src/client/features/upload/store";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { ApiError } from "../../../../src/client/lib/api";
import { renderShell, setupShell } from "../shell/helpers";
import { EXISTING_ID } from "./fixtures";
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
} from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  await freshUploader();
  server = installServer();
  vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
});

const items = () => getUploads().items;
const sentence = () => getRibbonSnapshot().current?.sentence;
const many = (count: number) => Array.from({ length: count }, (_, n) => ({ file: smallFile(`f${n}.txt`) }));

describe("429 rate_limited", () => {
  it("200 queued, the first init answered 429 with Retry-After 30: nothing more is asked for 30 seconds, and no file has failed", async () => {
    let limited = true;
    server.onInit = () =>
      limited ? envelope("rate_limited", 429, undefined, { "retry-after": "30" }) : undefined;
    keepResumeListInMemory();
    await addFiles(many(200), null);
    await settle(0);
    // The three that were already on their way when the answer came; not one more.
    const asked = server.inits.length;
    expect(asked).toBeLessThanOrEqual(3);
    await settle(29_900);
    expect(server.inits.length).toBe(asked);
    expect(items().filter((item) => item.state === "error").length).toBe(0);
    expect(items().every((item) => item.state === "paused" && item.pauseReason === "limited")).toBe(true);
    expect(sentence()).toBe("Too many requests — uploads go on in a moment");

    // It ends by itself.
    limited = false;
    await settle(200);
    for (let turn = 0; turn < 250; turn += 1) await settle(0);
    expect(server.completes.length).toBe(200);
    expect(items()).toEqual([]);
  });

  it("still limited after the wait: three more asks per wait, never the whole queue", async () => {
    server.onInit = () => envelope("rate_limited", 429, undefined, { "retry-after": "10" });
    await addFiles(many(50), null);
    await settle(0);
    await settle(60_000);
    // Seven rounds of at most three in a minute.
    expect(server.inits.length).toBeLessThanOrEqual(21);
  });

  it("without Retry-After it waits 30 seconds; a Retry-After of a day is cut to ten minutes", async () => {
    server.onInit = () => envelope("rate_limited", 429);
    await addFiles(many(1), null);
    await settle(0);
    expect(server.inits.length).toBe(1);
    await settle(29_000);
    expect(server.inits.length).toBe(1);
    await settle(1_500);
    expect(server.inits.length).toBe(2);

    await purgeUploads();
    await freshUploader();
    server = installServer();
    server.onInit = () => envelope("rate_limited", 429, undefined, { "retry-after": "86400" });
    await addFiles(many(1), null);
    await settle(0);
    await settle(599_000);
    expect(server.inits.length).toBe(1);
    await settle(2_000);
    expect(server.inits.length).toBe(2);
  });

  it("on a part: the file waits and goes on where it was — the parts that arrived are not sent again", async () => {
    server.partBytes = 100;
    let limited = true;
    server.onPut = (call) => {
      if (call.n === 2 && limited) {
        limited = false;
        return makeApiError(429, "rate_limited");
      }
      return undefined;
    };
    await addFiles([{ file: bigFile("video.mp4", 300) }], null);
    await settle(0);
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "limited" });
    await settle(5_000);
    expect(server.inits.length).toBe(1);
    expect(server.puts.filter((call) => call.n === 1).length).toBe(1);
    expect(server.completes.length).toBe(1);
  });
});

/** The transport's own error, as a body request answered 429 with Retry-After: 5 rejects. */
function makeApiError(status: number, code: string): ApiError {
  return new ApiError({ status, code: code as ApiError["code"], message: `${code} message`, retryAfter: 5 });
}

describe("429 ceiling_exceeded", () => {
  it("the open-sessions cap is not the daily limit: its own sentence, no clock, and Resume by hand", async () => {
    let over = true;
    server.onInit = () => (over ? envelope("ceiling_exceeded", 429, { kind: "open_uploads" }) : undefined);
    renderShell(<UploadPanel />);
    await act(() => addFiles(many(2), null));
    await act(() => settle(0));
    expect(items().map((item) => item.pauseReason)).toEqual(["open", "open"]);
    expect(sentence()).toBe("Too many uploads are open — finish or remove some to go on");
    const asked = server.inits.length;
    await act(() => settle(3_600_000));
    expect(server.inits.length).toBe(asked);
    over = false;
    await act(async () => screen.getByRole("button", { name: "Resume f0.txt" }).click());
    await act(() => settle(0));
    expect(server.completes.length).toBe(2);
  });
});

describe("Keep both for every other file, and the server still says taken", () => {
  it("each file asks for a free name once and then stops with its own sentence — no loop, with the clock running", async () => {
    server.onInit = () => envelope("conflict", 409, { existingId: EXISTING_ID });
    renderShell(
      <>
        <UploadDropOverlay />
        <UploadPanel />
      </>,
    );
    await act(() => addFiles(many(5), null));
    await act(() => settle(0));
    await act(async () => screen.getByRole("checkbox").click());
    await act(async () => screen.getByRole("button", { name: "Keep both" }).click());
    await act(() => settle(0));
    await act(() => settle(120_000));

    // One init that asked, one that said "rename": two per file, and then nothing.
    expect(server.inits.length).toBe(10);
    expect(server.inits.filter((body) => body.onConflict === "rename").length).toBe(5);
    expect(items().map((item) => [item.state, item.message])).toEqual(
      Array.from({ length: 5 }, () => ["error", "Couldn't find a free name for this file here."]),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(() => settle(600_000));
    expect(server.inits.length).toBe(10);
  });

  it("without the tick: a taken name on the rename init is an error too, not the question again", async () => {
    server.onInit = () => envelope("conflict", 409);
    renderShell(<UploadDropOverlay />);
    await act(() => addFiles(many(1), null));
    await act(() => settle(0));
    await act(async () => screen.getByRole("button", { name: "Keep both" }).click());
    await act(() => settle(60_000));
    expect(server.inits.length).toBe(2);
    expect(items()[0]).toMatchObject({ state: "error", canRetry: true });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("hash workers", () => {
  it("40 files that all meet a conflict: no worker is started for a file that waits for an answer", async () => {
    server.holdHash = true;
    server.onInit = () => envelope("conflict", 409, { existingId: EXISTING_ID });
    await addFiles(many(40), null);
    for (let turn = 0; turn < 60; turn += 1) await settle(0);
    expect(items().every((item) => item.state === "conflict")).toBe(true);
    expect(server.hashes.started).toBe(0);
    expect(liveHashJobs()).toBe(0);
  });

  it("never more workers than files in flight, however many are queued", async () => {
    server.holdHash = true;
    server.hold = true;
    await addFiles(many(40), null);
    for (let turn = 0; turn < 20; turn += 1) await settle(0);
    expect(liveHashJobs()).toBe(3);
    expect(server.hashes.peak).toBe(3);
  });

  it("a pause stops the worker of that file, and resume starts one again; a failure stops it too", async () => {
    server.holdHash = true;
    server.hold = true;
    await addFiles(many(2), null);
    await settle(0);
    expect(liveHashJobs()).toBe(2);
    const [first, second] = items();
    pauseItem(first!.id);
    expect(liveHashJobs()).toBe(1);
    expect(server.hashes.cancelled).toBe(1);
    resumeItem(first!.id);
    await settle(0);
    expect(liveHashJobs()).toBe(2);

    server.held
      .find((call) => call.uploadId === items()[1]!.uploadId)!
      .reject(makeApiError(400, "validation"));
    await settle(0);
    expect(items().find((item) => item.id === second!.id)!.state).toBe("error");
    expect(liveHashJobs()).toBe(1);
  });

  it("the purger stops every worker; the host leaving the page stops none (a remount is not a pause)", async () => {
    server.holdHash = true;
    server.hold = true;
    const view = renderShell(<UploadDropOverlay />);
    await act(() => addFiles(many(3), null));
    await act(() => settle(0));
    expect(liveHashJobs()).toBe(3);
    const before = items().map((item) => [item.state, item.pauseReason]);
    view.unmount();
    // Review round 3 (3M1): an unmount changes no row — the same host is back in the same commit
    // when the frame remounts. Signing out is the purger's, below.
    expect(liveHashJobs()).toBe(3);
    expect(items().map((item) => [item.state, item.pauseReason])).toEqual(before);
    await purgeUploads();
    expect(liveHashJobs()).toBe(0);
    expect(server.hashes.running).toBe(0);
  });
});
