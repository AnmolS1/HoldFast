// Thumbnails: one WebP transform per (node, version, size), cached under `t/`. The image service
// is a stand-in here that records its calls — the local one cannot decode every type the list
// has and treats what a camera wrote into a picture differently from the deployed one, so what
// this file proves is what the code ASKS for and what it does when the service fails.
import { eq } from "drizzle-orm";
import type { Context } from "hono";
import { describe, expect, it } from "vitest";
import { THUMB_INPUT_MAX_BYTES } from "../../../src/shared/constants";
import type { AppEnv } from "../../../src/worker/services/request-context";
import { addUsageIfUnder, subtractUsage } from "../../../src/worker/db/queries/ledger";
import { takeOverStaleHold } from "../../../src/worker/db/queries/files-host";
import { nodes } from "../../../src/worker/db/schema";
import { dayUTC } from "../../../src/worker/services/ip-hash";
import { keyFor, thumbKey } from "../../../src/worker/services/storage";
import {
  failureMarker,
  makeThumbnail,
  HOLD_STALE_SECONDS,
  THUMB_CALLS_PER_DAY,
  thumbMaxBytes,
  unitMarker,
  type ThumbOwner,
} from "../../../src/worker/services/thumbnails";
import { invoke } from "../services-core/request";
import {
  ask,
  FAKE_WEBP,
  freshIp,
  gate,
  testDb,
  newCtx,
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
      // No byte was charged for a response that carried none of the file. (The asker's own room
      // was asked for one byte before the transform, and given back.)
      expect((await ledgerRow("user", owner.id))?.bytes ?? 0).toBe(0);
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
    // Opens once the N admitted transforms are inside the image service AND the five refused
    // requests have answered — both events, so neither count is read early.
    const settled = gate();
    let inside = 0;
    let refused = 0;
    const check = () => inside >= N && refused === 5 && settled.open();
    const images = imagesMock(async () => {
      inside++;
      check();
      await hold.opened;
      return FAKE_WEBP;
    });
    // All N+5 are lined up at their cache lookup and let go together, so their unit consumes
    // overlap: a "read the total, then add" consume would let more than N through.
    const lineUp = gate();
    let arrived = 0;
    const lined = spyBucket({
      get: (async (key: string, opts?: R2GetOptions) => {
        if (key.startsWith("t/") && ++arrived === N + 5) lineUp.open();
        if (key.startsWith("t/")) await lineUp.opened;
        return spyBucket().bucket.get(key, opts);
      }) as R2Bucket["get"],
    });
    const options = limited({ IMAGES: images.binding, FILES: lined.bucket });
    const urls: string[] = [];
    for (let i = 0; i < N + 5; i++) {
      urls.push(await urlFor("thumb", await picture(owner.id), { user: owner.id }));
    }
    // Every admitted transform is held open, so all N+5 requests are in flight together; the
    // refused ones answer on their own.
    const answers = urls.map((url) =>
      ask(url, options).then((answer) => {
        if (answer.status === 404) {
          refused++;
          check();
        }
        return answer;
      }),
    );
    await settled.opened;
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

describe("one thumbnail per day: at most three calls of the image service and one unit of its owner's", () => {
  /** Opens once every one of `total` requests is inside the image service or has answered a 404. */
  const tally = (total: number) => {
    const all = gate();
    let inside = 0;
    let out = 0;
    const check = () => {
      if (inside + out === total) all.open();
    };
    return {
      all: all.opened,
      enter: () => {
        inside++;
        check();
      },
      answered: <T extends { status: number }>(answer: T) => {
        if (answer.status === 404) {
          out++;
          check();
        }
        return answer;
      },
    };
  };
  const unitRow = (node: { id: string; versionId: string }) => ledgerRow("notice", unitMarker(node, 320));
  const callRow = (node: { id: string; versionId: string }) => ledgerRow("notice", failureMarker(node, 320));

  it("thirteen requests for one failing thumbnail — a link and a share partner alternating, then an address already over its own ceiling — cost the owner ONE unit and the account ONE call; the exhausted address is refused before either; nobody is charged a byte", async () => {
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
    // The exhausted address: its own refusal, before the owner's unit or the image service.
    expect(statuses).toEqual([...Array.from({ length: 10 }, () => 404), 429, 429, 429]);
    expect(images.calls).toHaveLength(1);
    expect(await ledgerRow("transform_user", owner.id)).toEqual({ bytes: 0, count: 1 });
    // One call made, then given up on for the day: the count is past the cap.
    expect(await callRow(node)).toEqual({ bytes: 0, count: 1 + THUMB_CALLS_PER_DAY });
    expect(await unitRow(node)).toMatchObject({ count: 1 });
    expect(spy.puts).toEqual([]);
    // The file itself was read once: for the one call.
    expect(spy.gets.filter((call) => call.key === node.r2Key)).toHaveLength(1);
    // The askers' own ledgers were asked for one byte of room and given it back; nobody else's.
    for (const row of [
      await ledgerRow("ip", await ipSubject(ip)),
      await ledgerRow("ip", await ipSubject(over)),
      await ledgerRow("user", partner.id),
    ]) {
      expect(row?.bytes ?? 0).toBe(0);
    }
    for (const row of [await ledgerRow("link", link.id), await ledgerRow("link_owner", owner.id)]) {
      expect(row).toBeNull();
    }
  });

  it("the markers are for one size of one version on one day: another size, a replaced file and the next UTC day each get a fresh day", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const failing = imagesMock(() => {
      throw imagesError(9422, "The transformation quota has been reached");
    });
    const working = imagesMock();
    const subject = { user: owner.id };
    const first = await ask(await urlFor("thumb", node, subject), { env: { IMAGES: failing.binding } });
    expect(first.status).toBe(404);
    // Given up on: even a service that would now succeed is not asked.
    const second = await ask(await urlFor("thumb", node, subject), { env: { IMAGES: working.binding } });
    expect(second.status).toBe(404);
    expect(working.calls).toHaveLength(0);

    // Another size.
    const small = await ask(await urlFor("thumb", node, subject, { size: 160 }), {
      env: { IMAGES: working.binding },
    });
    expect(small.status).toBe(200);
    expect(working.calls).toHaveLength(1);

    // The next UTC day: the markers were yesterday's.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const later = await ask(await urlFor("thumb", node, subject), {
      now: tomorrow,
      env: { IMAGES: working.binding },
    });
    expect(later.status).toBe(200);
    expect(working.calls).toHaveLength(2);

    // A replaced file: a new version, new keys, no marker.
    const replaced = await picture(owner.id);
    const before = await ask(await urlFor("thumb", replaced, subject), { env: { IMAGES: failing.binding } });
    expect(before.status).toBe(404);
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

  it("a transform that succeeds is one call and one unit and is never given up on; a missing source object and an empty output are", async () => {
    const owner = await makeAccount();
    const good = await picture(owner.id);
    const fine = imagesMock();
    for (let i = 0; i < 6; i++) {
      const answer = await ask(await urlFor("thumb", good, { user: owner.id }), {
        env: { IMAGES: fine.binding },
      });
      expect(answer.status).toBe(200);
    }
    // Five of the six were cache hits: they claimed nothing.
    expect(fine.calls).toHaveLength(1);
    expect(await callRow(good)).toEqual({ bytes: 0, count: 1 });
    expect(await unitRow(good)).toMatchObject({ count: 1 });

    const gone = await picture(owner.id, { content: null, node: { size: 2000 } });
    const empty = await picture(owner.id);
    const nothing = imagesMock(() => new Uint8Array(0));
    for (const node of [gone, empty]) {
      for (let i = 0; i < 4; i++) {
        const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
          env: { IMAGES: nothing.binding },
        });
        expect(answer.status).toBe(404);
      }
      expect(await callRow(node)).toEqual({ bytes: 0, count: 1 + THUMB_CALLS_PER_DAY });
    }
    // One call for the empty output; none at all for the missing object. Three units in all.
    expect(nothing.calls).toHaveLength(1);
    expect(await units(owner.id)).toBe(3);
  });

  it("a failure without a code is a call that stays counted, and the owner pays once: six requests → three calls, ONE unit", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock(() => {
      throw new Error("Network connection lost.");
    });
    const url = await urlFor("thumb", node, { user: owner.id });
    for (let i = 0; i < 6; i++)
      expect((await ask(url, { env: { IMAGES: images.binding } })).status).toBe(404);
    expect(THUMB_CALLS_PER_DAY).toBe(3);
    expect(images.calls).toHaveLength(3);
    expect(await units(owner.id)).toBe(1);
    expect(await callRow(node)).toEqual({ bytes: 0, count: 3 });
    // A connection that comes back within the three calls is not held against the thumbnail.
    const flaky = await picture(owner.id);
    let failures = 2;
    const recovering = imagesMock(() => {
      if (failures-- > 0) throw new Error("Network connection lost.");
      return FAKE_WEBP;
    });
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const answer = await ask(await urlFor("thumb", flaky, { user: owner.id }), {
        env: { IMAGES: recovering.binding },
      });
      statuses.push(answer.status);
    }
    expect(statuses).toEqual([404, 404, 200, 200]);
    expect(recovering.calls).toHaveLength(3);
    expect(await units(owner.id)).toBe(2);
  });

  it("fifty requests that are cut before the image service answers, on one thumbnail that can be made → three calls and one unit; then the icon until 00:00 UTC, and the next day an honest request renders", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    // Locally an aborted request runs to its end, so "the call was cut" is the service never
    // answering with a result: an untyped error, as a lost connection or a killed invocation is.
    const cut = imagesMock(() => {
      throw new Error("Network connection lost.");
    });
    const link = await linkOn(node.id, owner.id);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 50; i++) {
      statuses.push(
        (await ask(await urlFor("thumb", node, { link }), { ip, env: { IMAGES: cut.binding } })).status,
      );
    }
    expect(statuses).toEqual(Array.from({ length: 50 }, () => 404));
    expect(cut.calls).toHaveLength(THUMB_CALLS_PER_DAY);
    expect(await units(owner.id)).toBe(1);
    // The asking address paid nothing in bytes: no response carried any.
    expect((await ledgerRow("ip", await ipSubject(ip)))?.bytes ?? 0).toBe(0);

    // Today the thumbnail is the icon, even for its owner and with a service that now works.
    const working = imagesMock();
    const url = await urlFor("thumb", node, { user: owner.id });
    expect((await ask(url, { env: { IMAGES: working.binding } })).status).toBe(404);
    expect(working.calls).toHaveLength(0);

    // The next UTC day: one call, one unit of that day, served and cached.
    const tomorrow = new Date(Date.now() + 86_400_000);
    const next = await ask(url, { now: tomorrow, env: { IMAGES: working.binding } });
    expect(next.status).toBe(200);
    expect(next.bytes).toEqual(FAKE_WEBP);
    expect(working.calls).toHaveLength(1);
    expect(await ledgerRow("transform_user", owner.id, dayUTC(tomorrow))).toEqual({ bytes: 0, count: 1 });
  });

  it("a thumbnail whose cache write fails every time is served three times and then is the icon: nothing gives a call back", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock();
    const broken = spyBucket({
      put: (async () => {
        throw new Error("the store is down");
      }) as unknown as R2Bucket["put"],
    });
    const env = { IMAGES: images.binding, FILES: broken.bucket };
    const url = await urlFor("thumb", node, { user: owner.id });
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await ask(url, { env })).status);
    expect(statuses).toEqual([200, 200, 200, 404, 404, 404, 404, 404]);
    expect(images.calls).toHaveLength(THUMB_CALLS_PER_DAY);
    expect(await units(owner.id)).toBe(1);
    // Never given up on — the image was fine — but no call is left today.
    expect(await callRow(node)).toEqual({ bytes: 0, count: THUMB_CALLS_PER_DAY });
  });

  it("twenty misses at once for ONE failing thumbnail → at most three calls and ONE unit between them, twenty 404s; after them, none", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const link = await linkOn(node.id, owner.id);
    const hold = gate();
    const count = tally(20);
    const images = imagesMock(async () => {
      count.enter();
      await hold.opened;
      throw imagesError(9523, "heif: Decoder plugin generated an error");
    });
    const env = { IMAGES: images.binding };
    const answers = [];
    for (let i = 0; i < 20; i++) {
      const url = await urlFor("thumb", node, i % 2 ? { link } : { user: owner.id });
      answers.push(ask(url, { env }).then(count.answered));
    }
    // Every request is either inside the image service, held there, or has answered.
    await count.all;
    hold.open();
    const statuses = (await Promise.all(answers)).map((answer) => answer.status);
    expect(statuses).toEqual(Array.from({ length: 20 }, () => 404));
    expect(images.calls.length).toBeGreaterThanOrEqual(1);
    expect(images.calls.length).toBeLessThanOrEqual(THUMB_CALLS_PER_DAY);
    expect(await units(owner.id)).toBe(1);
    for (let i = 0; i < 5; i++) {
      expect((await ask(await urlFor("thumb", node, { link }), { env })).status).toBe(404);
    }
    expect(images.calls.length).toBeLessThanOrEqual(THUMB_CALLS_PER_DAY);
  });

  it("twenty misses at once for ONE thumbnail that can be made → at most three transforms and ONE unit; the next request is a cache hit", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const hold = gate();
    const count = tally(20);
    const images = imagesMock(async () => {
      count.enter();
      await hold.opened;
      return FAKE_WEBP;
    });
    const spy = spyBucket();
    const env = { IMAGES: images.binding, FILES: spy.bucket };
    const url = await urlFor("thumb", node, { user: owner.id });
    // The admitted transforms are held open until every other request has answered — otherwise a
    // late one finds the finished thumbnail in the cache (a 200 it is welcome to, but then the
    // counts are not fixed).
    const answers = Array.from({ length: 20 }, () => ask(url, { env }).then(count.answered));
    await count.all;
    const made = images.calls.length;
    expect(made).toBeGreaterThanOrEqual(1);
    expect(made).toBeLessThanOrEqual(THUMB_CALLS_PER_DAY);
    hold.open();
    const statuses = (await Promise.all(answers)).map((answer) => answer.status).sort();
    expect(statuses).toEqual([
      ...Array.from({ length: made }, () => 200),
      ...Array.from({ length: 20 - made }, () => 404),
    ]);
    expect(await units(owner.id)).toBe(1);
    // Writers of one key, the same bytes: one object.
    expect(spy.puts).toEqual(Array.from({ length: made }, () => thumbKey(node.id, node.versionId, 320)));
    const after = await ask(url, { env });
    expect(after.status).toBe(200);
    expect(after.bytes).toEqual(FAKE_WEBP);
    expect(images.calls).toHaveLength(made);
    expect(await units(owner.id)).toBe(1);
  });

  it("an owner at their transform ceiling: ten misses at once for one thumbnail → no call; and the unit already paid for one thumbnail does not pay for another", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock();
    const atCeiling = { env: { IMAGES: images.binding }, settings: { ceilings: { CEIL_TRANSFORMS_DAY: 0 } } };
    const url = await urlFor("thumb", node, { user: owner.id });
    const statuses = (await Promise.all(Array.from({ length: 10 }, () => ask(url, atCeiling)))).map(
      (answer) => answer.status,
    );
    expect(statuses).toEqual(Array.from({ length: 10 }, () => 404));
    expect(images.calls).toHaveLength(0);
    expect(await units(owner.id)).toBe(0);

    // A ceiling of one: thumbnail A takes it; ten misses at once each for A' and B are refused.
    const one = await makeAccount();
    const a = await picture(one.id);
    const b = await picture(one.id);
    const c = await picture(one.id);
    const single = { env: { IMAGES: images.binding }, settings: { ceilings: { CEIL_TRANSFORMS_DAY: 1 } } };
    expect((await ask(await urlFor("thumb", a, { user: one.id }), single)).status).toBe(200);
    expect(images.calls).toHaveLength(1);
    const urls = [await urlFor("thumb", b, { user: one.id }), await urlFor("thumb", c, { user: one.id })];
    const refused = await Promise.all(Array.from({ length: 20 }, (_, i) => ask(urls[i % 2]!, single)));
    expect(refused.map((answer) => answer.status)).toEqual(Array.from({ length: 20 }, () => 404));
    expect(images.calls).toHaveLength(1);
    expect(await units(one.id)).toBe(1);
  });

  it("an attempt that ends for a reason that is not the image's is given back: the owner's unit refused five times does not cost the thumbnail its day", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const images = imagesMock();
    const url = await urlFor("thumb", node, { user: owner.id });
    const none = { env: { IMAGES: images.binding }, settings: { ceilings: { CEIL_TRANSFORMS_DAY: 0 } } };
    for (let i = 0; i < 5; i++) expect((await ask(url, none)).status).toBe(404);
    expect(images.calls).toHaveLength(0);
    expect(await callRow(node)).toBeNull();
    expect(await unitRow(node)).toEqual({ bytes: 0, count: 0 });
    // With a unit to spend, it is made.
    expect((await ask(url, { env: { IMAGES: images.binding } })).status).toBe(200);
    expect(images.calls).toHaveLength(1);
  });

  it("the attempt is handed to the request's deferred work before the image service is asked: it does not depend on the asker staying", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const ctx = newCtx();
    let deferredBefore = -1;
    let deferredDuring = -1;
    const images = imagesMock(() => {
      deferredDuring = ctx.pending.length;
      return FAKE_WEBP;
    });
    const watching = spyBucket({
      get: (async (key: string, options?: R2GetOptions) => {
        // The cache lookup: nothing of the attempt exists yet.
        if (key.startsWith("t/")) deferredBefore = ctx.pending.length;
        return spyBucket().bucket.get(key, options);
      }) as R2Bucket["get"],
    });
    const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
      ctx,
      env: { IMAGES: images.binding, FILES: watching.bucket },
    });
    expect(answer.status).toBe(200);
    expect(deferredBefore).toBe(0);
    expect(deferredDuring).toBe(1);
  });
});

