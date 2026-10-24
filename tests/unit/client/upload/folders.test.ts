// Folder upload: folders first, each once; a folder that is already there is used, a name that
// something else holds fails its subtree only — and the folder's children are never listed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { carriesFiles, fromDrop, fromFileList } from "../../../../src/client/features/upload/intake";
import { addFiles, cancelItem, pauseItem, retryItem } from "../../../../src/client/features/upload/manager";
import { MAX_DROP_FILES } from "../../../../src/client/features/upload/plan";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getUploads } from "../../../../src/client/features/upload/store";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { setupShell } from "../shell/helpers";
import { EXISTING_ID, FOLDER_ID, folderDto, rowId } from "./fixtures";
import {
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
const folderCalls = () =>
  server.calls
    .filter((call) => call.method === "POST" && call.path === "/api/nodes/folder")
    .map((call) => call.body as { parentId: string | null; name: string });
const childrenRequests = () => server.calls.filter((call) => /\/children/.test(call.path));

/** Answer folder creation by name; anything not named is created with an id of its own. */
function folders(byName: Record<string, () => Response>): void {
  let made = 0;
  server.onJson = (call) => {
    if (call.method !== "POST" || call.path !== "/api/nodes/folder") return undefined;
    const body = call.body as { parentId: string | null; name: string };
    const answer = byName[body.name];
    if (answer) return answer();
    made += 1;
    return json(folderDto({ id: rowId(0x7000 + made), name: body.name, parentId: body.parentId }));
  };
}

const tree = [
  { file: smallFile("top.txt"), path: "trip" },
  { file: smallFile("a.jpg"), path: "trip/day1" },
  { file: smallFile("b.jpg"), path: "trip/day1" },
  { file: smallFile("c.jpg"), path: "trip/day2" },
];

describe("folder upload", () => {
  it("creates each folder once, parents first, then puts every file in its own folder", async () => {
    folders({});
    const changed: Array<(string | null)[]> = [];
    const stop = onNodesChanged((detail) => changed.push(detail.parentIds));
    await addFiles(tree, FOLDER_ID, ["trip/empty"]);
    await settle();
    stop();

    const trip = rowId(0x7001);
    // Each folder once; "trip" before anything inside it; an empty folder is created too.
    expect(folderCalls()[0]).toEqual({ parentId: FOLDER_ID, name: "trip" });
    expect(
      folderCalls()
        .slice(1)
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { parentId: trip, name: "day1" },
      { parentId: trip, name: "day2" },
      { parentId: trip, name: "empty" },
    ]);
    const made = Object.fromEntries(
      server.calls
        .filter((call) => call.method === "POST" && call.path === "/api/nodes/folder")
        .map((call, index) => [(call.body as { name: string }).name, rowId(0x7001 + index)]),
    );
    const parents = Object.fromEntries(server.inits.map((body) => [body.name, body.parentId]));
    expect(parents).toEqual({
      "top.txt": trip,
      "a.jpg": made.day1,
      "b.jpg": made.day1,
      "c.jpg": made.day2,
    });
    expect(server.completes.length).toBe(4);
    // A new folder is a change of its parent's children.
    expect(changed).toContainEqual([FOLDER_ID]);
    expect(changed).toContainEqual([trip]);
    expect(childrenRequests()).toEqual([]);
  });

  it("409 with details.existingId: that folder is used, and nothing is listed", async () => {
    folders({ day1: () => envelope("conflict", 409, { existingId: EXISTING_ID }) });
    await addFiles(tree, null);
    await settle();
    const parents = Object.fromEntries(server.inits.map((body) => [body.name, body.parentId]));
    expect(parents["a.jpg"]).toBe(EXISTING_ID);
    expect(parents["b.jpg"]).toBe(EXISTING_ID);
    expect(server.completes.length).toBe(4);
    expect(items()).toEqual([]);
    expect(childrenRequests()).toEqual([]);
  });

  it("a folder inside the existing one is created under its id", async () => {
    folders({ trip: () => envelope("conflict", 409, { existingId: EXISTING_ID }) });
    await addFiles(tree, null);
    await settle();
    expect(folderCalls().slice(1)).toEqual([
      { parentId: EXISTING_ID, name: "day1" },
      { parentId: EXISTING_ID, name: "day2" },
    ]);
    expect(server.completes.length).toBe(4);
  });

  it("409 without it: that subtree fails with its sentence, the siblings still upload, nothing is listed", async () => {
    folders({ day1: () => envelope("conflict", 409) });
    await addFiles([...tree, { file: smallFile("deep.jpg"), path: "trip/day1/raw" }], null);
    await settle();

    // Nothing under the failed folder was sent, and no folder was created inside it.
    expect(server.inits.map((body) => body.name).sort()).toEqual(["c.jpg", "top.txt"]);
    expect(folderCalls().map((body) => body.name)).toEqual(["trip", "day1", "day2"]);
    expect(server.completes.length).toBe(2);
    const failed = items().filter((item) => item.state === "error");
    expect(failed.map((item) => item.name).sort()).toEqual(["a.jpg", "b.jpg", "deep.jpg"]);
    for (const item of failed) {
      expect(item.message).toBe(
        "Couldn't create the folder day1 — something else already has that name. Nothing in it was uploaded.",
      );
      // The answer will be the same next time: no new try is offered.
      expect(item.canRetry).toBe(false);
    }
    expect(childrenRequests()).toEqual([]);
  });

  it("existingId that is not a string is not an id: the subtree fails", async () => {
    folders({ day2: () => envelope("conflict", 409, { existingId: 42 }) });
    await addFiles(tree, null);
    await settle();
    expect(server.inits.map((body) => body.name).sort()).toEqual(["a.jpg", "b.jpg", "top.txt"]);
    expect(items().map((item) => [item.name, item.state])).toEqual([["c.jpg", "error"]]);
  });
});

