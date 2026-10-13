// B2 — nothing of one account reaches the next through work that outlives its request. For every
// action: the request is held, the account's state is purged (sign-out, or another identity), and
// only then does the request end — well or badly. Afterwards the cache holds nothing of the old
// account, nothing is toasted or announced, no event is sent and nothing is downloaded.
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import {
  createFolderIn,
  downloadNode,
  getAnnouncement,
  moveNodes,
  recheckNode,
  renameNode,
  setStarred,
  trashNodes,
} from "../../../../src/client/features/explorer/actions";
import { explorerKeys, type Listing } from "../../../../src/client/features/explorer/queries";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { envelope, json } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode, pageOf } from "./fixtures/nodes";
import { deferred, recordNodesChanged, serveDrive, setupExplorer } from "./helpers";

setupExplorer();

// Account A's top level.
const SALARY = fileNode(1, { name: "salary-of-A.pdf" });
const DIARY = fileNode(2, { name: "diary-of-A.txt", scanStatus: "error" });
const FOLDER = folderNode(3, { name: "private-of-A" });
const KEY = explorerKeys.listing(null, "name", "asc");

const seed = (nodes: NodeDto[]) =>
  queryClient.setQueryData<Listing>(KEY, { pages: [pageOf(nodes)], pageParams: [undefined] });
const cached = () =>
  queryClient.getQueriesData({ queryKey: explorerKeys.all }).filter(([, data]) => data !== undefined);
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

interface Case {
  name: string;
  /** Which request to hold. */
  held: (method: string, path: string) => boolean;
  run: () => Promise<unknown>;
}

const CASES: Case[] = [
  { name: "rename", held: (m) => m === "PATCH", run: () => renameNode(SALARY, "renamed-by-A.pdf") },
  { name: "star", held: (m) => m === "PATCH", run: () => setStarred([SALARY], true) },
  { name: "trash", held: (_m, p) => p.endsWith("/trash"), run: () => trashNodes([SALARY]) },
  {
    name: "move",
    held: (_m, p) => p.endsWith("/move"),
    run: () => moveNodes([SALARY], { id: FOLDER.id, name: FOLDER.name }),
  },
  {
    name: "new folder",
    held: (_m, p) => p.endsWith("/folder"),
    run: () => createFolderIn(null, "made-by-A"),
  },
  { name: "Re-check", held: (_m, p) => p.endsWith("/rescan"), run: () => recheckNode(DIARY) },
  { name: "download", held: (_m, p) => p.endsWith("/download-url"), run: () => downloadNode(SALARY) },
];

const ENDINGS = [
  [
    "then succeeds",
    (drive: FakeDrive, call: { method: string; path: string; body: unknown }) => {
      const answer = drive.handle(call)!;
      return answer.body === undefined
        ? new Response(null, { status: answer.status })
        : json(answer.body, answer.status);
    },
  ],
  ["then fails with 500", () => envelope("internal", 500)],
  ["then is refused with 409", () => envelope("conflict", 409)],
] as const;

describe.each(CASES)("$name, in flight when the account's state is purged", ({ held, run }) => {
  it.each(ENDINGS)("%s: the next account finds nothing of it", async (_ending, answer) => {
    const drive = new FakeDrive([SALARY, DIARY, FOLDER]);
    const gate = deferred<void>();
    serveDrive(drive, async (call) => {
      if (!held(call.method, call.path)) return undefined;
      await gate.promise;
      return answer(drive, call);
    });
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const seen = recordNodesChanged();
    seed([FOLDER, DIARY, SALARY]);

    const action = run();
    // Let the optimistic part happen and the request leave.
    await turn();
    await turn();

    await purgeUserState();
    expect(cached()).toEqual([]);

    gate.resolve();
    await action;
    await turn();

    // The cache was not re-created, by a rollback or by a late success.
    expect(cached()).toEqual([]);
    expect(JSON.stringify(queryClient.getQueriesData({}))).not.toContain("-of-A");
    // Nothing names the old account's files to the next one.
    expect(getToasts()).toEqual([]);
    expect(getAnnouncement()).toBe("");
    expect(getRibbonSnapshot().current).toBeNull();
    // No sibling view is told to refresh, and nothing is downloaded.
    expect(seen.events).toEqual([]);
    expect(clicks).not.toHaveBeenCalled();
    seen.stop();
  });
});

describe("an Undo kept from the previous account does nothing", () => {
  it("trash → Undo pressed after the purge: no restore is sent", async () => {
    const drive = new FakeDrive([SALARY]);
    serveDrive(drive);
    seed([SALARY]);
    await trashNodes([SALARY]);
    const undo = getToasts().find((entry) => entry.key === "undo")!.action!.onClick;
    await purgeUserState();
    const seen = recordNodesChanged();
    undo();
    await turn();
    await turn();
    expect(drive.callsTo("POST", /\/restore$/)).toHaveLength(0);
    expect(drive.trashed.has(SALARY.id)).toBe(true);
    expect(seen.events).toEqual([]);
    expect(getToasts()).toEqual([]);
    seen.stop();
  });

  it("move → Undo pressed after the purge: nothing is moved back", async () => {
    const drive = new FakeDrive([SALARY, FOLDER]);
    serveDrive(drive);
    seed([FOLDER, SALARY]);
    await moveNodes([SALARY], { id: FOLDER.id, name: FOLDER.name });
    const undo = getToasts().find((entry) => entry.key === "undo")!.action!.onClick;
    await purgeUserState();
    undo();
    await turn();
    await turn();
    expect(drive.callsTo("POST", /\/move$/)).toHaveLength(1);
    expect(drive.nodes.get(SALARY.id)!.parentId).toBe(FOLDER.id);
  });
});

describe("the same actions for the account that is still signed in (the guard does not silence them)", () => {
  it("a failed rename still rolls back and says so", async () => {
    serveDrive(new FakeDrive([SALARY]).fail("PATCH", /./, 409));
    seed([SALARY]);
    expect(await renameNode(SALARY, "other.pdf")).toBe(false);
    expect(queryClient.getQueryData<Listing>(KEY)!.pages[0]!.items[0]!.name).toBe("salary-of-A.pdf");
    expect(getToasts()).toHaveLength(1);
  });
});
