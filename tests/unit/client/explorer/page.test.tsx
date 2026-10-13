// The explorer page against the in-memory drive: listing, sorting, errors, optimistic actions,
// the tree-changed event, roles, opening, keyboard and details.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { COMMAND_IDS, findCommand, runCommand } from "../../../../src/client/components/CommandPalette";
import { getToasts } from "../../../../src/client/components/Toaster";
import { requestUpload } from "../../../../src/client/features/upload";
import { emitNodesChanged } from "../../../../src/client/lib/contracts";
import { setPrefs } from "../../../../src/client/lib/prefs";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { buildRoutes } from "../../../../src/client/router";
import {
  envelope,
  intersect,
  json,
  renderRoutes,
  sessionOf,
  shellFetch,
  type MockCall,
} from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode, manyNodes, nodeId, OTHER } from "./fixtures/nodes";
import {
  deferred,
  openMenu,
  pick,
  recordNodesChanged,
  renderExplorer,
  rowOf,
  rows,
  selectedIds,
  serveDrive,
  setupExplorer,
  toastMessages,
  waitForRows,
} from "./helpers";

// The uploader is a sibling feature: its slot is a stub here, and the call is what is asserted.
vi.mock("../../../../src/client/features/upload", () => ({
  requestUpload: vi.fn(),
  UploadDropOverlay: () => null,
  routes: [],
}));

setupExplorer();

const ALPHA = folderNode(1, { name: "Alpha" });
const BETA = folderNode(2, { name: "Beta" });
const NOTES = fileNode(3, { name: "notes.pdf" });
const PHOTO = fileNode(4, { name: "photo.png", mimeCategory: "image", thumb: true });
const top = () => new FakeDrive([ALPHA, BETA, NOTES, PHOTO]);

const paths = (calls: MockCall[], method = "GET") =>
  calls.filter((call) => call.method === method).map((call) => call.path);
const dialog = () => screen.findByRole("dialog");
const emptyState = (type: string) => document.querySelector(`[data-explorer] [data-empty-state="${type}"]`);
const errorState = () => emptyState("unavailable");

async function typeName(value: string, confirm: string): Promise<void> {
  const box = await dialog();
  fireEvent.change(within(box).getByRole("textbox"), { target: { value } });
  fireEvent.click(within(box).getByRole("button", { name: confirm }));
}

async function menuAction(id: string, action: string): Promise<void> {
  const { menu } = await openMenu(id);
  pick(menu, action);
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
}

describe("listing", () => {
  it("the top level lists its items with one request, counts them and titles the page", async () => {
    const calls = serveDrive(top());
    renderExplorer("/");
    await waitForRows(4);
    expect(paths(calls)).toEqual(["/api/nodes/root?sort=name&dir=asc&limit=200"]);
    expect(rows().map((row) => row.getAttribute("data-item-id"))).toEqual([
      ALPHA.id,
      BETA.id,
      NOTES.id,
      PHOTO.id,
    ]);
    expect(document.querySelector("[data-item-count]")!.textContent).toBe("4 items");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Files");
    expect(errorState()).toBeNull();
  });

  it("a folder lists its children and shows the trail back to Files", async () => {
    const inside = fileNode(5, { parentId: ALPHA.id, name: "inside.pdf" });
    const calls = serveDrive(top().add(inside));
    renderExplorer(`/folder/${ALPHA.id}`);
    await waitForRows(1);
    expect(paths(calls).sort()).toEqual(
      [`/api/nodes/${ALPHA.id}`, `/api/nodes/${ALPHA.id}/children?sort=name&dir=asc&limit=200`].sort(),
    );
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Alpha"));
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(trail).getByRole("link", { name: "Files" }).getAttribute("href")).toBe("/");
  });

  it("an empty top level is the first-use state; an empty folder is the cleared state", async () => {
    serveDrive(new FakeDrive([ALPHA]));
    const view = renderExplorer(`/folder/${ALPHA.id}`);
    await waitFor(() => expect(emptyState("cleared")).not.toBeNull());
    expect(screen.getByText("This folder is empty")).toBeTruthy();
    view.unmount();
    serveDrive(new FakeDrive());
    renderExplorer("/");
    await waitFor(() => expect(emptyState("first-use")).not.toBeNull());
  });

  it("the view mode is the one preference: usePrefs().viewMode", async () => {
    serveDrive(top());
    setPrefs({ viewMode: "grid" });
    renderExplorer("/");
    await waitForRows(4);
    const list = document.querySelector("[data-hf-list]")!;
    expect(list.getAttribute("data-view")).toBe("grid");
    act(() => setPrefs({ viewMode: "list" }));
    expect(list.getAttribute("data-view")).toBe("list");
    // The feature keeps no storage key of its own.
    expect(Object.keys(localStorage).sort()).toEqual(["hf.prefs.v1", "mui-mode"]);
  });

  it("grid: a thumbnail URL is asked for the clean image only; a refused one falls back to the icon", async () => {
    const drive = top().fail("GET", /\/thumb-url$/, 404);
    const calls = serveDrive(drive);
    setPrefs({ viewMode: "grid" });
    renderExplorer("/");
    await waitForRows(4);
    act(() => intersect());
    await waitFor(() => expect(rowOf(PHOTO.id)!.querySelector('[data-thumb="fallback"]')).not.toBeNull());
    expect(paths(calls).filter((path) => path.includes("thumb-url"))).toEqual([
      `/api/nodes/${PHOTO.id}/thumb-url?size=320`,
    ]);
    expect(errorState()).toBeNull();
  });

  it("the next page is asked for with the cursor; a change of sort or direction starts without one", async () => {
    const drive = new FakeDrive(manyNodes(250));
    const calls = serveDrive(drive);
    renderExplorer("/");
    await waitFor(() =>
      expect(document.querySelector("[data-item-count]")!.textContent).toMatch(/^200 items/),
    );
    act(() => intersect((element) => element.hasAttribute("data-load-more-sentinel")));
    await waitFor(() => expect(document.querySelector("[data-item-count]")!.textContent).toBe("250 items"));
    expect(paths(calls)).toEqual([
      "/api/nodes/root?sort=name&dir=asc&limit=200",
      "/api/nodes/root?sort=name&dir=asc&limit=200&cursor=200",
    ]);

    fireEvent.click(document.querySelector("[data-sort-button]")!);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Size" }));
    await waitFor(() => expect(paths(calls)).toHaveLength(3));
    expect(paths(calls)[2]).toBe("/api/nodes/root?sort=size&dir=asc&limit=200");
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());

    fireEvent.click(document.querySelector("[data-sort-button]")!);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Descending" }));
    await waitFor(() => expect(paths(calls)).toHaveLength(4));
    expect(paths(calls)[3]).toBe("/api/nodes/root?sort=size&dir=desc&limit=200");
    // "Modified" is the API's `updated`.
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(document.querySelector("[data-sort-button]")!);
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Modified" }));
    await waitFor(() => expect(paths(calls)).toHaveLength(5));
    expect(paths(calls)[4]).toBe("/api/nodes/root?sort=updated&dir=desc&limit=200");
  });

  it("a received tree-changed event refetches the listing of the parents it names, and no other", async () => {
    const calls = serveDrive(top());
    renderExplorer("/");
    await waitForRows(4);
    act(() => emitNodesChanged([nodeId(77)]));
    await act(async () => {});
    expect(paths(calls)).toHaveLength(1);
    act(() => emitNodesChanged([null]));
    await waitFor(() => expect(paths(calls)).toHaveLength(2));
    expect(paths(calls)[1]).toBe("/api/nodes/root?sort=name&dir=asc&limit=200");
  });
});

