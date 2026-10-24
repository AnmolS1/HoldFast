// What the operating system leaves in a folder (.DS_Store, Thumbs.db, AppleDouble "._" files,
// __MACOSX/) is left out of every folder upload — picker and drop — and the user is told how
// many. A file the user chose on its own is theirs, whatever its name; no other dotfile is ever
// left out. A folder picker that hands back plain files is refused, never uploaded flat.
import "fake-indexeddb/auto";
import { act, render } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { UploadDropOverlay } from "../../../../src/client/features/upload";
import {
  folderPickWasFlat,
  fromDrop,
  fromFileList,
  isSystemClutter,
} from "../../../../src/client/features/upload/intake";
import { addFiles } from "../../../../src/client/features/upload/manager";
import { requestUpload as slotRequestUpload } from "../../../../src/client/features/upload/slots";
import { getUploads } from "../../../../src/client/features/upload/store";
import {
  canPickFolders,
  registerUploadRequester,
  requestUpload,
  type UploadRequest,
} from "../../../../src/client/lib/contracts";
import { purgeUserState } from "../../../../src/client/lib/query";
import {
  isApplePlatform,
  isCharacterShortcut,
  matchShortcut,
  shortcutLabel,
  SHORTCUTS,
  useShortcut,
} from "../../../../src/client/lib/shortcuts";
import { renderShell, seedConfig, seedSession, sessionOf, setupShell } from "../shell/helpers";
import { FOLDER_ID, OTHER_USER_ID, usageDto } from "./fixtures";
import { freshUploader, installServer, json, settle, smallFile, type Server } from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  await freshUploader();
  server = installServer();
  window.history.replaceState({}, "", "/");
});

const said = () => getUploads().announcements.map((entry) => entry.text);
/**
 * How often a sentence reaches a screen reader: the toast region and the uploader's live region
 * are both polite live regions, so each copy is heard (review F01-1: exactly once).
 */
const heard = (sentence: string) => [...toasts(), ...said()].filter((text) => text === sentence).length;
const toasts = () => getToasts().map((toast) => toast.message);
const folderCalls = () =>
  server.calls
    .filter((call) => call.method === "POST" && call.path === "/api/nodes/folder")
    .map((call) => (call.body as { name: string }).name);

/** A file as a folder picker hands it over: its path inside the chosen folder comes with it. */
function picked(relative: string): File {
  const made = smallFile(relative.split("/").pop()!);
  Object.defineProperty(made, "webkitRelativePath", { value: relative });
  return made;
}

// ---- the drop's entries --------------------------------------------------------------------

type Entry = { isFile: boolean; isDirectory: boolean; fullPath: string };
const fileEntry = (fullPath: string): Entry & { file: unknown } => ({
  isFile: true,
  isDirectory: false,
  fullPath,
  file: (done: (file: File) => void) => done(smallFile(fullPath.split("/").pop()!)),
});
const dirEntry = (fullPath: string, children: Entry[]): Entry & { createReader: unknown } => ({
  isFile: false,
  isDirectory: true,
  fullPath,
  createReader: () => {
    let handed = false;
    return {
      readEntries: (done: (batch: Entry[]) => void) => {
        done(handed ? [] : children);
        handed = true;
      },
    };
  },
});
const dropped = (entries: Entry[]) =>
  ({
    types: ["Files"],
    files: [],
    items: entries.map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null })),
  }) as unknown as DataTransfer;

const CLUTTER = [".DS_Store", "Thumbs.db", "ehthumbs.db", "desktop.ini", "Icon\r", "._photo.jpg", "._"];
const KEPT = [".env", ".gitignore", "Icon", "_foo", "x._y", "Desktop.ini.bak", "thumbs.db.txt"];

