import "fake-indexeddb/auto";
// The resume list (kept through idb-keyval; a stand-in database here) and the purger that empties
// it with the queue. Between tests the store is emptied by that purger, not swapped.
import { act, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import {
  addFiles,
  cancelItem,
  forgetUploadsForTests,
  purgeUploads,
  removeItem,
  restoreUploads,
} from "../../../../src/client/features/upload/manager";
import {
  readResumeRows,
  saveResumeRow,
  type ResumeRow,
} from "../../../../src/client/features/upload/resume-list";
import { getUploads } from "../../../../src/client/features/upload/store";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { purgeUserState } from "../../../../src/client/lib/query";
import { renderShell, seedSession, sessionOf, setupShell } from "../shell/helpers";
import {
  AT,
  EXPIRES,
  FOLDER_ID,
  initResponse,
  openUploadsResponse,
  OTHER_USER_ID,
  rowId,
  uploadSession,
  USER_ID,
} from "./fixtures";
import { bigFile, freshUploader, installServer, json, settle, smallFile, type Server } from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  // The purger under test is what empties the list between tests.
  await freshUploader();
  server = installServer();
});

const items = () => getUploads().items;
const MODIFIED = 1_760_000_000_123;
const video = (lastModified = MODIFIED) => bigFile("video.mp4", 400, lastModified);

/** An upload of four parts with the first two at the server, then the page is reloaded. */
async function reloadMidUpload(): Promise<ResumeRow> {
  server.hold = true;
  server.partBytes = 100;
  await addFiles([{ file: video() }], FOLDER_ID);
  await settle();
  server.held.find((call) => call.n === 1)!.resolve();
  server.held.find((call) => call.n === 2)!.resolve();
  await settle();
  const [row] = await readResumeRows();
  forgetUploadsForTests();
  await settle();
  server.hold = false;
  return row!;
}

describe("the resume list", () => {
  it("keeps what init was sent, for the account that sent it — and no file", async () => {
    server.hold = true;
    server.partBytes = 100;
    await addFiles([{ file: video() }], FOLDER_ID);
    await settle();
    const rows = await readResumeRows();
    expect(rows).toEqual([
      {
        id: items()[0]!.id,
        userId: USER_ID,
        uploadId: items()[0]!.uploadId,
        body: server.inits[0],
        path: "",
        finalName: "video.mp4",
        expiresAt: EXPIRES,
      },
    ]);
    expect(rows[0]!.body.fileLastModified).toBe(new Date(MODIFIED).toISOString());
  });

  it("a finished upload leaves the list", async () => {
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(server.completes.length).toBe(1);
    expect(await readResumeRows()).toEqual([]);
  });

  it("a cancelled upload leaves the list and its session is aborted", async () => {
    server.hold = true;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    const { id, uploadId } = items()[0]!;
    expect((await readResumeRows()).length).toBe(1);
    cancelItem(id);
    await settle();
    expect(await readResumeRows()).toEqual([]);
    expect(server.count("DELETE", new RegExp(`^/api/uploads/${uploadId}$`))).toBe(1);
  });
});

