// "Download as zip": the manifest, URLs minted lazily in windows of ZIP_URL_BATCH, one re-mint per
// node, the two sinks, what was left out, and progress on the transfer ribbon.
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot, subscribeRibbon } from "../../../../src/client/components/TransferRibbon/store";
import {
  cancelZip,
  getZipJobs,
  leftOutSentence,
  safeZipPath,
  setZipSleepForTests,
  startZip,
  uniqueZipPath,
  ZIP_BLOB_MAX_BYTES,
  ZIP_FETCH_ATTEMPTS,
  ZIP_LIMITS,
  ZIP_MANIFEST_ROOTS,
  ZIP_RATE_WAIT_MAX_MS,
  ZIP_RATE_WAITS,
} from "../../../../src/client/features/explorer/zip";
import { purgeUserState } from "../../../../src/client/lib/query";
import { TOKEN_TTL, ZIP_URL_BATCH } from "../../../../src/shared/constants";
import type { NodeDto, ZipManifest } from "../../../../src/shared/schemas/node";
import { json, type MockCall } from "../shell/helpers";
import { FakeDrive } from "./fixtures/drive";
import { fileNode, folderNode, manifestOf } from "./fixtures/nodes";
import { deferred, serveDrive, setupExplorer, toastMessages } from "./helpers";

setupExplorer();

const FOLDER = folderNode(1, { name: "Trip" });
const filesIn = (count: number, patch: (n: number) => Partial<NodeDto> = () => ({})) =>
  Array.from({ length: count }, (_, index) =>
    fileNode(index + 10, {
      parentId: FOLDER.id,
      name: `photo-${String(index + 1).padStart(3, "0")}.jpg`,
      size: 20,
      ...patch(index + 1),
    }),
  );

const isFile = (call: MockCall) => call.path.startsWith("/d/");
const idOfFile = (call: MockCall) => call.path.split("/")[2]!;
const bytes = (text: string) => new Response(text, { status: 200 });

/** The in-memory sink: capture what would be saved, without a real download. */
function captureBlob(): { saved: Array<{ blob: Blob; name: string | null }> } {
  const saved: Array<{ blob: Blob; name: string | null }> = [];
  let last: Blob | null = null;
  vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: (blob: Blob) => ((last = blob), "blob:zip") }));
  Object.assign(URL, { revokeObjectURL: () => {} });
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ blob: last!, name: this.getAttribute("download") });
  });
  return { saved };
}

const mints = (calls: MockCall[]) =>
  calls
    .filter((call) => call.path === "/api/nodes/download-urls")
    .map((call) => (call.body as { nodeIds: string[] }).nodeIds);

describe("constants this depends on", () => {
  it("50 URLs a window, each good for 900 s; the in-memory sink stops at 1 GB decimal", () => {
    expect(ZIP_URL_BATCH).toBe(50);
    expect(TOKEN_TTL.zip).toBe(900);
    expect(ZIP_BLOB_MAX_BYTES).toBe(1_000_000_000);
  });
});

