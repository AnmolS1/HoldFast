// The storage wrapper against local R2 (Miniflare reproduces the multipart rules and the
// known-length rule of the real store).
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MIN_PART_BYTES, THUMB_SIZES } from "../../../src/shared/constants";
import { uuidv7 } from "../../../src/worker/db/ids";
import {
  avatarKey,
  keyFor,
  parseUploadKey,
  storage,
  thumbKey,
  thumbPrefix,
} from "../../../src/worker/services/storage";

const store = storage(env);
const OWNER = "o".repeat(32);
const encoder = new TextEncoder();
const fresh = () => ({ nodeId: uuidv7(), versionId: uuidv7() });
const freshKey = () => {
  const { nodeId, versionId } = fresh();
  return keyFor(OWNER, nodeId, versionId);
};

function streamOf(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

/** `size` bytes with a pattern that differs from part to part. */
function filled(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i += 4096) bytes[i] = (seed + i / 4096) & 0xff;
  return bytes;
}

describe("keys", () => {
  const node = "0199d3c2-7a10-7000-8000-0000000000a1";
  const version = "0199d3c2-7a10-7000-8000-0000000000c3";

  it("have the documented shapes", () => {
    expect(keyFor(OWNER, node, version)).toBe(`u/${OWNER}/${node}/${version}`);
    expect(thumbKey(node, version, 320)).toBe(`t/${node}/${version}/320.webp`);
    expect(thumbPrefix(node)).toBe(`t/${node}/`);
    expect(thumbPrefix(node, version)).toBe(`t/${node}/${version}/`);
    expect(avatarKey(OWNER, node)).toBe(`a/${OWNER}/${node}`);
    expect(parseUploadKey(keyFor(OWNER, node, version))).toEqual({
      ownerId: OWNER,
      nodeId: node,
      versionId: version,
    });
  });

  it("are immutable: the same version is the same key, a new version is a new key", () => {
    expect(keyFor(OWNER, node, version)).toBe(keyFor(OWNER, node, version));
    const next = uuidv7();
    expect(keyFor(OWNER, node, next)).not.toBe(keyFor(OWNER, node, version));
    expect(thumbKey(node, next, 160)).not.toBe(thumbKey(node, version, 160));
    // Every thumbnail of a version sits under that version's prefix, and under no other's.
    for (const size of THUMB_SIZES) {
      expect(thumbKey(node, version, size).startsWith(thumbPrefix(node, version))).toBe(true);
      expect(thumbKey(node, version, size).startsWith(thumbPrefix(node, next))).toBe(false);
    }
  });

  it("only keyFor returns a key under u/ — whatever ids the other helpers are handed", () => {
    expect(keyFor(OWNER, node, version).startsWith("u/")).toBe(true);
    expect(thumbKey(node, version, 160).startsWith("u/")).toBe(false);
    expect(avatarKey(OWNER, node).startsWith("u/")).toBe(false);
    const crafted = [
      "",
      ".",
      "..",
      "../u/x",
      "u/x",
      `${node}/../../u`,
      "a/b",
      "a b",
      "a\nb",
      `${node} `,
      "x".repeat(65),
    ];
    for (const bad of crafted) {
      expect(() => keyFor(bad, node, version), bad).toThrow("storage key");
      expect(() => keyFor(OWNER, bad, version), bad).toThrow("storage key");
      expect(() => keyFor(OWNER, node, bad), bad).toThrow("storage key");
      expect(() => thumbKey(bad, version, 160), bad).toThrow("storage key");
      expect(() => thumbKey(node, bad, 160), bad).toThrow("storage key");
      expect(() => thumbPrefix(bad), bad).toThrow("storage key");
      expect(() => thumbPrefix(node, bad), bad).toThrow("storage key");
      expect(() => avatarKey(bad, node), bad).toThrow("storage key");
      expect(() => avatarKey(OWNER, bad), bad).toThrow("storage key");
    }
    // The two id families are not interchangeable.
    expect(() => keyFor(node, node, version)).toThrow("owner id");
    expect(() => keyFor(OWNER, OWNER, version)).toThrow("node id");
    expect(() => thumbKey(node, version, 640 as never)).toThrow("thumb size");
  });

  it("parseUploadKey is null for anything that is not an upload key", () => {
    for (const key of [
      "",
      "u/",
      `u/${OWNER}/${node}`,
      `u/${OWNER}/${node}/${version}/x`,
      `t/${node}/${version}/160.webp`,
      `u/short/${node}/${version}`,
      "u/spike-s8/mpu-2.bin",
    ]) {
      expect(parseUploadKey(key), key).toBeNull();
    }
  });
});

