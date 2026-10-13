import "fake-indexeddb/auto";
// Smaller rules of the queue: one upload per file, ids out of the address, the life of a row on
// the device, what offers a new try, and how many rows are drawn.
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import {
  addFiles,
  cancelItem,
  removeItem,
  restoreUploads,
} from "../../../../src/client/features/upload/manager";
import { targetFromLocation } from "../../../../src/client/features/upload/picker";
import { PANEL_ROWS } from "../../../../src/client/features/upload/plan";
import { getNode } from "../../../../src/client/features/upload/protocol";
import { readResumeRows, saveResumeRow } from "../../../../src/client/features/upload/resume-list";
import { getUploads } from "../../../../src/client/features/upload/store";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { purgeUserState } from "../../../../src/client/lib/query";
import { renderShell, seedConfig, seedSession, sessionOf, setupShell } from "../shell/helpers";
import {
  AT,
  FOLDER_ID,
  initResponse,
  openUploadsResponse,
  OTHER_USER_ID,
  rowId,
  uploadSession,
  USER_ID,
} from "./fixtures";
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
  window.history.replaceState({}, "", "/");
});

const items = () => getUploads().items;

describe("the same file twice", () => {
  it("for the same place is one upload: one item, one session", async () => {
    server.hold = true;
    const file = smallFile("a.txt", 10, 1_760_000_000_000);
    await addFiles([{ file }, { file }], null);
    await settle();
    await addFiles([{ file: smallFile("a.txt", 10, 1_760_000_000_000) }], null);
    await settle();
    expect(items().length).toBe(1);
    expect(server.inits.length).toBe(1);
    // Another folder, another date or a finished upload is another upload.
    await addFiles([{ file }], FOLDER_ID);
    await addFiles([{ file: smallFile("a.txt", 10, 1_760_000_000_001) }], null);
    await settle();
    expect(items().length).toBe(3);
  });

  it("after the first has finished, the file can be uploaded again", async () => {
    const file = smallFile("a.txt");
    await addFiles([{ file }], null);
    await settle();
    await addFiles([{ file }], null);
    await settle();
    expect(server.inits.length).toBe(2);
  });

  it("the same file in two folders of one folder upload is two uploads", async () => {
    const file = smallFile("a.txt");
    await addFiles(
      [
        { file, path: "one" },
        { file, path: "two" },
        { file, path: "one" },
      ],
      null,
    );
    await settle();
    expect(server.inits.length).toBe(2);
  });
});

describe("a folder id out of the address", () => {
  const at = (path: string) => {
    window.history.replaceState({}, "", path);
    return targetFromLocation();
  };

  it("only a well-formed id is one: anything else is the top level, and nothing throws", () => {
    expect(at(`/folder/${FOLDER_ID}`)).toBe(FOLDER_ID);
    expect(at(`/uploads?parent=${FOLDER_ID}`)).toBe(FOLDER_ID);
    // A broken escape, a path, a query: none of them reaches a request.
    expect(at("/folder/%E0%A4")).toBeNull();
    expect(at("/folder/abc")).toBeNull();
    expect(at("/uploads?parent=..%2Fauth%2Fsign-out%3Fk%3Dv")).toBeNull();
    expect(at("/uploads?parent=%E0%A4")).toBeNull();
    expect(at(`/folder/${FOLDER_ID}%2F..%2F..%2Fauth`)).toBeNull();
  });

  it("the node request refuses anything that is not an id, without asking the server", async () => {
    const error = await getNode("../auth/sign-out?k=v").then(
      () => null,
      (cause: unknown) => cause,
    );
    expect(error).toMatchObject({ status: 404, code: "not_found" });
    expect(server.calls).toEqual([]);
  });

  it("requestUpload on a page with a broken address does not throw", async () => {
    window.history.replaceState({}, "", "/folder/%E0%A4");
    const { requestUpload } = await import("../../../../src/client/features/upload");
    expect(() => requestUpload({ files: [smallFile("a.txt")] })).not.toThrow();
    await settle();
    expect(server.inits.map((body) => body.parentId)).toEqual([null]);
  });
});

