import "fake-indexeddb/auto";
// Nothing of one account reaches the next through late work: every step that outlives its
// request does nothing once the account's state has been purged — no row, no announcement, no
// toast, no request — and nothing the feature keeps at module level survives the purge.
import { act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import { addFiles, resolveConflict } from "../../../../src/client/features/upload/manager";
import { openPicker, takePickerTarget } from "../../../../src/client/features/upload/picker";
import { readResumeRows } from "../../../../src/client/features/upload/resume-list";
import { getUploads } from "../../../../src/client/features/upload/store";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { purgeUserState } from "../../../../src/client/lib/query";
import { renderShell, seedConfig, seedSession, sessionOf, setupShell } from "../shell/helpers";
import { EXISTING_ID, FOLDER_ID, nodeDetail, nodeDto, OTHER_USER_ID, rowId, usageDto } from "./fixtures";
import {
  envelope,
  FAKED_TIMERS,
  freshUploader,
  installServer,
  json,
  settle,
  smallFile,
  type Server,
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
const said = () => getUploads().announcements.map((entry) => entry.text);

/** Hold every request matching `path` until the returned function is called with its answer. */
function hold(path: RegExp, method = "GET"): (response: Response) => void {
  let answer!: (response: Response) => void;
  const previous = server.onJson;
  server.onJson = (call) =>
    call.method === method && path.test(call.path)
      ? new Promise<Response>((resolve) => (answer = resolve))
      : previous?.(call);
  return (response) => answer(response);
}

/** The first account signs out and the second signs in, in the same tab, without a reload. */
async function switchAccount(): Promise<void> {
  await purgeUserState();
  seedSession(sessionOf({ id: OTHER_USER_ID }));
  seedConfig();
}

describe("late work after the account changed", () => {
  it("free space read for the first account: the files are not queued for the second", async () => {
    const answer = hold(/^\/api\/account\/usage$/);
    const adding = addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    await switchAccount();
    answer(json(usageDto()));
    await adding;
    await settle();
    expect(items()).toEqual([]);
    expect(server.inits).toEqual([]);
    expect(said()).toEqual([]);
    expect(getToasts()).toEqual([]);
  });

  it("free space that would have refused the first account's upload: no sentence for the second", async () => {
    const answer = hold(/^\/api\/account\/usage$/);
    const adding = addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    await switchAccount();
    answer(json(usageDto({ usedBytes: 5_000_000_000, filesBytes: 5_000_000_000 })));
    await adding;
    await settle();
    expect(said()).toEqual([]);
    expect(getToasts()).toEqual([]);
  });

  it("a scan answer for the first account's file: no verdict, no announcement, no change signal", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    const answer = hold(SCAN_ASK, "POST");
    await settle(1_100);
    expect(server.count("POST", SCAN_ASK)).toBe(1);
    await switchAccount();
    const changed: unknown[] = [];
    const stop = onNodesChanged((detail) => changed.push(detail));
    answer(json({ items: [nodeDto({ id: rowId(0x2001), name: "a.txt", scanStatus: "infected" })] }));
    await settle();
    stop();
    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
    expect(changed).toEqual([]);
    expect(getRibbonSnapshot().current).toBeNull();
    // And the loop is the next account's from a clean start: nothing is asked for the old file.
    const asked = server.calls.length;
    await settle(60_000);
    expect(server.calls.length).toBe(asked);
  });

  it("a folder made for the first account's upload: no file follows, nothing is announced", async () => {
    const answer = hold(/^\/api\/nodes\/folder$/, "POST");
    await addFiles([{ file: smallFile("a.jpg"), path: "trip" }], null);
    await settle();
    await switchAccount();
    const changed: unknown[] = [];
    const stop = onNodesChanged((detail) => changed.push(detail));
    answer(json(nodeDto({ id: rowId(0x7001), kind: "folder", name: "trip" })));
    await settle();
    stop();
    expect(server.inits).toEqual([]);
    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
    expect(changed).toEqual([]);
  });

  it("an upload that fails after the purge: no error row, no announcement, nothing on the device", async () => {
    server.hold = true;
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    const flying = server.held[0]!;
    await switchAccount();
    flying.reject(new Error("late"));
    await settle();
    expect(items()).toEqual([]);
    expect(said()).toEqual([]);
    expect(await readResumeRows()).toEqual([]);
  });

  it("a rate-limit pause of the first account does not wake up in the second account's queue", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onInit = () => envelope("rate_limited", 429, undefined, { "retry-after": "1" });
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    await switchAccount();
    server.onInit = undefined;
    server.hold = true;
    await addFiles([{ file: smallFile("b.txt") }], null);
    await settle();
    const before = server.calls.length;
    await settle(60_000);
    expect(server.calls.length).toBe(before);
    expect(items().map((item) => item.name)).toEqual(["b.txt"]);
  });
});