describe("isSystemClutter", () => {
  it.each(CLUTTER)("%j is clutter", (name) => {
    expect(isSystemClutter(name, ["trip"])).toBe(true);
  });

  it.each(KEPT)("%j is the user's", (name) => {
    expect(isSystemClutter(name, ["trip"])).toBe(false);
  });

  it("anything under a __MACOSX segment is clutter, at any depth; a name merely containing it is not", () => {
    expect(isSystemClutter("b.txt", ["__MACOSX", "a"])).toBe(true);
    expect(isSystemClutter("b.txt", ["trip", "__MACOSX"])).toBe(true);
    expect(isSystemClutter("b.txt", ["__MACOSX-notes"])).toBe(false);
    expect(isSystemClutter("__MACOSX", ["trip"])).toBe(false);
  });

  it("a .git folder is the user's data", () => {
    expect(isSystemClutter("config", [".git"])).toBe(false);
    expect(isSystemClutter("HEAD", ["repo", ".git"])).toBe(false);
  });
});

describe("a folder picker's files", () => {
  it("each clutter name is left out and counted; every other dotfile is kept", () => {
    const intake = fromFileList([
      ...CLUTTER.map((name) => picked(`trip/${name}`)),
      ...KEPT.map((name) => picked(`trip/${name}`)),
      picked("trip/.git/config"),
      picked("trip/day1/a.jpg"),
    ]);
    expect(intake.files.map((entry) => `${entry.path}/${entry.file.name}`).sort()).toEqual(
      [...KEPT.map((name) => `trip/${name}`), "trip/.git/config", "trip/day1/a.jpg"].sort(),
    );
    expect(intake.skipped).toBe(CLUTTER.length);
  });

  it("__MACOSX/ and everything under it is left out — no folder is made for it", () => {
    const intake = fromFileList([
      picked("trip/__MACOSX/a/b.txt"),
      picked("trip/__MACOSX/._c.jpg"),
      picked("trip/c.jpg"),
    ]);
    expect(intake.files.map((entry) => entry.file.name)).toEqual(["c.jpg"]);
    expect(intake.skipped).toBe(2);
    expect(intake.folders).toEqual(["trip"]);
  });

  it("a folder whose only content is under __MACOSX/ is still listed (as a drop lists it)", () => {
    const intake = fromFileList([picked("trip/__MACOSX/._a.jpg"), picked("trip/sub/__MACOSX/x/b.txt")]);
    expect(intake.files).toEqual([]);
    expect(intake.folders.sort()).toEqual(["trip", "trip/sub"]);
    expect(intake.skipped).toBe(2);
  });

  it("a folder that held only clutter is still listed: it is a folder the user chose", () => {
    const intake = fromFileList([picked("trip/empty-ish/.DS_Store"), picked("trip/a.jpg")]);
    expect(intake.files.map((entry) => entry.file.name)).toEqual(["a.jpg"]);
    expect(intake.folders.sort()).toEqual(["trip", "trip/empty-ish"]);
    expect(intake.skipped).toBe(1);
  });

  it("a file chosen on its own (the files picker, a paste) is kept whatever its name", () => {
    const intake = fromFileList([smallFile(".DS_Store"), smallFile("._x"), smallFile("Thumbs.db")]);
    expect(intake.files.map((entry) => entry.file.name)).toEqual([".DS_Store", "._x", "Thumbs.db"]);
    expect(intake.skipped).toBe(0);
  });
});

describe("a dropped folder", () => {
  it("each clutter name is left out and counted; every other dotfile is kept", async () => {
    const intake = await fromDrop(
      dropped([
        dirEntry("/trip", [
          ...CLUTTER.map((name) => fileEntry(`/trip/${name}`)),
          ...KEPT.map((name) => fileEntry(`/trip/${name}`)),
          dirEntry("/trip/.git", [fileEntry("/trip/.git/config")]),
        ]),
      ]),
    );
    expect(intake.files.map((entry) => `${entry.path}/${entry.file.name}`).sort()).toEqual(
      [...KEPT.map((name) => `trip/${name}`), "trip/.git/config"].sort(),
    );
    expect(intake.skipped).toBe(CLUTTER.length);
    expect(intake.folders.sort()).toEqual(["trip", "trip/.git"]);
  });

  it("__MACOSX/ is walked only to count it: no folder is made for it", async () => {
    const intake = await fromDrop(
      dropped([
        dirEntry("/trip", [
          fileEntry("/trip/a.jpg"),
          dirEntry("/trip/__MACOSX", [dirEntry("/trip/__MACOSX/a", [fileEntry("/trip/__MACOSX/a/b.txt")])]),
        ]),
      ]),
    );
    expect(intake.files.map((entry) => entry.file.name)).toEqual(["a.jpg"]);
    expect(intake.folders).toEqual(["trip"]);
    expect(intake.skipped).toBe(1);
  });

  it("a folder that held only clutter is still listed", async () => {
    const intake = await fromDrop(dropped([dirEntry("/trip", [fileEntry("/trip/.DS_Store")])]));
    expect(intake.files).toEqual([]);
    expect(intake.folders).toEqual(["trip"]);
    expect(intake.skipped).toBe(1);
  });

  it("a file dropped on its own is kept whatever its name", async () => {
    const intake = await fromDrop(dropped([fileEntry("/.DS_Store"), fileEntry("/._x")]));
    expect(intake.files.map((entry) => entry.file.name)).toEqual([".DS_Store", "._x"]);
    expect(intake.skipped).toBe(0);
  });
});

