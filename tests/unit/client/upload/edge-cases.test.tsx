import "fake-indexeddb/auto";
// Every answer the upload API can give that is not "go on": what state the item takes, what the
// user reads, and — for blocked content — that nothing is ever sent for it again.
import { act, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import { addFiles } from "../../../../src/client/features/upload/manager";
import { readResumeRows } from "../../../../src/client/features/upload/resume-list";
import { getUploads } from "../../../../src/client/features/upload/store";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { AUTH_EXPIRED_EVENT, completeReauth, isReauthPending } from "../../../../src/client/lib/api";
import { renderShell, setupShell } from "../shell/helpers";
import { errorBody, EXISTING_ID } from "./fixtures";
import {
  apiError,
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
});

const items = () => getUploads().items;
const sentence = () => getRibbonSnapshot().current?.sentence;
const live = () => document.querySelector("[data-upload-live]")!.textContent ?? "";

function renderUploader() {
  return renderShell(
    <>
      <UploadDropOverlay />
      <UploadPanel />
    </>,
  );
}

async function settled(ms = 0): Promise<void> {
  await act(() => settle(ms));
}

describe("blocked content is final", () => {
  const blocked = () => envelope("forbidden", 403, { reason: "blocked_content" });

  it("a 403 blocked_content at complete: refused, off the resume list, no Retry, and not one more request", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.hold = true;
    server.onComplete = blocked;
    renderUploader();
    await act(() => addFiles([{ file: smallFile("bad.bin") }], null));
    await settled();
    // While it is on its way it is on the resume list.
    expect((await readResumeRows()).map((row) => row.body.name)).toEqual(["bad.bin"]);
    server.held[0]!.resolve();
    await settled();

    expect(server.completes.length).toBe(1);
    expect(items()[0]).toMatchObject({ state: "refused", canRetry: false, uploadId: null });
    expect(await readResumeRows()).toEqual([]);

    // The whole backoff schedule runs out, and more: nothing is sent for it.
    const json = server.calls.length;
    const bodies = server.puts.length;
    await settled(60_000);
    await settled(600_000);
    expect(server.calls.length).toBe(json);
    expect(server.puts.length).toBe(bodies);
    expect(server.completes.length).toBe(1);

    const row = document.querySelector<HTMLElement>("[data-upload-row]")!;
    expect(row.dataset.uploadRow).toBe("refused");
    expect(within(row).getByText("Refused — this file can't be stored here.")).toBeTruthy();
    expect(
      within(row)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).toEqual(["Remove bad.bin from the list"]);
    expect(screen.queryByRole("button", { name: /again|retry|resume/i })).toBeNull();
    expect(live()).toContain("bad.bin was refused. This file can't be stored here.");
    expect(live()).not.toMatch(/didn't finish|try again/i);
    expect(sentence()).toBe("1 file was refused");
  });

  it("dropping the refused file again sends nothing; another file still uploads", async () => {
    server.onComplete = (_body, nth) => (nth === 1 ? blocked() : undefined);
    const bad = smallFile("bad.bin", 10, 1_760_000_000_000);
    await addFiles([{ file: bad }], null);
    await settle();
    expect(items()[0]!.state).toBe("refused");
    const inits = server.inits.length;

    await addFiles([{ file: bad }, { file: smallFile("fine.txt") }], null);
    await settle();
    expect(server.inits.slice(inits).map((body) => body.name)).toEqual(["fine.txt"]);
    expect(items().map((item) => [item.name, item.state])).toEqual([["bad.bin", "refused"]]);
  });

  it("control: a 500 at complete on the same item IS retried, and ends as an error that offers a new try", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onComplete = () => envelope("internal", 500);
    renderUploader();
    await act(() => addFiles([{ file: smallFile("bad.bin") }], null));
    await settled();
    expect(server.completes.length).toBe(2);
    await settled(60_000);
    expect(server.completes.length).toBe(6);
    expect(items()[0]).toMatchObject({ state: "error", canRetry: true });
    expect(screen.getByRole("button", { name: "Try bad.bin again" })).toBeTruthy();
    expect(live()).toContain("bad.bin didn't finish");
    // Still resumable: its row stays on the resume list.
    expect((await readResumeRows()).length).toBe(1);
  });
});