describe("what a drop could not hand over", () => {
  it("is said at once, by name — and the rest uploads", async () => {
    await addFiles([{ file: smallFile("a.jpg"), path: "trip" }], null, ["trip"], {
      unreadable: ["trip/broken.jpg", "trip/raw/x.dng", "trip/raw/y.dng", "trip/raw/z.dng", "notes.txt"],
    });
    await settle();
    const sentence =
      "5 items could not be read and were left out: trip/broken.jpg, trip/raw/x.dng, trip/raw/y.dng and 2 more";
    expect(getToasts().map((toast) => toast.message)).toEqual([sentence]);
    // Heard once, from the toast's live region — not again from the uploader's (F01 review F01-1).
    expect(getUploads().announcements.map((entry) => entry.text)).not.toContain(sentence);
    expect(server.completes.length).toBe(1);
  });

  it("one item: the singular sentence", async () => {
    await addFiles([], null, [], { unreadable: ["broken.jpg"] });
    expect(getToasts().map((toast) => toast.message)).toEqual([
      "1 item could not be read and was left out: broken.jpg",
    ]);
  });

  it("too many files: nothing is queued and nothing is asked", async () => {
    await addFiles([{ file: smallFile("a.jpg") }], null, [], { tooMany: true });
    await settle();
    expect(items()).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(getToasts().map((toast) => toast.message)).toEqual([
      "That is more than 10,000 files. Nothing was uploaded — upload it in smaller parts.",
    ]);
  });
});