describe("the owner-unit hold can never wedge a thumbnail", () => {
  const unitRow = (node: { id: string; versionId: string }) => ledgerRow("notice", unitMarker(node, 320));
  /** A hold left behind by a request that never came back, `ageSeconds` ago. */
  const leftHold = (node: { id: string; versionId: string }, ageSeconds: number) =>
    addUsageIfUnder(
      testDb(),
      dayUTC(new Date()),
      "notice",
      unitMarker(node, 320),
      { bytes: Math.floor(Date.now() / 1000) - ageSeconds, count: 0 },
      {},
    );

  it("the ceiling service throwing between the hold and the charge → no thumbnail and no throw (the route answers the icon, never a 500), the hold given back, and the next request renders", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    // An owner without the account its limit is computed from: the consume itself throws.
    const broken = { id: owner.id, account: undefined as unknown as ThumbOwner["account"] };
    const made = await invoke(null, (c) => makeThumbnail(c, node, 320, broken));
    expect(made).toMatchObject({ ok: true, value: { ok: false, reason: "error" } });
    expect(await unitRow(node)).toEqual({ bytes: 0, count: 0 });
    expect(await units(owner.id)).toBe(0);
    const images = imagesMock();
    const next = await ask(await urlFor("thumb", node, { user: owner.id }), {
      env: { IMAGES: images.binding },
    });
    expect(next.status).toBe(200);
    expect(images.calls).toHaveLength(1);
    expect(await units(owner.id)).toBe(1);
  });

  it(`a hold nobody came back to (a cut invocation) is taken over after ${HOLD_STALE_SECONDS} s: six minutes old → the next request renders; one minute old → the icon, no call`, async () => {
    const owner = await makeAccount();
    const images = imagesMock();
    const fresh = await picture(owner.id);
    await leftHold(fresh, 60);
    const busy = await ask(await urlFor("thumb", fresh, { user: owner.id }), {
      env: { IMAGES: images.binding },
    });
    expect(busy.status).toBe(404);
    expect(images.calls).toHaveLength(0);
    expect(await units(owner.id)).toBe(0);

    const stale = await picture(owner.id);
    await leftHold(stale, 360);
    const taken = await ask(await urlFor("thumb", stale, { user: owner.id }), {
      env: { IMAGES: images.binding },
    });
    expect(taken.status).toBe(200);
    expect(images.calls).toHaveLength(1);
    expect(await units(owner.id)).toBe(1);
    expect(await unitRow(stale)).toMatchObject({ count: 1 });
  });

  it("twenty requests at once find one stale hold: exactly one takes it over — ONE owner unit, at most three calls that day — and none is a 5xx (answers the security flag 'race condition / quota bypass')", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    await leftHold(node, 360);
    const hold = gate();
    const all = gate();
    let inside = 0;
    let out = 0;
    const check = () => inside + out === 20 && all.open();
    const images = imagesMock(async () => {
      inside++;
      check();
      await hold.opened;
      return FAKE_WEBP;
    });
    const url = await urlFor("thumb", node, { user: owner.id });
    const answers = Array.from({ length: 20 }, () =>
      ask(url, { env: { IMAGES: images.binding } }).then((answer) => {
        if (answer.status === 404) {
          out++;
          check();
        }
        return answer;
      }),
    );
    // Every request is inside the image service, held there, or has answered.
    await all.opened;
    const made = images.calls.length;
    expect(made).toBeGreaterThanOrEqual(1);
    expect(made).toBeLessThanOrEqual(THUMB_CALLS_PER_DAY);
    hold.open();
    const statuses = (await Promise.all(answers)).map((answer) => answer.status).sort();
    expect(statuses).toEqual([
      ...Array.from({ length: made }, () => 200),
      ...Array.from({ length: 20 - made }, () => 404),
    ]);
    // One takeover: one charge of the owner's unit, the hold now charged.
    expect(await units(owner.id)).toBe(1);
    expect(await unitRow(node)).toMatchObject({ count: 1 });
    expect(await ledgerRow("notice", failureMarker(node, 320))).toEqual({ bytes: 0, count: made });
  });

  it("the takeover is one conditional UPDATE naming the hold as read: only that hold, held, not charged and older than the window — and only once", async () => {
    const day = dayUTC(new Date());
    const at = Math.floor(Date.now() / 1000);
    const staleBefore = at - HOLD_STALE_SECONDS;
    const marker = (name: string) => `thumb_unit:test-${name}-${crypto.randomUUID()}`;
    const seed = (id: string, bytes: number, count: number) =>
      addUsageIfUnder(testDb(), day, "notice", id, { bytes, count }, {});
    const take = (id: string, heldAt: number) =>
      takeOverStaleHold(testDb(), day, id, at, heldAt, staleBefore);

    const stale = marker("stale");
    await seed(stale, at - 360, 0);
    expect(await take(stale, at - 360)).toBe(true);
    // Now another hold (its time is `at`): a second taker naming the old one finds nothing.
    expect(await take(stale, at - 360)).toBe(false);
    const fresh = marker("fresh");
    await seed(fresh, at - 60, 0);
    expect(await take(fresh, at - 60)).toBe(false);
    const charged = marker("charged");
    await seed(charged, at - 360, 1);
    expect(await take(charged, at - 360)).toBe(false);
    const released = marker("released");
    await seed(released, 0, 0);
    expect(await take(released, 0)).toBe(false);
    expect(await take(marker("none"), at - 360)).toBe(false);
    // Twenty at once on one stale hold: exactly one wins.
    const contested = marker("contested");
    await seed(contested, at - 360, 0);
    const wins = await Promise.all(Array.from({ length: 20 }, () => take(contested, at - 360)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it("the review's P2: X and Y read one stale hold, X takes it over and gives it back, then Y's takeover fails and the slot is taken by the ordinary acquire — never two holders", async () => {
    const day = dayUTC(new Date());
    const at = Math.floor(Date.now() / 1000);
    const id = `thumb_unit:test-p2-${crypto.randomUUID()}`;
    const old = at - 360;
    await addUsageIfUnder(testDb(), day, "notice", id, { bytes: old, count: 0 }, {});
    const holders = new Set<string>();
    // X and Y have both read `old`. X wins the takeover…
    expect(await takeOverStaleHold(testDb(), day, id, at, old, at - HOLD_STALE_SECONDS)).toBe(true);
    holders.add("X");
    // …and gives it back (its consume threw, or the owner's ceiling refused it).
    await subtractUsage(testDb(), day, "notice", id, at);
    holders.delete("X");
    // Y's takeover names the hold it read: it is gone, so Y does not hold.
    expect(await takeOverStaleHold(testDb(), day, id, at + 1, old, at + 1 - HOLD_STALE_SECONDS)).toBe(false);
    // Z finds a free slot and takes it as anyone takes a free slot: the ordinary acquire.
    const acquire = (when: number) =>
      addUsageIfUnder(testDb(), day, "notice", id, { bytes: when, count: 0 }, { bytes: when, count: 0 });
    expect(await acquire(at + 2)).toBe(true);
    holders.add("Z");
    // The row is Z's hold, and Z's alone: a fresh hold that nobody can take over.
    expect(await ledgerRow("notice", id)).toEqual({ bytes: at + 2, count: 0 });
    expect(await takeOverStaleHold(testDb(), day, id, at + 3, at + 2, at + 3 - HOLD_STALE_SECONDS)).toBe(
      false,
    );
    expect(await acquire(at + 3)).toBe(false);
    expect([...holders]).toEqual(["Z"]);
  });
});

describe("the hold → unit → mark → call → write pipeline does not depend on the request's own path", () => {
  it("a request that gives up on the thumbnail the moment it has started it (its handler returns at once, as a cut request's would) still ends with the unit charged and marked and the thumbnail cached", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const account = { quotaBytes: owner.quotaBytes, createdAt: owner.createdAt };
    const ran = await invoke(
      null,
      async (c) => {
        // Not awaited: the request's own path goes no further than starting it.
        void makeThumbnail(c, node, 320, { id: owner.id, account });
        return "gone";
      },
      { env: { IMAGES: imagesMock().binding } },
    );
    expect(ran).toMatchObject({ ok: true, value: "gone" });
    expect(await ledgerRow("notice", unitMarker(node, 320))).toMatchObject({ count: 1 });
    expect(await units(owner.id)).toBe(1);
    expect(await spyBucket().bucket.head(thumbKey(node.id, node.versionId, 320))).not.toBeNull();
  });
});

describe("the asker's room is asked for the largest thumbnail, not one byte", () => {
  it(`an address at its ceiling − k, for k below thumbMaxBytes (${thumbMaxBytes(320)} for 320), → 429, no call, no unit; with exactly that room, the thumbnail is made`, async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const link = await linkOn(node.id, owner.id);
    const images = imagesMock();
    const CEIL = 10_000_000;
    const settings = { ceilings: { CEIL_IP_BYTES_DAY: CEIL } };
    const filled = async (room: number) => {
      const ip = freshIp();
      await addUsageIfUnder(
        testDb(),
        dayUTC(new Date()),
        "ip",
        await ipSubject(ip),
        { bytes: CEIL - room, count: 0 },
        {},
      );
      return ip;
    };
    for (const room of [1, 100, thumbMaxBytes(320) - 1]) {
      const answer = await ask(await urlFor("thumb", node, { link }), {
        ip: await filled(room),
        env: { IMAGES: images.binding },
        settings,
      });
      expect(answer.status, `room ${room}`).toBe(429);
      expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(images.calls).toHaveLength(0);
    expect(await units(owner.id)).toBe(0);
    expect(await ledgerRow("notice", unitMarker(node, 320))).toBeNull();
    // The control: room for the largest 320 thumbnail → made (and charged its real length).
    const ip = await filled(thumbMaxBytes(320));
    const made = await ask(await urlFor("thumb", node, { link }), {
      ip,
      env: { IMAGES: images.binding },
      settings,
    });
    expect(made.status).toBe(200);
    expect(images.calls).toHaveLength(1);
    expect(await ledgerRow("ip", await ipSubject(ip))).toEqual({
      bytes: CEIL - thumbMaxBytes(320) + FAKE_WEBP.byteLength,
      count: 0,
    });
  });

  it("an output above thumbMaxBytes is not stored or served, and the thumbnail is given up on for the day", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const spy = spyBucket();
    const images = imagesMock(() => new Uint8Array(thumbMaxBytes(160) + 1));
    const answer = await ask(await urlFor("thumb", node, { user: owner.id }, { size: 160 }), {
      env: { IMAGES: images.binding, FILES: spy.bucket },
    });
    expect(answer.status).toBe(404);
    expect(spy.puts).toEqual([]);
    expect(await ledgerRow("notice", failureMarker(node, 160))).toEqual({
      bytes: 0,
      count: 1 + THUMB_CALLS_PER_DAY,
    });
  });
});