describe("URLs are minted lazily, one window ahead of the stream", () => {
  it("120 files: three requests of 50, 50 and 20 — each only when the stream reaches it", async () => {
    const files = filesIn(120);
    const drive = new FakeDrive([FOLDER, ...files]);
    const calls = serveDrive(drive, (call) => (isFile(call) ? bytes("x".repeat(20)) : undefined));
    const { saved } = captureBlob();

    const result = await startZip([FOLDER.id], "Trip");
    expect(result.outcome).toBe("saved");
    expect(mints(calls).map((ids) => ids.length)).toEqual([50, 50, 20]);
    expect(mints(calls).flat()).toEqual(files.map((file) => file.id));

    // Order of events: the manifest, a window, its 50 files, and only then the next window.
    const order = calls.map((call) =>
      call.path === "/api/nodes/zip-manifest" ? "manifest" : isFile(call) ? "file" : "mint",
    );
    expect(order[0]).toBe("manifest");
    const mintAt = order.flatMap((kind, index) => (kind === "mint" ? [index] : []));
    expect(mintAt).toEqual([1, 52, 103]);
    expect(order.filter((kind) => kind === "file")).toHaveLength(120);
    // The manifest carried no URL: the body sent was the selection only.
    expect(calls[0]!.body).toEqual({ nodeIds: [FOLDER.id] });

    // One archive, named after the folder, holding every path.
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe("Trip.zip");
    const archive = new Uint8Array(await saved[0]!.blob.arrayBuffer());
    expect(Array.from(archive.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const text = new TextDecoder("latin1").decode(archive);
    expect(text).toContain("Trip/photo-001.jpg");
    expect(text).toContain("Trip/photo-120.jpg");
    expect(toastMessages()).toEqual(["Zip saved."]);
  });

  it("an item that comes back as { nodeId, error } is minted once more, on its own", async () => {
    const files = filesIn(3);
    const drive = new FakeDrive([FOLDER, ...files]);
    drive.urlErrors.set(files[1]!.id, ["rate_limited"]);
    const calls = serveDrive(drive, (call) => (isFile(call) ? bytes("ok") : undefined));
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result).toMatchObject({ outcome: "saved", leftOut: [] });
    expect(mints(calls)).toEqual([files.map((file) => file.id), [files[1]!.id]]);
    expect(calls.filter(isFile).map(idOfFile)).toEqual(files.map((file) => file.id));
  });

  it("a fetch refused with 403 (a token that no longer verifies) is minted once more and fetched again", async () => {
    const files = filesIn(2);
    const drive = new FakeDrive([FOLDER, ...files]);
    let refused = false;
    const calls = serveDrive(drive, (call) => {
      if (!isFile(call)) return undefined;
      if (idOfFile(call) === files[0]!.id && !refused) {
        refused = true;
        return new Response("The link has expired.", { status: 403 });
      }
      return bytes("ok");
    });
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result).toMatchObject({ outcome: "saved", leftOut: [] });
    expect(mints(calls)).toEqual([files.map((file) => file.id), [files[0]!.id]]);
    // The second fetch used the new URL, not the refused one.
    const tokens = calls
      .filter((call) => isFile(call) && idOfFile(call) === files[0]!.id)
      .map((call) => call.path);
    // (The fake numbers its tokens: the window minted 1 and 2, the re-mint 3.)
    expect(tokens).toEqual([`/d/${files[0]!.id}/token-1`, `/d/${files[0]!.id}/token-3`]);
  });

  it("once means once: a node that keeps failing is MISSING — the archive is not called saved, and says which files", async () => {
    const files = filesIn(3);
    const drive = new FakeDrive([FOLDER, ...files]);
    drive.urlErrors.set(files[0]!.id, ["scan_pending", "scan_pending", "scan_pending"]);
    const calls = serveDrive(drive, (call) => {
      if (!isFile(call)) return undefined;
      return idOfFile(call) === files[2]!.id ? new Response("no", { status: 403 }) : bytes("ok");
    });
    const { saved } = captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result.outcome).toBe("partial");
    expect(result.missing).toEqual(["Trip/photo-001.jpg", "Trip/photo-003.jpg"]);
    expect(result.leftOut).toEqual([]);
    // First window, then exactly one more mint for each of the two.
    expect(mints(calls)).toEqual([files.map((file) => file.id), [files[0]!.id], [files[2]!.id]]);
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[2]!.id)).toHaveLength(2);
    expect(saved).toHaveLength(1);
    expect(toastMessages()).toEqual([
      "The zip is saved, but 2 files are missing from it: Trip/photo-001.jpg, Trip/photo-003.jpg. Download them one by one.",
    ]);
    expect(toastMessages()[0]).not.toMatch(/^Zip saved/);
  });
});

describe("one re-mint per node, whatever the reason", () => {
  it("an error item, re-minted, whose fetch is then refused is left out — not minted a third time", async () => {
    const files = filesIn(2);
    const drive = new FakeDrive([FOLDER, ...files]);
    drive.urlErrors.set(files[0]!.id, ["rate_limited"]);
    const calls = serveDrive(drive, (call) => {
      if (!isFile(call)) return undefined;
      return idOfFile(call) === files[0]!.id ? new Response("no", { status: 403 }) : bytes("ok");
    });
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result.missing).toEqual(["Trip/photo-001.jpg"]);
    expect(mints(calls)).toEqual([files.map((file) => file.id), [files[0]!.id]]);
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[0]!.id)).toHaveLength(1);
  });
});

