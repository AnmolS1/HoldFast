// The row-state table of the task file: for each scan status, what the row shows (sentence and
// colour token — never colour alone) and which actions it offers.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setPrefs } from "../../../../src/client/lib/prefs";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, OTHER } from "./fixtures/nodes";
import { openMenu, renderExplorer, rowOf, serveDrive, setupExplorer, waitForRows } from "./helpers";

setupExplorer();

interface Expected {
  status: NodeDto["scanStatus"];
  /** null = nothing is said in the row. */
  sentence: string | null;
  token: string | null;
  underline: boolean;
  actions: string[];
}

const TABLE: Expected[] = [
  { status: "pending", sentence: null, token: null, underline: true, actions: ["rename", "move", "trash"] },
  {
    status: "clean",
    sentence: null,
    token: null,
    underline: false,
    actions: ["open", "download", "rename", "move", "star", "share", "trash"],
  },
  {
    status: "infected",
    sentence: "Blocked — flagged by the malware scan",
    token: "danger",
    underline: false,
    actions: ["trash"],
  },
  {
    status: "under_review",
    sentence: "Under review",
    token: "textSecondary",
    underline: false,
    actions: ["trash"],
  },
  {
    status: "skipped",
    sentence: "Couldn't scan",
    token: "attention",
    underline: false,
    actions: ["open", "download", "rename", "move", "star", "recheck", "trash"],
  },
  {
    status: "error",
    sentence: "Couldn't scan",
    token: "attention",
    underline: false,
    actions: ["open", "download", "rename", "move", "star", "recheck", "trash"],
  },
];

describe.each(["list", "grid"] as const)("row states (%s view)", (view) => {
  it.each(TABLE)("$status", async ({ status, sentence, token, underline, actions }) => {
    const file = fileNode(1, { name: "report.pdf", scanStatus: status });
    serveDrive(new FakeDrive([file]));
    setPrefs({ viewMode: view });
    renderExplorer("/");
    await waitForRows(1);
    const row = rowOf(file.id)!;
    expect(row.getAttribute("data-scan")).toBe(status);

    const dot = row.querySelector<HTMLElement>("[data-status]");
    if (sentence === null) expect(dot).toBeNull();
    else {
      // A glyph AND a sentence: colour is never the only signal.
      expect(dot!.textContent).toContain(sentence);
      expect(dot!.querySelector("svg")).not.toBeNull();
      expect(dot!.getAttribute("data-token")).toBe(token);
    }
    // The activity colour reaches a row through the progress underline only.
    const bar = row.querySelector('[role="progressbar"]');
    expect(bar !== null).toBe(underline);
    if (underline) expect(bar!.getAttribute("aria-label")).toBe("Scanning report.pdf");

    expect((await openMenu(file.id)).ids).toEqual(actions);
  });
});

describe("row states for people the file is shared with", () => {
  it("a blocked file offers a viewer nothing, and an editor trash only", async () => {
    const viewer = fileNode(1, { name: "a.exe", scanStatus: "infected", role: "viewer", owner: OTHER });
    const editor = fileNode(2, { name: "b.exe", scanStatus: "infected", role: "editor", owner: OTHER });
    serveDrive(new FakeDrive([viewer, editor]));
    renderExplorer("/");
    await waitForRows(2);
    expect((await openMenu(editor.id)).ids).toEqual(["trash"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // No entry at all: no menu opens.
    fireEvent.contextMenu(rowOf(viewer.id)!);
    await waitFor(() => expect(rowOf(viewer.id)!.getAttribute("aria-selected")).toBe("true"));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("an unscanned file is neither downloadable nor opened by an editor (the server would refuse both)", async () => {
    const file = fileNode(1, { name: "big.iso", scanStatus: "skipped", role: "editor", owner: OTHER });
    serveDrive(new FakeDrive([file]));
    renderExplorer("/");
    await waitForRows(1);
    expect((await openMenu(file.id)).ids).toEqual(["rename", "move", "trash"]);
  });
});
