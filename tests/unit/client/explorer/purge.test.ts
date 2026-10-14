// Account state: what this feature keeps outside the query cache is emptied when the account
// signs out or changes — the registered purgers do it, through the shell's one routine.
import { InfiniteQueryObserver } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot } from "../../../../src/client/components/TransferRibbon";
import { announce, getAnnouncement } from "../../../../src/client/features/explorer/actions";
import {
  beginEdit,
  explorerKeys,
  getSort,
  invalidateParents,
  MAX_REFETCH_PAGES,
  setSort,
  useListingChanged,
} from "../../../../src/client/features/explorer/queries";
import { getZipJobs, startZip } from "../../../../src/client/features/explorer/zip";
import { runUserStatePurgers } from "../../../../src/client/lib/contracts";
import { purgeUserState, queryClient } from "../../../../src/client/lib/query";
import type { MockCall } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode, pageOf } from "./fixtures/nodes";
import { deferred, renderExplorer, serveDrive, setupExplorer } from "./helpers";

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

  it("the note that a long folder changed (it is keyed by the folder's id) is dropped", async () => {
    const key = explorerKeys.listing(FOLDER.id, "name", "asc");
    queryClient.setQueryData(key, {
      pages: Array.from({ length: MAX_REFETCH_PAGES + 1 }, () => pageOf([FILE])),
      pageParams: [undefined],
    });
    // An observer makes the listing "active": a long active listing is marked, not refetched.
    const observer = new InfiniteQueryObserver(queryClient, {
      queryKey: key,
      queryFn: () => pageOf([FILE]),
      initialPageParam: undefined,
      getNextPageParam: () => undefined,
      staleTime: Infinity,
    });
    const stop = observer.subscribe(() => {});
    const { result } = renderHook(() => useListingChanged(FOLDER.id));
    act(() => invalidateParents(queryClient, [FOLDER.id]));
    expect(result.current).toBe(true);
    stop();
    await act(async () => {
      await runUserStatePurgers();
    });
    expect(result.current).toBe(false);
  });

  it("an edit in flight (a folder's reads wait for it) is forgotten: a waiting read goes ahead", async () => {
    const calls = serveDrive(new FakeDrive([FILE]));
    // An edit that never settles (its request outlived the sign-out).
    beginEdit([null]);
    renderExplorer("/");
    await vi.waitFor(() =>
      expect(queryClient.isFetching({ queryKey: explorerKeys.children(null) })).toBeGreaterThan(0),
    );
    expect(calls.filter((call) => call.path.startsWith("/api/nodes/root"))).toHaveLength(0);
    await act(async () => {
      await runUserStatePurgers();
    });
    await vi.waitFor(() =>
      expect(calls.filter((call) => call.path.startsWith("/api/nodes/root"))).toHaveLength(1),
    );
  });
});