describe("folder creation waits, stops and is tried again with the files", () => {
  const folderRequests = () => folderCalls().length;

  it("offline while a folder is being made: nothing fails; back online the folder is made and the files upload", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    // The connection is gone: the request fails, and the browser says so.
    server.onJson = (call) => {
      if (call.method === "POST" && call.path === "/api/nodes/folder") throw new TypeError("offline");
      return undefined;
    };
    await addFiles(tree, null);
    await settle(0);
    window.dispatchEvent(new Event("offline"));
    await settle(0);
    await settle(120_000);
    expect(items().map((item) => [item.state, item.pauseReason])).toEqual(
      tree.map(() => ["paused", "offline"]),
    );
    // And it is not asked for while offline.
    const asked = folderRequests();
    await settle(120_000);
    expect(folderRequests()).toBe(asked);

    folders({});
    window.dispatchEvent(new Event("online"));
    await settle(0);
    await settle(0);
    expect(server.completes.length).toBe(4);
    expect(items()).toEqual([]);
  });

  it("a folder that cannot be made (a 5xx spell) fails its files with a new try — and the new try makes it", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/nodes/folder" ? envelope("internal", 500) : undefined;
    await addFiles([tree[1]!, tree[2]!], null);
    await settle(0);
    await settle(60_000);
    // One folder, asked for on the schedule — not once per file.
    expect(folderRequests()).toBe(6);
    expect(items().map((item) => [item.state, item.canRetry, item.message])).toEqual([
      ["error", true, "Couldn't create the folder trip. Nothing in it was uploaded."],
      ["error", true, "Couldn't create the folder trip. Nothing in it was uploaded."],
    ]);
    await settle(600_000);
    expect(folderRequests()).toBe(6);

    folders({});
    for (const item of items()) retryItem(item.id);
    await settle(0);
    await settle(0);
    expect(server.completes.length).toBe(2);
    expect(
      folderCalls()
        .slice(6)
        .map((body) => body.name),
    ).toEqual(["trip", "day1"]);
  });

  it("a rate limit on a folder pauses the queue like any other request", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    let limited = true;
    server.onJson = (call) =>
      limited && call.method === "POST" && call.path === "/api/nodes/folder"
        ? envelope("rate_limited", 429, undefined, { "retry-after": "20" })
        : undefined;
    await addFiles([tree[0]!], null);
    await settle(0);
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "limited" });
    limited = false;
    folders({});
    await settle(20_000);
    await settle(0);
    expect(server.completes.length).toBe(1);
  });

  it("cancelling every file of the upload stops the folders: no more are made", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.method === "POST" &&
      call.path === "/api/nodes/folder" &&
      (call.body as { name: string }).name === "trip"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : undefined;
    await addFiles(tree, null, ["trip/empty1", "trip/empty2"]);
    await settle();
    expect(folderRequests()).toBe(1);
    for (const item of items()) cancelItem(item.id);
    answer(json(folderDto({ id: rowId(0x7001), name: "trip" })));
    await settle();
    await settle();
    expect(folderRequests()).toBe(1);
    expect(server.inits).toEqual([]);
  });

  it("a file paused by hand while it waits for its folder stays paused when that folder fails", async () => {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.method === "POST" && call.path === "/api/nodes/folder"
        ? new Promise<Response>((resolve) => (answer = resolve))
        : undefined;
    await addFiles([tree[1]!, tree[2]!], null);
    await settle();
    pauseItem(items()[1]!.id);
    answer(envelope("conflict", 409));
    await settle();
    expect(items().map((item) => [item.name, item.state])).toEqual([
      ["a.jpg", "error"],
      ["b.jpg", "paused"],
    ]);
  });
});

describe("what a folder picker hands over", () => {
  it("the folder path of each file comes from webkitRelativePath", () => {
    const file = (name: string, relative: string) => {
      const made = smallFile(name);
      Object.defineProperty(made, "webkitRelativePath", { value: relative });
      return made;
    };
    const intake = fromFileList([
      file("a.jpg", "trip/day1/a.jpg"),
      file("top.txt", "trip/top.txt"),
      smallFile("x"),
    ]);
    expect(intake.files.map((entry) => [entry.file.name, entry.path])).toEqual([
      ["a.jpg", "trip/day1"],
      ["top.txt", "trip"],
      ["x", ""],
    ]);
    expect(intake.folders.sort()).toEqual(["trip", "trip/day1"]);
  });
});

