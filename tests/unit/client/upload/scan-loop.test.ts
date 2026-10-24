// Following the scan: ONE loop for the whole queue. However many files wait, it sends at most one
// request a second — every file that is due in it (`GET /api/nodes/scan-status`, R1 m16) — backs
// off when told to, stops asking about a file that is gone, does not ask while the tab is hidden,
// and gives a file up after a bound.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addFiles } from "../../../../src/client/features/upload/manager";
import { SCAN_FOLLOW_LIMIT_MS } from "../../../../src/client/features/upload/plan";
import { getUploads } from "../../../../src/client/features/upload/store";
import { describeItem, summarise } from "../../../../src/client/features/upload/summary";
import { setupShell } from "../shell/helpers";
import { SCAN_BATCH_MAX } from "../../../../src/client/features/upload/plan";
import { nodeDto } from "./fixtures";
import {
  envelope,
  FAKED_TIMERS,
  json,
  SCAN_ASK,
  scanAsks,
  freshUploader,
  installServer,
  settle,
  smallFile,
  type Server,
  askIds,
} from "./helpers";

setupShell();

let server: Server;
beforeEach(async () => {
  await freshUploader();
  server = installServer();
  server.scanStatus = "pending";
  vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
});

const items = () => getUploads().items;
const polls = () => scanAsks(server);

async function land(count: number): Promise<void> {
  await addFiles(
    Array.from({ length: count }, (_, n) => ({ file: smallFile(`f${n}.txt`) })),
    null,
  );
  // No clock needed to upload: only promise turns.
  for (let turn = 0; turn < count; turn += 1) await settle(0);
  expect(items().filter((item) => item.state === "scanning").length).toBe(count);
}

describe("the scan loop", () => {
  it("60 files waiting for the scanner: all of them in each request, a handful of requests in 60 seconds (one per file per second before)", async () => {
    await land(60);
    expect(polls().length).toBe(0);
    await settle(60_000);
    // Asked at 1, 2, 4, 6, 9, 14, 24 and 44 s: the files' own waits, all of them at once.
    expect(polls().length).toBeLessThanOrEqual(9);
    expect(polls().length).toBeGreaterThanOrEqual(7);
    const ids = new Set(items().map((item) => item.nodeId));
    for (const asked of polls()) expect(new Set(asked)).toEqual(ids);
  });

  it(`a queue longer than ${SCAN_BATCH_MAX}: at most ${SCAN_BATCH_MAX} files a request, the rest in the next`, async () => {
    await land(SCAN_BATCH_MAX + 20);
    await settle(1_000);
    expect(polls().map((ids) => ids.length)).toEqual([SCAN_BATCH_MAX]);
    const left = items()
      .map((item) => item.nodeId!)
      .filter((id) => !polls()[0]!.includes(id));
    expect(left).toHaveLength(20);
    // The next request: the ones left out first, then those due again, up to the limit.
    await settle(1_000);
    expect(polls()[1]).toHaveLength(SCAN_BATCH_MAX);
    expect(polls()[1]!.slice(0, 20)).toEqual(left);
  });

  it("a verdict takes its file out of the loop; the others are still asked", async () => {
    await land(3);
    server.scanStatus = "infected";
    await settle(3_000);
    expect(items().map((item) => [item.state, item.scanStatus])).toEqual([
      ["done", "infected"],
      ["done", "infected"],
      ["done", "infected"],
    ]);
    // One request asked about the three.
    expect(polls()).toHaveLength(1);
    expect(polls()[0]).toHaveLength(3);
    await settle(60_000);
    expect(polls()).toHaveLength(1);
  });

  it("429 with Retry-After: the whole loop waits that long — it does not ask the next file instead — and the file is not shown as uploaded", async () => {
    await land(5);
    server.onJson = (call) =>
      SCAN_ASK.test(call.path)
        ? envelope("rate_limited", 429, undefined, { "retry-after": "30" })
        : undefined;
    await settle(1_000);
    expect(polls().length).toBe(1);
    await settle(29_000);
    expect(polls().length).toBe(1);
    expect(items().every((item) => item.state === "scanning")).toBe(true);
    server.onJson = undefined;
    server.scanStatus = "clean";
    await settle(10_000);
    expect(items()).toEqual([]);
  });

  it("a 5xx spell backs the loop off instead of hammering: far fewer requests than seconds", async () => {
    await land(10);
    server.onJson = (call) => (SCAN_ASK.test(call.path) ? envelope("internal", 500) : undefined);
    await settle(120_000);
    // 2, 4, 8, 16, 32, then every 60 s.
    expect(polls().length).toBeLessThanOrEqual(8);
    expect(polls().length).toBeGreaterThanOrEqual(5);
  });

  it("a file the answer leaves out (gone, or no longer ours to see) is followed no more; the others are", async () => {
    await land(2);
    const [first, second] = items().map((item) => item.nodeId!);
    server.onJson = (call) =>
      SCAN_ASK.test(call.path)
        ? json({
            items: askIds(call)
              .filter((id) => id !== first)
              .map((id) => nodeDto({ id, scanStatus: "pending" })),
          })
        : undefined;
    await settle(2_000);
    expect(items().map((item) => item.state)).toEqual(["done", "scanning"]);
    const about = (id: string) => polls().filter((ids) => ids.includes(id)).length;
    expect(about(first!)).toBe(1);
    await settle(30_000);
    expect(about(first!)).toBe(1);
    expect(about(second!)).toBeGreaterThan(1);
  });

  it("the whole request refused with a 4xx says nothing about any one file: the loop backs off and the rows stay", async () => {
    await land(2);
    server.onJson = (call) => (SCAN_ASK.test(call.path) ? envelope("forbidden", 403) : undefined);
    await settle(2_000);
    expect(items().map((item) => item.state)).toEqual(["scanning", "scanning"]);
    expect(polls()).toHaveLength(1);
    server.onJson = undefined;
    server.scanStatus = "clean";
    await settle(10_000);
    expect(items()).toEqual([]);
  });

  it("nothing is asked while the tab is hidden; it goes on when the tab is back", async () => {
    await land(2);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(60_000);
    expect(polls().length).toBe(0);
    // A file that lands while the tab is hidden does not start the asking either.
    await addFiles([{ file: smallFile("late.txt") }], null);
    await settle(0);
    await settle(60_000);
    expect(polls().length).toBe(0);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(1_000);
    // A second later, the three files in one request.
    expect(polls()).toHaveLength(1);
    expect(polls()[0]).toHaveLength(3);
  });

  it("after the bound a file still pending says 'still being checked' and is asked about no more", async () => {
    await land(2);
    await settle(SCAN_FOLLOW_LIMIT_MS + 5_000);
    expect(items().map((item) => [item.state, item.scanStatus])).toEqual([
      ["done", "pending"],
      ["done", "pending"],
    ]);
    expect(describeItem(items()[0]!)).toBe("Uploaded — still being checked. The folder shows the result.");
    expect(summarise(getUploads())).toMatchObject({
      sentence: "2 files are still being checked",
      status: "paused",
    });
    const asked = polls().length;
    // Both files in each request, and each request one the files' own waits made due (every 30 s
    // once they have waited a while).
    expect(asked).toBeLessThanOrEqual(SCAN_FOLLOW_LIMIT_MS / 30_000 + 10);
    await settle(600_000);
    expect(polls().length).toBe(asked);
  });
});
