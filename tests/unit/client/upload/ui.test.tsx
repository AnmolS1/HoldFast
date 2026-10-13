// What the uploader shows and how it is reached: the ribbon feed and its panel, the two slots, the
// drop target and paste, the pre-flight, the live region and the /uploads page.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot, TransferRibbon } from "../../../../src/client/components/TransferRibbon";
import { requestUpload, routes, UploadDropOverlay } from "../../../../src/client/features/upload";
import { addFiles } from "../../../../src/client/features/upload/manager";
import { targetFromLocation } from "../../../../src/client/features/upload/picker";
import { getUploads } from "../../../../src/client/features/upload/store";
import { renderRoutes, renderShell, seedConfig, setupShell } from "../shell/helpers";
import { FOLDER_ID, nodeDetail, OTHER_USER_ID, usageDto } from "./fixtures";
import {
  bigFile,
  envelope,
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
afterEach(() => window.history.replaceState({}, "", "/"));

const items = () => getUploads().items;
const ribbon = () => getRibbonSnapshot();
const live = () => document.querySelector("[data-upload-live]")!;

async function settled(): Promise<void> {
  await act(() => settle());
}

function choose(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, "files", { value: files, configurable: true });
  fireEvent.change(input);
}

const filesInput = () => document.querySelector<HTMLInputElement>('input[data-upload-input="files"]')!;
const folderInput = () => document.querySelector<HTMLInputElement>('input[data-upload-input="folder"]')!;

describe("the transfer ribbon", () => {
  it("publishes one sentence in user units under the source 'upload', and its panel", async () => {
    server.hold = true;
    server.partBytes = 100_000_000;
    await addFiles([{ file: bigFile("a.bin", 300_000_000) }, { file: bigFile("b.bin", 900_000_000) }], null);
    await settle();
    expect(ribbon().current).toMatchObject({
      sourceId: "upload",
      status: "active",
      sentence: "Uploading 1 of 2 · 1.2 GB left",
    });
    expect(ribbon().panels.map((panel) => panel.sourceId)).toEqual(["upload"]);
    expect(ribbon().openCount).toBe(1);

    // All of a.bin arrives: the fraction and the sentence follow.
    for (const call of server.held.filter((entry) => entry.size === 100_000_000).slice(0, 3)) {
      call.progress(100_000_000);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ribbon().current!.progress).toBeGreaterThan(0.2);
    expect(ribbon().current!.sentence).toMatch(/^Uploading 1 of 2 · 900 MB left/);

    server.hold = false;
    for (const call of [...server.held]) call.resolve();
    await settle();
    // Idle again: the source is done and the panel is gone.
    expect(ribbon().current).toBeNull();
    expect(ribbon().openCount).toBe(0);
    expect(ribbon().panels).toEqual([]);
  });

  it("the panel has a row per file with pause, resume and cancel; focus stays on the button that flips", async () => {
    server.hold = true;
    renderShell(
      <>
        <UploadDropOverlay />
        <TransferRibbon />
      </>,
    );
    await act(() => addFiles([{ file: smallFile("a.txt") }, { file: smallFile("b.txt") }], null));
    await settled();
    await act(async () => screen.getByRole("button", { name: /Uploading 1 of 2/ }).click());
    const panel = screen.getByRole("region", { name: "Transfers" });
    expect(within(panel).getByRole("heading", { name: "Uploads" })).toBeTruthy();
    expect(panel.querySelectorAll("[data-upload-row]").length).toBe(2);
    expect(within(panel).getAllByRole("progressbar").length).toBe(2);

    const pause = within(panel).getByRole("button", { name: "Pause a.txt" });
    pause.focus();
    await act(async () => pause.click());
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "user" });
    expect(document.activeElement).toBe(pause);
    expect(pause.getAttribute("aria-label")).toBe("Resume a.txt");
    expect(within(panel).getByText("Paused")).toBeTruthy();

    // Cancel takes the row's buttons away: focus goes to the panel's heading, not to nowhere.
    const cancel = within(panel).getByRole("button", { name: "Cancel b.txt" });
    cancel.focus();
    await act(async () => cancel.click());
    await settled();
    expect(items()[1]).toMatchObject({ state: "cancelled" });
    expect(document.activeElement).toBe(within(panel).getByRole("heading", { name: "Uploads" }));

    await act(async () => within(panel).getByRole("button", { name: "Resume all" }).click());
    await settled();
    expect(items()[0]!.state).toBe("uploading");
  });

  it("there is no second surface: the host renders no row and no progress bar of its own", async () => {
    server.hold = true;
    const { container } = renderShell(<UploadDropOverlay />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await settled();
    expect(container.querySelector("[data-upload-row]")).toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector("[data-upload-panel]")).toBeNull();
  });
});