describe("a request that fails ends in the error state or a toast — the page never throws", () => {
  const STATUSES = [404, 500] as const;

  it.each(STATUSES)("the top-level listing answered %i", async (status) => {
    serveDrive(top().fail("GET", /\/nodes\/root$/, status));
    renderExplorer("/");
    await waitFor(() => expect(errorState()).not.toBeNull());
    expect(errorState()!.textContent).toContain("req req-fake");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    expect(rows()).toHaveLength(0);
    // Nothing can be added to a folder that did not load.
    expect(findCommand(COMMAND_IDS.newFolder)?.disabled).toBe(true);
    expect(document.querySelector("[data-new-folder]")).toBeNull();
  });

  it.each(STATUSES)("a folder's detail answered %i", async (status) => {
    serveDrive(top().fail("GET", new RegExp(`/nodes/${ALPHA.id}$`), status));
    renderExplorer(`/folder/${ALPHA.id}`);
    await waitFor(() => expect(errorState()).not.toBeNull());
    expect(errorState()!.textContent).toContain("req req-fake");
    expect(screen.getByRole("link", { name: "Back to Files" }).getAttribute("href")).toBe("/");
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  it.each(STATUSES)("a folder's children answered %i", async (status) => {
    serveDrive(top().fail("GET", /\/children$/, status));
    renderExplorer(`/folder/${ALPHA.id}`);
    await waitFor(() => expect(errorState()).not.toBeNull());
    expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
  });

  it("a folder that does not exist says so, and Try again asks once more", async () => {
    const drive = top();
    const calls = serveDrive(drive);
    renderExplorer("/folder/abc");
    await waitFor(() => expect(errorState()).not.toBeNull());
    expect(errorState()!.textContent).toContain("This folder isn't available");
    const before = calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(calls.length).toBe(before + 2));
  });

  it("a later page that fails keeps the list, says so, and is not retried by scrolling", async () => {
    const drive = new FakeDrive(manyNodes(250));
    const calls = serveDrive(drive);
    renderExplorer("/");
    await waitFor(() =>
      expect(document.querySelector("[data-item-count]")!.textContent).toMatch(/^200 items/),
    );
    drive.fail("GET", /\/nodes\/root$/, 500, 1);
    act(() => intersect((element) => element.hasAttribute("data-load-more-sentinel")));
    await waitFor(() => expect(document.querySelector('[data-banner="more-failed"]')).not.toBeNull());
    expect(errorState()).toBeNull();
    expect(document.querySelector("[data-load-more-sentinel]")).toBeNull();
    expect(paths(calls)).toHaveLength(2);
    fireEvent.click(document.querySelector("[data-retry-more]")!);
    await waitFor(() => expect(document.querySelector("[data-item-count]")!.textContent).toBe("250 items"));
    expect(document.querySelector('[data-banner="more-failed"]')).toBeNull();
  });

  // Every request an action makes: the list stays, a toast carries the request id.
  const ACTIONS: Array<[name: string, method: string, pattern: RegExp, run: () => Promise<void>]> = [
    [
      "rename",
      "PATCH",
      /./,
      async () => (await menuAction(NOTES.id, "rename"), typeName("other.pdf", "Rename")),
    ],
    ["star", "PATCH", /./, () => menuAction(NOTES.id, "star")],
    ["trash", "POST", /\/trash$/, () => menuAction(NOTES.id, "trash")],
    ["download", "POST", /\/download-url$/, () => menuAction(NOTES.id, "download")],
    ["zip", "POST", /\/zip-manifest$/, () => menuAction(ALPHA.id, "zip")],
  ];
  describe.each(STATUSES)("answered %i", (status) => {
    it.each(ACTIONS)("%s", async (_name, method, pattern, run) => {
      const drive = top().fail(method, pattern, status);
      serveDrive(drive);
      renderExplorer("/");
      await waitForRows(4);
      await run();
      await waitFor(() => expect(getToasts().some((entry) => entry.requestId === "req-fake")).toBe(true));
      await waitForRows(4);
      expect(rowOf(NOTES.id)!.textContent).toContain("notes.pdf");
      expect(errorState()).toBeNull();
      expect(screen.queryByText(/Unexpected Application Error/)).toBeNull();
    });

    it("new folder: the dialog stays open for another try", async () => {
      serveDrive(top().fail("POST", /\/folder$/, status));
      renderExplorer("/");
      await waitForRows(4);
      fireEvent.click(document.querySelector("[data-new-folder]")!);
      await typeName("Gamma", "Create");
      await waitFor(() => expect(getToasts().some((entry) => entry.requestId === "req-fake")).toBe(true));
      expect(screen.getByRole("dialog")).toBeTruthy();
      expect(rows()).toHaveLength(4);
    });

    it("move", async () => {
      serveDrive(top().fail("POST", /\/move$/, status));
      renderExplorer("/");
      await waitForRows(4);
      await menuAction(NOTES.id, "move");
      const tree = await screen.findByRole("tree");
      fireEvent.click(await within(tree).findByText("Alpha"));
      fireEvent.click(document.querySelector("[data-move-confirm]")!);
      await waitFor(() => expect(getToasts().some((entry) => entry.requestId === "req-fake")).toBe(true));
      expect(rowOf(NOTES.id)).not.toBeNull();
    });

    it("Re-check", async () => {
      const broken = fileNode(9, { name: "broken.bin", scanStatus: "error", scanReason: "engine" });
      serveDrive(
        top()
          .add(broken)
          .fail("POST", /\/rescan$/, status),
      );
      renderExplorer("/");
      await waitForRows(5);
      await menuAction(broken.id, "recheck");
      await waitFor(() => expect(getToasts().some((entry) => entry.requestId === "req-fake")).toBe(true));
      expect(rowOf(broken.id)!.getAttribute("data-scan")).toBe("error");
    });
  });
});

describe("optimistic actions roll back", () => {
  it("rename: the new name shows at once; a refusal puts the old one back and says why", async () => {
    const held = deferred<Response>();
    const drive = top();
    serveDrive(drive, (call) => (call.method === "PATCH" ? held.promise : undefined));
    renderExplorer("/");
    await waitForRows(4);
    await menuAction(NOTES.id, "rename");
    await typeName("Beta", "Rename");
    // Before the server has answered.
    await waitFor(() => expect(rowOf(NOTES.id)!.textContent).toContain("Beta"));
    expect(rowOf(NOTES.id)!.textContent).not.toContain("notes.pdf");
    await act(async () => held.resolve(envelope("conflict", 409)));
    await waitFor(() => expect(rowOf(NOTES.id)!.textContent).toContain("notes.pdf"));
    expect(toastMessages()).toContain("Couldn't rename: “Beta” is already used in this folder.");
  });

  it("rename: the saved name stays", async () => {
    const drive = top();
    serveDrive(drive);
    renderExplorer("/");
    await waitForRows(4);
    await menuAction(NOTES.id, "rename");
    await typeName("minutes.pdf", "Rename");
    await waitFor(() => expect(drive.nodes.get(NOTES.id)!.name).toBe("minutes.pdf"));
    await waitFor(() => expect(rowOf(NOTES.id)!.textContent).toContain("minutes.pdf"));
    expect(toastMessages()).toEqual([]);
  });

  it("trash: the row leaves at once and comes back when the request fails", async () => {
    const held = deferred<Response>();
    serveDrive(top(), (call) => (call.path.endsWith("/trash") ? held.promise : undefined));
    renderExplorer("/");
    await waitForRows(4);
    await menuAction(NOTES.id, "trash");
    await waitForRows(3);
    expect(rowOf(NOTES.id)).toBeNull();
    await act(async () => held.resolve(envelope("internal", 500)));
    await waitForRows(4);
    expect(getToasts().some((entry) => entry.key === "undo")).toBe(false);
  });

  it("star: the change shows at once and is undone when the request fails", async () => {
    const held = deferred<Response>();
    serveDrive(top(), (call) => (call.method === "PATCH" ? held.promise : undefined));
    renderExplorer("/");
    await waitForRows(4);
    await menuAction(NOTES.id, "star");
    // Starred now: the menu offers to remove it.
    expect((await openMenu(NOTES.id)).ids).toContain("star");
    expect(within(screen.getByRole("menu")).getByText("Remove star")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    await act(async () => held.resolve(envelope("internal", 500)));
    await waitFor(async () => {
      await openMenu(NOTES.id);
      expect(within(screen.getByRole("menu")).getByText("Star")).toBeTruthy();
    });
  });
});

describe("the tree-changed event is sent after every saved change", () => {
  async function at(path: string, drive: FakeDrive, count: number) {
    serveDrive(drive);
    renderExplorer(path);
    await waitForRows(count);
    return recordNodesChanged();
  }

  it("create: the parent", async () => {
    const drive = top().add(fileNode(5, { parentId: ALPHA.id }));
    const seen = await at(`/folder/${ALPHA.id}`, drive, 1);
    await waitFor(() => expect(document.querySelector("[data-new-folder]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-new-folder]")!);
    await typeName("Gamma", "Create");
    await waitFor(() => expect(seen.events).toEqual([[ALPHA.id]]));
    await waitForRows(2);
    seen.stop();
  });

  it("create at the top level: [null]; a taken name is said in the dialog and nothing is sent", async () => {
    const seen = await at("/", top(), 4);
    fireEvent.click(document.querySelector("[data-new-folder]")!);
    await typeName("Alpha", "Create");
    expect(
      await screen.findByText("“Alpha” is already used in this folder. Choose another name."),
    ).toBeTruthy();
    expect(seen.events).toEqual([]);
    await typeName("Gamma", "Create");
    await waitFor(() => expect(seen.events).toEqual([[null]]));
    seen.stop();
  });

  it("rename: the parent", async () => {
    const seen = await at("/", top(), 4);
    await menuAction(NOTES.id, "rename");
    await typeName("minutes.pdf", "Rename");
    await waitFor(() => expect(seen.events).toEqual([[null]]));
    seen.stop();
  });

  it("a star and an unstar: [node.parentId] each time", async () => {
    const inside = fileNode(5, { parentId: ALPHA.id, name: "inside.pdf" });
    const drive = top().add(inside);
    const seen = await at(`/folder/${ALPHA.id}`, drive, 1);
    await menuAction(inside.id, "star");
    await waitFor(() => expect(seen.events).toEqual([[ALPHA.id]]));
    expect(drive.nodes.get(inside.id)!.starred).toBe(true);
    await waitFor(() => expect(drive.callsTo("GET", /\/children$/).length).toBeGreaterThan(1));
    await menuAction(inside.id, "star");
    await waitFor(() => expect(seen.events).toEqual([[ALPHA.id], [ALPHA.id]]));
    expect(drive.nodes.get(inside.id)!.starred).toBe(false);
    seen.stop();
  });

  it("move: the old parent and the new one", async () => {
    const drive = top();
    const seen = await at("/", drive, 4);
    await menuAction(NOTES.id, "move");
    const tree = await screen.findByRole("tree");
    fireEvent.click(await within(tree).findByText("Alpha"));
    fireEvent.click(document.querySelector("[data-move-confirm]")!);
    await waitFor(() => expect(seen.events).toEqual([[null, ALPHA.id]]));
    expect(drive.nodes.get(NOTES.id)!.parentId).toBe(ALPHA.id);
    await waitForRows(3);
    seen.stop();
  });

  it("trash: the parent; undo: the parent it left and the one it came back to", async () => {
    const inside = fileNode(5, { parentId: ALPHA.id, name: "inside.pdf" });
    const drive = top().add(inside);
    const seen = await at(`/folder/${ALPHA.id}`, drive, 1);
    await menuAction(inside.id, "trash");
    await waitFor(() => expect(seen.events).toEqual([[ALPHA.id]]));
    expect(drive.trashed.has(inside.id)).toBe(true);
    const undo = getToasts().find((entry) => entry.key === "undo")!;
    expect(undo.message).toBe("“inside.pdf” moved to trash");
    await act(async () => undo.action!.onClick());
    await waitFor(() => expect(seen.events).toEqual([[ALPHA.id], [ALPHA.id]]));
    await waitForRows(1);
    seen.stop();
  });

  it("undo of a trash whose folder is gone: both the old parent and the top level", async () => {
    const inside = fileNode(5, { parentId: ALPHA.id, name: "inside.pdf" });
    const drive = top().add(inside);
    const seen = await at(`/folder/${ALPHA.id}`, drive, 1);
    await menuAction(inside.id, "trash");
    await waitFor(() => expect(seen.events).toHaveLength(1));
    drive.nodes.delete(ALPHA.id);
    await act(async () =>
      getToasts()
        .find((entry) => entry.key === "undo")!
        .action!.onClick(),
    );
    await waitFor(() => expect(seen.events[1]).toEqual([ALPHA.id, null]));
    seen.stop();
  });

  it("several at once: one event, one toast, one Undo for all", async () => {
    const drive = top();
    const seen = await at("/", drive, 4);
    fireEvent.click(rowOf(NOTES.id)!);
    fireEvent.click(rowOf(PHOTO.id)!, { ctrlKey: true });
    expect(selectedIds()).toEqual([NOTES.id, PHOTO.id]);
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: /Move to trash/ }));
    await waitFor(() => expect(seen.events).toEqual([[null]]));
    await waitForRows(2);
    expect(toastMessages()).toEqual(["2 items moved to trash"]);
    seen.stop();
  });
});

