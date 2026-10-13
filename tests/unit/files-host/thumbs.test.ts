// Thumbnails: one WebP transform per (node, version, size), cached under `t/`. The image service
// is a stand-in here that records its calls — the local one cannot decode every type the list
// has and treats what a camera wrote into a picture differently from the deployed one, so what
// this file proves is what the code ASKS for and what it does when the service fails.
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { THUMB_INPUT_MAX_BYTES } from "../../../src/shared/constants";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { keyFor, thumbKey } from "../../../src/worker/services/storage";
import { failureMarker, makeThumbnail, UNCODED_TRIES } from "../../../src/worker/services/thumbnails";
import {
  ask,
  FAKE_WEBP,
  freshIp,
  gate,
  imagesMock,
  ipSubject,
  ledgerRow,
  linkOn,
  makeAccount,
  makeShare,
  NOT_FOUND,
  pattern,
  rand,
  spyBucket,
  storedFile,
  updateNode,
  urlFor,
  type AskOptions,
} from "./harness";

const picture = async (ownerId: string, set: Parameters<typeof storedFile>[1] = {}) =>
  (
    await storedFile(ownerId, {
      mime: "image/png",
      name: `photo-${rand()}.png`,
      content: pattern(2000),
      ...set,
    })
  ).node;

/** An error shaped like the image service's own: a numeric `code` and its message. */
const imagesError = (code: number, message: string) =>
  Object.assign(new Error(`IMAGES_TRANSFORM_ERROR ${code}: ${message}`), { code });

const units = async (ownerId: string) => (await ledgerRow("transform_user", ownerId))?.count ?? 0;

describe("a miss transforms once and caches; a hit serves the cached object", () => {
  it("asks for exactly a WebP of quality 80, scaled down to the size; stores it under t/<node>/<version>/<size>.webp; the second request does not transform", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock();
    const spy = spyBucket();
    const env = { IMAGES: images.binding, FILES: spy.bucket };
    const url = await urlFor("thumb", node, { user: owner.id }, { size: 320 });

    const first = await ask(url, { env });
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toBe("image/webp");
    expect(first.headers.get("content-length")).toBe(String(FAKE_WEBP.byteLength));
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(first.bytes).toEqual(FAKE_WEBP);

    expect(images.calls).toHaveLength(1);
    expect(images.calls[0]?.transform).toEqual({ width: 320, height: 320, fit: "scale-down" });
    expect(images.calls[0]?.output).toEqual({ format: "image/webp", quality: 80 });
    for (const options of [images.calls[0]?.transform, images.calls[0]?.output]) {
      expect(Object.keys(options as object)).not.toContain("metadata");
    }
    const key = `t/${node.id}/${node.versionId}/320.webp`;
    expect(spy.puts).toEqual([key]);
    expect(key).toBe(thumbKey(node.id, node.versionId, 320));
    const stored = await spy.bucket.head(key);
    expect(stored?.httpMetadata?.contentType).toBe("image/webp");
    expect(stored?.size).toBe(FAKE_WEBP.byteLength);

    const second = await ask(url, { env });
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toBe("image/webp");
    expect(second.bytes).toEqual(FAKE_WEBP);
    expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
    expect(images.calls).toHaveLength(1);
    expect(spy.puts).toHaveLength(1);
    // One unit for the one transform; the hit consumed nothing.
    expect(await ledgerRow("transform_user", owner.id)).toEqual({ bytes: 0, count: 1 });

    // The cached object answers like any other: revalidation and a range.
    const cached = await ask(url, { env, headers: { "if-none-match": second.headers.get("etag")! } });
    expect(cached.status).toBe(304);
    const ranged = await ask(url, { env, headers: { range: "bytes=0-3" } });
    expect(ranged.status).toBe(206);
    expect(ranged.bytes).toEqual(FAKE_WEBP.subarray(0, 4));
    expect(images.calls).toHaveLength(1);

    // Another size is another object and another transform.
    const small = await ask(await urlFor("thumb", node, { user: owner.id }, { size: 160 }), { env });
    expect(small.status).toBe(200);
    expect(images.calls[1]?.transform).toEqual({ width: 160, height: 160, fit: "scale-down" });
    expect(images.calls[1]?.output).toEqual({ format: "image/webp", quality: 80 });
    expect(spy.puts[1]).toBe(`t/${node.id}/${node.versionId}/160.webp`);
    expect(await units(owner.id)).toBe(2);
  });

  it("the image service is given the file's own bytes, and nothing is written under u/", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const spy = spyBucket();
    const images = imagesMock();
    await ask(await urlFor("thumb", node, { user: owner.id }), {
      env: { IMAGES: images.binding, FILES: spy.bucket },
    });
    expect(spy.gets.map((call) => call.key)).toEqual([thumbKey(node.id, node.versionId, 320), node.r2Key]);
    expect(spy.puts.every((key) => key.startsWith("t/"))).toBe(true);
  });

  it("a HEAD makes nothing: 404 on a miss with no transform and no unit; on a hit, the GET's headers", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock();
    const env = { IMAGES: images.binding };
    const url = await urlFor("thumb", node, { user: owner.id });
    const miss = await ask(url, { env, method: "HEAD" });
    expect(miss.status).toBe(404);
    expect(images.calls).toHaveLength(0);
    expect(await ledgerRow("transform_user", owner.id)).toBeNull();

    const got = await ask(url, { env });
    const hit = await ask(url, { env, method: "HEAD" });
    expect(hit.status).toBe(200);
    expect(hit.bytes).toHaveLength(0);
    for (const name of ["content-type", "content-length", "content-disposition", "accept-ranges"]) {
      expect(hit.headers.get(name), name).toBe(got.headers.get(name));
    }
    expect(images.calls).toHaveLength(1);
  });

  it("a link's thumbnail and a share partner's are the same cached object: one transform for all three viewers", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const link = await linkOn(node.id, owner.id);
    const images = imagesMock();
    const env = { IMAGES: images.binding };
    for (const subject of [{ user: owner.id }, { link }, { link }]) {
      expect((await ask(await urlFor("thumb", node, subject), { env })).status).toBe(200);
    }
    expect(images.calls).toHaveLength(1);
    expect(await units(owner.id)).toBe(1);
  });
});