describe("a name that is taken", () => {
  const taken = (details?: Record<string, unknown>) => envelope("conflict", 409, details);

  it("409 on init asks: Replace (with the file's id), Keep both, or Skip", async () => {
    server.onInit = (body) => (body.onConflict === "fail" ? taken({ existingId: EXISTING_ID }) : undefined);
    renderUploader();
    await act(() => addFiles([{ file: smallFile("notes.txt") }], null));
    await settled();
    expect(items()[0]!.state).toBe("conflict");
    const dialog = screen.getByRole("dialog", { name: "notes.txt is already here" });
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Skip", "Keep both", "Replace"]);
    expect(document.activeElement?.textContent).toBe("Skip");
    expect(sentence()).toBe("notes.txt already exists — choose what to do");

    await act(async () => within(dialog).getByRole("button", { name: "Replace" }).click());
    await settled();
    expect(server.inits[1]).toMatchObject({ onConflict: "replace", replaceNodeId: EXISTING_ID });
    expect(server.completes.length).toBe(1);
  });

  it("Keep both asks the server for a free name", async () => {
    server.onInit = (body) => (body.onConflict === "fail" ? taken() : undefined);
    renderUploader();
    await act(() => addFiles([{ file: smallFile("notes.txt") }], null));
    await settled();
    const dialog = screen.getByRole("dialog");
    // Without the id of the file that is there, Replace is not offered.
    expect(within(dialog).queryByRole("button", { name: "Replace" })).toBeNull();
    await act(async () => within(dialog).getByRole("button", { name: "Keep both" }).click());
    await settled();
    expect(server.inits[1]).toMatchObject({ onConflict: "rename" });
    expect(server.inits[1]).not.toHaveProperty("replaceNodeId");
    expect(server.completes.length).toBe(1);
  });

  it("Skip sends nothing more for that file", async () => {
    server.onInit = () => taken({ existingId: EXISTING_ID });
    renderUploader();
    await act(() => addFiles([{ file: smallFile("notes.txt") }], null));
    await settled();
    await act(async () => screen.getByRole("button", { name: "Skip" }).click());
    await settled();
    expect(server.inits.length).toBe(1);
    expect(server.puts.length).toBe(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(items()).toEqual([]);
  });

  it("the same answer for every other conflict of the upload", async () => {
    server.onInit = (body) => (body.onConflict === "fail" ? taken({ existingId: EXISTING_ID }) : undefined);
    renderUploader();
    await act(() =>
      addFiles(
        [{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }, { file: smallFile("c.txt") }],
        null,
      ),
    );
    await settled();
    expect(items().map((item) => item.state)).toEqual(["conflict", "conflict", "conflict"]);
    await act(async () => screen.getByRole("checkbox").click());
    await act(async () => screen.getByRole("button", { name: "Keep both" }).click());
    await settled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      server.inits
        .slice(3)
        .map((body) => [body.name, body.onConflict])
        .sort(),
    ).toEqual([
      ["a.txt", "rename"],
      ["b.txt", "rename"],
      ["c.txt", "rename"],
    ]);
    expect(server.completes.length).toBe(3);
  });

  it("a 409 on replace is shown in the server's words and offers Keep both, not Replace again", async () => {
    const refusal = "This file can't be replaced right now.";
    server.onInit = (body) =>
      body.onConflict === "fail"
        ? taken({ existingId: EXISTING_ID })
        : body.onConflict === "replace"
          ? json(errorBody("conflict", refusal), 409)
          : undefined;
    renderUploader();
    await act(() => addFiles([{ file: smallFile("notes.txt") }], null));
    await settled();
    await act(async () => screen.getByRole("button", { name: "Replace" }).click());
    await settled();
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(refusal)).toBeTruthy();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Skip", "Keep both"]);
    await act(async () => within(dialog).getByRole("button", { name: "Keep both" }).click());
    await settled();
    expect(server.inits.map((body) => body.onConflict)).toEqual(["fail", "replace", "rename"]);
    expect(server.completes.length).toBe(1);
  });
});