describe("what the manifest left out", () => {
  it("the skipped list and `truncated` are stated in one toast when the zip is saved", async () => {
    const files = filesIn(2);
    const manifest: ZipManifest = manifestOf(
      files.map((node) => ({ node })),
      [
        { nodeId: fileNode(90).id, path: "new.pdf", reason: "scan_pending" },
        { nodeId: fileNode(91).id, path: "bad.exe", reason: "scan_blocked" },
        { nodeId: fileNode(92).id, path: "big.iso", reason: "unscanned" },
        { nodeId: fileNode(93).id, path: "more.bin", reason: "unscanned" },
      ],
      true,
    );
    const drive = new FakeDrive(files);
    serveDrive(drive, (call) =>
      call.path === "/api/nodes/zip-manifest" ? json(manifest) : isFile(call) ? bytes("ok") : undefined,
    );
    captureBlob();
    const result = await startZip(
      files.map((file) => file.id),
      "Holdfast 2026-10-13",
    );
    expect(result.truncated).toBe(true);
    expect(result.leftOut.map((item) => item.reason)).toEqual([
      "scan_pending",
      "scan_blocked",
      "unscanned",
      "unscanned",
    ]);
    expect(toastMessages()).toEqual([
      "Zip saved. 4 items were left out: new.pdf (still scanning), bad.exe (blocked), big.iso (couldn't be scanned) and 1 more. Only the first 10,000 files were included.",
    ]);
  });

  it("the drive's own manifest: a pending and a blocked file in a folder are skipped with their reasons", async () => {
    const files = filesIn(3, (n) =>
      n === 2 ? { scanStatus: "pending" } : n === 3 ? { scanStatus: "infected" } : {},
    );
    const drive = new FakeDrive([FOLDER, ...files]);
    const calls = serveDrive(drive, (call) => (isFile(call) ? bytes("ok") : undefined));
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result.leftOut).toEqual([
      { path: "Trip/photo-002.jpg", reason: "scan_pending" },
      { path: "Trip/photo-003.jpg", reason: "scan_blocked" },
    ]);
    // Nothing was minted or fetched for what was skipped.
    expect(mints(calls)).toEqual([[files[0]!.id]]);
    expect(calls.filter(isFile)).toHaveLength(1);
  });

  it("nothing zippable: no archive, and the toast says what was left out", async () => {
    const files = filesIn(1, () => ({ scanStatus: "pending" }));
    const calls = serveDrive(new FakeDrive([FOLDER, ...files]));
    const { saved } = captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result.outcome).toBe("empty");
    expect(saved).toHaveLength(0);
    expect(mints(calls)).toEqual([]);
    expect(toastMessages()).toEqual([
      "Nothing to zip. 1 item was left out: Trip/photo-001.jpg (still scanning).",
    ]);
  });

  it("one sentence for one item, a count for several, null for none", () => {
    expect(leftOutSentence([])).toBeNull();
    expect(leftOutSentence([{ path: "a.txt", reason: "scan_blocked" }])).toBe(
      "1 item was left out: a.txt (blocked).",
    );
  });
});

