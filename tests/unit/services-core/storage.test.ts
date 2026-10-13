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
  type GetResult,
  thumbKey,
  thumbPrefix,
} from "../../../src/worker/services/storage";

const store = storage(env);
const textOf = async (result: GetResult) => (result?.kind === "body" ? result.object.text() : null);
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
    expect(await textOf(await store.get(key))).toBe("hello storage");
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
    expect(await textOf(await store.get(key))).toBe("first second");
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
});

describe("get: ranges and conditions", () => {
  // Exactly 1,000 bytes, byte i = i mod 251 — the object the range spike measured on the real store.
  const k1000 = new Uint8Array(1000).map((_, i) => i % 251);
  async function stored() {
    const key = freshKey();
    const object = await store.put(key, k1000, { size: 1000 });
    return { key, etag: object.etag };
  }
  /** What a read gave, in the spike's own terms. */
  async function seen(result: GetResult) {
    if (result === null) return "null";
    if (result.kind !== "body") return result;
    const bytes = new Uint8Array(await result.object.arrayBuffer());
    return { kind: "body", range: result.object.range, bodyBytes: bytes.length, firstByte: bytes[0] ?? null };
  }

  it("a satisfiable range is the part asked for, clamped to the object", async () => {
    const { key } = await stored();
    const cases: [R2Range, { offset: number; length: number }, number][] = [
      [{ offset: 0 }, { offset: 0, length: 1000 }, 0],
      [{ suffix: 100 }, { offset: 900, length: 100 }, 147],
      [{ offset: 999 }, { offset: 999, length: 1 }, 246],
      [{ offset: 0, length: 5000 }, { offset: 0, length: 1000 }, 0],
      [{ offset: 900, length: 200 }, { offset: 900, length: 100 }, 147],
      [{ suffix: 2000 }, { offset: 0, length: 1000 }, 0],
      [{ length: 10 }, { offset: 0, length: 10 }, 0],
      [{ offset: 2, length: 3 }, { offset: 2, length: 3 }, 2],
    ];
    for (const [range, expected, firstByte] of cases) {
      expect(await seen(await store.get(key, { range })), JSON.stringify(range)).toEqual({
        kind: "body",
        range: expected,
        bodyBytes: expected.length,
        firstByte,
      });
    }
    // A read without a range reports the whole object as its range.
    expect(await seen(await store.get(key))).toEqual({
      kind: "body",
      range: { offset: 0, length: 1000 },
      bodyBytes: 1000,
      firstByte: 0,
    });
  });

  it("a range outside the object is unsatisfiable_range with the size — never a throw", async () => {
    const { key } = await stored();
    const outside: unknown[] = [
      { offset: 5000 },
      { offset: 1000 },
      { offset: 1000, length: 6 },
      { offset: 0, length: 0 },
      { suffix: 0 },
      { offset: -1 },
      { offset: 1.5 },
      { length: -3 },
      { suffix: -1 },
      { offset: Number.NaN },
      { offset: "0" },
      {},
    ];
    for (const range of outside) {
      expect(await store.get(key, { range: range as R2Range }), JSON.stringify(range)).toEqual({
        kind: "unsatisfiable_range",
        size: 1000,
      });
    }
    // The last byte is inside; one past it is not.
    expect((await store.get(key, { range: { offset: 999 } }))?.kind).toBe("body");
    expect((await store.get(key, { range: { offset: 1000 } }))?.kind).toBe("unsatisfiable_range");
    // An empty object has no satisfiable range at all — and reads whole.
    const empty = freshKey();
    await store.put(empty, new Uint8Array(0), { size: 0 });
    for (const range of [{ offset: 0 }, { suffix: 10 }, { offset: 0, length: 10 }]) {
      expect(await store.get(empty, { range }), JSON.stringify(range)).toEqual({
        kind: "unsatisfiable_range",
        size: 0,
      });
    }
    expect((await store.get(empty))?.kind).toBe("body");
  });

  it("what the bare binding does with the same ranges here (recorded: the local store against the real one)", async () => {
    const { key } = await stored();
    const rows: string[] = [];
    for (const range of [
      { offset: 5000 },
      { offset: 1000 },
      { offset: 0, length: 0 },
      { suffix: 0 },
      { offset: -1 },
    ]) {
      const outcome = await env.FILES.get(key, { range }).then(
        async (object) => (object ? `body of ${(await object.arrayBuffer()).byteLength} bytes` : "null"),
        (error: Error) => `THROWS ${error.message}`,
      );
      rows.push(`${JSON.stringify(range)}\t${outcome}`);
    }
    console.log(`RANGE-TABLE range\tlocal binding\n${rows.map((row) => `RANGE-TABLE ${row}`).join("\n")}`);
    expect(rows).toHaveLength(5);
  });

  it("a missing key is null, with or without a range or a condition", async () => {
    const key = freshKey();
    expect(await store.get(key)).toBeNull();
    expect(await store.get(key, { range: { offset: 0, length: 10 } })).toBeNull();
    expect(await store.get(key, { range: { offset: 5000 } })).toBeNull();
    expect(await store.get(key, { range: { suffix: 0 } })).toBeNull();
    expect(await store.get(key, { onlyIf: { etagMatches: "abc" } })).toBeNull();
  });

  it("a condition that does not hold is precondition_failed, with the metadata and no body", async () => {
    const { key, etag } = await stored();
    const failing: R2Conditional[] = [
      { etagDoesNotMatch: etag },
      { etagMatches: "0cc175b9c0f1b6a831c399e269772661" },
      { uploadedAfter: new Date(Date.now() + 86_400_000) },
      { uploadedBefore: new Date("2020-01-01T00:00:00.000Z") },
    ];
    for (const onlyIf of failing) {
      const result = await store.get(key, { onlyIf });
      expect(result?.kind, JSON.stringify(onlyIf)).toBe("precondition_failed");
      if (result?.kind !== "precondition_failed") continue;
      expect(result.meta.size).toBe(1000);
      expect(result.meta.etag).toBe(etag);
      expect("body" in result.meta).toBe(false);
    }
    // A failed condition wins over a range.
    expect(
      (await store.get(key, { onlyIf: { etagDoesNotMatch: etag }, range: { offset: 0, length: 100 } }))?.kind,
    ).toBe("precondition_failed");
    // The controls: the same conditions the other way round give the body.
    for (const onlyIf of [
      { etagMatches: etag },
      { etagDoesNotMatch: "0cc175b9c0f1b6a831c399e269772661" },
      { uploadedAfter: new Date("2020-01-01T00:00:00.000Z") },
      { uploadedBefore: new Date(Date.now() + 86_400_000) },
    ]) {
      expect((await store.get(key, { onlyIf }))?.kind, JSON.stringify(onlyIf)).toBe("body");
    }
  });

  it("an ETag is accepted quoted, weak or bare — and a malformed one is no condition, never a throw", async () => {
    const { key, etag } = await stored();
    for (const spelling of [etag, `"${etag}"`, `W/"${etag}"`, ` "${etag}" `]) {
      expect((await store.get(key, { onlyIf: { etagDoesNotMatch: spelling } }))?.kind, spelling).toBe(
        "precondition_failed",
      );
      expect((await store.get(key, { onlyIf: { etagMatches: spelling } }))?.kind, spelling).toBe("body");
    }
    const malformed: unknown[] = [
      '"unterminated',
      'has"quote',
      "has space",
      "x".repeat(300),
      "",
      "line\nbreak",
      7,
      null,
      {},
      ["", 7],
    ];
    for (const bad of malformed) {
      // As "if none match": dropped, so the body is served (not a 304, not a 500).
      const none = await store.get(key, { onlyIf: { etagDoesNotMatch: bad as string } });
      expect(none?.kind, JSON.stringify(bad)).toBe("body");
      if (none?.kind === "body") await none.object.body.cancel();
      // As "if match": dropped too — no condition.
      const match = await store.get(key, { onlyIf: { etagMatches: bad as string } });
      expect(match?.kind, JSON.stringify(bad)).toBe("body");
      if (match?.kind === "body") await match.object.body.cancel();
    }
    // A malformed value beside a good condition leaves the good one standing.
    expect(
      (await store.get(key, { onlyIf: { etagMatches: "has space", etagDoesNotMatch: etag } }))?.kind,
    ).toBe("precondition_failed");
    // A date that is not a date is dropped as well.
    expect((await store.get(key, { onlyIf: { uploadedBefore: new Date("nope") } }))?.kind).toBe("body");
    expect((await store.get(key, { onlyIf: null as unknown as R2Conditional }))?.kind).toBe("body");
  });

  it("an ETag of * is not forwarded: it is no condition, whichever way round", async () => {
    const { key } = await stored();
    const asked: unknown[] = [];
    const counting = storage({
      FILES: {
        get: async (_key: string, options: unknown) => {
          asked.push(options);
          return null;
        },
      } as unknown as R2Bucket,
    });
    for (const star of ["*", '"*"', 'W/"*"', ["*"], ["*", "*"]]) {
      // On the real bucket: the body, both ways (a literal `*` would fail one of them).
      expect((await store.get(key, { onlyIf: { etagMatches: star as string } }))?.kind).toBe("body");
      expect((await store.get(key, { onlyIf: { etagDoesNotMatch: star as string } }))?.kind).toBe("body");
      await counting.get("t/x/y", { onlyIf: { etagMatches: star as string } });
      await counting.get("t/x/y", { onlyIf: { etagDoesNotMatch: star as string } });
    }
    // Nothing reached the store as a condition.
    expect(asked).toHaveLength(10);
    expect(asked).toEqual(asked.map(() => ({})));
    // A list that holds a real ETag beside * keeps the real one.
    await counting.get("t/x/y", { onlyIf: { etagMatches: ["*", "abc123"] as unknown as string } });
    expect(asked.at(-1)).toEqual({ onlyIf: { etagMatches: ["abc123"] } });
  });

  it("request headers are not an option: the parsed forms are the only ones the type takes", async () => {
    const { key } = await stored();
    const headers = new Headers({ range: "bytes=0-9" });
    // @ts-expect-error a Headers object is not a range
    const asRange = await store.get(key, { range: headers });
    // Handed in anyway, it is not passed on as a header: it is no valid range.
    expect(asRange).toEqual({ kind: "unsatisfiable_range", size: 1000 });
    // @ts-expect-error a Headers object is not a condition
    const asCondition = await store.get(key, { onlyIf: new Headers({ "if-none-match": "unquoted" }) });
    expect(asCondition?.kind).toBe("body");
  });

  it("a range that is wrong whatever the size is never handed to the store at all", async () => {
    const asked: unknown[] = [];
    const counting = storage({
      FILES: {
        get: async (_key: string, options: unknown) => {
          asked.push(options);
          return null;
        },
        head: async () => ({ size: 1000 }),
      } as unknown as R2Bucket,
    });
    for (const range of [
      { suffix: 0 },
      { offset: 0, length: 0 },
      { offset: -1 },
      {},
      new Headers({ range: "bytes=0-" }),
    ]) {
      expect(await counting.get("t/x/y", { range: range as R2Range })).toEqual({
        kind: "unsatisfiable_range",
        size: 1000,
      });
    }
    expect(asked).toEqual([]);
    // The control: a well-formed range is asked for, as the parsed object.
    await counting.get("t/x/y", { range: { offset: 5, length: 10 } });
    expect(asked).toEqual([{ range: { offset: 5, length: 10 } }]);
  });

  it("an error that is not about the range still surfaces", async () => {
    const failing = storage({
      FILES: {
        get: async () => {
          throw new Error("the store is down (made up for the test)");
        },
        head: async () => ({ size: 1000 }),
      } as unknown as R2Bucket,
    });
    await expect(failing.get("t/x/y", { range: { offset: 0, length: 10 } })).rejects.toThrow(
      "the store is down",
    );
    await expect(failing.get("t/x/y")).rejects.toThrow("the store is down");
  });

  it("a store that THROWS for a range past the end (as the real one does, error 10039) is mapped", async () => {
    // The real store's behaviour, reproduced: the local one may answer differently (see the table).
    const throwing = storage({
      FILES: {
        get: async (_key: string, options?: { range?: { offset?: number } }) => {
          if ((options?.range?.offset ?? 0) >= 1000) {
            throw new Error("get: The requested range is not satisfiable (10039)");
          }
          return null;
        },
        head: async (key: string) => (key === "t/x/gone" ? null : { size: 1000 }),
      } as unknown as R2Bucket,
    });
    expect(await throwing.get("t/x/y", { range: { offset: 1000 } })).toEqual({
      kind: "unsatisfiable_range",
      size: 1000,
    });
    expect(await throwing.get("t/x/y", { range: { offset: 5000, length: 5 } })).toEqual({
      kind: "unsatisfiable_range",
      size: 1000,
    });
    // The object vanished between the two calls.
    expect(await throwing.get("t/x/gone", { range: { offset: 5000 } })).toBeNull();
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

  it("deletePrefix refuses a whole area and anything wider; list refuses what is neither an area nor scoped", async () => {
    for (const prefix of ["", "/", "u/", "t/", "a/", "b/", "u", `t/${uuidv7()}`, "x/abc/", "t//", "t/../"]) {
      await expect(store.deletePrefix(prefix), prefix).rejects.toThrow("not scoped");
    }
    for (const prefix of ["", "/", "u", "x/", "x/abc/", "ut/", `t/${uuidv7()}`, "t//", "t/../", "u/../t/"]) {
      await expect(store.list(prefix), prefix).rejects.toThrow("not an area or a scoped prefix");
    }
  });

  it("list pages through a whole area — and deletePrefix on that same area still throws, deleting nothing", async () => {
    const nodeIds = Array.from({ length: 6 }, () => uuidv7());
    const version = uuidv7();
    const mine: string[] = [];
    for (const nodeId of nodeIds) {
      for (const size of THUMB_SIZES) mine.push(thumbKey(nodeId, version, size));
    }
    for (const key of mine) await store.put(key, encoder.encode("t"), { size: 1, contentType: "image/webp" });

    // The wrapper's own page size is 1,000; a small-page stand-in over the real bucket shows the cursor.
    const paged = storage({
      FILES: {
        list: (options: R2ListOptions) => env.FILES.list({ ...options, limit: 7 }),
      } as unknown as R2Bucket,
    });
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await paged.list("t/", cursor);
      seen.push(...page.objects.map((object) => object.key));
      cursor = page.cursor ?? undefined;
      pages += 1;
    } while (cursor !== undefined && pages < 50);
    expect(pages).toBeGreaterThan(2);
    expect(seen.filter((key) => mine.includes(key)).sort()).toEqual([...mine].sort());
    expect(new Set(seen).size, "no key twice").toBe(seen.length);
    expect(seen.every((key) => key.startsWith("t/"))).toBe(true);
    // The real wrapper answers the same area in one call, and the other areas list too.
    expect((await store.list("t/")).objects.length).toBeGreaterThanOrEqual(mine.length);
    for (const area of ["u/", "a/", "b/"]) expect(Array.isArray((await store.list(area)).objects)).toBe(true);

    await expect(store.deletePrefix("t/")).rejects.toThrow("not scoped");
    for (const key of mine) expect(await store.head(key), key).not.toBeNull();
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
    expect(second?.kind === "body" ? new Uint8Array(await second.object.arrayBuffer())[0] : null).toBe(2);
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

  it("abort swallows exactly 'no such upload' (10024) and nothing that merely sounds like it", async () => {
    const throwing = (message: string) =>
      ({ abort: async () => Promise.reject(new Error(message)) }) as unknown as R2MultipartUpload;
    // What the store says for an upload that is gone.
    await expect(
      store.abort(throwing("abortMultipartUpload: The specified multipart upload does not exist. (10024)")),
    ).resolves.toBeUndefined();
    for (const message of [
      "abortMultipartUpload: The specified bucket does not exist. (10006)",
      "abortMultipartUpload: We encountered an internal error. Please try again. (10001)",
      "completeMultipartUpload: The specified multipart upload does not exist. (10024)",
      "The specified multipart upload does not exist.",
      "abortMultipartUpload: something about 10024 in the middle (10001)",
      "NoSuchUpload",
      "Network connection lost.",
    ]) {
      await expect(store.abort(throwing(message)), message).rejects.toThrow(message);
    }
    await expect(
      store.abort({
        abort: async () => Promise.reject("a string, not an Error (10024)"),
      } as unknown as R2MultipartUpload),
    ).rejects.toBe("a string, not an Error (10024)");
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
