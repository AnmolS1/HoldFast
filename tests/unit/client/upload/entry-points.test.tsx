import "fake-indexeddb/auto";
// Whose files are these? The mark is taken when the user ACTS — the drop, the picker's change,
// the paste, requestUpload — before anything asynchronous. Whatever arrives later under another
// account is discarded whole: nothing queued, shown, announced or sent.
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { requestUpload, UploadDropOverlay } from "../../../../src/client/features/upload";
import { fromDrop } from "../../../../src/client/features/upload/intake";
import {
  actionMark,
  addFiles,
  forgetUploadsForTests,
  sameActor,
} from "../../../../src/client/features/upload/manager";
import { readResumeRows } from "../../../../src/client/features/upload/resume-list";
import { getUploads } from "../../../../src/client/features/upload/store";
import { UploadPanel } from "../../../../src/client/features/upload/UploadPanel";
import { adoptIdentity, purgeUserState, queryClient } from "../../../../src/client/lib/query";
import { renderShell, seedConfig, seedSession, sessionOf, setupShell } from "../shell/helpers";
import { OTHER_USER_ID, usageDto } from "./fixtures";
import {
  authSessionStoreMounted,
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
const said = () => getUploads().announcements.map((entry) => entry.text);
const requests = () => server.calls.map((call) => `${call.method} ${call.path}`);

/** A dropped folder whose one file the disk hands over only when `release()` is called. */
function slowDrop(name: string) {
  let release!: () => void;
  const reads: string[] = [];
  const file = (path: string, held: boolean) => ({
    isFile: true,
    isDirectory: false,
    fullPath: path,
    file: (done: (file: File) => void) => {
      reads.push(path);
      if (held) release = () => done(smallFile(path.split("/").pop()!));
      else done(smallFile(path.split("/").pop()!));
    },
  });
  const children = [file(`/trip/${name}`, true), file("/trip/second.pdf", false)];
  const folder = {
    isFile: false,
    isDirectory: true,
    fullPath: "/trip",
    createReader: () => {
      let handed = false;
      return {
        readEntries: (done: (batch: unknown[]) => void) => {
          done(handed ? [] : children);
          handed = true;
        },
      };
    },
  };
  const transfer = {
    types: ["Files"],
    files: [],
    items: [{ kind: "file", webkitGetAsEntry: () => folder, getAsFile: () => null }],
  };
  return { transfer: transfer as unknown as DataTransfer, release: () => release(), reads };
}

function drop(transfer: DataTransfer): void {
  const event = new Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  act(() => {
    window.dispatchEvent(event);
  });
}

describe("a drop that is still being walked when the account changes", () => {
  it("sign-out during the walk: nothing is queued, announced or sent — and the next account sees nothing of it", async () => {
    renderShell(
      <>
        <UploadDropOverlay />
        <UploadPanel />
      </>,
    );
    const slow = slowDrop("payslip-of-A.pdf");
    drop(slow.transfer);
    await act(() => settle());
    expect(slow.reads).toEqual(["/trip/payslip-of-A.pdf"]);

    // A signs out while the disk is still reading.
    await act(() => purgeUserState());
    const before = requests().length;
    await act(async () => slow.release());
    await act(() => settle());

    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
    expect(getToasts()).toEqual([]);
    expect(requests().slice(before)).toEqual([]);
    // The walk stopped too: the second file was never read off the disk.
    expect(slow.reads).toEqual(["/trip/payslip-of-A.pdf"]);

    // B signs in, in the same tab.
    await act(async () => {
      seedSession(sessionOf({ id: OTHER_USER_ID }));
      seedConfig();
    });
    await act(() => settle());
    expect(items()).toEqual([]);
    expect(document.querySelectorAll("[data-upload-row]").length).toBe(0);
    expect(document.querySelector("[data-upload-live]")!.textContent).toBe("");
    expect(server.inits).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("another account takes the session over during the walk (no sign-out): A's file is not uploaded into B's account", async () => {
    // The client knows whose state it holds: the first account's.
    await adoptIdentity(sessionOf());
    renderShell(<UploadDropOverlay />);
    const slow = slowDrop("payslip-of-A.pdf");
    drop(slow.transfer);
    await act(() => settle());

    // The session read now names someone else: the shell purges and keeps the new session.
    let changed = false;
    await act(async () => {
      const next = sessionOf({ id: OTHER_USER_ID });
      seedSession(next);
      changed = await adoptIdentity(next);
    });
    expect(changed).toBe(true);
    const before = requests().length;
    await act(async () => slow.release());
    await act(() => settle());

    expect(requests().slice(before)).toEqual([]);
    expect(server.inits).toEqual([]);
    expect(server.completes).toEqual([]);
    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
  });

  it("the same drop with no account change uploads both files (the control of the two above)", async () => {
    renderShell(<UploadDropOverlay />);
    const slow = slowDrop("payslip-of-A.pdf");
    drop(slow.transfer);
    await act(() => settle());
    await act(async () => slow.release());
    await act(() => settle());
    expect(server.inits.map((body) => body.name).sort()).toEqual(["payslip-of-A.pdf", "second.pdf"]);
  });
});

describe("the mark of the user's action", () => {
  it("files handed over under a mark that is stale are discarded whole", async () => {
    const then = actionMark();
    await purgeUserState();
    seedSession(sessionOf({ id: OTHER_USER_ID }));
    seedConfig();
    expect(sameActor(then)).toBe(false);
    await addFiles([{ file: smallFile("a.txt") }], null, ["empty"], { unreadable: ["b.txt"] }, then);
    await settle();
    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
    expect(getToasts()).toEqual([]);
    expect(server.calls).toEqual([]);
  });

  it("the walk reads nothing more once its mark is stale", async () => {
    const slow = slowDrop("a.pdf");
    let wanted = true;
    const walking = fromDrop(slow.transfer, () => wanted);
    await settle();
    wanted = false;
    slow.release();
    const intake = await walking;
    expect(slow.reads).toEqual(["/trip/a.pdf"]);
    expect(intake.files.map((entry) => entry.file.name)).toEqual(["a.pdf"]);
  });

  it("the feature's own epoch alone makes a mark stale (the page forgot its queue, the account did not change)", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.path === "/api/account/usage" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined;
    const adding = addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    forgetUploadsForTests();
    answer(json(usageDto()));
    await adding;
    await settle();
    expect(items()).toEqual([]);
    expect(server.inits).toEqual([]);
  });

  it("the shell's account epoch alone makes a mark stale: late work in the moment between the shell's purge starting and this feature's purger running sends nothing", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.path === "/api/account/usage" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined;
    const adding = addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    // The shell has moved its epoch on and is still cancelling its queries: this feature's own
    // purger has not run yet. Held open here for as long as the test needs.
    let finish!: () => void;
    const cancelling = vi
      .spyOn(queryClient, "cancelQueries")
      .mockImplementation(() => new Promise<void>((resolve) => (finish = resolve)));
    const purging = purgeUserState();
    answer(json(usageDto()));
    await adding;
    await settle();
    expect(server.inits).toEqual([]);
    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
    cancelling.mockRestore();
    finish();
    await purging;
    await settle();
    expect(server.inits).toEqual([]);
    expect(items()).toEqual([]);
  });

  it("requestUpload, the picker and a paste take their mark in the call itself", async () => {
    // Each is synchronous up to addFiles; the free-space read is the first wait. An account
    // change during it discards the files (the mark was the first account's).
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.path === "/api/account/usage" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined;
    renderShell(<UploadDropOverlay />);
    requestUpload({ files: [smallFile("from-another-feature.txt")] });
    const input = document.querySelector<HTMLInputElement>('input[data-upload-input="files"]')!;
    Object.defineProperty(input, "files", { value: [smallFile("picked.txt")], configurable: true });
    act(() => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [smallFile("pasted.png")] } });
    act(() => {
      document.body.dispatchEvent(paste);
    });
    await act(() => settle());
    await act(() => purgeUserState());
    seedSession(sessionOf({ id: OTHER_USER_ID }));
    seedConfig();
    await act(async () => answer(json(usageDto())));
    await act(() => settle());
    expect(items()).toEqual([]);
    expect(server.inits).toEqual([]);
    expect(said()).toEqual([]);
  });
});

// A purge used to mount the auth library's own session store (the shell's purger read it with
// `get()`), and the store unmounted itself a second later from a timer that touches `document`:
// after the file's last test that ran once jsdom was gone and failed the whole run. The purger
// reads `.value` now and mounts nothing; the shared clean-up stays as a net.
describe("nothing a test started outlives it", () => {
  it("a purge does not mount the auth library's session store", async () => {
    await purgeUserState();
    expect(authSessionStoreMounted()).toBe(false);
  });
});