describe("a transform in flight across a Replace, a purge or a takedown leaves nothing behind", () => {
  /** Replaces the file: a new version, a new object, the node pointing at it. */
  const replace = async (node: { id: string; ownerId: string }) => {
    const versionId = crypto.randomUUID();
    const r2Key = keyFor(node.ownerId, node.id, versionId);
    await spyBucket().bucket.put(r2Key, pattern(2000, 5));
    await updateNode(node.id, { versionId, r2Key });
  };

  for (const [when, before] of [
    ["between the transform and the cache write", true],
    ["between the cache write and the re-read", false],
  ] as const) {
    it(`a Replace ${when} → the object just written is deleted and the answer is the icon`, async () => {
      const owner = await makeAccount();
      const node = await picture(owner.id);
      const key = thumbKey(node.id, node.versionId, 320);
      const real = spyBucket();
      const spy = spyBucket({
        put: (async (k: string, value: ArrayBuffer, options?: R2PutOptions) => {
          if (before) await replace(node);
          const written = await real.bucket.put(k, value, options);
          if (!before) await replace(node);
          return written;
        }) as unknown as R2Bucket["put"],
      });
      const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
        env: { IMAGES: imagesMock().binding, FILES: spy.bucket },
      });
      expect(answer.status).toBe(404);
      expect(spy.deletes).toEqual([key]);
      expect(await real.bucket.head(key)).toBeNull();
    });
  }

  it("a takedown between the cache write and the re-read → deleted, the icon; a node purged meanwhile → the same", async () => {
    const owner = await makeAccount();
    for (const change of [
      (id: string) => updateNode(id, { takedownAt: new Date(), takedownReason: "admin" }),
      (id: string) => testDb().delete(nodes).where(eq(nodes.id, id)),
    ]) {
      const node = await picture(owner.id);
      const key = thumbKey(node.id, node.versionId, 320);
      const real = spyBucket();
      const spy = spyBucket({
        put: (async (k: string, value: ArrayBuffer, options?: R2PutOptions) => {
          const written = await real.bucket.put(k, value, options);
          await change(node.id);
          return written;
        }) as unknown as R2Bucket["put"],
      });
      const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
        env: { IMAGES: imagesMock().binding, FILES: spy.bucket },
      });
      expect(answer.status).toBe(404);
      expect(await real.bucket.head(key)).toBeNull();
    }
  });

  it("the control: nothing changed meanwhile → the object stays and is served", async () => {
    const owner = await makeAccount();
    const node = await picture(owner.id);
    const spy = spyBucket();
    const answer = await ask(await urlFor("thumb", node, { user: owner.id }), {
      env: { IMAGES: imagesMock().binding, FILES: spy.bucket },
    });
    expect(answer.status).toBe(200);
    expect(spy.deletes).toEqual([]);
    expect(await spy.bucket.head(thumbKey(node.id, node.versionId, 320))).not.toBeNull();
  });
});

