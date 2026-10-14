import { describe, expect, it } from "vitest";
import {
  actionsFor,
  actionsForSelection,
  buildCrumbs,
  canAddTo,
  kindLabel,
  scanSentence,
  shareRootOf,
  sharingSentence,
  siblingWindow,
  truncateMiddle,
  type ExplorerAction,
} from "../../../../src/client/features/explorer/model";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { detailOf, fileNode, folderNode, nodeId, OTHER } from "./fixtures/nodes";

const list = (set: ReadonlySet<ExplorerAction>) => Array.from(set).sort();
const actions = (node: NodeDto, isShareRoot = false) => list(actionsFor(node, { isShareRoot }));

describe("role gating", () => {
  const MUTATING: ExplorerAction[] = ["rename", "move", "star", "share", "trash", "recheck"];

  it("an owner may do everything to a clean file", () => {
    expect(actions(fileNode(1))).toEqual(
      ["download", "move", "open", "rename", "share", "star", "trash", "zip"].sort(),
    );
  });

  it("a viewer sees no mutating action — on a file, a folder or an unscanned file", () => {
    for (const node of [
      fileNode(1, { role: "viewer", owner: OTHER }),
      folderNode(2, { role: "viewer", owner: OTHER }),
      fileNode(3, { role: "viewer", owner: OTHER, scanStatus: "error" }),
    ]) {
      for (const action of MUTATING)
        expect(actionsFor(node, { isShareRoot: false }).has(action), action).toBe(false);
    }
    expect(actions(fileNode(1, { role: "viewer", owner: OTHER }))).toEqual(["download", "open", "zip"]);
    expect(actions(folderNode(2, { role: "viewer", owner: OTHER }))).toEqual(["open", "zip"]);
    expect(canAddTo("viewer")).toBe(false);
  });

  it("an editor may rename, move and trash inside a share — never star, share or Re-check", () => {
    const file = fileNode(1, { role: "editor", owner: OTHER });
    expect(actions(file)).toEqual(["download", "move", "open", "rename", "trash", "zip"]);
    expect(actions(folderNode(2, { role: "editor", owner: OTHER }))).toEqual([
      "move",
      "open",
      "rename",
      "trash",
      "zip",
    ]);
    expect(canAddTo("editor")).toBe(true);
  });

  it("an editor may not rename, move or trash the share root itself", () => {
    const root = folderNode(2, { role: "editor", owner: OTHER });
    expect(actions(root, true)).toEqual(["open", "zip"]);
    // The owner is never limited by it.
    expect(actions(folderNode(2), true)).toContain("rename");
  });

  it("the share root is where a non-owner's breadcrumbs start (the folder itself when it has none)", () => {
    const shared = folderNode(5, { role: "editor", owner: OTHER, parentId: nodeId(4) });
    expect(shareRootOf(detailOf(shared, [{ id: nodeId(4), name: "Shared" }]))).toBe(nodeId(4));
    expect(shareRootOf(detailOf(folderNode(4, { role: "editor", owner: OTHER })))).toBe(nodeId(4));
    expect(shareRootOf(detailOf(folderNode(4)))).toBeNull();
    expect(shareRootOf(null)).toBeNull();
  });
});

describe("row states → available actions", () => {
  it.each([
    ["pending", ["move", "rename", "trash"]],
    ["clean", ["download", "move", "open", "rename", "share", "star", "trash", "zip"]],
    ["infected", ["trash"]],
    ["under_review", ["trash"]],
    ["skipped", ["download", "move", "open", "recheck", "rename", "star", "trash"]],
    ["error", ["download", "move", "open", "recheck", "rename", "star", "trash"]],
  ] as const)("owner, %s", (scanStatus, expected) => {
    expect(actions(fileNode(1, { scanStatus }))).toEqual([...expected]);
  });

  it("an unscanned file is never shareable and never zipped, for anyone", () => {
    for (const scanStatus of ["skipped", "error"] as const) {
      const allowed = actionsFor(fileNode(1, { scanStatus }), { isShareRoot: false });
      expect(allowed.has("share")).toBe(false);
      expect(allowed.has("zip")).toBe(false);
    }
  });

  it("only the owner downloads an unscanned file", () => {
    const theirs = fileNode(1, { scanStatus: "skipped", role: "editor", owner: OTHER });
    expect(actionsFor(theirs, { isShareRoot: false }).has("download")).toBe(false);
    // …and only the owner is offered to open it: a preview the server refuses is not offered.
    expect(actionsFor(theirs, { isShareRoot: false }).has("open")).toBe(false);
    expect(
      actionsFor(fileNode(1, { scanStatus: "error", role: "viewer", owner: OTHER }), { isShareRoot: false })
        .size,
    ).toBe(0);
    expect(actionsFor(fileNode(1, { scanStatus: "skipped" }), { isShareRoot: false }).has("open")).toBe(true);
    expect(actionsFor(fileNode(1, { scanStatus: "skipped" }), { isShareRoot: false }).has("download")).toBe(
      true,
    );
  });

  it("a blocked file offers trash only — to an editor too, and nothing to a viewer", () => {
    expect(actions(fileNode(1, { scanStatus: "infected", role: "editor", owner: OTHER }))).toEqual(["trash"]);
    expect(actions(fileNode(1, { scanStatus: "infected", role: "viewer", owner: OTHER }))).toEqual([]);
  });
});