describe("put, head, get", () => {
  it("stores a buffer with an octet-stream type and { nodeId, ownerId } only", async () => {
    const { nodeId, versionId } = fresh();
    const key = keyFor(OWNER, nodeId, versionId);
    const bytes = encoder.encode("hello storage");
    const stored = await store.put(key, bytes, { size: bytes.length, contentType: "text/html" });
    expect(stored.size).toBe(bytes.length);
    const head = await store.head(key);
    // The declared type is never stored under u/.
    expect(head?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(head?.customMetadata).toEqual({ nodeId, ownerId: OWNER });
    const object = await store.get(key);
    expect(object && "body" in object ? await object.text() : null).toBe("hello storage");
    expect(await store.head(freshKey())).toBeNull();
    expect(await store.get(freshKey())).toBeNull();
  });

  it("outside u/ the given content type is kept and there is no custom metadata", async () => {
    const { nodeId, versionId } = fresh();
    const key = thumbKey(nodeId, versionId, 160);
    await store.put(key, encoder.encode("webp"), { size: 4, contentType: "image/webp" });
    const head = await store.head(key);
    expect(head?.httpMetadata?.contentType).toBe("image/webp");
    expect(head?.customMetadata ?? {}).toEqual({});
  });

  it("a stream of unknown length is stored through a fixed-length stream of exactly `size` bytes", async () => {
    const key = freshKey();
    const a = encoder.encode("first ");
    const b = encoder.encode("second");
    // The control: the bare binding refuses this stream.
    await expect(env.FILES.put(freshKey(), streamOf(a, b))).rejects.toThrow(/known length/);
    await store.put(key, streamOf(a, b), { size: a.length + b.length });
    const object = await store.get(key);
    expect(object && "body" in object ? await object.text() : null).toBe("first second");
  });

  it("a body that is not the declared size fails and stores nothing", async () => {
    const bytes = encoder.encode("twelve bytes");
    for (const size of [bytes.length - 1, bytes.length + 1]) {
      const bufferKey = freshKey();
      await expect(store.put(bufferKey, bytes, { size })).rejects.toThrow("declared size");
      expect(await store.head(bufferKey)).toBeNull();
      const streamKey = freshKey();
      await expect(store.put(streamKey, streamOf(bytes), { size })).rejects.toThrow();
      expect(await store.head(streamKey)).toBeNull();
    }
    await expect(store.put(freshKey(), bytes, { size: -1 })).rejects.toThrow("invalid size");
    await expect(store.put("u/not-an-upload-key", bytes, { size: bytes.length })).rejects.toThrow(
      "upload key",
    );
  });

  it("reads a range and honours a condition", async () => {
    const key = freshKey();
    const stored = await store.put(key, encoder.encode("0123456789"), { size: 10 });
    const range = await store.get(key, { range: { offset: 2, length: 3 } });
    expect(range && "body" in range ? await range.text() : null).toBe("234");
    const suffix = await store.get(key, { range: { suffix: 4 } });
    expect(suffix && "body" in suffix ? await suffix.text() : null).toBe("6789");
    const unchanged = await store.get(key, { onlyIf: { etagDoesNotMatch: stored.etag } });
    expect(unchanged).not.toBeNull();
    expect(unchanged && "body" in unchanged).toBe(false);
  });
});

describe("delete, deletePrefix, list", () => {
  it("deletes keys in batches, ignoring missing ones", async () => {
    const keys = [freshKey(), freshKey(), freshKey()];
    for (const key of keys) await store.put(key, encoder.encode("x"), { size: 1 });
    const missing = Array.from({ length: 5 }, freshKey);
    await store.delete([...missing, ...keys]);
    for (const key of keys) expect(await store.head(key)).toBeNull();
    await store.delete([]);
  });

  it("never hands the store more than 1,000 keys in one call", async () => {
    // Local R2 does not enforce the store's 1,000-key limit, so the calls themselves are counted.
    const calls: number[] = [];
    const counting = storage({
      FILES: { delete: async (keys: string[]) => void calls.push(keys.length) } as unknown as R2Bucket,
    });
    await counting.delete(Array.from({ length: 2_500 }, (_, i) => `t/x/${i}`));
    expect(calls).toEqual([1_000, 1_000, 500]);
    calls.length = 0;
    await counting.delete(Array.from({ length: 1_000 }, (_, i) => `t/x/${i}`));
    expect(calls).toEqual([1_000]);
  });

  it("deletePrefix removes one version's thumbnails and nothing else", async () => {
    const nodeId = uuidv7();
    const [v1, v2] = [uuidv7(), uuidv7()];
    for (const version of [v1, v2]) {
      for (const size of THUMB_SIZES) {
        await store.put(thumbKey(nodeId, version, size), encoder.encode("t"), {
          size: 1,
          contentType: "image/webp",
        });
      }
    }
    const upload = keyFor(OWNER, nodeId, v1);
    await store.put(upload, encoder.encode("u"), { size: 1 });

    const listed = await store.list(thumbPrefix(nodeId));
    expect(listed.objects.map((object) => object.key).sort()).toEqual(
      [v1, v2].flatMap((version) => THUMB_SIZES.map((size) => thumbKey(nodeId, version, size))).sort(),
    );
    expect(listed.cursor).toBeNull();

    expect(await store.deletePrefix(thumbPrefix(nodeId, v1))).toBe(3);
    expect((await store.list(thumbPrefix(nodeId))).objects.map((object) => object.key).sort()).toEqual(
      THUMB_SIZES.map((size) => thumbKey(nodeId, v2, size)).sort(),
    );
    expect(await store.deletePrefix(thumbPrefix(nodeId))).toBe(3);
    expect(await store.deletePrefix(thumbPrefix(nodeId))).toBe(0);
    // The upload object was never under a thumbnail prefix.
    expect(await store.head(upload)).not.toBeNull();
  });

  it("refuses a prefix that is not scoped to an id", async () => {
    for (const prefix of ["", "/", "u/", "t/", "a/", "b/", "u", `t/${uuidv7()}`, "x/abc/", "t//", "t/../"]) {
      await expect(store.deletePrefix(prefix), prefix).rejects.toThrow("not scoped");
      await expect(store.list(prefix), prefix).rejects.toThrow("not scoped");
    }
  });
});

describe("multipart", () => {
  it("round-trips three 5 MiB parts, given in any order", async () => {
    const { nodeId, versionId } = fresh();
    const key = keyFor(OWNER, nodeId, versionId);
    const mpu = await store.createMultipart(key);
    expect(mpu.key).toBe(key);
    const parts = [];
    for (const n of [1, 2, 3]) parts.push(await store.uploadPart(mpu, n, filled(MIN_PART_BYTES, n)));
    expect(parts.map((part) => part.n)).toEqual([1, 2, 3]);
    // Nothing exists before complete.
    expect(await store.head(key)).toBeNull();
    // A second handle on the same upload (a later request) completes it.
    const resumed = store.resumeMultipart(key, mpu.uploadId);
    const done = await store.complete(resumed, [parts[2]!, parts[0]!, parts[1]!]);
    expect(done.size).toBe(3 * MIN_PART_BYTES);
    expect(done.etag).toMatch(/-3$/);
    const head = await store.head(key);
    expect(head?.httpMetadata?.contentType).toBe("application/octet-stream");
    expect(head?.customMetadata).toEqual({ nodeId, ownerId: OWNER });
    const second = await store.get(key, { range: { offset: MIN_PART_BYTES, length: 1 } });
    expect(second && "body" in second ? new Uint8Array(await second.arrayBuffer())[0] : null).toBe(2);
  });

  it("a part stream of unknown length needs its size", async () => {
    const mpu = await store.createMultipart(freshKey());
    const bytes = filled(1024, 9);
    await expect(store.uploadPart(mpu, 1, streamOf(bytes))).rejects.toThrow(/known length/);
    const part = await store.uploadPart(mpu, 1, streamOf(bytes), bytes.length);
    expect((await store.complete(mpu, [part])).size).toBe(1024);
  });

  it("unequal non-final parts are refused at complete, not at the part (10048)", async () => {
    const key = freshKey();
    const mpu = await store.createMultipart(key);
    const parts = [
      await store.uploadPart(mpu, 1, filled(MIN_PART_BYTES, 1)),
      await store.uploadPart(mpu, 2, filled(MIN_PART_BYTES + 1024, 2)),
      await store.uploadPart(mpu, 3, filled(10, 3)),
    ];
    await expect(store.complete(mpu, parts)).rejects.toThrow(/10048/);
    expect(await store.head(key)).toBeNull();
    await store.abort(mpu);
  });

  it("a non-final part under 5 MiB is refused at complete (10011); a single small part completes", async () => {
    const key = freshKey();
    const mpu = await store.createMultipart(key);
    const parts = [
      await store.uploadPart(mpu, 1, filled(1024, 1)),
      await store.uploadPart(mpu, 2, filled(1024, 2)),
    ];
    await expect(store.complete(mpu, parts)).rejects.toThrow(/10011/);
    expect(await store.head(key)).toBeNull();
    await store.abort(mpu);

    const small = freshKey();
    const single = await store.createMultipart(small);
    const only = await store.uploadPart(single, 1, filled(1024, 1));
    expect((await store.complete(single, [only])).size).toBe(1024);
  });

  it("abort discards the parts and is safe to repeat", async () => {
    const key = freshKey();
    const mpu = await store.createMultipart(key);
    const part = await store.uploadPart(mpu, 1, filled(1024, 1));
    await store.abort(mpu);
    await store.abort(mpu);
    await store.abort(store.resumeMultipart(key, mpu.uploadId));
    await expect(store.complete(mpu, [part])).rejects.toThrow();
    expect(await store.head(key)).toBeNull();
  });
});