describe("degrade, never fail: whatever the image service does, the answer is the icon's 404", () => {
  const failures: Array<[string, () => Error]> = [
    ["the monthly quota (9422)", () => imagesError(9422, "The transformation quota has been reached")],
    ["an untyped connection error", () => new Error("Network connection lost.")],
    ["an input it cannot decode (9523)", () => imagesError(9523, "heif: Decoder plugin generated an error")],
    ["something that is not an Error", () => "nope" as unknown as Error],
  ];

  it.each(failures)(
    "%s → 404, ONE call, nothing written, and the unit stays charged",
    async (_name, failure) => {
      const owner = await makeAccount();
      const node = await picture(owner.id);
      const spy = spyBucket();
      const images = imagesMock(() => {
        throw failure();
      });
      const env = { IMAGES: images.binding, FILES: spy.bucket };
      const url = await urlFor("thumb", node, { user: owner.id });
      const answer = await ask(url, { env });
      expect(answer.status).toBe(404);
      expect(answer.text).toBe(NOT_FOUND);
      expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(images.calls).toHaveLength(1);
      expect(spy.puts).toEqual([]);
      expect(await spy.bucket.head(thumbKey(node.id, node.versionId, 320))).toBeNull();
      expect(await units(owner.id)).toBe(1);
      // No byte was charged for a response that carried none of the file.
      expect(await ledgerRow("user", owner.id)).toBeNull();
    },
  );

  it("with the image service failing on every call, every /t/ request is a 404 and none is a 5xx — one call each, never a retry", async () => {
    for (const failure of [failures[0]![1], failures[1]![1]]) {
      const owner = await makeAccount();
      const images = imagesMock(() => {
        throw failure();
      });
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const node = await picture(owner.id, { mime: i % 2 ? "image/jpeg" : "image/png" });
        for (const size of [160, 320, 1280] as const) {
          const url = await urlFor("thumb", node, { user: owner.id }, { size });
          statuses.push((await ask(url, { env: { IMAGES: images.binding } })).status);
        }
      }
      expect(statuses).toEqual(Array.from({ length: 18 }, () => 404));
      expect(images.calls).toHaveLength(18);
    }
  });

  it("a service that answers with no bytes → 404, nothing written", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const spy = spyBucket();
    const images = imagesMock(() => new Uint8Array(0));
    const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
      env: { IMAGES: images.binding, FILES: spy.bucket },
    });
    expect(answer.status).toBe(404);
    expect(spy.puts).toEqual([]);
  });

  it("the cache write failing after a good transform still serves the thumbnail", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock();
    const broken = spyBucket({
      put: (async () => {
        throw new Error("the store is down");
      }) as unknown as R2Bucket["put"],
    });
    const url = await urlFor("thumb", node, { user: owner.id });
    const answer = await ask(url, { env: { IMAGES: images.binding, FILES: broken.bucket } });
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toBe("image/webp");
    expect(answer.bytes).toEqual(FAKE_WEBP);
    // Nothing was cached, so the next request transforms again.
    expect((await ask(url, { env: { IMAGES: images.binding } })).status).toBe(200);
    expect(images.calls).toHaveLength(2);
  });

  it("the file's own object missing → 404 without calling the image service", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id, { content: null, node: { size: 2000 } });
    const images = imagesMock();
    const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
      env: { IMAGES: images.binding },
    });
    expect(answer.status).toBe(404);
    expect(images.calls).toHaveLength(0);
  });
});

