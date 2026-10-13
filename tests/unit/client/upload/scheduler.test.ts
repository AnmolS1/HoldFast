// The upload manager against a stand-in API: limits, slicing, retry, pause and resume, what is
// sent at complete, and what happens after a file has landed.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  addFiles,
  pauseItem,
  resumeItem,
  retryItem,
  SCAN_POLL_MS,
} from "../../../../src/client/features/upload/manager";
import { getUploads } from "../../../../src/client/features/upload/store";
import { onNodesChanged } from "../../../../src/client/lib/contracts";
import { setupShell } from "../shell/helpers";
import { FOLDER_ID, initResponse, nodeDto } from "./fixtures";
import {
  apiError,
  bigFile,
  DIGEST,
  FAKED_TIMERS,
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
});

const items = () => getUploads().items;
const partNumbers = (calls = server.puts) => calls.map((call) => call.n);

describe("concurrency", () => {
  it("three files at a time and three parts per file — never more than nine requests", async () => {
    server.hold = true;
    server.partBytes = 100;
    await addFiles(
      [1, 2, 3, 4, 5].map((n) => ({ file: bigFile(`f${n}.bin`, 450) })),
      null,
    );
    await settle();
    // Three files have started; the other two have not even asked for a session.
    expect(server.inits.map((body) => body.name)).toEqual(["f1.bin", "f2.bin", "f3.bin"]);
    expect(server.held.length).toBe(9);
    expect(items().map((item) => item.state)).toEqual([
      "uploading",
      "uploading",
      "uploading",
      "queued",
      "queued",
    ]);

    // Answer one request at a time; at every step no file has more than three in flight.
    for (let step = 0; step < 100 && server.held.length > 0; step += 1) {
      const perFile = new Map<string, number>();
      for (const call of server.held) perFile.set(call.uploadId, (perFile.get(call.uploadId) ?? 0) + 1);
      expect(Math.max(...perFile.values())).toBeLessThanOrEqual(3);
      expect(perFile.size).toBeLessThanOrEqual(3);
      expect(server.inFlight).toBeLessThanOrEqual(9);
      server.held[0]!.resolve();
      await settle();
    }
    expect(server.peak).toBe(9);
    expect(server.inits.length).toBe(5);
    expect(server.completes.length).toBe(5);
    expect(server.puts.length).toBe(25);
  });
});

describe("slicing", () => {
  it("the cap-sized file goes up as the server's 30 parts, the last one 53,842,944 bytes", async () => {
    await addFiles([{ file: bigFile("cap.bin", 2_000_000_000) }], null);
    await settle();
    expect(server.puts.length).toBe(30);
    const sizes = [...server.puts].sort((a, b) => Number(a.n) - Number(b.n)).map((call) => call.size);
    expect(sizes.slice(0, 29).every((size) => size === 67_108_864)).toBe(true);
    expect(sizes[29]).toBe(53_842_944);
    expect(server.completes[0]!.parts.map((part) => part.n)).toEqual(
      Array.from({ length: 30 }, (_, i) => i + 1),
    );
  });

  it("a last part of one byte", async () => {
    server.partBytes = 1000;
    await addFiles([{ file: bigFile("odd.bin", 2001) }], null);
    await settle();
    expect(server.puts.map((call) => [call.n, call.size]).sort()).toEqual([
      [1, 1000],
      [2, 1000],
      [3, 1],
    ]);
  });

  it("the mode, the part size and the part count are the server's — also when no client would pick them", async () => {
    // 2,500 bytes is far under any real part size; the server says: multipart, 7 parts of 400.
    server.onInit = (body) =>
      json(
        initResponse(body.size, { mode: "multipart", partBytes: 400, partCount: 7, finalName: body.name }),
      );
    await addFiles([{ file: bigFile("small.bin", 2500) }], null);
    await settle();
    expect(server.puts.map((call) => [call.n, call.size]).sort()).toEqual([
      [1, 400],
      [2, 400],
      [3, 400],
      [4, 400],
      [5, 400],
      [6, 400],
      [7, 100],
    ]);
    expect(server.completes[0]!.parts.length).toBe(7);
  });

  it("a single session sends the whole file once and completes with no parts", async () => {
    await addFiles([{ file: smallFile("notes.txt", 10) }], null);
    await settle();
    expect(server.puts.map((call) => [call.n, call.size])).toEqual([["single", 10]]);
    expect(server.completes).toEqual([{ sha256: DIGEST, parts: [] }]);
  });

  it("an empty file is uploaded like any other", async () => {
    await addFiles([{ file: smallFile("empty.txt", 0) }], null);
    await settle();
    expect(server.puts.map((call) => [call.n, call.size])).toEqual([["single", 0]]);
    expect(server.completes.length).toBe(1);
  });

  it("init carries the file's date as an ISO timestamp, and the folder it goes to", async () => {
    await addFiles([{ file: smallFile("notes.txt", 10, 1_760_000_000_123) }], FOLDER_ID);
    await settle();
    expect(server.inits[0]).toEqual({
      parentId: FOLDER_ID,
      name: "notes.txt",
      size: 10,
      mimeDeclared: "text/plain",
      fileLastModified: new Date(1_760_000_000_123).toISOString(),
      onConflict: "fail",
      purpose: "file",
    });
  });
});