describe("what the feature keeps at module level", () => {
  const drag = (type: string) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["Files"], files: [], items: [] } });
    act(() => {
      window.dispatchEvent(event);
    });
  };
  const sentence = () => document.querySelector("[data-upload-drop]")?.textContent;

  it("the folder's name in the drop sentence is asked each time and kept nowhere: the next account never reads it", async () => {
    window.history.replaceState({}, "", `/folder/${FOLDER_ID}`);
    renderShell(<UploadDropOverlay />);
    drag("dragenter");
    await act(() => settle());
    expect(sentence()).toBe("Drop to upload to Projects");
    drag("dragleave");

    await act(() => switchAccount());
    // The second account has no access to that folder.
    server.onJson = (call) =>
      call.path === `/api/nodes/${FOLDER_ID}` ? envelope("not_found", 404) : undefined;
    drag("dragenter");
    await act(() => settle());
    expect(sentence()).toBe("Drop to upload to this folder");
  });

  it("a name that arrives after the account changed is not shown", async () => {
    window.history.replaceState({}, "", `/folder/${FOLDER_ID}`);
    renderShell(<UploadDropOverlay />);
    const answer = hold(new RegExp(`^/api/nodes/${FOLDER_ID}$`));
    drag("dragenter");
    await act(() => settle());
    await act(() => switchAccount());
    await act(async () => {
      answer(json(nodeDetail({ id: FOLDER_ID, kind: "folder", name: "Taxes 2026" })));
    });
    await act(() => settle());
    expect(sentence()).toBe("Drop to upload to this folder");
  });

  it("the folder a picker was opened for is forgotten with the account", async () => {
    openPicker("files", FOLDER_ID);
    await switchAccount();
    expect(takePickerTarget()).toBeNull();
  });
});

describe("a choice made for every other file", () => {
  it("Replace for every other file does not replace a file the server names no id for: that one is asked", async () => {
    server.onInit = (body) => {
      if (body.onConflict !== "fail") return undefined;
      return body.name === "nameless.txt"
        ? envelope("conflict", 409)
        : envelope("conflict", 409, { existingId: EXISTING_ID });
    };
    server.hold = true;
    await addFiles(
      [
        { file: smallFile("a.txt") },
        { file: smallFile("b.txt") },
        { file: smallFile("c.txt") },
        { file: smallFile("nameless.txt") },
      ],
      null,
    );
    await settle();
    // Three have asked; the fourth has not started yet.
    resolveConflict(items()[0]!.id, "replace", true);
    await settle();
    for (const call of [...server.held]) call.resolve();
    await settle();
    await settle();
    const nameless = items().find((item) => item.name === "nameless.txt")!;
    expect(nameless.state).toBe("conflict");
    expect(
      server.inits.filter((body) => body.name === "nameless.txt").map((body) => body.onConflict),
    ).toEqual(["fail"]);
  });

  it("belongs to the upload it was ticked for: a later drop is asked again", async () => {
    server.onInit = (body) =>
      body.onConflict === "fail" ? envelope("conflict", 409, { existingId: EXISTING_ID }) : undefined;
    server.hold = true;
    await addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null);
    await settle();
    resolveConflict(items()[0]!.id, "replace", true);
    await settle();
    // The first upload is still running when another one is dropped into another folder.
    expect(items().some((item) => item.state === "uploading")).toBe(true);
    await addFiles([{ file: smallFile("later.txt") }], FOLDER_ID);
    await settle();
    const later = items().find((item) => item.name === "later.txt")!;
    expect(later.state).toBe("conflict");
    expect(server.inits.filter((body) => body.name === "later.txt").map((body) => body.onConflict)).toEqual([
      "fail",
    ]);
  });
});