describe("what reaches the image service", () => {
  it("an image above the input limit never does — and one exactly at the limit does", async () => {
    const owner = await makeAccount();
    const images = imagesMock();
    const env = { IMAGES: images.binding };
    const over = await picture(owner.id, { node: { size: THUMB_INPUT_MAX_BYTES + 1 } });
    const answer = await ask(await urlFor("thumb", over, { user: owner.id }), { env });
    expect(answer.status).toBe(404);
    expect(answer.text).toBe(NOT_FOUND);
    expect(images.calls).toHaveLength(0);
    expect(await ledgerRow("transform_user", owner.id)).toBeNull();

    // The control: the same file one byte smaller in the database is transformed.
    const at = await picture(owner.id, { node: { size: THUMB_INPUT_MAX_BYTES } });
    expect((await ask(await urlFor("thumb", at, { user: owner.id }), { env })).status).toBe(200);
    expect(images.calls).toHaveLength(1);
  });

  it("the thumbnail function refuses an oversize input itself, before it asks for anything", async () => {
    // No request context at all: it must not get as far as needing one.
    const nothing = {} as Context<AppEnv>;
    const owner = { id: "owner", account: { quotaBytes: 0, createdAt: new Date(0) } };
    const node = { id: crypto.randomUUID(), versionId: "v", r2Key: "u/x", size: THUMB_INPUT_MAX_BYTES + 1 };
    expect(await makeThumbnail(nothing, node, 320, owner)).toEqual({ ok: false, reason: "too_large" });
    expect(await makeThumbnail(nothing, { ...node, size: Number.NaN }, 320, owner)).toEqual({
      ok: false,
      reason: "too_large",
    });
  });

  it("HEIC and HEIF are on the list: each reaches the image service", async () => {
    const owner = await makeAccount();
    for (const [mime, name] of [
      ["image/heic", "phone.heic"],
      ["image/heif", "camera.heif"],
      ["image/jpeg", "scan.jpg"],
      ["image/gif", "loop.gif"],
      ["image/webp", "web.webp"],
    ] as const) {
      const images = imagesMock();
      const node = await picture(owner.id, { mime, name });
      const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
        env: { IMAGES: images.binding },
      });
      expect(answer.status, mime).toBe(200);
      expect(answer.headers.get("content-type"), mime).toBe("image/webp");
      expect(images.calls, mime).toHaveLength(1);
    }
  });
});

