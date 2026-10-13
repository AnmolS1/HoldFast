// Folder upload: folders first, each once; a folder that is already there is used, a name that
// something else holds fails its subtree only — and the folder's children are never listed.
import { beforeEach, describe, expect, it } from "vitest";
import { carriesFiles, fromDrop, fromFileList } from "../../../../src/client/features/upload/intake";
import { addFiles } from "../../../../src/client/features/upload/manager";
import { getUploads } from "../../../../src/client/features/upload/store";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { setupShell } from "../shell/helpers";
import { EXISTING_ID, FOLDER_ID, folderDto, rowId } from "./fixtures";
import { envelope, freshUploader, installServer, json, settle, smallFile, type Server } from "./helpers";

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
    expect(folderCalls()).toEqual([
      { parentId: FOLDER_ID, name: "trip" },
      { parentId: trip, name: "day1" },
      { parentId: trip, name: "day2" },
      // An empty folder is created too.
      { parentId: trip, name: "empty" },
    ]);
    const parents = Object.fromEntries(server.inits.map((body) => [body.name, body.parentId]));
    expect(parents).toEqual({
      "top.txt": trip,
      "a.jpg": rowId(0x7002),
      "b.jpg": rowId(0x7002),
      "c.jpg": rowId(0x7003),
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

  it("an entry that cannot be read is left out; the rest of the drop goes on", async () => {
    const intake = await fromDrop(dropped([fileEntry("/gone.txt", true), fileEntry("/fine.txt")]));
    expect(intake.files.map((entry) => entry.file.name)).toEqual(["fine.txt"]);
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