describe("the user is told how many were left out", () => {
  it("a toast, heard exactly once — the folders and the rest still upload", async () => {
    await addFiles([{ file: smallFile("a.jpg"), path: "trip" }], null, ["trip", "trip/only-clutter"], {
      skipped: 3,
    });
    await settle();
    const sentence = "3 system files skipped (.DS_Store and similar)";
    expect(toasts()).toEqual([sentence]);
    expect(heard(sentence)).toBe(1);
    expect(folderCalls().sort()).toEqual(["only-clutter", "trip"]);
    expect(server.inits.map((body) => body.name)).toEqual(["a.jpg"]);
  });

  it("one: the singular sentence", async () => {
    await addFiles([], null, ["trip"], { skipped: 1 });
    expect(toasts()).toEqual(["1 system file skipped (.DS_Store and similar)"]);
  });

  it("the unreadable notice is heard exactly once too", async () => {
    await addFiles([], null, [], { unreadable: ["broken.jpg"] });
    const sentence = "1 item could not be read and was left out: broken.jpg";
    expect(toasts()).toEqual([sentence]);
    expect(heard(sentence)).toBe(1);
  });

  it("none: nothing is said", async () => {
    await addFiles([{ file: smallFile("a.jpg") }], null, [], { skipped: 0 });
    await settle();
    expect(toasts()).toEqual([]);
    expect(said().some((text) => /skipped/.test(text))).toBe(false);
  });
});

// ---- the folder picker, end to end in jsdom ----------------------------------------------------

const folderInput = () => document.querySelector<HTMLInputElement>('input[data-upload-input="folder"]')!;
const filesInput = () => document.querySelector<HTMLInputElement>('input[data-upload-input="files"]')!;