describe("the live region", () => {
  it("announces each file's start and completion, politely", async () => {
    renderShell(<UploadDropOverlay />);
    expect(live().getAttribute("aria-live")).toBe("polite");
    expect(live().getAttribute("role")).toBe("log");
    expect(live().textContent).toBe("");
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await settled();
    expect(Array.from(live().children, (child) => child.textContent)).toEqual([
      "Uploading a.txt",
      "a.txt uploaded",
    ]);
  });

  it("announces a failure", async () => {
    server.onInit = () => envelope("validation", 400);
    renderShell(<UploadDropOverlay />);
    await act(() => addFiles([{ file: smallFile("a.txt") }], null));
    await settled();
    expect(live().textContent).toContain("a.txt didn't finish");
  });
});

describe("requestUpload", () => {
  it("with files: they are queued for the folder that was named", async () => {
    expect(requestUpload({ files: [smallFile("a.txt")], parentId: FOLDER_ID })).toBeUndefined();
    await settle();
    expect(server.inits.map((body) => [body.name, body.parentId])).toEqual([["a.txt", FOLDER_ID]]);
    expect(server.completes.length).toBe(1);
  });

  it("with files and no folder: the folder in the address, else the top level", async () => {
    window.history.replaceState({}, "", `/folder/${FOLDER_ID}`);
    requestUpload({ files: [smallFile("a.txt")] });
    await settle();
    window.history.replaceState({}, "", "/recent");
    requestUpload({ files: [smallFile("b.txt")] });
    await settle();
    expect(server.inits.map((body) => [body.name, body.parentId])).toEqual([
      ["a.txt", FOLDER_ID],
      ["b.txt", null],
    ]);
  });

  it("without files: opens this feature's own file picker, inside the call", async () => {
    renderShell(<UploadDropOverlay />);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    window.history.replaceState({}, "", `/folder/${FOLDER_ID}`);
    requestUpload();
    // Synchronously: a picker only opens while the click that asked for it is being handled.
    expect(click).toHaveBeenCalledTimes(1);
    expect(click.mock.instances[0]).toBe(filesInput());
    expect(filesInput().type).toBe("file");
    expect(filesInput().multiple).toBe(true);
    expect(filesInput().hidden).toBe(true);

    // The address changes while the picker is open: the files still go where it was opened for.
    window.history.replaceState({}, "", "/recent");
    await act(async () => choose(filesInput(), [smallFile("a.txt")]));
    await settled();
    expect(server.inits.map((body) => [body.name, body.parentId])).toEqual([["a.txt", FOLDER_ID]]);
  });

  it("files that reach the input without the picker being asked for go to the folder in the address", async () => {
    renderShell(<UploadDropOverlay />);
    window.history.replaceState({}, "", `/uploads?parent=${FOLDER_ID}`);
    await act(async () => choose(filesInput(), [smallFile("a.txt")]));
    await settled();
    // And a target that was asked for is used once, not kept for the next selection.
    window.history.replaceState({}, "", "/");
    await act(async () => choose(filesInput(), [smallFile("b.txt")]));
    await settled();
    expect(server.inits.map((body) => [body.name, body.parentId])).toEqual([
      ["a.txt", FOLDER_ID],
      ["b.txt", null],
    ]);
  });

  it("the folder picker asks for a directory", () => {
    renderShell(<UploadDropOverlay />);
    expect(folderInput().hasAttribute("webkitdirectory")).toBe(true);
  });

  it("the target folder is read from the address", () => {
    const at = (path: string) => {
      window.history.replaceState({}, "", path);
      return targetFromLocation();
    };
    expect(at("/")).toBeNull();
    expect(at(`/folder/${FOLDER_ID}`)).toBe(FOLDER_ID);
    expect(at(`/uploads?parent=${FOLDER_ID}`)).toBe(FOLDER_ID);
    expect(at("/uploads")).toBeNull();
    expect(at(`/trash?parent=${FOLDER_ID}`)).toBeNull();
    expect(at(`/preview/${FOLDER_ID}`)).toBeNull();
  });
});

