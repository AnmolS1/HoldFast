// Account state: what this feature keeps outside the query cache is emptied when the account
// signs out or changes — the registered purgers do it, through the shell's one routine.
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import { announce, getAnnouncement } from "../../../../src/client/features/explorer/actions";
import { explorerKeys, getSort, setSort } from "../../../../src/client/features/explorer/queries";
import { getZipJobs, startZip } from "../../../../src/client/features/explorer/zip";
import { runUserStatePurgers } from "../../../../src/client/lib/contracts";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import type { MockCall } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode, pageOf } from "./fixtures/nodes";
import { deferred, serveDrive, setupExplorer } from "./helpers";

setupExplorer();

const FOLDER = folderNode(1, { name: "Trip" });
const FILE = fileNode(2, { parentId: FOLDER.id, name: "a.jpg", size: 10 });
const isFile = (call: MockCall) => call.path.startsWith("/d/");

describe("the explorer's purgers", () => {
  it("a running zip is stopped and forgotten; its file is never saved", async () => {
    const held = deferred<Response>();
    serveDrive(new FakeDrive([FOLDER, FILE]), (call) => (isFile(call) ? held.promise : undefined));
    const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const running = startZip([FOLDER.id], "Trip");
    await vi.waitFor(() => expect(getZipJobs()[0]?.label).toBe("Zipping 0 of 1"));
    expect(getRibbonSnapshot().current?.sourceId).toMatch(/^zip:/);

    await purgeUserState();
    expect(getZipJobs()).toHaveLength(0);
    expect(getRibbonSnapshot().current).toBeNull();
    held.resolve(new Response("bytes of the previous account"));
    expect((await running).outcome).toBe("cancelled");
    expect(clicks).not.toHaveBeenCalled();
    expect(getToasts()).toHaveLength(0);
    // Nothing was published again after the purge.
    expect(getRibbonSnapshot()).toMatchObject({ current: null, openCount: 0 });
  });

  it("the chosen order goes back to the default", async () => {
    setSort({ sort: "size", dir: "desc" });
    expect(getSort()).toEqual({ sort: "size", dir: "desc" });
    await runUserStatePurgers();
    expect(getSort()).toEqual({ sort: "name", dir: "asc" });
  });

  it("the last announcement (it names a file) is cleared", async () => {
    announce("Renamed to salary.pdf");
    await runUserStatePurgers();
    expect(getAnnouncement()).toBe("");
  });

  it("listings live in the query cache, which the same routine empties", async () => {
    queryClient.setQueryData(explorerKeys.listing(null, "name", "asc"), {
      pages: [pageOf([FILE])],
      pageParams: [undefined],
    });
    await purgeUserState();
    expect(queryClient.getQueriesData({ queryKey: explorerKeys.all })).toEqual([]);
  });
});