describe("an asker whose own day is used up is refused before the owner pays or the service is called", () => {
  it("an exhausted address (link) and an exhausted signed-in user → 429 with Retry-After (readable by the app), no call, no unit, no hold", async () => {
    const owner = await makeAccount();
    const partner = await makeAccount();
    const node = await picture(owner.id);
    await makeShare(node.id, owner.id, partner.id);
    const link = await linkOn(node.id, owner.id);
    const images = imagesMock();
    for (const [subject, ceilings] of [
      [{ link }, { CEIL_IP_BYTES_DAY: 0 }],
      [{ user: partner.id }, { CEIL_USER_BYTES_DAY: 0 }],
    ] as const) {
      const answer = await ask(await urlFor("thumb", node, subject), {
        env: { IMAGES: images.binding },
        settings: { ceilings },
      });
      expect(answer.status).toBe(429);
      expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
      expect(Number(answer.headers.get("retry-after"))).toBeLessThanOrEqual(86_400);
      expect(answer.headers.get("access-control-expose-headers")?.split(", ")).toContain("Retry-After");
    }
    expect(images.calls).toHaveLength(0);
    expect(await units(owner.id)).toBe(0);
    expect(await ledgerRow("notice", unitMarker(node, 320))).toBeNull();
    // With room, the same thumbnail is made.
    expect(
      (await ask(await urlFor("thumb", node, { link }), { env: { IMAGES: images.binding } })).status,
    ).toBe(200);
  });
});