describe("the uploader is asked through its slot", () => {
  it("Upload in a folder calls requestUpload({ parentId })", async () => {
    serveDrive(top().add(fileNode(5, { parentId: ALPHA.id })));
    renderExplorer(`/folder/${ALPHA.id}`);
    await waitForRows(1);
    await waitFor(() => expect(document.querySelector("[data-upload]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-upload]")!);
    expect(vi.mocked(requestUpload).mock.calls).toEqual([[{ parentId: ALPHA.id }]]);
  });

  it("at the top level there is no parent to name", async () => {
    vi.mocked(requestUpload).mockClear();
    serveDrive(new FakeDrive());
    renderExplorer("/");
    await waitFor(() => expect(document.querySelector("[data-empty-upload]")).not.toBeNull());
    fireEvent.click(document.querySelector("[data-empty-upload]")!);
    expect(vi.mocked(requestUpload).mock.calls).toEqual([[{ parentId: undefined }]]);
  });
});

describe("roles in a shared folder", () => {
  const shared = (role: NodeDto["role"]) => {
    const root = folderNode(20, { name: "Shared project", role, owner: OTHER, parentId: nodeId(19) });
    const sub = folderNode(21, { name: "Drafts", role, owner: OTHER, parentId: root.id });
    const file = fileNode(22, { name: "plan.pdf", role, owner: OTHER, parentId: root.id });
    return { root, sub, file, drive: new FakeDrive([root, sub, file]) };
  };

  it("a viewer sees no mutating action anywhere", async () => {
    const { root, sub, file, drive } = shared("viewer");
    serveDrive(drive);
    renderExplorer(`/folder/${root.id}`);
    await waitForRows(2);
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Shared project"));
    expect(document.querySelector("[data-new-folder]")).toBeNull();
    expect(document.querySelector("[data-upload]")).toBeNull();
    expect(findCommand(COMMAND_IDS.newFolder)?.disabled).toBe(true);
    expect(findCommand(COMMAND_IDS.rename)?.disabled).toBe(true);
    expect(findCommand(COMMAND_IDS.trash)?.disabled).toBe(true);
    expect((await openMenu(file.id)).ids).toEqual(["open", "download"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect((await openMenu(sub.id)).ids).toEqual(["open", "zip"]);
    // Not draggable, and the trail starts at the share root: no way up to the owner's tree.
    expect(rowOf(file.id)!.getAttribute("draggable")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("an editor may add, rename, move and trash inside — but not star, share or Re-check", async () => {
    const { root, file, drive } = shared("editor");
    serveDrive(drive);
    renderExplorer(`/folder/${root.id}`);
    await waitForRows(2);
    await waitFor(() => expect(document.querySelector("[data-new-folder]")).not.toBeNull());
    expect((await openMenu(file.id)).ids).toEqual(["open", "download", "rename", "move", "trash"]);
    expect(rowOf(file.id)!.getAttribute("draggable")).toBe("true");
  });

  it("the move picker of a share starts at the share root, not at the caller's own files", async () => {
    const { root, file, drive } = shared("editor");
    serveDrive(drive);
    renderExplorer(`/folder/${root.id}`);
    await waitForRows(2);
    await menuAction(file.id, "move");
    const tree = await screen.findByRole("tree");
    const items = await within(tree).findAllByRole("treeitem");
    expect(items[0]!.getAttribute("aria-label")).toBe("Shared project");
    expect(within(tree).queryByText("My files")).toBeNull();
    await within(tree).findByText("Drafts");
    expect(drive.callsTo("GET", /\/nodes\/root$/)).toHaveLength(0);
  });
});

describe("sharing waits for the sharing task", () => {
  it("the share action is shown, disabled, with the reason", async () => {
    serveDrive(top());
    renderExplorer("/");
    await waitForRows(4);
    const { menu } = await openMenu(NOTES.id);
    const share = menu.querySelector<HTMLElement>('[data-action="share"]')!;
    expect(share.getAttribute("aria-disabled")).toBe("true");
    expect(share.textContent).toContain("Sharing isn't switched on yet");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // The selection bar offers the same list under More.
    fireEvent.click(rowOf(NOTES.id)!);
    fireEvent.click(within(screen.getByRole("toolbar")).getByRole("button", { name: "More" }));
    const more = await screen.findByRole("menu");
    expect(more.querySelector('[data-action="share"]')!.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("opening", () => {
  it("a file goes to the preview route with its siblings and where it came from", async () => {
    serveDrive(top());
    const { router } = renderExplorer("/");
    await waitForRows(4);
    fireEvent.keyDown(rowOf(NOTES.id)!, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/preview/${NOTES.id}`));
    expect(router.state.location.state).toEqual({ siblingIds: [NOTES.id, PHOTO.id], from: "/" });
  });

  it("a folder goes to its own route (double-click and Enter)", async () => {
    serveDrive(top());
    const { router } = renderExplorer("/");
    await waitForRows(4);
    fireEvent.doubleClick(rowOf(ALPHA.id)!);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/folder/${ALPHA.id}`));
  });

  it("a file that is still scanning or blocked does not open; the reason is said", async () => {
    const pending = fileNode(7, { name: "new.pdf", scanStatus: "pending" });
    const blocked = fileNode(8, { name: "bad.exe", scanStatus: "infected" });
    serveDrive(top().add(pending, blocked));
    const { router } = renderExplorer("/");
    await waitForRows(6);
    fireEvent.keyDown(rowOf(pending.id)!, { key: "Enter" });
    fireEvent.keyDown(rowOf(blocked.id)!, { key: "Enter" });
    expect(router.state.location.pathname).toBe("/");
    expect(toastMessages()).toEqual(["Blocked — flagged by the malware scan"]);
  });
});

describe("keyboard", () => {
  it("Shift+F10 and the menu key open the row's menu; every entry with a shortcut shows it", async () => {
    serveDrive(top());
    renderExplorer("/");
    await waitForRows(4);
    const row = rowOf(NOTES.id)!;
    row.focus();
    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    const menu = await screen.findByRole("menu");
    expect(selectedIds()).toEqual([NOTES.id]);
    for (const [action, key] of [
      ["open", "↵"],
      ["rename", "F2"],
      ["trash", "Del"],
    ])
      expect(menu.querySelector(`[data-action="${action}"] kbd`)!.textContent).toBe(key);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.keyDown(row, { key: "ContextMenu" });
    expect(await screen.findByRole("menu")).toBeTruthy();
  });

  it("the commands the frame's keys run: new folder, rename and trash act on the focused row", async () => {
    const drive = top();
    serveDrive(drive);
    renderExplorer("/");
    await waitForRows(4);
    expect(findCommand(COMMAND_IDS.newFolder)?.disabled).toBe(false);
    rowOf(NOTES.id)!.focus();
    act(() => void runCommand(COMMAND_IDS.rename));
    expect(within(await dialog()).getByRole<HTMLInputElement>("textbox").value).toBe("notes.pdf");
    fireEvent.click(within(await dialog()).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // Focus comes back to the row the dialog was about.
    await waitFor(() => expect(document.activeElement).toBe(rowOf(NOTES.id)));
    act(() => void runCommand(COMMAND_IDS.trash));
    await waitFor(() => expect(drive.trashed.has(NOTES.id)).toBe(true));
    // …and after the row is gone, to the one that took its place.
    await waitFor(() => expect(document.activeElement).toBe(rowOf(PHOTO.id)));
  });

  it("Space selects the focused row, select-all takes everything, Escape clears", async () => {
    serveDrive(top());
    renderExplorer("/");
    await waitForRows(4);
    const row = rowOf(ALPHA.id)!;
    fireEvent.keyDown(row, { key: " " });
    expect(selectedIds()).toEqual([ALPHA.id]);
    expect(document.querySelector("[data-selection-live]")!.textContent).toBe("1 selected");
    fireEvent.keyDown(row, { key: "a", ctrlKey: true });
    expect(selectedIds()).toHaveLength(4);
    expect(screen.getByRole("toolbar").getAttribute("aria-label")).toBe("4 selected");
    expect(document.querySelector("[data-explorer-toolbar]")).toBeNull();
    fireEvent.keyDown(row, { key: "Escape" });
    expect(selectedIds()).toEqual([]);
    expect(document.querySelector("[data-explorer-toolbar]")).not.toBeNull();
  });
});

describe("details", () => {
  it("one selected file: size, type, dates, digest, scan status in plain English, sharing", async () => {
    serveDrive(top());
    renderExplorer("/");
    await waitForRows(4);
    const panel = document.querySelector<HTMLElement>("[data-details-panel]")!;
    expect(panel.textContent).toContain("Nothing selected");
    fireEvent.click(rowOf(NOTES.id)!);
    await waitFor(() => expect(panel.querySelector(`[data-explorer-details="${NOTES.id}"]`)).not.toBeNull());
    expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe("notes.pdf");
    expect(panel.textContent).toContain("PDF document · pdf");
    expect(panel.textContent).toContain("3 KB");
    expect(panel.querySelector("[data-sha256]")!.textContent).toBe(NOTES.sha256);
    expect(panel.textContent).toContain("Scanned. Nothing harmful found.");
    expect(panel.textContent).toContain("Not shared");
    expect(panel.querySelector("[data-recheck]")).toBeNull();
  });

  it("several selected: a count; none, in a folder: the folder itself", async () => {
    const inside = fileNode(5, { parentId: ALPHA.id, name: "inside.pdf" });
    const other = fileNode(6, { parentId: ALPHA.id, name: "other.pdf" });
    serveDrive(top().add(inside, other));
    renderExplorer(`/folder/${ALPHA.id}`);
    await waitForRows(2);
    const panel = document.querySelector<HTMLElement>("[data-details-panel]")!;
    await waitFor(() => expect(panel.querySelector(`[data-explorer-details="${ALPHA.id}"]`)).not.toBeNull());
    fireEvent.click(rowOf(inside.id)!);
    fireEvent.click(rowOf(other.id)!, { shiftKey: true });
    await waitFor(() => expect(panel.querySelector('[data-explorer-details="selection"]')).not.toBeNull());
    expect(panel.textContent).toContain("2 items");
    expect(panel.textContent).toContain("2 files, 0 folders · 11 KB");
  });

  it("Re-check on a file that could not be scanned posts the rescan and the row goes back to scanning", async () => {
    const broken = fileNode(9, { name: "broken.bin", scanStatus: "error", scanReason: "engine" });
    const drive = top().add(broken);
    serveDrive(drive);
    renderExplorer("/");
    await waitForRows(5);
    fireEvent.click(rowOf(broken.id)!);
    const panel = document.querySelector<HTMLElement>("[data-details-panel]")!;
    await waitFor(() => expect(panel.querySelector("[data-recheck]")).not.toBeNull());
    expect(panel.textContent).toContain("Couldn't scan. The scanner had a problem. Check it again.");
    fireEvent.click(panel.querySelector("[data-recheck]")!);
    await waitFor(() => expect(rowOf(broken.id)!.getAttribute("data-scan")).toBe("pending"));
    expect(drive.callsTo("POST", /\/rescan$/)).toHaveLength(1);
    expect(rowOf(broken.id)!.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(toastMessages()).toEqual([]);
  });

  it("leaving the page empties the panel", async () => {
    serveDrive(top());
    const view = renderExplorer("/");
    await waitForRows(4);
    fireEvent.click(rowOf(NOTES.id)!);
    const panel = document.querySelector<HTMLElement>("[data-details-panel]")!;
    await waitFor(() => expect(panel.querySelector("[data-explorer-details]")).not.toBeNull());
    await act(async () => void (await view.router.navigate(`/preview/${NOTES.id}`)));
    expect(panel.querySelector("[data-explorer-details]")).toBeNull();
  });
});

describe("downloading one file", () => {
  it("asks for a download URL and hands it to a hidden <a download>", async () => {
    const drive = top();
    serveDrive(drive);
    const clicked: Array<{ href: string; download: string | null }> = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.getAttribute("download") });
    });
    renderExplorer("/");
    await waitForRows(4);
    await menuAction(NOTES.id, "download");
    await waitFor(() => expect(clicked).toHaveLength(1));
    expect(drive.callsTo("POST", /\/download-url$/)[0]!.body).toEqual({ kind: "download" });
    expect(clicked[0]!.href).toMatch(new RegExp(`^http://files\\.localhost:3000/d/${NOTES.id}/token-`));
    expect(clicked[0]!.download).toBe("");
    // Nothing of the URL stays in the document.
    expect(document.querySelector(`a[href*="token-"]`)).toBeNull();
  });

  it("an unscanned file downloads for its owner with the warning", async () => {
    const unscanned = fileNode(9, { name: "big.iso", scanStatus: "skipped", scanReason: "size" });
    serveDrive(top().add(unscanned));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    renderExplorer("/");
    await waitForRows(5);
    const { menu } = await openMenu(unscanned.id);
    expect(menu.querySelector('[data-action="download"]')!.textContent).toContain("Download unscanned file");
    pick(menu, "download");
    await waitFor(() =>
      expect(toastMessages()).toEqual([
        "This file couldn't be scanned. Open it only if you trust where it came from.",
      ]),
    );
  });
});

describe("drag and drop", () => {
  /** A stand-in for the browser's DataTransfer (jsdom has none). */
  const transfer = (types: string[] = []) => ({
    types,
    effectAllowed: "",
    dropEffect: "",
    setData(type: string) {
      this.types.push(type);
    },
  });

  it("a row dropped on a folder row moves it there; the target shows the dashed ring while over it", async () => {
    const drive = top();
    serveDrive(drive);
    renderExplorer("/");
    await waitForRows(4);
    const seen = recordNodesChanged();
    const data = transfer();
    fireEvent.dragStart(rowOf(NOTES.id)!, { dataTransfer: data });
    expect(data.types).toEqual(["application/x-holdfast-nodes"]);
    fireEvent.dragOver(rowOf(ALPHA.id)!, { dataTransfer: data });
    expect(rowOf(ALPHA.id)!.getAttribute("data-drop-target")).toBe("true");
    expect(rowOf(ALPHA.id)!.style.outline).toContain("dashed");
    // A file is not a place to drop.
    fireEvent.dragOver(rowOf(PHOTO.id)!, { dataTransfer: data });
    expect(rowOf(PHOTO.id)!.getAttribute("data-drop-target")).toBeNull();
    fireEvent.drop(rowOf(ALPHA.id)!, { dataTransfer: data });
    await waitFor(() => expect(drive.nodes.get(NOTES.id)!.parentId).toBe(ALPHA.id));
    await waitFor(() => expect(seen.events).toEqual([[null, ALPHA.id]]));
    expect(rowOf(ALPHA.id)!.getAttribute("data-drop-target")).toBeNull();
    seen.stop();
  });

  it("a selected row drags the whole selection; a folder cannot be dropped on itself", async () => {
    const drive = top();
    serveDrive(drive);
    renderExplorer("/");
    await waitForRows(4);
    fireEvent.click(rowOf(NOTES.id)!);
    fireEvent.click(rowOf(BETA.id)!, { ctrlKey: true });
    const data = transfer();
    fireEvent.dragStart(rowOf(BETA.id)!, { dataTransfer: data });
    fireEvent.dragOver(rowOf(BETA.id)!, { dataTransfer: data });
    expect(rowOf(BETA.id)!.getAttribute("data-drop-target")).toBeNull();
    fireEvent.drop(rowOf(ALPHA.id)!, { dataTransfer: data });
    await waitFor(() => expect(drive.callsTo("POST", /\/move$/)).toHaveLength(2));
    expect(drive.nodes.get(NOTES.id)!.parentId).toBe(ALPHA.id);
    expect(drive.nodes.get(BETA.id)!.parentId).toBe(ALPHA.id);
  });

  it("a row dropped on a breadcrumb moves it to that folder (here: up to the top level)", async () => {
    const inside = fileNode(5, { parentId: ALPHA.id, name: "inside.pdf" });
    const drive = top().add(inside);
    serveDrive(drive);
    renderExplorer(`/folder/${ALPHA.id}`);
    await waitForRows(1);
    const files = await screen.findByRole("link", { name: "Files" });
    const data = transfer();
    fireEvent.dragStart(rowOf(inside.id)!, { dataTransfer: data });
    fireEvent.dragOver(files, { dataTransfer: data });
    await waitFor(() => expect(files.getAttribute("data-drop-target")).toBe("true"));
    expect(files.style.outline).toContain("dashed");
    fireEvent.drop(files, { dataTransfer: data });
    await waitFor(() => expect(drive.nodes.get(inside.id)!.parentId).toBeNull());
    expect(drive.callsTo("POST", /\/move$/)[0]!.body).toEqual({ parentId: null });
    await waitForRows(0);
  });

  it("files dragged in from the desktop are not this feature's: no ring, no move", async () => {
    const drive = top();
    serveDrive(drive);
    renderExplorer("/");
    await waitForRows(4);
    const data = transfer(["Files"]);
    fireEvent.dragOver(rowOf(ALPHA.id)!, { dataTransfer: data });
    expect(rowOf(ALPHA.id)!.getAttribute("data-drop-target")).toBeNull();
    fireEvent.drop(rowOf(ALPHA.id)!, { dataTransfer: data });
    await act(async () => {});
    expect(drive.callsTo("POST", /\/move$/)).toHaveLength(0);
  });
});

describe("underneath a preview the page is not the page in front", () => {
  it("its commands are withdrawn: the Delete key cannot trash a selection the user cannot see", async () => {
    const drive = top();
    // The real frame and route tree: the overlay route keeps the explorer mounted underneath.
    shellFetch({
      session: sessionOf(),
      extra: (call) => {
        const answer = drive.handle({ method: call.method, path: call.path, body: call.body });
        return answer ? json(answer.body, answer.status) : undefined;
      },
    });
    const { router } = renderRoutes(buildRoutes(), ["/"]);
    await waitForRows(4);
    fireEvent.click(rowOf(NOTES.id)!);
    expect(selectedIds()).toEqual([NOTES.id]);
    expect(findCommand(COMMAND_IDS.trash)?.disabled).toBe(false);

    await act(async () => void (await router.navigate(`/preview/${NOTES.id}`, { state: { from: "/" } })));
    await waitFor(() => expect(document.querySelector("[data-overlay]")).not.toBeNull());
    // Still mounted, selection and all — but inert, and with nothing registered to act on it.
    expect(document.querySelector('[data-background="kept"] [data-explorer]')).not.toBeNull();
    expect(selectedIds()).toEqual([NOTES.id]);
    expect(findCommand(COMMAND_IDS.trash)).toBeUndefined();
    expect(findCommand(COMMAND_IDS.rename)).toBeUndefined();
    expect(findCommand(COMMAND_IDS.newFolder)).toBeUndefined();
    fireEvent.keyDown(document.body, { key: "Delete" });
    fireEvent.keyDown(document.body, { key: "F2" });
    await act(async () => {});
    expect(drive.callsTo("POST", /\/trash$/)).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();

    // Back in front: the same key works again.
    await act(async () => void (await router.navigate(-1)));
    await waitFor(() => expect(findCommand(COMMAND_IDS.trash)?.disabled).toBe(false));
    fireEvent.keyDown(document.body, { key: "Delete" });
    await waitFor(() => expect(drive.callsTo("POST", /\/trash$/)).toHaveLength(1));
  });
});