describe("a replace the caller may not make", () => {
  it.each([
    ["403", () => envelope("forbidden", 403)],
    ["404", () => envelope("not_found", 404)],
  ])(
    "%s on the replace init: back to the question without Replace, in the uploader's own words",
    async (_s, answer) => {
      server.onInit = (body) =>
        body.onConflict === "fail"
          ? envelope("conflict", 409, { existingId: EXISTING_ID })
          : body.onConflict === "replace"
            ? answer()
            : undefined;
      renderUploader();
      await act(() => addFiles([{ file: smallFile("notes.txt") }], null));
      await settled();
      await act(async () => screen.getByRole("button", { name: "Replace" }).click());
      await settled();
      expect(items()[0]!.state).toBe("conflict");
      const dialog = screen.getByRole("dialog");
      expect(
        within(dialog).getByText(
          "You can't replace the file that is here. Keep both files, or skip this one.",
        ),
      ).toBeTruthy();
      expect(
        within(dialog)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["Skip", "Keep both"]);
      await act(async () => within(dialog).getByRole("button", { name: "Keep both" }).click());
      await settled();
      expect(server.inits.map((body) => body.onConflict)).toEqual(["fail", "replace", "rename"]);
      expect(server.completes.length).toBe(1);
    },
  );

  it("a 403 that is blocked content stays what it is: refused, with no question", async () => {
    server.onInit = (body) =>
      body.onConflict === "fail"
        ? envelope("conflict", 409, { existingId: EXISTING_ID })
        : envelope("forbidden", 403, { reason: "blocked_content" });
    renderUploader();
    await act(() => addFiles([{ file: smallFile("notes.txt") }], null));
    await settled();
    await act(async () => screen.getByRole("button", { name: "Replace" }).click());
    await settled();
    expect(items()[0]!.state).toBe("refused");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the session ends", () => {
  it("a 401 on a part pauses the queue and asks for the sign-in; after it the file goes on where it was", async () => {
    server.hold = true;
    server.partBytes = 100;
    let signedIn = false;
    server.onJson = (call) => {
      if (call.path === "/api/uploads/open" && !signedIn) return envelope("unauthorized", 401);
      return undefined;
    };
    await addFiles([{ file: bigFile("video.mp4", 400) }, { file: bigFile("other.bin", 300) }], null);
    await settle();
    // Part 1 of the first file arrives; then the session is gone.
    server.held.find((call) => call.uploadId === items()[0]!.uploadId && call.n === 1)!.resolve();
    await settle();
    const first = items()[0]!;
    const uploadId = first.uploadId;
    server.held
      .find((call) => call.uploadId === uploadId && call.n === 2)!
      .reject(apiError(401, "unauthorized"));
    await settle();

    expect(isReauthPending()).toBe(true);
    expect(items().map((item) => [item.state, item.pauseReason])).toEqual([
      ["paused", "auth"],
      ["paused", "auth"],
    ]);
    expect(server.held).toEqual([]);
    expect(sentence()).toBe("Sign in to continue uploading");
    const inits = server.inits.length;
    const before = server.puts.length;

    signedIn = true;
    server.hold = false;
    completeReauth();
    await settle();
    expect(isReauthPending()).toBe(false);
    // No file starts over: no new session, and part 1 is not sent a second time.
    expect(server.inits.length).toBe(inits);
    const again = server.puts.slice(before).filter((call) => call.uploadId === uploadId);
    expect(again.map((call) => call.n).sort()).toEqual([2, 3, 4]);
    expect(server.completes.length).toBe(2);
    expect(server.completes.find((body) => body.parts.length === 4)!.parts.map((part) => part.n)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("a 401 that the sign-in check does not confirm is an ordinary failure, not a loop", async () => {
    server.onPut = (_call, nth) => (nth === 1 ? apiError(401, "unauthorized") : undefined);
    await addFiles([{ file: smallFile("notes.txt") }], null);
    await settle();
    expect(isReauthPending()).toBe(false);
    expect(items()[0]).toMatchObject({ state: "error", canRetry: true });
    expect(server.puts.length).toBe(1);
  });

  it("the API client's auth:expired pauses the queue, auth:restored resumes it", async () => {
    server.hold = true;
    await addFiles([{ file: smallFile("notes.txt") }], null);
    await settle();
    window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
    await settle();
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "auth" });
    server.hold = false;
    window.dispatchEvent(new CustomEvent("auth:restored"));
    await settle();
    expect(server.inits.length).toBe(1);
    expect(server.completes.length).toBe(1);
  });
});

describe("the connection drops", () => {
  it("offline pauses, online resumes, and the session is the same one", async () => {
    server.hold = true;
    server.partBytes = 100;
    await addFiles([{ file: bigFile("video.mp4", 300) }], null);
    await settle();
    window.dispatchEvent(new Event("offline"));
    await settle();
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "offline" });
    expect(sentence()).toBe("Offline — uploads resume when you're back online");
    // A file added while offline waits too.
    await addFiles([{ file: smallFile("later.txt") }], null);
    expect(items()[1]).toMatchObject({ state: "paused", pauseReason: "offline" });
    expect(server.inits.length).toBe(1);

    server.hold = false;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(server.inits.map((body) => body.name)).toEqual(["video.mp4", "later.txt"]);
    expect(server.completes.length).toBe(2);
  });
});

describe("a page opened offline", () => {
  it("queues what is added and sends it once the connection is back", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "offline" });
    expect(server.inits).toEqual([]);
    onLine.mockReturnValue(true);
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(server.completes.length).toBe(1);
  });
});