describe("the sink", () => {
  const big = (totalBytes: number): ZipManifest => ({
    ...manifestOf(filesIn(1).map((node) => ({ node }))),
    totalBytes,
  });

  it("no save picker and more than 1 GB: refused with the sentence, nothing minted or fetched", async () => {
    const calls = serveDrive(new FakeDrive(filesIn(1)), (call) =>
      call.path === "/api/nodes/zip-manifest" ? json(big(ZIP_BLOB_MAX_BYTES + 1)) : undefined,
    );
    const { saved } = captureBlob();
    const result = await startZip([filesIn(1)[0]!.id], "Big");
    expect(result.outcome).toBe("too_large");
    expect(toastMessages()).toEqual(["Too large to zip in this browser — download the items individually."]);
    expect(calls.map((call) => call.path)).toEqual(["/api/nodes/zip-manifest"]);
    expect(saved).toHaveLength(0);
    expect(getRibbonSnapshot().current).toBeNull();
  });

  it("exactly 1 GB is still allowed in memory", async () => {
    serveDrive(new FakeDrive(filesIn(1)), (call) =>
      call.path === "/api/nodes/zip-manifest"
        ? json(big(ZIP_BLOB_MAX_BYTES))
        : isFile(call)
          ? bytes("ok")
          : undefined,
    );
    captureBlob();
    expect((await startZip([filesIn(1)[0]!.id], "Edge")).outcome).toBe("saved");
  });

  it("with showSaveFilePicker the archive streams to the chosen file — no size ceiling, no object URL", async () => {
    const chunks: Uint8Array[] = [];
    const picker = vi.fn(async () => ({
      createWritable: async () =>
        new WritableStream<Uint8Array>({
          write(chunk) {
            chunks.push(chunk);
          },
        }),
    }));
    vi.stubGlobal("showSaveFilePicker", picker);
    const calls = serveDrive(new FakeDrive(filesIn(1)), (call) =>
      call.path === "/api/nodes/zip-manifest"
        ? json(big(ZIP_BLOB_MAX_BYTES * 2))
        : isFile(call)
          ? bytes("streamed")
          : undefined,
    );
    const { saved } = captureBlob();
    const result = await startZip([filesIn(1)[0]!.id], "Big");
    expect(result.outcome).toBe("saved");
    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0]).toEqual([
      {
        suggestedName: "Big.zip",
        types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }],
      },
    ]);
    // The picker was asked before anything was fetched: it needs the click.
    expect(calls[0]!.path).toBe("/api/nodes/zip-manifest");
    expect(saved).toHaveLength(0);
    const written = new TextDecoder("latin1").decode(
      Uint8Array.from(chunks.flatMap((chunk) => Array.from(chunk))),
    );
    expect(written.startsWith("PK")).toBe(true);
    expect(written).toContain("streamed");
  });

  it("cancelling the picker cancels the zip: no request, no toast, no ribbon entry", async () => {
    vi.stubGlobal("showSaveFilePicker", async () => {
      throw new DOMException("The user aborted a request.", "AbortError");
    });
    const calls = serveDrive(new FakeDrive(filesIn(1)));
    const result = await startZip([filesIn(1)[0]!.id], "Big");
    expect(result.outcome).toBe("cancelled");
    expect(calls).toHaveLength(0);
    expect(getToasts()).toHaveLength(0);
    expect(getZipJobs()).toHaveLength(0);
  });
});

