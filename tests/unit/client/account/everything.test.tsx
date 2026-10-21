// "Download everything" (account → Your data): the explorer's zip engine over `{ allOwned: true }`.
// URLs are minted one window of ZIP_URL_BATCH at a time just ahead of the stream — for a
// 10,000-file manifest that is 200 requests, each only when the stream reaches its window — and a
// zip whose account changes stops and asks for nothing more.
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { startZip } from "../../../../src/client/features/explorer";
import { resetZipForTests } from "../../../../src/client/features/explorer/zip";
import { notIncludedText } from "../../../../src/client/features/account/not-included";
import { resetPrefsSync } from "../../../../src/client/features/account/prefs-sync";
import { purgeUserState } from "../../../../src/client/lib/query";
import { buildRoutes } from "../../../../src/client/router";
import { ZIP_MAX_ENTRIES, ZIP_URL_BATCH } from "../../../../src/shared/constants";
import {
  CONFIG,
  json,
  mockFetch,
  renderRoutes,
  seedConfig,
  sessionOf,
  setupShell,
  shellFetch,
  type MockCall,
} from "../shell/helpers";

setupShell();
beforeEach(() => {
  resetZipForTests();
  resetPrefsSync();
  seedConfig();
});

const idOf = (n: number) => `0199c6f0-7b1e-7c3a-8000-${n.toString(16).padStart(12, "0")}`;
const LATER = new Date(Date.now() + 86_400_000).toISOString();

function manifest(count: number, truncated = false) {
  return {
    entries: Array.from({ length: count }, (_, index) => ({
      nodeId: idOf(index + 1),
      path: `folder/file-${index + 1}.txt`,
      size: 1,
      etag: "e",
      modifiedAt: new Date().toISOString(),
    })),
    totalBytes: count,
    skipped: [{ nodeId: idOf(999_999), path: "folder/pending.txt", reason: "scan_pending" }],
    truncated,
  };
}

/** The API and the files host; `order` records, in sequence, each mint window and each file fetched. */
function serve(
  count: number,
  options: { truncated?: boolean; onFile?: (index: number) => Promise<void> | void } = {},
) {
  const order: Array<{ mint: number } | { file: number }> = [];
  const calls = mockFetch(async (call: MockCall) => {
    if (call.path === "/api/nodes/zip-manifest") return json(manifest(count, options.truncated));
    if (call.path === "/api/nodes/download-urls") {
      const ids = (call.body as { nodeIds: string[] }).nodeIds;
      order.push({ mint: ids.length });
      return json({
        items: ids.map((nodeId) => ({
          nodeId,
          url: `${CONFIG.filesOrigin}/d/${nodeId}/token`,
          expiresAt: LATER,
        })),
      });
    }
    if (call.path.startsWith("/d/")) {
      const index = parseInt(call.path.split("/")[2]!.slice(-12), 16);
      order.push({ file: index });
      // The slow consumer: every file takes its time.
      await options.onFile?.(index);
      return new Response("x", { status: 200 });
    }
    return json({ error: "not_found", message: "not found" }, 404);
  });
  return { calls, order };
}

function captureBlob(): { saved: Blob[] } {
  const saved: Blob[] = [];
  vi.stubGlobal(
    "URL",
    Object.assign(URL, {
      createObjectURL: (blob: Blob) => (saved.push(blob), "blob:zip"),
      revokeObjectURL: () => {},
    }),
  );
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  return { saved };
}