describe("the daily transform ceiling", () => {
  const N = 3;
  const limited = (env: Record<string, unknown>): AskOptions => ({
    env,
    settings: { ceilings: { CEIL_TRANSFORMS_DAY: N } },
  });

  it("N misses each take one unit and transform; miss N+1 is a 404 and the image service is not called; a hit takes nothing", async () => {
    const owner = await makeAccount();
    const images = imagesMock();
    const options = limited({ IMAGES: images.binding });
    const urls: string[] = [];
    for (let i = 0; i < N; i++) {
      urls.push(await urlFor("thumb", await picture(owner.id), { user: owner.id }));
      expect((await ask(urls[i]!, options)).status).toBe(200);
      expect(await units(owner.id)).toBe(i + 1);
    }
    expect(images.calls).toHaveLength(N);

    const spy = spyBucket();
    const next = await picture(owner.id);
    const refused = await ask(await urlFor("thumb", next, { user: owner.id }), {
      ...options,
      env: { IMAGES: images.binding, FILES: spy.bucket },
    });
    expect(refused.status).toBe(404);
    expect(refused.text).toBe(NOT_FOUND);
    expect(images.calls).toHaveLength(N);
    expect(spy.puts).toEqual([]);
    // The file itself was not even read.
    expect(spy.gets.map((call) => call.key)).toEqual([thumbKey(next.id, next.versionId, 320)]);
    expect(await units(owner.id)).toBe(N);

    // A cached thumbnail is still served, and consumes nothing.
    expect((await ask(urls[0]!, options)).status).toBe(200);
    expect(await units(owner.id)).toBe(N);
    expect(images.calls).toHaveLength(N);

    // Another owner has their own day.
    const other = await makeAccount();
    const theirs = await urlFor("thumb", await picture(other.id), { user: other.id });
    expect((await ask(theirs, options)).status).toBe(200);
  });

  it("N+5 misses at once, for different files of one owner → exactly N transforms and N units", async () => {
    const owner = await makeAccount();
    const hold = gate();
    const images = imagesMock(async () => {
      await hold.opened;
      return FAKE_WEBP;
    });
    const options = limited({ IMAGES: images.binding });
    const urls: string[] = [];
    for (let i = 0; i < N + 5; i++) {
      urls.push(await urlFor("thumb", await picture(owner.id), { user: owner.id }));
    }
    // Every admitted transform is held open, so all N+5 requests are in flight together; the
    // refused ones answer on their own.
    const refusedAll = gate();
    let refused = 0;
    const answers = urls.map((url) =>
      ask(url, options).then((answer) => {
        if (answer.status === 404 && ++refused === 5) refusedAll.open();
        return answer;
      }),
    );
    await refusedAll.opened;
    expect(images.calls).toHaveLength(N);
    expect(await units(owner.id)).toBe(N);
    hold.open();
    const statuses = (await Promise.all(answers)).map((answer) => answer.status).sort();
    expect(statuses).toEqual([
      ...Array.from({ length: N }, () => 200),
      ...Array.from({ length: 5 }, () => 404),
    ]);
    expect(images.calls).toHaveLength(N);
    expect(await units(owner.id)).toBe(N);
  });
});