describe("progress and failure", () => {
  it("publishes to the ribbon as zip:<id>, forward only, in plain words; done at the end", async () => {
    const files = filesIn(4);
    serveDrive(new FakeDrive([FOLDER, ...files]), (call) =>
      isFile(call) ? bytes("x".repeat(20)) : undefined,
    );
    captureBlob();
    const seen: Array<{ sourceId: string; progress: number; sentence: string; status: string }> = [];
    const stop = subscribeRibbon(() => {
      const current = getRibbonSnapshot().current;
      if (current) seen.push({ ...current });
    });
    const running = startZip([FOLDER.id], "Trip");
    await vi.waitFor(() => expect(getZipJobs()).toHaveLength(1));
    await running;
    stop();
    expect(seen.length).toBeGreaterThan(2);
    expect(new Set(seen.map((entry) => entry.sourceId)).size).toBe(1);
    expect(seen[0]!.sourceId).toMatch(/^zip:\d+$/);
    expect(seen[0]!).toMatchObject({ progress: 0, sentence: "Preparing zip", status: "active" });
    const progress = seen.map((entry) => entry.progress);
    expect([...progress].sort((a, b) => a - b)).toEqual(progress);
    expect(seen.some((entry) => /^Zipping \d of 4 · \d+ B left$/.test(entry.sentence))).toBe(true);
    // Finished: the source is done, so the ribbon is idle, and the job is forgotten.
    expect(getRibbonSnapshot()).toMatchObject({ current: null, openCount: 0 });
    expect(getZipJobs()).toHaveLength(0);
  });

  it.each([404, 500])(
    "a manifest answered %i ends in one toast with the request id; nothing is thrown",
    async (status) => {
      serveDrive(new FakeDrive([FOLDER]).fail("POST", /\/zip-manifest$/, status));
      const result = await startZip([FOLDER.id], "Trip");
      expect(result.outcome).toBe("failed");
      expect(getToasts()).toHaveLength(1);
      expect(getToasts()[0]).toMatchObject({
        message: "The zip didn't finish. Try again.",
        requestId: "req-fake",
      });
      expect(getRibbonSnapshot().current).toBeNull();
      expect(getZipJobs()).toHaveLength(0);
    },
  );

  it("a window of URLs answered 500 mid-way fails the zip, and nothing is saved", async () => {
    const files = filesIn(60);
    const drive = new FakeDrive([FOLDER, ...files]);
    let mintCalls = 0;
    serveDrive(drive, (call) => {
      if (isFile(call)) return bytes("ok");
      if (call.path === "/api/nodes/download-urls" && ++mintCalls === 2)
        return json({ error: "internal", message: "x", requestId: "req-mint" }, 500);
      return undefined;
    });
    const { saved } = captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result.outcome).toBe("failed");
    expect(saved).toHaveLength(0);
    expect(toastMessages()).toEqual(["The zip didn't finish. Try again."]);
  });

  it("Stop cancels a running zip quietly", async () => {
    const files = filesIn(2);
    const held = deferred<Response>();
    serveDrive(new FakeDrive([FOLDER, ...files]), (call) => (isFile(call) ? held.promise : undefined));
    const { saved } = captureBlob();
    const running = startZip([FOLDER.id], "Trip");
    await vi.waitFor(() => expect(getZipJobs()[0]?.label).toBe("Zipping 0 of 2"));
    cancelZip(getZipJobs()[0]!.id);
    held.resolve(bytes("late"));
    expect((await running).outcome).toBe("cancelled");
    expect(saved).toHaveLength(0);
    expect(getToasts()).toHaveLength(0);
    expect(getZipJobs()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Review, fix pass 1.

/** Record every wait the zip asks for, and do not wait. */
function noWaiting(): number[] {
  const waits: number[] = [];
  setZipSleepForTests(async (ms) => {
    waits.push(ms);
  });
  return waits;
}
const text = async (blob: Blob) => new TextDecoder("latin1").decode(new Uint8Array(await blob.arrayBuffer()));

describe("M1 — a file the files host does not give is never dropped in silence", () => {
  it("429: waits as long as Retry-After says and fetches again — the file is in the archive", async () => {
    const waits = noWaiting();
    const files = filesIn(3);
    const refusals = new Map([[files[1]!.id, 2]]);
    const calls = serveDrive(new FakeDrive([FOLDER, ...files]), (call) => {
      if (!isFile(call)) return undefined;
      const left = refusals.get(idOfFile(call)) ?? 0;
      if (left > 0) {
        refusals.set(idOfFile(call), left - 1);
        return new Response("Too many requests.", { status: 429, headers: { "retry-after": "7" } });
      }
      return bytes(`bytes-of-${idOfFile(call)}`);
    });
    const { saved } = captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result).toMatchObject({ outcome: "saved", missing: [] });
    expect(waits).toEqual([7_000, 7_000]);
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[1]!.id)).toHaveLength(3);
    expect(await text(saved[0]!.blob)).toContain(`bytes-of-${files[1]!.id}`);
    // Waiting is not a reason to mint again.
    expect(mints(calls)).toHaveLength(1);
    expect(toastMessages()).toEqual(["Zip saved."]);
  });

  it(`5xx and a dropped connection: ${ZIP_FETCH_ATTEMPTS} tries with a growing wait, then the file counts as missing`, async () => {
    const waits = noWaiting();
    const files = filesIn(3);
    let flaky = 1;
    const calls = serveDrive(new FakeDrive([FOLDER, ...files]), (call) => {
      if (!isFile(call)) return undefined;
      if (idOfFile(call) === files[0]!.id) return new Response("Bad gateway.", { status: 502 });
      if (idOfFile(call) === files[1]!.id && flaky-- > 0) throw new TypeError("Failed to fetch");
      return bytes("ok");
    });
    const { saved } = captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[0]!.id)).toHaveLength(
      ZIP_FETCH_ATTEMPTS,
    );
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[1]!.id)).toHaveLength(2);
    expect(waits).toEqual([1_000, 3_000, 1_000]);
    expect(result.outcome).toBe("partial");
    expect(result.missing).toEqual(["Trip/photo-001.jpg"]);
    expect(saved).toHaveLength(1);
    expect(toastMessages()).toEqual([
      "The zip is saved, but 1 file is missing from it: Trip/photo-001.jpg. Download it on its own.",
    ]);
  });

  it("a 429 that never lifts is bounded: a few waits for that file, then it is missing — never an endless loop", async () => {
    const waits = noWaiting();
    const files = filesIn(2);
    const calls = serveDrive(new FakeDrive([FOLDER, ...files]), (call) => {
      if (!isFile(call)) return undefined;
      return idOfFile(call) === files[0]!.id
        ? new Response("Too many requests.", { status: 429, headers: { "retry-after": "2" } })
        : bytes("ok");
    });
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(waits).toHaveLength(ZIP_RATE_WAITS);
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[0]!.id)).toHaveLength(
      ZIP_RATE_WAITS + 1,
    );
    expect(result).toMatchObject({ outcome: "partial", missing: ["Trip/photo-001.jpg"] });
  });

  it("a daily ceiling (Retry-After beyond a minute) stops the zip at once: no archive, and not one request per remaining file", async () => {
    const waits = noWaiting();
    const files = filesIn(40);
    const calls = serveDrive(new FakeDrive([FOLDER, ...files]), (call) => {
      if (!isFile(call)) return undefined;
      return idOfFile(call) === files[2]!.id
        ? new Response("Daily download limit reached.", { status: 429, headers: { "retry-after": "3600" } })
        : bytes("ok");
    });
    const { saved } = captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(3600 * 1000).toBeGreaterThan(ZIP_RATE_WAIT_MAX_MS);
    expect(result.outcome).toBe("limited");
    expect(waits).toEqual([]);
    expect(calls.filter(isFile)).toHaveLength(3);
    expect(saved).toHaveLength(0);
    expect(toastMessages()).toEqual([
      "The download limit was reached, so the zip was stopped. Try again later.",
    ]);
  });

  it("the API's own limiter on a window of URLs is waited out too", async () => {
    const waits = noWaiting();
    const files = filesIn(2);
    let refused = false;
    serveDrive(new FakeDrive([FOLDER, ...files]), (call) => {
      if (isFile(call)) return bytes("ok");
      if (call.path === "/api/nodes/download-urls" && !refused) {
        refused = true;
        return new Response(JSON.stringify({ error: "rate_limited", message: "x", requestId: "r" }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3" },
        });
      }
      return undefined;
    });
    captureBlob();
    expect((await startZip([FOLDER.id], "Trip")).outcome).toBe("saved");
    expect(waits).toEqual([3_000]);
  });
});