describe("drop and paste", () => {
  const transfer = (files: File[]) => ({ types: ["Files"], files, items: [] });
  const dispatch = (type: string, dataTransfer: unknown, target: EventTarget = window) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it("dragging files over the app says where they will go; dropping uploads them there", async () => {
    window.history.replaceState({}, "", `/folder/${FOLDER_ID}`);
    renderShell(<UploadDropOverlay />);
    expect(document.querySelector("[data-upload-drop]")).toBeNull();
    dispatch("dragenter", transfer([]));
    expect(document.querySelector("[data-upload-drop]")!.textContent).toBe("Drop to upload to this folder");
    // The folder's name arrives.
    await waitFor(() =>
      expect(document.querySelector("[data-upload-drop]")!.textContent).toBe("Drop to upload to Projects"),
    );
    expect(dispatch("dragover", transfer([])).defaultPrevented).toBe(true);
    const drop = dispatch("drop", transfer([smallFile("a.txt")]));
    expect(drop.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-upload-drop]")).toBeNull();
    await settled();
    expect(server.inits.map((body) => [body.name, body.parentId])).toEqual([["a.txt", FOLDER_ID]]);
  });

  it("at the top level the target is Files; leaving takes the sentence away", () => {
    renderShell(<UploadDropOverlay />);
    dispatch("dragenter", transfer([]));
    dispatch("dragenter", transfer([]));
    expect(document.querySelector("[data-upload-drop]")!.textContent).toBe("Drop to upload to Files");
    dispatch("dragleave", transfer([]));
    expect(document.querySelector("[data-upload-drop]")).not.toBeNull();
    dispatch("dragleave", transfer([]));
    expect(document.querySelector("[data-upload-drop]")).toBeNull();
  });

  it("a drag that carries no files (text, a dragged row) is none of its business", () => {
    renderShell(<UploadDropOverlay />);
    const enter = dispatch("dragenter", { types: ["text/plain"], files: [], items: [] });
    expect(document.querySelector("[data-upload-drop]")).toBeNull();
    expect(enter.defaultPrevented).toBe(false);
    expect(dispatch("drop", { types: ["text/plain"], files: [], items: [] }).defaultPrevented).toBe(false);
  });

  const paste = (files: File[], target: EventTarget) => {
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { files } });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it("pasted files are uploaded to the folder in the address", async () => {
    window.history.replaceState({}, "", `/uploads?parent=${FOLDER_ID}`);
    renderShell(<UploadDropOverlay />);
    expect(paste([smallFile("shot.png")], document.body).defaultPrevented).toBe(true);
    await settled();
    expect(server.inits.map((body) => [body.name, body.parentId])).toEqual([["shot.png", FOLDER_ID]]);
  });

  it("a paste into a text field, and a paste of text, are left alone", async () => {
    renderShell(
      <>
        <UploadDropOverlay />
        <input aria-label="name" />
      </>,
    );
    expect(paste([smallFile("shot.png")], screen.getByLabelText("name")).defaultPrevented).toBe(false);
    expect(paste([], document.body).defaultPrevented).toBe(false);
    await settled();
    expect(server.inits).toEqual([]);
  });
});

