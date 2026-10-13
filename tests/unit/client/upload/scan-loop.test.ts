// Following the scan: ONE loop for the whole queue. However many files wait, it asks about one
// of them per second, backs off when told to, stops asking about a file that is gone, does not
// ask while the tab is hidden, and gives a file up after a bound.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addFiles } from "../../../../src/client/features/upload/manager";
import { SCAN_FOLLOW_LIMIT_MS } from "../../../../src/client/features/upload/plan";
import { getUploads } from "../../../../src/client/features/upload/store";
import { describeItem, summarise } from "../../../../src/client/features/upload/summary";
import { setupShell } from "../shell/helpers";
import {
  envelope,
  FAKED_TIMERS,
  freshUploader,
  installServer,
  settle,
  smallFile,
  type Server,
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
const polls = () => server.calls.filter((call) => call.method === "GET" && /^\/api\/nodes\//.test(call.path));

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
  it("60 files waiting for the scanner: at most 61 requests in 60 seconds, each file asked about in turn", async () => {
    await land(60);
    expect(polls().length).toBe(0);
    await settle(60_000);
    expect(polls().length).toBeLessThanOrEqual(61);
    expect(polls().length).toBeGreaterThanOrEqual(59);
    // In turn: no file twice before every file once.
    expect(
      new Set(
        polls()
          .slice(0, 59)
          .map((call) => call.path),
      ).size,
    ).toBe(59);
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
    const asked = polls().length;
    expect(asked).toBe(3);
    await settle(60_000);
    expect(polls().length).toBe(asked);
  });

  it("429 with Retry-After: the whole loop waits that long — it does not ask the next file instead — and the file is not shown as uploaded", async () => {
    await land(5);
    server.onJson = (call) =>
      /^\/api\/nodes\//.test(call.path)
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
    server.onJson = (call) => (/^\/api\/nodes\//.test(call.path) ? envelope("internal", 500) : undefined);
    await settle(120_000);
    // 2, 4, 8, 16, 32, then every 60 s.
    expect(polls().length).toBeLessThanOrEqual(8);
    expect(polls().length).toBeGreaterThanOrEqual(5);
  });

  it("403 and 404 end the following of that file only", async () => {
    await land(2);
    const first = items()[0]!.nodeId;
    server.onJson = (call) => (call.path === `/api/nodes/${first}` ? envelope("not_found", 404) : undefined);
    await settle(2_000);
    expect(items().map((item) => item.state)).toEqual(["done", "scanning"]);
    const forFirst = () => polls().filter((call) => call.path === `/api/nodes/${first}`).length;
    expect(forFirst()).toBe(1);
    await settle(30_000);
    expect(forFirst()).toBe(1);
  });

  it("nothing is asked while the tab is hidden; it goes on when the tab is back", async () => {
    await land(2);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(60_000);
    expect(polls().length).toBe(0);
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await settle(2_000);
    expect(polls().length).toBe(2);
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
    // Two files, one request a second in all: about one per file every two seconds.
    expect(asked).toBeLessThanOrEqual(SCAN_FOLLOW_LIMIT_MS / 1_000 + 1);
    await settle(600_000);
    expect(polls().length).toBe(asked);
  });
});