describe("M2 — more roots than one manifest may name", () => {
  it(`250 selected items: three manifest requests of at most ${ZIP_MANIFEST_ROOTS}, merged into one archive`, async () => {
    const files = Array.from({ length: 250 }, (_, index) =>
      fileNode(index + 100, { name: `f-${String(index).padStart(3, "0")}.txt`, size: 2 }),
    );
    const calls = serveDrive(new FakeDrive(files), (call) => (isFile(call) ? bytes("ok") : undefined));
    const { saved } = captureBlob();
    const result = await startZip(
      files.map((file) => file.id),
      "Holdfast 2026-10-13",
    );
    const manifests = calls.filter((call) => call.path === "/api/nodes/zip-manifest");
    expect(manifests.map((call) => (call.body as { nodeIds: string[] }).nodeIds.length)).toEqual([
      100, 100, 50,
    ]);
    expect(manifests.flatMap((call) => (call.body as { nodeIds: string[] }).nodeIds)).toEqual(
      files.map((f) => f.id),
    );
    expect(result).toMatchObject({ outcome: "saved", missing: [], truncated: false });
    expect(calls.filter(isFile)).toHaveLength(250);
    const archive = await text(saved[0]!.blob);
    expect(archive).toContain("f-000.txt");
    expect(archive).toContain("f-249.txt");
    // URL windows are still 50 at a time.
    expect(mints(calls).map((ids) => ids.length)).toEqual([50, 50, 50, 50, 50]);
  });

  it("a part that says truncated makes the whole truncated; the in-memory ceiling is held against the parts' sum", async () => {
    const files = Array.from({ length: 150 }, (_, index) =>
      fileNode(index + 100, { name: `f-${index}.txt`, size: 1 }),
    );
    let part = 0;
    const calls = serveDrive(new FakeDrive(files), (call) => {
      if (call.path !== "/api/nodes/zip-manifest") return undefined;
      part += 1;
      const mine = files.filter((file) => (call.body as { nodeIds: string[] }).nodeIds.includes(file.id));
      return json({
        ...manifestOf(
          mine.map((node) => ({ node })),
          [],
          part === 2,
        ),
        totalBytes: ZIP_BLOB_MAX_BYTES / 2 + 1,
      });
    });
    captureBlob();
    const result = await startZip(
      files.map((file) => file.id),
      "Big",
    );
    expect(part).toBe(2);
    expect(result.outcome).toBe("too_large");
    expect(calls.filter(isFile)).toHaveLength(0);
  });
});