describe("resume inside a session", () => {
  it("parts the server already has are skipped, and complete names them all", async () => {
    server.partBytes = 100;
    server.onInit = (body) =>
      json(
        initResponse(body.size, {
          partBytes: 100,
          finalName: body.name,
          resumedParts: [
            { n: 1, etag: "kept-1" },
            { n: 3, etag: "kept-3" },
          ],
        }),
      );
    await addFiles([{ file: bigFile("video.mp4", 400) }], null);
    await settle();
    expect(partNumbers().sort()).toEqual([2, 4]);
    expect(server.completes[0]!.parts).toEqual([
      { n: 1, etag: "kept-1" },
      { n: 2, etag: "etag-2" },
      { n: 3, etag: "kept-3" },
      { n: 4, etag: "etag-4" },
    ]);
  });

  it("pause aborts what is in flight; resume sends only the missing parts and asks for no new session", async () => {
    server.hold = true;
    server.partBytes = 100;
    await addFiles([{ file: bigFile("video.mp4", 400) }], null);
    await settle();
    expect(partNumbers(server.held)).toEqual([1, 2, 3]);
    server.held[0]!.resolve();
    await settle();
    expect(partNumbers(server.held)).toEqual([2, 3, 4]);
    const [item] = items();
    const stopped = [...server.held];

    pauseItem(item!.id);
    await settle();
    expect(stopped.every((call) => call.signal?.aborted)).toBe(true);
    expect(server.held).toEqual([]);
    expect(items()[0]).toMatchObject({ state: "paused", pauseReason: "user" });
    // What the server has is kept; what was in flight is not counted.
    expect(items()[0]!.sentBytes).toBe(100);

    const before = server.puts.length;
    resumeItem(item!.id);
    await settle();
    expect(partNumbers(server.puts.slice(before)).sort()).toEqual([2, 3, 4]);
    expect(server.inits.length).toBe(1);
    for (const call of [...server.held]) call.resolve();
    await settle();
    expect(server.completes[0]!.parts.map((part) => part.n)).toEqual([1, 2, 3, 4]);
    expect(server.inits.length).toBe(1);
  });
});