function choose(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  act(() => {
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const FLAT = "This browser picked files, not a folder. Drag the folder in instead, or use Upload files.";

describe("folderPickWasFlat", () => {
  it("every file without a path: flat; one with a path: a folder; nothing: not flat", () => {
    expect(folderPickWasFlat([smallFile("a"), smallFile("b")])).toBe(true);
    expect(folderPickWasFlat([smallFile("a"), picked("trip/b")])).toBe(false);
    expect(folderPickWasFlat([picked("trip/a")])).toBe(false);
    expect(folderPickWasFlat([])).toBe(false);
  });
});

describe("a folder picker that hands back plain files", () => {
  it("is refused with the notice: nothing is queued, created or sent", async () => {
    renderShell(createElement(UploadDropOverlay));
    choose(folderInput(), [smallFile("a.jpg"), smallFile("b.jpg")]);
    await act(() => settle());
    expect(toasts()).toEqual([FLAT]);
    expect(heard(FLAT)).toBe(1);
    expect(getUploads().items).toEqual([]);
    expect(server.inits).toEqual([]);
    expect(folderCalls()).toEqual([]);
    expect(folderInput().value).toBe("");
  });

  it("mixed (some files carry a path): accepted, the tree as picked", async () => {
    renderShell(createElement(UploadDropOverlay));
    choose(folderInput(), [smallFile("loose.jpg"), picked("trip/a.jpg")]);
    await act(() => settle());
    expect(toasts()).not.toContain(FLAT);
    expect(server.inits.map((body) => body.name).sort()).toEqual(["a.jpg", "loose.jpg"]);
    expect(folderCalls()).toEqual(["trip"]);
  });

  it("the files picker is never held to it: plain files are what it hands back", async () => {
    renderShell(createElement(UploadDropOverlay));
    choose(filesInput(), [smallFile("a.jpg"), smallFile(".DS_Store")]);
    await act(() => settle());
    expect(toasts()).toEqual([]);
    expect(server.inits.map((body) => body.name).sort()).toEqual([".DS_Store", "a.jpg"]);
  });

  it("a picked folder with clutter: the clutter is left out and the sentence said", async () => {
    renderShell(createElement(UploadDropOverlay));
    choose(folderInput(), [picked("trip/.DS_Store"), picked("trip/day1/._a.jpg"), picked("trip/day1/a.jpg")]);
    await act(() => settle());
    expect(toasts()).toEqual(["2 system files skipped (.DS_Store and similar)"]);
    expect(server.inits.map((body) => body.name)).toEqual(["a.jpg"]);
  });
});

// ---- asking for the folder picker (slots, lib/contracts) ----------------------------------------

/** Which hidden input a request clicked, and with what target the change is then read. */
function watchClicks(): string[] {
  const clicked: string[] = [];
  for (const input of [folderInput(), filesInput()]) {
    input.click = () => void clicked.push(input.getAttribute("data-upload-input")!);
  }
  return clicked;
}

describe("requestUpload({ kind })", () => {
  it('kind "folder" opens the folder picker, and what it hands back goes to the folder asked for', async () => {
    renderShell(createElement(UploadDropOverlay));
    const clicked = watchClicks();
    slotRequestUpload({ kind: "folder", parentId: FOLDER_ID });
    expect(clicked).toEqual(["folder"]);
    choose(folderInput(), [picked("trip/a.jpg")]);
    await act(() => settle());
    expect(server.calls.find((call) => call.path === "/api/nodes/folder")?.body).toMatchObject({
      parentId: FOLDER_ID,
      name: "trip",
    });
  });

  it('absent or "files": the files picker, as before', () => {
    renderShell(createElement(UploadDropOverlay));
    const clicked = watchClicks();
    slotRequestUpload();
    slotRequestUpload({ kind: "files" });
    slotRequestUpload({ parentId: FOLDER_ID });
    expect(clicked).toEqual(["files", "files", "files"]);
  });

  it("files given: they are queued and no picker opens, whatever the kind", async () => {
    renderShell(createElement(UploadDropOverlay));
    const clicked = watchClicks();
    slotRequestUpload({ kind: "folder", files: [smallFile("given.txt")] });
    await act(() => settle());
    expect(clicked).toEqual([]);
    expect(server.inits.map((body) => body.name)).toEqual(["given.txt"]);
  });

  it("through lib/contracts: the request reaches the registered requester with its kind", () => {
    const seen: Array<UploadRequest | undefined> = [];
    const stop = registerUploadRequester((opts) => seen.push(opts));
    requestUpload({ parentId: FOLDER_ID, kind: "folder" });
    stop();
    expect(seen).toEqual([{ parentId: FOLDER_ID, kind: "folder" }]);
  });

  it("through lib/contracts, the host registered: the folder picker opens", () => {
    renderShell(createElement(UploadDropOverlay));
    const clicked = watchClicks();
    requestUpload({ kind: "folder" });
    expect(clicked).toEqual(["folder"]);
  });
});

describe("the folder picker's mark of the user's action", () => {
  // The free-space read is the first wait after the change: an account change during it discards
  // the files — the mark was taken at the change, under the first account.
  function holdUsage(): () => void {
    let answer!: (response: Response) => void;
    server.onJson = (call) =>
      call.path === "/api/account/usage" ? new Promise<Response>((resolve) => (answer = resolve)) : undefined;
    return () => answer(json(usageDto()));
  }

  it("an account switch during the usage read discards the picked folder", async () => {
    const release = holdUsage();
    renderShell(createElement(UploadDropOverlay));
    choose(folderInput(), [picked("trip/a.jpg"), picked("trip/b.jpg")]);
    await act(() => settle());
    await act(() => purgeUserState());
    seedSession(sessionOf({ id: OTHER_USER_ID }));
    seedConfig();
    await act(async () => release());
    await act(() => settle());
    expect(getUploads().items).toEqual([]);
    expect(server.inits).toEqual([]);
    expect(folderCalls()).toEqual([]);
  });

  it("the control: no switch, and the same pick uploads", async () => {
    const release = holdUsage();
    renderShell(createElement(UploadDropOverlay));
    choose(folderInput(), [picked("trip/a.jpg"), picked("trip/b.jpg")]);
    await act(() => settle());
    await act(async () => release());
    await act(() => settle());
    expect(server.inits.map((body) => body.name).sort()).toEqual(["a.jpg", "b.jpg"]);
    expect(folderCalls()).toEqual(["trip"]);
  });
});

// ---- the entry points' own rules ----------------------------------------------------------------

describe("⌘⇧U / Ctrl+Shift+U", () => {
  const press = (key: string, mods: { meta?: boolean; ctrl?: boolean; shift?: boolean }) => ({
    key,
    metaKey: Boolean(mods.meta),
    ctrlKey: Boolean(mods.ctrl),
    shiftKey: Boolean(mods.shift),
    altKey: false,
  });

  it("is Upload folder; ⌘U stays Upload files — on a Mac and elsewhere", () => {
    expect(matchShortcut(press("U", { meta: true, shift: true }), true)).toBe("uploadFolder");
    expect(matchShortcut(press("u", { meta: true }), true)).toBe("upload");
    expect(matchShortcut(press("U", { ctrl: true, shift: true }), false)).toBe("uploadFolder");
    expect(matchShortcut(press("u", { ctrl: true }), false)).toBe("upload");
    expect(shortcutLabel("uploadFolder", true)).toBe("⌘⇧U");
    expect(shortcutLabel("uploadFolder", false)).toBe("Ctrl+Shift+U");
  });

  it("is not global — Ctrl+Shift+U in a text field stays the system's (Unicode entry) — and the Single-key switch leaves it alone", () => {
    const def = SHORTCUTS.find((shortcut) => shortcut.id === "uploadFolder")!;
    expect(def.global).toBeFalsy();
    expect(isCharacterShortcut(def)).toBe(false);
  });

  it("fires on the page, never from a text field", () => {
    const fired: string[] = [];
    function Bound() {
      useShortcut("uploadFolder", () => fired.push("folder"));
      return createElement("input", { "aria-label": "Name" });
    }
    const view = render(createElement(Bound));
    const chord = { key: "U", ctrlKey: true, metaKey: true, shiftKey: true, bubbles: true, cancelable: true };
    // Whichever of ⌘ and Ctrl this platform reads as the modifier: only one may be held.
    const apple = isApplePlatform();
    const event = () => new KeyboardEvent("keydown", { ...chord, ctrlKey: !apple, metaKey: apple });
    view.getByRole("textbox").dispatchEvent(event());
    expect(fired).toEqual([]);
    document.body.dispatchEvent(event());
    expect(fired).toEqual(["folder"]);
    view.unmount();
  });
});

describe("canPickFolders (the FAB's guard)", () => {
  const ua = navigator.userAgent;
  const withPicker = () =>
    Object.defineProperty(HTMLInputElement.prototype, "webkitdirectory", {
      configurable: true,
      get: () => false,
      set: () => {},
    });
  const setUa = (value: string) =>
    Object.defineProperty(navigator, "userAgent", { value, configurable: true });

  it("no webkitdirectory: no; with it: yes; Samsung Internet: no", () => {
    try {
      expect(canPickFolders()).toBe(false);
      withPicker();
      expect(canPickFolders()).toBe(true);
      setUa(
        "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
      );
      expect(canPickFolders()).toBe(false);
    } finally {
      delete (HTMLInputElement.prototype as { webkitdirectory?: boolean }).webkitdirectory;
      setUa(ua);
    }
  });
});