describe("m1 — names in the archive are checked here, whatever the manifest says", () => {
  it.each([
    ["../../etc/passwd", "etc/passwd"],
    ["/etc/passwd", "etc/passwd"],
    ["C:\\Windows\\system.ini", "Windows/system.ini"],
    ["a/./b/../c.txt", "a/b/c.txt"],
    ["Trip/\u0000evil\u001f.txt", "Trip/evil.txt"],
    ["..", "file"],
    ["", "file"],
    ["ok/name.txt", "ok/name.txt"],
  ])("%j → %j", (hostile, safe) => {
    expect(safeZipPath(hostile)).toBe(safe);
  });

  it("two entries never share a name, compared without case", () => {
    const taken = new Set<string>();
    expect(["a.txt", "A.TXT", "a.txt", "dir/b", "dir/B"].map((path) => uniqueZipPath(path, taken))).toEqual([
      "a.txt",
      "A (2).TXT",
      "a (3).txt",
      "dir/b",
      "dir/B (2)",
    ]);
  });

  it("a hostile manifest: nothing in the archive escapes its folder or overwrites a neighbour", async () => {
    const files = filesIn(4);
    const paths = ["../../outside.txt", "/abs/secret.txt", "same.txt", "SAME.txt"];
    serveDrive(new FakeDrive(files), (call) =>
      call.path === "/api/nodes/zip-manifest"
        ? json(manifestOf(files.map((node, index) => ({ node, path: paths[index]! }))))
        : isFile(call)
          ? bytes("ok")
          : undefined,
    );
    const { saved } = captureBlob();
    await startZip(
      files.map((file) => file.id),
      "Hostile",
    );
    const archive = await text(saved[0]!.blob);
    expect(archive).not.toContain("../");
    expect(archive).not.toContain("/abs/");
    for (const name of ["outside.txt", "abs/secret.txt", "same.txt", "SAME (2).txt"])
      expect(archive).toContain(name);
  });
});