describe("what a drop hands over", () => {
  type Entry = { isFile: boolean; isDirectory: boolean; fullPath: string };
  const fileEntry = (fullPath: string, broken = false): Entry & { file: unknown } => ({
    isFile: true,
    isDirectory: false,
    fullPath,
    file: (done: (file: File) => void, failed: (error: Error) => void) =>
      broken ? failed(new Error("unreadable")) : done(smallFile(fullPath.split("/").pop()!)),
  });
  /** A directory whose reader hands its children over in batches of `size`, then an empty batch. */
  const dirEntry = (fullPath: string, children: Entry[], size = 2): Entry & { createReader: unknown } => ({
    isFile: false,
    isDirectory: true,
    fullPath,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (done: (batch: Entry[]) => void) => {
          const batch = children.slice(at, at + size);
          at += size;
          done(batch);
        },
      };
    },
  });
  const dropped = (entries: Array<Entry | null>, loose: File[] = []) =>
    ({
      types: ["Files"],
      files: loose,
      items: entries.map((entry, index) => ({
        kind: "file",
        webkitGetAsEntry: () => entry,
        getAsFile: () => loose[index] ?? null,
      })),
    }) as unknown as DataTransfer;

  it("walks a dropped folder to the end — a reader answers in batches — and keeps each file's folder", async () => {
    const trip = dirEntry("/trip", [
      fileEntry("/trip/a.jpg"),
      fileEntry("/trip/b.jpg"),
      // In the second batch: missed by a walk that reads only once.
      fileEntry("/trip/c.jpg"),
      dirEntry("/trip/day1", [
        fileEntry("/trip/day1/d.jpg"),
        fileEntry("/trip/day1/e.jpg"),
        fileEntry("/trip/day1/f.jpg"),
      ]),
      dirEntry("/trip/empty", []),
    ]);
    const intake = await fromDrop(dropped([trip, fileEntry("/loose.txt")]));
    expect(intake.files.map((entry) => [entry.file.name, entry.path])).toEqual([
      ["a.jpg", "trip"],
      ["b.jpg", "trip"],
      ["c.jpg", "trip"],
      ["d.jpg", "trip/day1"],
      ["e.jpg", "trip/day1"],
      ["f.jpg", "trip/day1"],
      ["loose.txt", ""],
    ]);
    // No leading slash, and the empty folder is there.
    expect(intake.folders).toEqual(["trip", "trip/day1", "trip/empty"]);
  });

  it("an unreadable file inside a dropped folder is left out and named; its siblings and the folders after it are still taken", async () => {
    const trip = dirEntry("/trip", [
      fileEntry("/trip/a.jpg"),
      fileEntry("/trip/broken.jpg", true),
      fileEntry("/trip/c.jpg"),
      fileEntry("/trip/d.jpg"),
      dirEntry("/trip/day1", [fileEntry("/trip/day1/e.jpg")]),
    ]);
    const intake = await fromDrop(dropped([fileEntry("/gone.txt", true), trip, fileEntry("/fine.txt")]));
    expect(intake.files.map((entry) => [entry.file.name, entry.path])).toEqual([
      ["a.jpg", "trip"],
      ["c.jpg", "trip"],
      ["d.jpg", "trip"],
      ["e.jpg", "trip/day1"],
      ["fine.txt", ""],
    ]);
    expect(intake.unreadable).toEqual(["gone.txt", "trip/broken.jpg"]);
    expect(intake.tooMany).toBe(false);
  });

  it("a folder that cannot be listed is named; what was read before it and everything beside it stays", async () => {
    const locked = {
      isFile: false,
      isDirectory: true,
      fullPath: "/trip/locked",
      createReader: () => ({
        readEntries: (_done: unknown, failed: (error: Error) => void) => failed(new Error("denied")),
      }),
    };
    const trip = dirEntry("/trip", [fileEntry("/trip/a.jpg"), locked, fileEntry("/trip/z.jpg")], 5);
    const intake = await fromDrop(dropped([trip]));
    expect(intake.files.map((entry) => entry.file.name)).toEqual(["a.jpg", "z.jpg"]);
    expect(intake.unreadable).toEqual(["trip/locked"]);
  });

  it("a drop of more files than one upload takes stops walking and says so", async () => {
    const huge = dirEntry(
      "/huge",
      Array.from({ length: MAX_DROP_FILES + 50 }, (_, n) => fileEntry(`/huge/f${n}.txt`)),
      1000,
    );
    const intake = await fromDrop(dropped([huge, fileEntry("/after.txt")]));
    expect(intake.tooMany).toBe(true);
    expect(intake.files.length).toBe(MAX_DROP_FILES + 1);
  });

  it("where the browser gives no entries, the plain files are taken", async () => {
    const plain = smallFile("plain.txt");
    const intake = await fromDrop(dropped([null], [plain]));
    expect(intake.files).toEqual([{ file: plain, path: "" }]);
    const bare = await fromDrop({ types: ["Files"], files: [plain], items: [] } as unknown as DataTransfer);
    expect(bare.files).toEqual([{ file: plain, path: "" }]);
  });

  it("only a drag of files from the system counts", () => {
    expect(carriesFiles({ types: ["Files"] } as unknown as DataTransfer)).toBe(true);
    expect(carriesFiles({ types: ["text/plain", "text/uri-list"] } as unknown as DataTransfer)).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});
