// A large object for the streaming tests, written straight into the local store with a multipart
// upload (the upload routes are another task's) — and the same bytes computed again for any
// offset, so a ranged read can be checked without keeping the object in memory.
import { env } from "cloudflare:workers";
import { PART_BYTES } from "../../../src/shared/constants";
import { storage } from "../../../src/worker/services/storage";
import { makeFile } from "../services-core/helpers";
import { makeAccount } from "./harness";

const BLOCK = 1 << 20;
const base = new Uint8Array(BLOCK);
for (let i = 0; i < BLOCK; i++) base[i] = (i * 31 + (i >> 7) * 17 + (i >> 13)) & 0xff;

/** Block `index` of the object: the base block with its own index written at its start. */
function block(index: number): Uint8Array {
  const bytes = base.slice();
  new DataView(bytes.buffer).setFloat64(0, index, true);
  return bytes;
}

/** The bytes `[offset, offset + length)` of the object. */
export function expected(offset: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let written = 0;
  while (written < length) {
    const at = offset + written;
    const index = Math.floor(at / BLOCK);
    const within = at % BLOCK;
    const take = Math.min(length - written, BLOCK - within);
    out.set(block(index).subarray(within, within + take), written);
    written += take;
  }
  return out;
}

function partStream(offset: number, length: number): ReadableStream<Uint8Array> {
  let at = offset;
  const end = offset + length;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (at >= end) return controller.close();
      const index = Math.floor(at / BLOCK);
      const within = at % BLOCK;
      const take = Math.min(end - at, BLOCK - within);
      controller.enqueue(block(index).subarray(within, within + take));
      at += take;
    },
  });
}

/** A clean file node of `size` bytes whose object was written in parts of `PART_BYTES`. */
export async function seedLarge(size: number) {
  const owner = await makeAccount();
  const node = await makeFile(owner.id, null, {
    size,
    scanStatus: "clean",
    mimeSniffed: "application/octet-stream",
  });
  const store = storage(env);
  const upload = await store.createMultipart(node.r2Key!);
  const parts = [];
  for (let n = 1, offset = 0; offset < size; n++, offset += PART_BYTES) {
    const length = Math.min(PART_BYTES, size - offset);
    parts.push(await store.uploadPart(upload, n, partStream(offset, length), length));
  }
  const object = await store.complete(upload, parts);
  return {
    owner,
    node: { ...node, r2Key: node.r2Key!, versionId: node.versionId! },
    parts: parts.length,
    object,
  };
}

/** Reads a response to its end without keeping it: the byte count, and its first and last bytes. */
export async function drain(response: Response, keep = 4096) {
  const reader = response.body!.getReader();
  let total = 0;
  let first = new Uint8Array(0);
  let last = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (first.byteLength < keep) {
      const joined = new Uint8Array(Math.min(keep, first.byteLength + value.byteLength));
      joined.set(first);
      joined.set(value.subarray(0, joined.byteLength - first.byteLength), first.byteLength);
      first = joined;
    }
    const tail = new Uint8Array(Math.min(keep, last.byteLength + value.byteLength));
    const fromLast = Math.max(0, tail.byteLength - value.byteLength);
    tail.set(last.subarray(last.byteLength - fromLast));
    tail.set(value.subarray(Math.max(0, value.byteLength - (tail.byteLength - fromLast))), fromLast);
    last = tail;
    total += value.byteLength;
  }
  return { total, first, last };
}