describe("after a reload", () => {
  it("the row asks for its file again, and restoring it sends nothing", async () => {
    await reloadMidUpload();
    expect(items()).toEqual([]);
    const requests = server.calls.length;
    renderShell(<UploadPanel />);
    await act(() => restoreUploads());
    expect(server.calls.length).toBe(requests);
    expect(items().length).toBe(1);
    expect(items()[0]).toMatchObject({ state: "paused", file: null, name: "video.mp4", parentId: FOLDER_ID });
    expect(screen.getByText("Select video.mp4 again to resume")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Select video.mp4 again" })).toBeTruthy();
    expect(getRibbonSnapshot().current).toMatchObject({
      sentence: "1 upload to resume — select the file again",
      status: "paused",
    });
    // Asking twice shows it once.
    await act(() => restoreUploads());
    expect(items().length).toBe(1);
  });

  it("selecting the file again sends the same init, and no PUT for the parts the server has", async () => {
    const row = await reloadMidUpload();
    await restoreUploads();
    const inits = server.inits.length;
    const puts = server.puts.length;
    server.onInit = (body) =>
      json(
        initResponse(body.size, {
          uploadId: row.uploadId,
          partBytes: 100,
          finalName: body.name,
          resumedParts: [
            { n: 1, etag: "etag-1" },
            { n: 2, etag: "etag-2" },
          ],
        }),
      );
    // Selected on a page of another folder: the row's own folder is the one that counts.
    await addFiles([{ file: video() }], null);
    await settle();

    expect(server.inits.length).toBe(inits + 1);
    expect(server.inits[inits]).toEqual(row.body);
    expect(server.inits[inits]!.parentId).toBe(FOLDER_ID);
    expect(
      server.puts
        .slice(puts)
        .map((call) => call.n)
        .sort(),
    ).toEqual([3, 4]);
    expect(server.completes[0]!.parts.map((part) => part.n)).toEqual([1, 2, 3, 4]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("a file one millisecond off is a new upload; the row keeps waiting", async () => {
    await reloadMidUpload();
    await restoreUploads();
    const inits = server.inits.length;
    server.hold = true;
    await addFiles([{ file: video(MODIFIED + 1) }], null);
    await settle();
    expect(server.inits.length).toBe(inits + 1);
    expect(server.inits[inits]).toMatchObject({
      parentId: null,
      fileLastModified: new Date(MODIFIED + 1).toISOString(),
    });
    expect(items().map((item) => [item.file === null, item.state])).toEqual([
      [true, "paused"],
      [false, "uploading"],
    ]);
  });

  it("removing the row aborts its session and takes it off the list", async () => {
    const row = await reloadMidUpload();
    await restoreUploads();
    removeItem(items()[0]!.id);
    await settle();
    expect(items()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
    expect(server.count("DELETE", new RegExp(`^/api/uploads/${row.uploadId}$`))).toBe(1);
  });

  it("with the open sessions: a row whose session is gone goes, and an open session without a row is added", async () => {
    const row = await reloadMidUpload();
    const elsewhere = uploadSession({
      uploadId: rowId(0xc1),
      name: "elsewhere.zip",
      size: 5000,
      parentId: FOLDER_ID,
      fileLastModified: AT,
    });
    const dateless = uploadSession({ uploadId: rowId(0xc2), name: "dateless.bin", fileLastModified: null });
    // The row's own session is not among them: it expired.
    server.onJson = (call) =>
      call.path === "/api/uploads/open" ? json(openUploadsResponse([elsewhere, dateless])) : undefined;
    await restoreUploads({ server: true });

    // A session without the file's date can never be matched, so it is not offered.
    expect(items().map((item) => [item.name, item.uploadId])).toEqual([["elsewhere.zip", rowId(0xc1)]]);
    expect((await readResumeRows()).map((kept) => kept.uploadId)).toEqual([rowId(0xc1)]);
    expect(row.uploadId).not.toBe(rowId(0xc1));

    // The file of that session, selected again: init names the session's folder, size and date.
    const inits = server.inits.length;
    await addFiles([{ file: bigFile("elsewhere.zip", 5000, Date.parse(AT)) }], null);
    await settle();
    expect(server.inits[inits]).toMatchObject({
      parentId: FOLDER_ID,
      name: "elsewhere.zip",
      size: 5000,
      fileLastModified: AT,
      mimeDeclared: "application/octet-stream",
    });
  });

  it("the frame and the page asking at the same moment show the row once", async () => {
    const row = await reloadMidUpload();
    const still = uploadSession({
      uploadId: row.uploadId,
      name: row.body.name,
      size: row.body.size,
      parentId: row.body.parentId,
      fileLastModified: row.body.fileLastModified,
    });
    server.onJson = (call) =>
      call.path === "/api/uploads/open" ? json(openUploadsResponse([still])) : undefined;
    // As on /uploads after a reload: the host restores from the device, the page also asks the
    // server — and in development every effect runs twice.
    await Promise.all([
      restoreUploads(),
      restoreUploads({ server: true }),
      restoreUploads(),
      restoreUploads({ server: true }),
    ]);
    expect(items().map((item) => item.uploadId)).toEqual([row.uploadId]);
    expect((await readResumeRows()).length).toBe(1);
    expect(server.count("GET", /^\/api\/uploads\/open$/)).toBe(1);
  });

  it("a row of another account is never shown, and is deleted", async () => {
    const mine = await reloadMidUpload();
    await saveResumeRow({ ...mine, id: "theirs", userId: OTHER_USER_ID, uploadId: rowId(0xd1) });
    expect((await readResumeRows()).length).toBe(2);
    await restoreUploads();
    expect(items().map((item) => item.id)).toEqual([mine.id]);
    expect((await readResumeRows()).map((row) => row.userId)).toEqual([USER_ID]);
  });

  it("signed out, nothing is restored", async () => {
    await reloadMidUpload();
    seedSession(null);
    await restoreUploads();
    expect(items()).toEqual([]);
  });
});

describe("the purger", () => {
  it("empties the queue and the resume list, and stops what was in flight", async () => {
    server.hold = true;
    server.partBytes = 100;
    await addFiles([{ file: video() }, { file: smallFile("b.txt") }], null);
    await settle();
    expect(items().length).toBe(2);
    expect((await readResumeRows()).length).toBe(2);
    const flying = [...server.held];
    expect(flying.length).toBe(4);

    await purgeUploads();
    expect(items()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
    expect(flying.every((call) => call.signal?.aborted)).toBe(true);
    expect(getRibbonSnapshot().current).toBeNull();
    expect(getRibbonSnapshot().panels).toEqual([]);

    const puts = server.puts.length;
    const calls = server.calls.length;
    server.hold = false;
    await settle();
    expect(server.puts.length).toBe(puts);
    expect(server.calls.length).toBe(calls);
  });

  it("is registered with the shell: signing out leaves nothing behind", async () => {
    server.hold = true;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect((await readResumeRows()).length).toBe(1);
    await purgeUserState();
    expect(items()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("an init answered after the purge changes nothing: no row, no upload, for the next account", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/uploads"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : undefined;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(items()[0]!.state).toBe("uploading");

    await purgeUploads();
    seedSession(sessionOf({ id: OTHER_USER_ID }));
    answer(json(initResponse(10, { uploadId: rowId(0xe1), finalName: "a.txt" })));
    await settle();
    expect(items()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
    expect(server.puts.length).toBe(0);
    expect(server.completes.length).toBe(0);
  });
});
