// "Download as zip": the manifest, URLs minted lazily in windows of ZIP_URL_BATCH, one re-mint per
// node, the two sinks, what was left out, and progress on the transfer ribbon.
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { getRibbonSnapshot, subscribeRibbon } from "../../../../src/client/components/TransferRibbon/store";
import {
  cancelZip,
  getZipJobs,
  leftOutSentence,
  startZip,
  ZIP_BLOB_MAX_BYTES,
} from "../../../../src/client/features/explorer/zip";
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
    expect(tokens).toHaveLength(2);
    expect(tokens[0]).not.toBe(tokens[1]);
  });

  it("once means once: a node that keeps failing is left out and named, the rest is zipped", async () => {
    const files = filesIn(3);
    const drive = new FakeDrive([FOLDER, ...files]);
    drive.urlErrors.set(files[0]!.id, ["scan_pending", "scan_pending", "scan_pending"]);
    const calls = serveDrive(drive, (call) => {
      if (!isFile(call)) return undefined;
      return idOfFile(call) === files[2]!.id ? new Response("no", { status: 403 }) : bytes("ok");
    });
    captureBlob();
    const result = await startZip([FOLDER.id], "Trip");
    expect(result.outcome).toBe("saved");
    expect(result.leftOut).toEqual([
      { path: "Trip/photo-001.jpg", reason: "unavailable" },
      { path: "Trip/photo-003.jpg", reason: "unavailable" },
    ]);
    // First window, then exactly one more mint for each of the two.
    expect(mints(calls)).toEqual([files.map((file) => file.id), [files[0]!.id], [files[2]!.id]]);
    expect(calls.filter((call) => isFile(call) && idOfFile(call) === files[2]!.id)).toHaveLength(2);
    expect(toastMessages()).toEqual([
      "Zip saved. 2 items were left out: Trip/photo-001.jpg (couldn't be fetched), Trip/photo-003.jpg (couldn't be fetched).",
    ]);
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
    expect(result.leftOut).toEqual([{ path: "Trip/photo-001.jpg", reason: "unavailable" }]);
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