describe("m2, m3, m4, m6 — the sinks and the URLs", () => {
  it("the 1 GB ceiling is held against the bytes that arrive, not only the manifest's promise", async () => {
    const files = filesIn(1, () => ({ size: 5 }));
    serveDrive(new FakeDrive(files), (call) => (isFile(call) ? bytes("x".repeat(64)) : undefined));
    const { saved } = captureBlob();
    // The ceiling lowered to 10 bytes for this test: the manifest promises 5, the file that arrives is 64.
    ZIP_LIMITS.blobMax = 10;
    try {
      const result = await startZip([files[0]!.id], "Grown");
      expect(result.outcome).toBe("too_large");
    } finally {
      ZIP_LIMITS.blobMax = ZIP_BLOB_MAX_BYTES;
    }
    expect(saved).toHaveLength(0);
    expect(toastMessages()).toEqual(["Too large to zip in this browser — download the items individually."]);
  });

  it("one in-memory zip at a time: a second is refused while the first runs", async () => {
    const files = filesIn(1);
    const held = deferred<Response>();
    serveDrive(new FakeDrive([FOLDER, ...files]), (call) => (isFile(call) ? held.promise : undefined));
    captureBlob();
    const first = startZip([FOLDER.id], "One");
    await vi.waitFor(() => expect(getZipJobs()).toHaveLength(1));
    const second = await startZip([FOLDER.id], "Two");
    expect(second.outcome).toBe("busy");
    expect(toastMessages()).toEqual(["Another zip is still being made. Wait for it to finish."]);
    held.resolve(bytes("ok"));
    expect((await first).outcome).toBe("saved");
  });

  it("a zip that fails after the picker created its file takes the empty file away again", async () => {
    const remove = vi.fn(async () => {});
    vi.stubGlobal("showSaveFilePicker", async () => ({
      createWritable: async () => new WritableStream<Uint8Array>(),
      remove,
    }));
    serveDrive(new FakeDrive([FOLDER]).fail("POST", /\/zip-manifest$/, 500));
    expect((await startZip([FOLDER.id], "Trip")).outcome).toBe("failed");
    expect(remove).toHaveBeenCalledTimes(1);
    expect(toastMessages()).toEqual(["The zip didn't finish. Try again."]);
  });

  it("where the browser cannot remove it, the toast says an empty file may be left", async () => {
    vi.stubGlobal("showSaveFilePicker", async () => ({
      createWritable: async () => new WritableStream<Uint8Array>(),
    }));
    serveDrive(new FakeDrive([FOLDER]).fail("POST", /\/zip-manifest$/, 500));
    await startZip([FOLDER.id], "Trip");
    expect(toastMessages()).toEqual([
      "The zip didn't finish. Try again. An empty file may be left where you chose to save it.",
    ]);
  });

  it("a URL that is not on the files origin is never fetched: the file is missing, and said so", async () => {
    const files = filesIn(2);
    const calls = serveDrive(new FakeDrive([FOLDER, ...files]), (call) => {
      if (call.path === "/api/nodes/download-urls") {
        const ids = (call.body as { nodeIds: string[] }).nodeIds;
        return json({
          items: ids.map((nodeId) => ({
            nodeId,
            url:
              nodeId === files[0]!.id
                ? "https://evil.example/d/x/y"
                : `http://files.localhost:3000/d/${nodeId}/t`,
            expiresAt: "2026-10-02T12:00:00.000Z",
          })),
        });
      }
      return isFile(call) ? bytes("ok") : undefined;
    });
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(calls.filter(isFile).map(idOfFile)).toEqual([files[1]!.id]);
    expect(result).toMatchObject({ outcome: "partial", missing: ["Trip/photo-001.jpg"] });
  });
});

describe("B2 — a zip belongs to the account that started it", () => {
  it("the account changes while the save picker is open: nothing is requested afterwards", async () => {
    let choose: (handle: unknown) => void = () => {};
    const remove = vi.fn(async () => {});
    vi.stubGlobal(
      "showSaveFilePicker",
      () =>
        new Promise((resolve) => {
          choose = resolve;
        }),
    );
    const calls = serveDrive(new FakeDrive([FOLDER, ...filesIn(1)]));
    const running = startZip([FOLDER.id], "Trip");
    await purgeUserState();
    choose({ createWritable: async () => new WritableStream<Uint8Array>(), remove });
    expect((await running).outcome).toBe("cancelled");
    expect(calls).toHaveLength(0);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(getToasts()).toHaveLength(0);
  });

  it("a zip that fails after the account changed says nothing", async () => {
    const held = deferred<Response>();
    serveDrive(new FakeDrive([FOLDER]), (call) =>
      call.path === "/api/nodes/zip-manifest" ? held.promise : undefined,
    );
    vi.stubGlobal("showSaveFilePicker", undefined);
    const running = startZip([FOLDER.id], "Trip");
    await vi.waitFor(() => expect(getZipJobs()).toHaveLength(1));
    await purgeUserState();
    held.resolve(json({ error: "internal", message: "x", requestId: "req-old" }, 500));
    await running;
    expect(getToasts()).toHaveLength(0);
    expect(getRibbonSnapshot().current).toBeNull();
  });
});