describe("actions on a selection", () => {
  it("several items: move, star and trash when every one allows it; zip when any can be held", () => {
    const set = actionsForSelection([fileNode(1), folderNode(2)], null);
    expect(list(set)).toEqual(["move", "star", "trash", "zip"]);
  });

  it("one blocked file in the selection leaves trash (and a zip of the rest)", () => {
    const set = actionsForSelection([fileNode(1), fileNode(2, { scanStatus: "infected" })], null);
    expect(list(set)).toEqual(["trash", "zip"]);
  });

  it("rename, open, share and Re-check never apply to several items", () => {
    const set = actionsForSelection(
      [fileNode(1, { scanStatus: "error" }), fileNode(2, { scanStatus: "error" })],
      null,
    );
    for (const action of ["rename", "open", "share", "recheck"] as const) expect(set.has(action)).toBe(false);
  });

  it("the share root in a selection blocks move and trash for a non-owner", () => {
    const root = folderNode(2, { role: "editor", owner: OTHER });
    const inside = fileNode(3, { role: "editor", owner: OTHER, parentId: root.id });
    expect(list(actionsForSelection([root, inside], root.id))).toEqual(["zip"]);
    expect(list(actionsForSelection([inside], root.id))).toContain("trash");
  });

  it("nothing selected, nothing to do", () => {
    expect(actionsForSelection([], null).size).toBe(0);
  });
});

describe("the trail", () => {
  it("the top level is one crumb", () => {
    expect(buildCrumbs(null, null)).toEqual([{ label: "Files" }]);
  });

  it("an owner's folder: Files, the ancestors, then the folder with its id", () => {
    const folder = folderNode(3, { parentId: nodeId(2), name: "Invoices" });
    const crumbs = buildCrumbs(
      folder.id,
      detailOf(folder, [
        { id: nodeId(1), name: "Work" },
        { id: nodeId(2), name: "2026" },
      ]),
    );
    expect(crumbs).toEqual([
      { label: "Files", to: "/" },
      { label: "Work", to: `/folder/${nodeId(1)}`, id: nodeId(1) },
      { label: "2026", to: `/folder/${nodeId(2)}`, id: nodeId(2) },
      { label: "Invoices", id: folder.id },
    ]);
  });

  it("inside a share it starts at the share root, as the API returns it — no Files crumb", () => {
    const folder = folderNode(3, { parentId: nodeId(2), name: "Drafts", role: "viewer", owner: OTHER });
    const crumbs = buildCrumbs(folder.id, detailOf(folder, [{ id: nodeId(2), name: "Shared project" }]));
    expect(crumbs!.map((crumb) => crumb.label)).toEqual(["Shared project", "Drafts"]);
  });

  it("a trail that already ends with the folder does not name it twice", () => {
    const folder = folderNode(3, { name: "Invoices" });
    const crumbs = buildCrumbs(folder.id, detailOf(folder, [{ id: folder.id, name: "Invoices" }]));
    expect(crumbs!.map((crumb) => crumb.label)).toEqual(["Files", "Invoices"]);
  });

  it("no trail while the folder is unknown", () => {
    expect(buildCrumbs(nodeId(3), null)).toBeNull();
  });

  it("middle truncation keeps the first crumb and the last ones", () => {
    const crumbs = ["Files", "a", "b", "c", "d", "e"].map((label) => ({ label }));
    expect(truncateMiddle(crumbs, 4).map((crumb) => crumb.label)).toEqual(["Files", "…", "d", "e"]);
    expect(truncateMiddle(crumbs, 6)).toBe(crumbs);
    expect(truncateMiddle(crumbs.slice(0, 2), 4)).toHaveLength(2);
  });
});

describe("plain-English lines", () => {
  it("scan status: a sentence per status, with the reason when the scan could not run", () => {
    expect(scanSentence(fileNode(1))).toBe("Scanned. Nothing harmful found.");
    expect(scanSentence(fileNode(1, { scanStatus: "pending" }))).toMatch(/^Scanning now/);
    expect(scanSentence(fileNode(1, { scanStatus: "infected" }))).toMatch(
      /^Blocked — flagged by the malware scan/,
    );
    expect(scanSentence(fileNode(1, { scanStatus: "under_review" }))).toMatch(/^Under review/);
    expect(scanSentence(fileNode(1, { scanStatus: "skipped", scanReason: "size" }))).toBe(
      "Couldn't scan. It is too large to scan.",
    );
    expect(scanSentence(fileNode(1, { scanStatus: "error", scanReason: "timeout" }))).toBe(
      "Couldn't scan. The scan took too long. Check it again.",
    );
    expect(scanSentence(fileNode(1, { scanStatus: "error" }))).toBe("Couldn't scan.");
  });

  it("under review names no category and no reporter", () => {
    expect(scanSentence(fileNode(1, { scanStatus: "under_review" }))).not.toMatch(
      /report|csam|abuse|copyright/i,
    );
  });

  it("kind and sharing", () => {
    expect(kindLabel(folderNode(1))).toBe("Folder");
    expect(kindLabel(fileNode(1))).toBe("PDF document · pdf");
    expect(sharingSentence({ people: 0, link: "none", summary: "none" })).toBe("Not shared");
    expect(sharingSentence({ people: 1, link: "none", summary: "people" })).toBe("Shared with 1 person");
    expect(sharingSentence({ people: 3, link: "active", summary: "both" })).toBe(
      "Shared with 3 people · Anyone with the link",
    );
    expect(sharingSentence({ people: 0, link: "paused", summary: "link" })).toBe("Link paused");
  });

  it("a preview steps through the files around the one opened, never the folders", () => {
    const nodes = [folderNode(1), fileNode(2), fileNode(3), fileNode(4)];
    expect(siblingWindow(nodes, nodeId(3))).toEqual([nodeId(2), nodeId(3), nodeId(4)]);
    expect(siblingWindow(nodes, nodeId(3), 0)).toEqual([nodeId(3)]);
  });
});
