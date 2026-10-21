// Step 2d (sniff) and step 2g's image dimensions, through the pipeline: the consumer writes
// `mimeSniffed` and `scanDetail.image`, and both are read back from the node.
import { fileTypeFromBuffer } from "file-type";
import { describe, expect, it } from "vitest";
import { inlineAllowed, serveType } from "../../../src/shared/mime";
import { headerDimensions } from "../../../src/worker/scan/verdict";
import { sniff } from "../../../src/worker/services/mime";
import { pngBytes, zipBytes } from "../../setup/fixture-bytes";
import prologSvg from "./fixtures/prolog.svg?raw";
import { deliver, enc, explicit, nodeById, uploadedFile } from "./helpers";

const ack = [{ outcome: "ack" }];

function join(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function box(name: string, body: Uint8Array = new Uint8Array(8)): Uint8Array {
  const out = new Uint8Array(8 + body.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(enc(name), 4);
  out.set(body, 8);
  return out;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const docx = () =>
  zipBytes([
    {
      name: "[Content_Types].xml",
      data: enc(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          `<Override PartName="/word/document.xml" ContentType="${DOCX}.main+xml"/></Types>`,
      ),
    },
    { name: "word/document.xml", data: enc("<w:document/>") },
  ]);

/** A JPEG whose frame header (SOF0) says `width` × `height`, after `appBytes` of APP1 padding. */
function jpeg(width: number, height: number, appBytes = 0): Uint8Array {
  const head = Uint8Array.from([
    0xff,
    0xd8,
    0xff,
    0xe0,
    0x00,
    0x10,
    ...enc("JFIF\0"),
    1,
    1,
    0,
    0,
    1,
    0,
    1,
    0,
    0,
  ]);
  const segments: Uint8Array[] = [];
  for (let left = appBytes; left > 0;) {
    const take = Math.min(left, 60_000);
    const segment = new Uint8Array(4 + take);
    segment.set([0xff, 0xe1, ((take + 2) >> 8) & 0xff, (take + 2) & 0xff]);
    segments.push(segment);
    left -= take;
  }
  const frame = Uint8Array.from([
    ...[0xff, 0xc0, 0x00, 0x11, 8, height >> 8, height & 0xff, width >> 8, width & 0xff, 3],
    ...[1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9],
  ]);
  return join(head, ...segments, frame);
}

async function sniffedThroughPipeline(bytes: Uint8Array, name: string, vars: Record<string, unknown> = {}) {
  const { file } = await uploadedFile(bytes, { name });
  expect(await deliver([{ body: explicit(file) }], vars), name).toEqual(ack);
  return (await nodeById(file.id))!;
}

describe("sniff (step 2d) — the fixture set, as the consumer writes it", () => {
  it("PNG, PDF, mp4, zip, docx, mov without ftyp, HTML with a BOM, plain XML", async () => {
    const cases: [string, Uint8Array, string][] = [
      ["a.png", pngBytes(16, 8), "image/png"],
      ["a.pdf", enc("%PDF-1.7\n%%EOF\n"), "application/pdf"],
      ["a.mp4", join(box("ftyp", enc("isom\0\0\0\0isomiso2avc1mp41")), box("mdat")), "video/mp4"],
      ["a.zip", zipBytes([{ name: "a.txt", data: enc("hello") }]), "application/zip"],
      ["a.docx", docx(), DOCX],
      ["a.mov", join(box("moov"), box("mdat")), "video/quicktime"],
      ["page.html", enc("﻿<!DOCTYPE html><html><body>x</body></html>"), "text/html"],
      ["plain.xml", enc('<?xml version="1.0"?><note><to>you</to></note>'), "application/xml"],
    ];
    for (const [name, bytes, expected] of cases) {
      const row = await sniffedThroughPipeline(bytes, name);
      expect(row.mimeSniffed, name).toBe(expected);
      expect(row.scanStatus, name).toBe("clean");
    }
    // XML is never inline-able, and is served as an attachment.
    expect(inlineAllowed(serveType("application/xml", "plain.xml"))).toBe(false);
  });

  it("prolog.svg is image/svg+xml and never inline-able — CONTROL: file-type alone answers application/xml", async () => {
    const bytes = enc(prologSvg);
    expect(prologSvg.startsWith("<?xml")).toBe(true);
    expect((await fileTypeFromBuffer(bytes))?.mime).toBe("application/xml");
    expect(await sniff(bytes, "drawing.svg")).toBe("image/svg+xml");
    const row = await sniffedThroughPipeline(bytes, "drawing.svg");
    expect(row.mimeSniffed).toBe("image/svg+xml");
    expect(serveType(row.mimeSniffed, row.name)).toBe("application/octet-stream");
    expect(inlineAllowed(serveType(row.mimeSniffed, row.name))).toBe(false);
    // An SVG has no pixel size to record.
    expect(row.scanDetail?.image).toBeUndefined();
  });
});

describe("image dimensions (step 2g)", () => {
  it("a PNG and a JPEG fixture → recorded from the header; a non-image → none", async () => {
    expect((await sniffedThroughPipeline(pngBytes(640, 480), "p.png")).scanDetail?.image).toEqual({
      width: 640,
      height: 480,
    });
    const j = await sniffedThroughPipeline(jpeg(1920, 1080), "j.jpg");
    expect(j.mimeSniffed).toBe("image/jpeg");
    expect(j.scanDetail?.image).toEqual({ width: 1920, height: 1080 });
    expect((await sniffedThroughPipeline(enc("not a picture"), "t.txt")).scanDetail?.image).toBeUndefined();
  });

  it("the header parser: GIF and WebP (VP8, VP8L, VP8X) too; a damaged header → null", () => {
    const gif = join(enc("GIF89a"), Uint8Array.of(0x2c, 0x01, 0x90, 0x00));
    expect(headerDimensions(gif, "image/gif")).toEqual({ width: 300, height: 144 });
    const riff = (chunk: string, body: number[]) =>
      join(enc("RIFF\0\0\0\0WEBP"), enc(chunk), Uint8Array.from(body));
    // VP8: frame tag (3) + start code (3) at 20..25, then 14-bit width/height at 26/28.
    const vp8 = riff("VP8 ", [0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xf0, 0x00]);
    expect(headerDimensions(vp8, "image/webp")).toEqual({ width: 320, height: 240 });
    // VP8L: size(4) at 16, signature 0x2f at 20, then 14-bit (width-1), (height-1).
    const w = 99;
    const h = 49;
    const bits = w | (h << 14);
    const vp8l = riff("VP8L", [
      0,
      0,
      0,
      0,
      0x2f,
      bits & 0xff,
      (bits >> 8) & 0xff,
      (bits >> 16) & 0xff,
      (bits >> 24) & 0xff,
      0,
      0,
      0,
      0,
      0,
    ]);
    expect(headerDimensions(vp8l, "image/webp")).toEqual({ width: 100, height: 50 });
    const vp8x = riff("VP8X", [0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0x03, 0x00, 0xff, 0x01, 0x00]);
    expect(headerDimensions(vp8x, "image/webp")).toEqual({ width: 1024, height: 512 });
    expect(headerDimensions(pngBytes(4, 4).subarray(0, 20), "image/png")).toBeNull();
    expect(headerDimensions(Uint8Array.of(0xff, 0xd8, 0xff, 0xda, 0, 0), "image/jpeg")).toBeNull();
  });

  it("past the 8 KiB prefix the Images binding's info() is asked; when it throws there are none — the scan finishes, no retry", async () => {
    // The frame header sits past the sniff prefix: the header parser has nothing.
    const late = jpeg(800, 600, 9_000);
    const seen: string[] = [];
    const working = {
      IMAGES: {
        info: async () => (
          seen.push("info"),
          { format: "image/jpeg", width: 800, height: 600, fileSize: late.length }
        ),
      },
    };
    expect((await sniffedThroughPipeline(late, "late.jpg", working)).scanDetail?.image).toEqual({
      width: 800,
      height: 600,
    });
    expect(seen).toEqual(["info"]);
    const throwing = {
      IMAGES: {
        info: async () => {
          throw new Error("Network connection lost.");
        },
      },
    };
    const row = await sniffedThroughPipeline(jpeg(800, 600, 9_000), "late.jpg", throwing);
    expect(row.scanStatus).toBe("clean");
    expect(row.scanDetail?.image).toBeUndefined();
  });

  it("an image above THUMB_INPUT_MAX_BYTES never reaches the binding", async () => {
    const huge = jpeg(10, 10, 20_000_100);
    let called = 0;
    const row = await sniffedThroughPipeline(huge, "huge.jpg", {
      IMAGES: { info: async () => ((called += 1), { width: 1, height: 1 }) },
    });
    expect(called).toBe(0);
    expect(row.scanStatus).toBe("clean");
    expect(row.scanDetail?.image).toBeUndefined();
  });
});