describe("a thumbnail that failed today is not tried again today", () => {
  it("thirteen requests for one failing thumbnail — a link, a share partner, an address already over its own ceiling — cost the owner ONE unit and the account ONE call; nobody is charged a byte", async () => {
    const owner = await makeAccount();
    const partner = await makeAccount();
    const node = await picture(owner.id);
    await makeShare(node.id, owner.id, partner.id);
    const link = await linkOn(node.id, owner.id);
    const images = imagesMock(() => {
      throw imagesError(9523, "heif: Decoder plugin generated an error");
    });
    const spy = spyBucket();
    const env = { IMAGES: images.binding, FILES: spy.bucket };
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const subject = i % 2 ? { user: partner.id } : { link };
      const answer = await ask(await urlFor("thumb", node, subject), { ip, env });
      expect(answer.text).toBe(NOT_FOUND);
      statuses.push(answer.status);
    }
    const over = freshIp();
    for (let i = 0; i < 3; i++) {
      const answer = await ask(await urlFor("thumb", node, { link }), {
        ip: over,
        env,
        settings: { ceilings: { CEIL_IP_BYTES_DAY: 0 } },
      });
      statuses.push(answer.status);
    }
    expect(statuses).toEqual(Array.from({ length: 13 }, () => 404));
    expect(images.calls).toHaveLength(1);
    expect(await ledgerRow("transform_user", owner.id)).toEqual({ bytes: 0, count: 1 });
    expect(await ledgerRow("notice", failureMarker(node, 320))).toEqual({ bytes: 0, count: 1 });
    expect(spy.puts).toEqual([]);
    // The file itself was read once: for the one attempt.
    expect(spy.gets.filter((call) => call.key === node.r2Key)).toHaveLength(1);
    for (const row of [
      await ledgerRow("ip", await ipSubject(ip)),
      await ledgerRow("ip", await ipSubject(over)),
      await ledgerRow("user", partner.id),
      await ledgerRow("link", link.id),
      await ledgerRow("link_owner", owner.id),
    ]) {
      expect(row).toBeNull();
    }
  });

  it("the marker is for one size of one version on one day: another size, a replaced file and the next UTC day each get a fresh attempt", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const failing = imagesMock(() => {
      throw imagesError(9422, "The transformation quota has been reached");
    });
    const working = imagesMock();
    const subject = { user: owner.id };
    expect(
      (await ask(await urlFor("thumb", node, subject), { env: { IMAGES: failing.binding } })).status,
    ).toBe(404);
    // Marked: even a service that would now succeed is not asked.
    expect(
      (await ask(await urlFor("thumb", node, subject), { env: { IMAGES: working.binding } })).status,
    ).toBe(404);
    expect(working.calls).toHaveLength(0);

    // Another size.
    const small = await ask(await urlFor("thumb", node, subject, { size: 160 }), {
      env: { IMAGES: working.binding },
    });
    expect(small.status).toBe(200);
    expect(working.calls).toHaveLength(1);

    // The next UTC day: the marker was yesterday's.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const later = await ask(await urlFor("thumb", node, subject), {
      now: tomorrow,
      env: { IMAGES: working.binding },
    });
    expect(later.status).toBe(200);
    expect(working.calls).toHaveLength(2);

    // A replaced file: a new version, a new key, no marker.
    const replaced = await picture(owner.id);
    expect(
      (await ask(await urlFor("thumb", replaced, subject), { env: { IMAGES: failing.binding } })).status,
    ).toBe(404);
    const versionId = crypto.randomUUID();
    const r2Key = keyFor(owner.id, replaced.id, versionId);
    await spyBucket().bucket.put(r2Key, pattern(2000, 3));
    await updateNode(replaced.id, { versionId, r2Key });
    const fresh = await ask(await urlFor("thumb", { id: replaced.id, versionId }, subject), {
      env: { IMAGES: working.binding },
    });
    expect(fresh.status).toBe(200);
    expect(working.calls).toHaveLength(3);
  });

  it("a transform that succeeds leaves no marker; a missing source object and an empty output leave one", async () => {
    const owner = await makeAccount();
    const good = await picture(owner.id);
    expect(
      (await ask(await urlFor("thumb", good, { user: owner.id }), { env: { IMAGES: imagesMock().binding } }))
        .status,
    ).toBe(200);
    expect(await ledgerRow("notice", failureMarker(good, 320))).toBeNull();

    const gone = await picture(owner.id, { content: null, node: { size: 2000 } });
    const empty = await picture(owner.id);
    const nothing = imagesMock(() => new Uint8Array(0));
    for (const node of [gone, empty]) {
      for (let i = 0; i < 4; i++) {
        expect(
          (await ask(await urlFor("thumb", node, { user: owner.id }), { env: { IMAGES: nothing.binding } }))
            .status,
        ).toBe(404);
      }
      expect(await ledgerRow("notice", failureMarker(node, 320))).toEqual({ bytes: 0, count: 1 });
    }
    // One call for the empty output; none at all for the missing object. Three units in all.
    expect(nothing.calls).toHaveLength(1);
    expect(await units(owner.id)).toBe(3);
  });

  it("a failure without a code is tried again, three times a day at most: six requests → three calls, three units", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock(() => {
      throw new Error("Network connection lost.");
    });
    const url = await urlFor("thumb", node, { user: owner.id });
    for (let i = 0; i < 6; i++)
      expect((await ask(url, { env: { IMAGES: images.binding } })).status).toBe(404);
    expect(UNCODED_TRIES).toBe(3);
    expect(images.calls).toHaveLength(3);
    expect(await units(owner.id)).toBe(3);
    expect(await ledgerRow("notice", failureMarker(node, 320))).toEqual({ bytes: 3, count: 0 });
    // A connection that comes back within the three tries is not held against the thumbnail.
    const flaky = await picture(owner.id);
    let failures = 2;
    const recovering = imagesMock(() => {
      if (failures-- > 0) throw new Error("Network connection lost.");
      return FAKE_WEBP;
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push(
        (await ask(await urlFor("thumb", flaky, { user: owner.id }), { env: { IMAGES: recovering.binding } }))
          .status,
      );
    }
    expect(statuses).toEqual([404, 404, 200, 200]);
    expect(recovering.calls).toHaveLength(3);
  });

  it("two misses at once that both fail → at most two calls and ONE marker; after them, none", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const hold = gate();
    const bothIn = gate();
    let inside = 0;
    const images = imagesMock(async () => {
      if (++inside === 2) bothIn.open();
      await hold.opened;
      throw imagesError(9523, "heif: Decoder plugin generated an error");
    });
    const env = { IMAGES: images.binding };
    const url = await urlFor("thumb", node, { user: owner.id });
    const both = [ask(url, { env }), ask(url, { env })];
    // Both are inside the image service before either has failed.
    await bothIn.opened;
    hold.open();
    expect((await Promise.all(both)).map((answer) => answer.status)).toEqual([404, 404]);
    expect(images.calls).toHaveLength(2);
    expect(await ledgerRow("notice", failureMarker(node, 320))).toEqual({ bytes: 0, count: 1 });
    for (let i = 0; i < 5; i++) expect((await ask(url, { env })).status).toBe(404);
    expect(images.calls).toHaveLength(2);
    expect(await units(owner.id)).toBe(2);
  });
});