describe("retry and backoff", () => {
  it("a part that keeps failing is tried again at 0, 2, 5, 15 and 30 seconds, then the item is an error that can be resumed", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.partBytes = 100;
    server.onPut = (call) => (call.n === 2 ? apiError(500, "internal") : undefined);
    const began = Date.now();
    await addFiles([{ file: bigFile("video.mp4", 250) }], null);
    await settle(0);
    await settle(60_000);

    const tries = server.puts.filter((call) => call.n === 2).map((call) => call.at - began);
    expect(tries).toEqual([0, 0, 2000, 7000, 22000, 52000]);
    expect(items()[0]).toMatchObject({ state: "error", canRetry: true });
    // The session and the parts that arrived are kept.
    expect(items()[0]!.uploadId).not.toBeNull();
    expect(items()[0]!.parts.map((part) => part.n)).toEqual([1, 3]);
    expect(server.completes.length).toBe(0);
    // Nothing more happens by itself.
    await settle(120_000);
    expect(server.puts.filter((call) => call.n === 2).length).toBe(6);

    server.onPut = undefined;
    const before = server.puts.length;
    retryItem(items()[0]!.id);
    await settle(0);
    expect(partNumbers(server.puts.slice(before))).toEqual([2]);
    expect(server.inits.length).toBe(1);
    expect(server.completes[0]!.parts.map((part) => part.n)).toEqual([1, 2, 3]);
  });

  it("a network failure is retried the same way", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onPut = (_call, nth) => (nth <= 2 ? apiError(0, "network") : undefined);
    await addFiles([{ file: smallFile("notes.txt") }], null);
    await settle(0);
    expect(server.puts.length).toBe(2);
    await settle(2000);
    expect(server.puts.length).toBe(3);
    expect(server.completes.length).toBe(1);
  });

  it("a 4xx is an answer and is not retried", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.onPut = () => apiError(400, "validation");
    await addFiles([{ file: smallFile("notes.txt") }], null);
    await settle(0);
    await settle(120_000);
    expect(server.puts.length).toBe(1);
    expect(items()[0]).toMatchObject({
      state: "error",
      message: "validation message",
      requestId: "req-1234",
    });
  });
});

describe("after the file has landed", () => {
  it("tells the other features which folder changed — null at the top level", async () => {
    const seen: Array<(string | null)[]> = [];
    const stop = onNodesChanged((detail) => seen.push(detail.parentIds));
    await addFiles([{ file: smallFile("a.txt") }], FOLDER_ID);
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ids) => ids.length === 1 && ids[0] === FOLDER_ID)).toBe(true);
    seen.length = 0;
    await addFiles([{ file: smallFile("b.txt") }], null);
    await settle();
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((ids) => ids.length === 1 && ids[0] === null)).toBe(true);
    stop();
  });

  it("follows the scan by reading .node.scanStatus until it leaves pending", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    expect(items()[0]).toMatchObject({ state: "scanning", progress: 1 });
    const nodeId = items()[0]!.nodeId!;
    const polls = () => server.count("GET", new RegExp(`^/api/nodes/${nodeId}$`));
    expect(polls()).toBe(0);
    await settle(SCAN_POLL_MS[0]);
    expect(polls()).toBe(1);
    expect(items()[0]!.state).toBe("scanning");

    server.scanStatus = "infected";
    await settle(SCAN_POLL_MS[1]);
    expect(polls()).toBe(2);
    expect(items()[0]).toMatchObject({ state: "done", scanStatus: "infected" });
    // And then it stops asking.
    await settle(60_000);
    expect(polls()).toBe(2);
    expect(getUploads().announcements.map((entry) => entry.text)).toContain(
      "a.txt was blocked — flagged by the malware scan",
    );
  });

  it("an answer that carries the status at the top level is not the contract: the poll goes on", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "pending";
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    const nodeId = items()[0]!.nodeId!;
    // A bare NodeDto, as the endpoint answered before it was given its envelope.
    server.onJson = (call) =>
      call.path === `/api/nodes/${nodeId}`
        ? json(nodeDto({ id: nodeId, scanStatus: "infected" }))
        : undefined;
    await settle(SCAN_POLL_MS[0]);
    await settle(SCAN_POLL_MS[1]);
    expect(items()[0]!.state).toBe("scanning");
  });

  it("a clean file just completes: its row goes when the queue is idle", async () => {
    server.scanStatus = "clean";
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle();
    expect(items()).toEqual([]);
    expect(getUploads().finished).toBe(1);
    expect(getUploads().announcements.map((entry) => entry.text)).toEqual([
      "Uploading a.txt",
      "a.txt uploaded",
    ]);
  });

  it("a file that could not be scanned stays, with the scan's word", async () => {
    vi.useFakeTimers({ toFake: [...FAKED_TIMERS] });
    server.scanStatus = "error";
    await addFiles([{ file: smallFile("a.txt") }], null);
    await settle(0);
    await settle(SCAN_POLL_MS[0]);
    expect(items()[0]).toMatchObject({ state: "done", scanStatus: "error" });
    expect(getUploads().announcements.at(-1)!.text).toBe("Couldn't scan a.txt");
  });
});