describe("limits and switches", () => {
  it("429 ceiling_exceeded pauses the queue with its sentence and resumes when Retry-After has passed", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    let over = true;
    server.onInit = () =>
      over ? envelope("ceiling_exceeded", 429, undefined, { "retry-after": "3600" }) : undefined;
    await addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null);
    await settle(0);
    expect(items().map((item) => [item.state, item.pauseReason])).toEqual([
      ["paused", "ceiling"],
      ["paused", "ceiling"],
    ]);
    expect(sentence()).toBe("Daily upload limit reached — resumes after midnight UTC");
    const inits = server.inits.length;
    await settle(3_599_000);
    expect(server.inits.length).toBe(inits);
    over = false;
    await settle(1_000);
    expect(server.completes.length).toBe(2);
  });

  it("413 quota_exceeded stops the item with the server's sentence — the owner's, for an editor", async () => {
    server.onInit = () => json(errorBody("quota_exceeded", "The owner's storage is full."), 413);
    renderUploader();
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await settled();
    expect(items()[0]).toMatchObject({ state: "error", message: "The owner's storage is full." });
    expect(screen.getByText("The owner's storage is full.")).toBeTruthy();
    expect(server.inits.length).toBe(1);
  });

  it("413 file_too_large offers no new try", async () => {
    server.onInit = () => envelope("file_too_large", 413);
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(items()[0]).toMatchObject({ state: "error", canRetry: false, message: "file_too_large message" });
  });

  it("503 feature_disabled pauses the queue: uploads are paused right now", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onInit = () => envelope("feature_disabled", 503, { reason: "uploads_disabled" });
    await addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null);
    await settle(0);
    expect(items().map((item) => item.pauseReason)).toEqual(["disabled", "disabled"]);
    expect(sentence()).toBe("Uploads are paused right now.");
    // Not retried on a timer: one init per file that got as far as asking.
    const inits = server.inits.length;
    await settle(120_000);
    expect(server.inits.length).toBe(inits);
  });

  it("a session that is gone (404 at a part) is forgotten: the new try starts from init", async () => {
    server.partBytes = 100;
    server.onPut = (_call, nth) => (nth === 1 ? apiError(404, "not_found") : undefined);
    await addFiles([{ file: bigFile("video.mp4", 100) }], null);
    await settle();
    expect(items()[0]).toMatchObject({ state: "error", uploadId: null, message: "not_found message" });
    expect(await readResumeRows()).toEqual([]);
  });
});
