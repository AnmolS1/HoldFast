// Fixture generators that return bytes. No imports and no Node APIs, so they run in Worker tests
// (workerd), in jsdom and in Node alike. tests/setup/fixture-files.ts writes them to disk for
// Playwright.
//
// The antivirus test string and the archive around it are built here instead of being committed:
// a checked-in copy gets quarantined by antivirus software on developer machines.

const encoder = new TextEncoder();

/** The right-to-left override character (U+202E). */
export const RTLO = "‮";

/** A file name that displays as "invoicefdp.exe" in a bidi-naive UI. */
export const RTLO_FILE_NAME = `invoice${RTLO}exe.pdf`;

/** Larger than two 64 MiB parts (2 × 67,108,864), so a multipart upload needs exactly three. */
export const SPARSE_FILE_BYTES = 140_000_000;

/** The 68-byte EICAR antivirus test string. Harmless; every scanner reports it. */
export function eicarBytes(): Uint8Array {
  // Kept in two halves so that this source file is not itself reported.
  const head = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR";
  const tail = "-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";
  return encoder.encode(head + tail);
}

let crcTable: Uint32Array | undefined;

export function crc32(bytes: Uint8Array, seed = 0): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    // 5552 is the largest block for which the sums cannot overflow 32 bits before the modulo.
    const end = Math.min(i + 5552, bytes.length);
    for (; i < end; i++) {
      a += bytes[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let length = 0;
  for (const chunk of chunks) length += chunk.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** zlib stream made of stored (uncompressed) deflate blocks. */
function zlibStored(data: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [Uint8Array.of(0x78, 0x01)];
  for (let offset = 0; offset < data.length || offset === 0;) {
    const size = Math.min(0xffff, data.length - offset);
    const last = offset + size >= data.length;
    chunks.push(Uint8Array.of(last ? 1 : 0, size & 0xff, size >>> 8, ~size & 0xff, (~size >>> 8) & 0xff));
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
    if (last) break;
  }
  const sum = new Uint8Array(4);
  new DataView(sum.buffer).setUint32(0, adler32(data));
  chunks.push(sum);
  return concat(chunks);
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(encoder.encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * A valid, deterministic RGBA PNG of noise. It is stored uncompressed, so the file is a little
 * over `width × height × 4` bytes: the default 1024 × 512 gives 2,097,892 bytes (2 MB).
 */
export function pngBytes(width = 1024, height = 512): Uint8Array {
  const stride = 1 + width * 4;
  const raw = new Uint8Array(stride * height);
  let state = 0x9e3779b9;
  for (let y = 0; y < height; y++) {
    const row = y * stride; // raw[row] stays 0: filter type "none"
    for (let x = 1; x < stride; x++) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      raw[row + x] = x % 4 === 0 ? 0xff : state & 0xff; // opaque alpha
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8); // 8 bits per channel, RGBA, no interlace
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlibStored(raw)),
    pngChunk("IEND", new Uint8Array(0)),
  ]);
}

/** A zip archive with every entry stored (no compression). */
export function zipBytes(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // UTF-8 names
    lv.setUint16(8, 0, true); // stored
    lv.setUint16(10, 0, true); // time
    lv.setUint16(12, 0x21, true); // date: 1980-01-01
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, entry.data);

    const header = new Uint8Array(46 + name.length);
    const cv = new DataView(header.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0x21, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);

    offset += local.length + size;
  }
  const directory = concat(central);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, directory.length, true);
  ev.setUint32(16, offset, true);
  return concat([...locals, directory, end]);
}

/** `outer.zip` → `readme.txt` + `nested/inner.zip` → `eicar.com`. */
export function nestedEicarZipBytes(): Uint8Array {
  const inner = zipBytes([{ name: "eicar.com", data: eicarBytes() }]);
  return zipBytes([
    { name: "readme.txt", data: encoder.encode("The archive in nested/ holds the antivirus test file.\n") },
    { name: "nested/inner.zip", data: inner },
  ]);
}