describe("Download everything", () => {
  it("the button asks for the manifest of the whole account — { allOwned: true } and nothing else", async () => {
    captureBlob();
    const zips: MockCall[] = [];
    const calls = shellFetch({
      session: sessionOf(),
      extra: (call) => {
        if (call.path === "/api/nodes/zip-manifest") {
          zips.push(call);
          return json(manifest(3));
        }
        if (call.path === "/api/nodes/download-urls") {
          const ids = (call.body as { nodeIds: string[] }).nodeIds;
          return json({
            items: ids.map((nodeId) => ({
              nodeId,
              url: `${CONFIG.filesOrigin}/d/${nodeId}/t`,
              expiresAt: LATER,
            })),
          });
        }
        if (call.path.startsWith("/d/")) return new Response("x", { status: 200 });
        return undefined;
      },
    });
    renderRoutes(buildRoutes(), ["/account/data"]);
    expect(await screen.findByText(/A zip holds at most 10,000 files\./)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Download everything" }));
    await waitFor(() => expect(calls.filter((call) => call.path.startsWith("/d/"))).toHaveLength(3));
    expect(zips.map((call) => call.body)).toEqual([{ allOwned: true }]);
  });

  it("the zip carries _not_included.txt: every file left out and why, and that it holds the first 10,000 only", async () => {
    const { saved } = captureBlob();
    serve(3, { truncated: true });
    const result = await startZip({ allOwned: true }, "holdfast-everything", {
      notIncluded: notIncludedText,
    });
    expect(result.outcome).toBe("saved");
    // client-zip stores without compression: the archive's bytes hold each name and text as is.
    const archive = await saved[0]!.text();
    expect(archive).toContain("_not_included.txt");
    expect(archive).toContain("Not included in this zip\n\nfolder/pending.txt — still being scanned\n");
    expect(archive).toContain("This zip holds the first 10,000 files of your account, not all of them.");
    // The explorer's own zips stay as they were: no such file unless asked for.
    const plain = await startZip({ allOwned: true }, "plain");
    expect(plain.outcome).toBe("saved");
    expect(await saved[1]!.text()).not.toContain("_not_included.txt");
  });

  it(`a ${ZIP_MAX_ENTRIES}-file manifest with a slow consumer: ${ZIP_MAX_ENTRIES / ZIP_URL_BATCH} windows of ${ZIP_URL_BATCH}, each minted only when the stream reaches it`, async () => {
    captureBlob();
    const { calls, order } = serve(ZIP_MAX_ENTRIES, {
      truncated: true,
      onFile: () => new Promise((resolve) => setTimeout(resolve, 0)),
    });
    const result = await startZip({ allOwned: true }, "holdfast-everything");
    expect(result.outcome).toBe("saved");
    expect(result.truncated).toBe(true);
    const windows = calls.filter((call) => call.path === "/api/nodes/download-urls");
    expect(windows).toHaveLength(ZIP_MAX_ENTRIES / ZIP_URL_BATCH);
    for (const call of windows)
      expect((call.body as { nodeIds: string[] }).nodeIds.length).toBeLessThanOrEqual(ZIP_URL_BATCH);
    // Never ahead of the stream: before file k is fetched, exactly ceil(k / 50) windows were minted.
    let minted = 0;
    for (const step of order) {
      if ("mint" in step) minted += step.mint;
      else expect(minted, `file ${step.file}`).toBe(Math.ceil(step.file / ZIP_URL_BATCH) * ZIP_URL_BATCH);
    }
    expect(calls.filter((call) => call.path === "/api/nodes/zip-manifest").map((call) => call.body)).toEqual([
      { allOwned: true },
    ]);
  }, 60_000);

  it("the account changes while it runs: the zip stops, asks for no further window or file, and says nothing", async () => {
    captureBlob();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { calls } = serve(200, {
      onFile: async (index) => {
        if (index === 60) await held;
      },
    });
    const running = startZip({ allOwned: true }, "holdfast-everything");
    await waitFor(() => expect(calls.some((call) => call.path.endsWith(`${idOf(60)}/token`))).toBe(true));
    const before = calls.length;
    await purgeUserState();
    release();
    const result = await running;
    expect(result.outcome).toBe("cancelled");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(
      calls
        .slice(before)
        .filter((call) => call.path === "/api/nodes/download-urls" || call.path.startsWith("/d/")),
    ).toEqual([]);
  });

  it.each([
    ["the manifest", (call: MockCall) => call.path === "/api/nodes/zip-manifest"],
    ["the first window of URLs", (call: MockCall) => call.path === "/api/nodes/download-urls"],
  ])(
    "the account changes while %s is on its way: the zip stops there and fetches nothing",
    async (_name, isHeld) => {
      captureBlob();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      const calls = mockFetch(async (call: MockCall) => {
        if (isHeld(call)) await gate;
        if (call.path === "/api/nodes/zip-manifest") return json(manifest(120));
        if (call.path === "/api/nodes/download-urls") {
          const ids = (call.body as { nodeIds: string[] }).nodeIds;
          return json({
            items: ids.map((nodeId) => ({
              nodeId,
              url: `${CONFIG.filesOrigin}/d/${nodeId}/t`,
              expiresAt: LATER,
            })),
          });
        }
        if (call.path.startsWith("/d/")) return new Response("x", { status: 200 });
        return json({ error: "not_found", message: "not found" }, 404);
      });
      // As a browser does: a request whose signal is already aborted is never sent.
      const routed = globalThis.fetch;
      vi.stubGlobal("fetch", (input: RequestInfo | URL, init: RequestInit = {}) =>
        init.signal?.aborted
          ? Promise.reject(new DOMException("Aborted", "AbortError"))
          : routed(input, init),
      );
      const running = startZip({ allOwned: true }, "holdfast-everything", { notIncluded: notIncludedText });
      await waitFor(() => expect(calls.some(isHeld)).toBe(true));
      const before = calls.length;
      await purgeUserState();
      release();
      const result = await running;
      expect(result.outcome).toBe("cancelled");
      await new Promise((resolve) => setTimeout(resolve, 20));
      const later = calls
        .slice(before)
        .filter((call) => call.path === "/api/nodes/download-urls" || call.path.startsWith("/d/"));
      expect(later).toEqual([]);
    },
  );
});