describe("a row on the device has an end", () => {
  const row = (patch: Record<string, unknown> = {}) => ({
    id: "row-1",
    userId: USER_ID,
    uploadId: rowId(0xb1),
    body: {
      parentId: null,
      name: "video.mp4",
      size: 400,
      mimeDeclared: "video/mp4",
      fileLastModified: AT,
      onConflict: "fail" as const,
      purpose: "file" as const,
    },
    path: "",
    finalName: "video.mp4",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    ...patch,
  });

  it("carries its session's expiry, taken from init", async () => {
    server.hold = true;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect((await readResumeRows())[0]!.expiresAt).toBe("2026-10-14T09:00:00.000Z");
  });

  it("past its expiry it is deleted at load, on any page — never offered", async () => {
    await saveResumeRow(row({ expiresAt: new Date(Date.now() - 1_000).toISOString() }));
    await saveResumeRow(row({ id: "row-2", uploadId: rowId(0xb2) }));
    const before = server.calls.length;
    await restoreUploads();
    expect(items().map((item) => item.id)).toEqual(["row-2"]);
    expect((await readResumeRows()).map((kept) => kept.id)).toEqual(["row-2"]);
    expect(server.calls.length).toBe(before);
  });

  it("a row that ran out while the page was open is dropped when its file comes back: a new upload starts", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    await saveResumeRow(row({ expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    await restoreUploads();
    expect(items().length).toBe(1);
    await settle(61_000);
    server.hold = true;
    await addFiles([{ file: bigFile("video.mp4", 400, Date.parse(AT)) }], FOLDER_ID);
    await settle(0);
    // Not the row's folder and not the row's body: the row is gone.
    expect(items().map((item) => [item.id === "row-1", item.parentId])).toEqual([[false, FOLDER_ID]]);
    expect(server.inits.at(-1)!.parentId).toBe(FOLDER_ID);
    expect((await readResumeRows()).map((kept) => kept.id)).not.toContain("row-1");
  });

  it("a row written before rows had an expiry is not readable any more, and is deleted", async () => {
    const old = row();
    delete (old as Record<string, unknown>).expiresAt;
    await saveResumeRow(old as never);
    expect(await readResumeRows()).toEqual([]);
  });

  it("an open session that has already expired is not offered either", async () => {
    server.onJson = (call) =>
      call.path === "/api/uploads/open"
        ? json(
            openUploadsResponse([uploadSession({ expiresAt: new Date(Date.now() - 1_000).toISOString() })]),
          )
        : undefined;
    await restoreUploads({ server: true });
    expect(items()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("an open session is listed under the name that was asked for: the file selected again is that one row, not a second", async () => {
    // "Keep both" stored it as "report (1).pdf"; the session's name is still what init asked for.
    const session = uploadSession({ uploadId: rowId(0xc7), name: "report.pdf", size: 400 });
    server.onJson = (call) =>
      call.path === "/api/uploads/open" ? json(openUploadsResponse([session])) : undefined;
    await restoreUploads({ server: true });
    expect(items().map((item) => item.name)).toEqual(["report.pdf"]);

    server.hold = true;
    server.partBytes = 100;
    server.onInit = (body) =>
      json(initResponse(body.size, { uploadId: rowId(0xc7), partBytes: 100, finalName: "report (1).pdf" }));
    await addFiles([{ file: bigFile("report.pdf", 400, Date.parse(AT)) }], null);
    await settle();
    expect(items().map((item) => [item.name, item.file !== null, item.uploadId])).toEqual([
      ["report.pdf", true, rowId(0xc7)],
    ]);
    expect((await readResumeRows()).map((kept) => kept.uploadId)).toEqual([rowId(0xc7)]);
  });

  it("a row waiting for its file is titled with the name the user has on disk, not the stored one", async () => {
    await saveResumeRow(row({ finalName: "video (1).mp4" }));
    renderShell(<UploadPanel />);
    await act(() => restoreUploads());
    expect(screen.getByText("Select video.mp4 again to resume")).toBeTruthy();
    expect(document.querySelector("[data-upload-row]")!.getAttribute("data-upload-name")).toBe("video.mp4");
  });

  it("after an account change without a reload, the next account's own rows are restored by the host", async () => {
    server.hold = true;
    renderShell(<UploadDropOverlay />);
    await act(() => settle());
    await act(() => purgeUserState());
    // The second account has a row of its own on this device.
    await saveResumeRow(row({ userId: OTHER_USER_ID }));
    await act(async () => {
      seedSession(sessionOf({ id: OTHER_USER_ID }));
      seedConfig();
    });
    await act(() => settle());
    expect(items().map((item) => item.id)).toEqual(["row-1"]);
  });
});

describe("cancel while init is on its way", () => {
  it("the session the server opened meanwhile is closed as soon as its id is known", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/uploads"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : undefined;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    cancelItem(items()[0]!.id);
    await settle();
    expect(server.count("DELETE", /^\/api\/uploads\//)).toBe(0);
    answer(json(initResponse(10, { uploadId: rowId(0xd4), finalName: "a.txt" })));
    await settle();
    expect(server.count("DELETE", new RegExp(`^/api/uploads/${rowId(0xd4)}$`))).toBe(1);
    expect(server.puts).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("and the same when the row was removed", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/uploads"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : undefined;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    const { id } = items()[0]!;
    cancelItem(id);
    removeItem(id);
    answer(json(initResponse(10, { uploadId: rowId(0xd5), finalName: "a.txt" })));
    await settle();
    expect(server.count("DELETE", new RegExp(`^/api/uploads/${rowId(0xd5)}$`))).toBe(1);
  });

  it("a pause during init and a quick resume do not ask for two sessions at once", async () => {
    let answer!: (response: Response) => void;
    let asked = 0;
    server.onJson = (call) => {
      if (call.method !== "POST" || call.path !== "/api/uploads") return undefined;
      asked += 1;
      return new Promise<Response>((resolve) => (answer = resolve));
    };
    const { pauseItem, resumeItem } = await import("../../../../src/client/features/upload/manager");
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    const { id } = items()[0]!;
    pauseItem(id);
    resumeItem(id);
    await settle();
    expect(asked).toBe(1);
    answer(json(initResponse(10, { uploadId: rowId(0xd6), finalName: "a.txt" })));
    await settle();
    expect(server.completes.length).toBe(1);
    expect(server.count("DELETE", /^\/api\/uploads\//)).toBe(0);
  });
});

describe("what offers a new try", () => {
  it.each([
    ["400 validation", () => envelope("validation", 400), false],
    ["403 forbidden (a folder the caller may not write to)", () => envelope("forbidden", 403), false],
    ["404 at init (the folder is gone)", () => envelope("not_found", 404), false],
    ["413 file_too_large", () => envelope("file_too_large", 413), false],
    ["413 quota_exceeded (room can be made)", () => envelope("quota_exceeded", 413), true],
  ])("%s", async (_name, answer, retry) => {
    server.onInit = answer;
    renderShell(<UploadPanel />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await act(() => settle());
    expect(items()[0]).toMatchObject({ state: "error", canRetry: retry });
    expect(screen.queryByRole("button", { name: "Try a.txt again" }) !== null).toBe(retry);
    expect(screen.getByRole("button", { name: "Remove a.txt from the list" })).toBeTruthy();
  });

  it("a browser that wrongly says offline can be overruled: the row offers Resume", async () => {
    const onLine = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    renderShell(<UploadPanel />);
    await act(() => addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null));
    await act(() => settle());
    expect(items().map((item) => item.pauseReason)).toEqual(["offline", "offline"]);
    onLine.mockReturnValue(true);
    await act(async () => screen.getByRole("button", { name: "Resume a.txt" }).click());
    await act(() => settle());
    // The whole queue goes on, not just that row.
    expect(server.completes.length).toBe(2);
  });
});

describe("thousands of files", () => {
  it("the panel draws the first rows and counts the rest", async () => {
    server.hold = true;
    renderShell(<UploadPanel />);
    await act(() =>
      addFiles(
        Array.from({ length: PANEL_ROWS + 300 }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
        null,
      ),
    );
    await act(() => settle());
    expect(items().length).toBe(PANEL_ROWS + 300);
    expect(document.querySelectorAll("[data-upload-row]").length).toBe(PANEL_ROWS);
    expect(document.querySelector("[data-upload-more]")!.textContent).toBe("and 300 more");
  });
});