describe("pre-flight", () => {
  it("more than is free: nothing starts, and the sentence gives both numbers", async () => {
    server.onJson = (call) =>
      call.path === "/api/account/usage"
        ? json(usageDto({ usedBytes: 3_600_000_000, filesBytes: 3_600_000_000 }))
        : undefined;
    await addFiles(
      [1, 2, 3, 4].map((n) => ({ file: bigFile(`f${n}.bin`, 1_550_000_000) })),
      null,
    );
    await settle();
    expect(getToasts().map((toast) => toast.message)).toEqual(["This needs 6.2 GB and you have 1.4 GB free"]);
    expect(getUploads().announcements.map((entry) => entry.text)).toEqual([
      "This needs 6.2 GB and you have 1.4 GB free",
    ]);
    expect(items()).toEqual([]);
    expect(server.inits).toEqual([]);
    expect(ribbon().current).toBeNull();
  });

  it("into someone else's folder the caller's own free space is not the measure", async () => {
    server.onJson = (call) => {
      if (call.path === "/api/account/usage")
        return json(usageDto({ usedBytes: 5_000_000_000, filesBytes: 5_000_000_000 }));
      if (call.path === `/api/nodes/${FOLDER_ID}`) {
        return json(
          nodeDetail({
            id: FOLDER_ID,
            kind: "folder",
            role: "editor",
            owner: { id: OTHER_USER_ID, displayName: "Grace Hopper" },
          }),
        );
      }
      return undefined;
    };
    await addFiles([{ file: smallFile("a.txt") }], FOLDER_ID);
    await settle();
    expect(server.count("GET", /^\/api\/account\/usage$/)).toBe(0);
    expect(server.inits.length).toBe(1);
    // The caller's own tree, with no room left: refused before anything is sent.
    await addFiles([{ file: smallFile("b.txt") }], null);
    await settle();
    expect(server.inits.length).toBe(1);
  });

  it("when the free space cannot be read the upload goes ahead (the server checks again)", async () => {
    server.onJson = (call) => (call.path === "/api/account/usage" ? envelope("internal", 500) : undefined);
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(server.completes.length).toBe(1);
  });

  it("a file above the cap is refused on its own; the others upload", async () => {
    renderShell(
      <>
        <UploadDropOverlay />
        <TransferRibbon />
      </>,
    );
    await act(() =>
      addFiles([{ file: bigFile("huge.bin", 2_000_000_001) }, { file: smallFile("ok.txt") }], null),
    );
    await settled();
    expect(server.inits.map((body) => body.name)).toEqual(["ok.txt"]);
    expect(items().map((item) => [item.name, item.state, item.canRetry, item.message])).toEqual([
      ["huge.bin", "error", false, "This file is larger than the 2 GB limit."],
    ]);
    expect(ribbon().current).toMatchObject({ status: "error", sentence: "1 upload didn't finish" });
    await act(async () => screen.getByRole("button", { name: /1 upload didn't finish/ }).click());
    // No new try is offered for it; removing it empties the ribbon.
    expect(screen.queryByRole("button", { name: /Try huge.bin again/ })).toBeNull();
    await act(async () => screen.getByRole("button", { name: "Remove huge.bin from the list" }).click());
    expect(items()).toEqual([]);
    expect(ribbon().current).toBeNull();
  });

  it("with uploads switched off nothing is queued", async () => {
    seedConfig({ uploadsEnabled: false });
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(items()).toEqual([]);
    expect(server.calls).toEqual([]);
    expect(getToasts().map((toast) => toast.message)).toEqual(["Uploads are paused right now."]);
  });
});

describe("/uploads", () => {
  const open = (path = "/uploads") =>
    renderRoutes([{ path: "/", children: routes }], [path], <UploadDropOverlay />);

  it("offers the two pickers and says how much room is left", async () => {
    open();
    expect(await screen.findByText("4 GB free of 5 GB")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose files" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose a folder" })).toBeTruthy();
    // The page itself shows no progress: that is the ribbon's.
    expect(document.querySelector('[data-uploads-page] [role="progressbar"]')).toBeNull();
    expect(document.querySelector("[data-upload-row]")).toBeNull();
  });

  it("?parent names the folder the chosen files go to", async () => {
    open(`/uploads?parent=${FOLDER_ID}`);
    const click = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    await act(async () => (await screen.findByRole("button", { name: "Choose files" })).click());
    expect(click.mock.instances[0]).toBe(filesInput());
    await act(async () => choose(filesInput(), [smallFile("a.txt")]));
    await settled();
    expect(server.inits.map((body) => body.parentId)).toEqual([FOLDER_ID]);

    await act(async () => screen.getByRole("button", { name: "Choose a folder" }).click());
    expect(click.mock.instances[1]).toBe(folderInput());
  });

  it.each([
    ["404", () => envelope("not_found", 404)],
    ["500", () => envelope("internal", 500)],
  ])(
    "with every request answered %s it shows its error state and does not throw",
    async (_status, answer) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      server.onJson = (call) => (call.path.startsWith("/api/") ? answer() : undefined);
      open();
      const heading = await screen.findByRole("heading", { name: "Couldn't load uploads" });
      expect(heading.closest('[data-empty-state="unavailable"]')).not.toBeNull();
      expect(screen.getByText("req req-1234")).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Choose files" })).toBeNull();
      expect(errors).not.toHaveBeenCalled();

      // "Try again" asks again; once the API answers, the page is there.
      server.onJson = undefined;
      await act(async () => screen.getByRole("button", { name: "Try again" }).click());
      expect(await screen.findByRole("button", { name: "Choose files" })).toBeTruthy();
    },
  );

  it("with uploads switched off the pickers are disabled and the page says why", async () => {
    seedConfig({ uploadsEnabled: false });
    open();
    const button = await screen.findByRole("button", { name: "Choose files" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Uploads are paused right now.")).toBeTruthy();
  });
});
