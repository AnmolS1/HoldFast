// Range and conditional requests against the local object store: one case per row of the table
// the store's observed behaviour was written down in. The store throws on an unsatisfiable range,
// ignores `If-Range` and does not say whether a failed precondition is a 304 or a 412 — so every
// status here is this host's own decision, and several are decided before the store is asked.
import { beforeAll, describe, expect, it } from "vitest";
import {
  ask,
  freshIp,
  ipSubject,
  ledgerBytes,
  ledgerRow,
  makeAccount,
  nodeById,
  pattern,
  spyBucket,
  storedFile,
  updateNode,
  urlFor,
  type AskOptions,
  type StoredFile,
} from "./harness";

const SIZE = 1000;
let owner: Awaited<ReturnType<typeof makeAccount>>;
let file: StoredFile;
let url: string;
let etag: string;
let lastModified: string;

beforeAll(async () => {
  owner = await makeAccount();
  file = await storedFile(owner.id, { content: pattern(SIZE), name: "data.bin" });
  url = await urlFor("download", file.node, { user: owner.id });
  const first = await ask(url);
  etag = first.headers.get("etag")!;
  lastModified = first.headers.get("last-modified")!;
});

const get = (headers: Record<string, string>, options: AskOptions = {}) => ask(url, { ...options, headers });

describe("Range — parsed here, from the size in the database", () => {
  it("the first GET: 200, the whole object, its validators, no Content-Range (a full read is not a partial one)", async () => {
    const answer = await ask(url);
    expect(answer.status).toBe(200);
    expect(answer.bytes).toEqual(file.bytes);
    expect(answer.headers.get("content-length")).toBe(String(SIZE));
    expect(answer.headers.get("content-range")).toBeNull();
    expect(answer.headers.get("accept-ranges")).toBe("bytes");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
    expect(Number.isNaN(Date.parse(lastModified))).toBe(false);
  });

  it.each([
    ["bytes=0-", 0, SIZE - 1],
    ["bytes=0-99", 0, 99],
    ["bytes=100-199", 100, 199],
    ["bytes=-100", SIZE - 100, SIZE - 1],
    ["bytes=999-", SIZE - 1, SIZE - 1],
    // An end past the last byte is cut; a suffix longer than the object is the whole of it.
    ["bytes=900-5000", 900, SIZE - 1],
    [`bytes=0-${SIZE}`, 0, SIZE - 1],
    ["bytes=-5000", 0, SIZE - 1],
  ])("%s → 206 with exactly those bytes", async (range, first, last) => {
    const answer = await get({ range });
    expect(answer.status).toBe(206);
    expect(answer.headers.get("content-range")).toBe(`bytes ${first}-${last}/${SIZE}`);
    expect(answer.headers.get("content-length")).toBe(String(last - first + 1));
    expect(answer.bytes).toEqual(file.bytes.subarray(first, last + 1));
    expect(answer.headers.get("etag")).toBe(etag);
  });

  it.each([`bytes=${SIZE}-`, `bytes=${SIZE + 500}-`, "bytes=-0", `bytes=${SIZE}-${SIZE + 5}`])(
    "%s → 416 with `bytes */size`, and the store is never asked",
    async (range) => {
      const spy = spyBucket();
      const answer = await get({ range }, { env: { FILES: spy.bucket } });
      expect(answer.status).toBe(416);
      expect(answer.headers.get("content-range")).toBe(`bytes */${SIZE}`);
      expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(spy.gets).toEqual([]);
      expect(spy.heads).toEqual([]);
    },
  );

  it("the same 416 from the storage service when the database's size let the range through", async () => {
    // The row says 5,000 bytes, the object has 1,000: the range passes this host's own check
    // and the store's refusal (which it THROWS) arrives as `unsatisfiable_range`.
    const wrong = await storedFile(owner.id, { content: pattern(SIZE), node: { size: 5000 } });
    const spy = spyBucket();
    const answer = await ask(await urlFor("download", wrong.node, { user: owner.id }), {
      headers: { range: "bytes=2000-" },
      env: { FILES: spy.bucket },
    });
    expect(answer.status).toBe(416);
    expect(answer.headers.get("content-range")).toBe(`bytes */${SIZE}`);
    expect(spy.gets).toHaveLength(1);
  });

  it.each([
    "bytes=0-0,500-599",
    "bytes=abc",
    "bytes=5-2",
    "items=0-5",
    "bytes= 0-9",
    "bytes=-",
    "bytes=1-2-3",
  ])("%s → no range: 200 with the whole object, never multipart", async (range) => {
    const answer = await get({ range });
    expect(answer.status).toBe(200);
    expect(answer.bytes).toEqual(file.bytes);
    expect(answer.headers.get("content-range")).toBeNull();
    expect(answer.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("an empty file: 200 with no body; any range of it is 416", async () => {
    const empty = await storedFile(owner.id, { content: new Uint8Array(0) });
    const emptyUrl = await urlFor("download", empty.node, { user: owner.id });
    const whole = await ask(emptyUrl);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-length")).toBe("0");
    expect(whole.bytes).toHaveLength(0);
    const ranged = await ask(emptyUrl, { headers: { range: "bytes=0-" } });
    expect(ranged.status).toBe(416);
    expect(ranged.headers.get("content-range")).toBe("bytes */0");
  });
});

describe("preconditions — 304 or 412 is decided here, from the header that was sent", () => {
  it("If-None-Match: the object's tag quoted, weak, or in a list → 304 with no body", async () => {
    const bare = etag.slice(1, -1);
    for (const value of [etag, `W/${etag}`, `"nope", ${etag}`, `"a", W/"${bare}" , "b"`]) {
      const answer = await get({ "if-none-match": value });
      expect(answer.status, value).toBe(304);
      expect(answer.bytes).toHaveLength(0);
      expect(answer.headers.get("etag"), value).toBe(etag);
    }
    // Another tag: served.
    expect((await get({ "if-none-match": '"0cc175b9c0f1b6a831c399e269772661"' })).status).toBe(200);
  });

  it("If-None-Match: * → 304 and If-Match: * → 200, and the store is given no condition for either", async () => {
    const star = spyBucket();
    const none = await get({ "if-none-match": "*" }, { env: { FILES: star.bucket } });
    expect(none.status).toBe(304);
    expect(none.headers.get("etag")).toBe(etag);
    expect(star.gets).toEqual([]);

    const match = spyBucket();
    const whole = await get({ "if-match": "*" }, { env: { FILES: match.bucket } });
    expect(whole.status).toBe(200);
    expect(whole.bytes).toEqual(file.bytes);
    expect(match.gets).toHaveLength(1);
    expect(match.gets[0]?.options?.onlyIf).toBeUndefined();
  });

  it("an unquoted If-None-Match is no condition: 200, never a 5xx", async () => {
    const bare = etag.slice(1, -1);
    for (const value of [bare, `W/${bare}`, "abc", `${bare}, other`, '"', ""]) {
      const spy = spyBucket();
      const answer = await get({ "if-none-match": value }, { env: { FILES: spy.bucket } });
      expect(answer.status, value).toBe(200);
      expect(spy.gets[0]?.options?.onlyIf, value).toBeUndefined();
    }
  });

  it("If-Match with another tag → 412; with the object's → 200", async () => {
    const answer = await get({ "if-match": '"0cc175b9c0f1b6a831c399e269772661"' });
    expect(answer.status).toBe(412);
    expect(answer.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect((await get({ "if-match": etag })).status).toBe(200);
    expect((await get({ "if-match": `"x", ${etag}` })).status).toBe(200);
  });

  it("If-Unmodified-Since in the past → 412; If-Modified-Since in the future → 304; the other way round, served", async () => {
    const past = new Date(Date.now() - 86_400_000 * 365).toUTCString();
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    expect((await get({ "if-unmodified-since": past })).status).toBe(412);
    expect((await get({ "if-modified-since": future })).status).toBe(304);
    expect((await get({ "if-unmodified-since": future })).status).toBe(200);
    expect((await get({ "if-modified-since": past })).status).toBe(200);
    // A date that is not a date is no condition.
    expect((await get({ "if-modified-since": "yesterday-ish" })).status).toBe(200);
    // The object's own Last-Modified: not modified since then.
    expect((await get({ "if-modified-since": lastModified })).status).toBe(304);
  });

  it("the tag wins over the date of its pair: If-None-Match that differs + If-Modified-Since in the future → 200", async () => {
    const future = new Date(Date.now() + 86_400_000).toUTCString();
    expect((await get({ "if-none-match": '"other"', "if-modified-since": future })).status).toBe(200);
    const past = new Date(Date.now() - 86_400_000 * 365).toUTCString();
    expect((await get({ "if-match": etag, "if-unmodified-since": past })).status).toBe(200);
  });

  it("a matching If-None-Match with a Range → 304, not 206; If-Match that fails with an If-None-Match that would not → 412", async () => {
    expect((await get({ "if-none-match": etag, range: "bytes=0-99" })).status).toBe(304);
    expect((await get({ "if-match": '"other"', "if-none-match": '"another"' })).status).toBe(412);
    expect((await get({ "if-match": '"other"', "if-none-match": "*" })).status).toBe(412);
  });
});

describe("If-Range — the store ignores it, so it is compared here", () => {
  it("the current tag + Range → 206", async () => {
    const answer = await get({ range: "bytes=100-199", "if-range": etag });
    expect(answer.status).toBe(206);
    expect(answer.headers.get("content-range")).toBe(`bytes 100-199/${SIZE}`);
    expect(answer.bytes).toEqual(file.bytes.subarray(100, 200));
  });

  it("a stale tag + Range → 200 with the whole object, the ranged body cancelled, and the full size charged", async () => {
    const reader = await makeAccount();
    const mine = await storedFile(reader.id, { content: pattern(SIZE, 3) });
    const spy = spyBucket();
    const answer = await ask(await urlFor("download", mine.node, { user: reader.id }), {
      headers: { range: "bytes=100-199", "if-range": '"0cc175b9c0f1b6a831c399e269772661"' },
      env: { FILES: spy.bucket },
    });
    expect(answer.status).toBe(200);
    expect(answer.bytes).toEqual(mine.bytes);
    expect(answer.headers.get("content-range")).toBeNull();
    expect(answer.headers.get("content-length")).toBe(String(SIZE));
    // The first read was ranged and was given up; the second is the whole object.
    expect(spy.gets.map((call) => call.options?.range)).toEqual([{ offset: 100, length: 100 }, undefined]);
    expect(spy.cancelled).toBe(1);
    expect(await ledgerBytes("user", reader.id)).toBe(SIZE);
  });

  it("a weak tag, an unquoted tag, an old date, a date that is not one → 200 whole; the object's own date → 206", async () => {
    const bare = etag.slice(1, -1);
    const old = new Date(Date.now() - 86_400_000 * 365).toUTCString();
    for (const value of [
      `W/${etag}`,
      bare,
      old,
      "not a date",
      new Date(Date.now() + 86_400_000).toUTCString(),
    ]) {
      const answer = await get({ range: "bytes=0-9", "if-range": value });
      expect(answer.status, value).toBe(200);
      expect(answer.bytes, value).toEqual(file.bytes);
    }
    expect((await get({ range: "bytes=0-9", "if-range": lastModified })).status).toBe(206);
  });

  it("If-Range without a Range changes nothing; with an unsatisfiable Range it is still 416", async () => {
    expect((await get({ "if-range": '"stale"' })).status).toBe(200);
    expect((await get({ "if-range": '"stale"', range: `bytes=${SIZE}-` })).status).toBe(416);
  });
});

describe("the storage service's result, case by case", () => {
  it("null (the node's object is gone) → 404; nothing is charged", async () => {
    const reader = await makeAccount();
    const gone = await storedFile(reader.id, { content: null, node: { size: 500 } });
    const goneUrl = await urlFor("download", gone.node, { user: reader.id });
    for (const headers of [{}, { range: "bytes=0-9" }] as Record<string, string>[]) {
      const answer = await ask(goneUrl, { headers });
      expect(answer.status).toBe(404);
      expect(answer.text).toBe("Not found.\n");
    }
    expect((await ask(goneUrl, { method: "HEAD" })).status).toBe(404);
    expect(await ledgerRow("user", reader.id)).toBeNull();
  });

  it("precondition_failed → 304 when the request carried If-None-Match or If-Modified-Since, else 412 — also when this host's own reading of the object would disagree", async () => {
    // A store that answers "the condition failed" whatever the object says.
    const meta = await spyBucket().bucket.head(file.node.r2Key);
    const refusing = spyBucket({ get: async () => meta } as unknown as Partial<R2Bucket>);
    const env = { FILES: refusing.bucket };
    expect((await get({ "if-none-match": '"not-the-tag"' }, { env })).status).toBe(304);
    expect((await get({ "if-modified-since": new Date(0).toUTCString() }, { env })).status).toBe(304);
    expect((await get({ "if-match": etag }, { env })).status).toBe(412);
    expect(
      (await get({ "if-unmodified-since": new Date(Date.now() + 86_400_000).toUTCString() }, { env })).status,
    ).toBe(412);
  });

  it("body → 200 for the whole object and 206 for a part of it", async () => {
    expect((await ask(url)).status).toBe(200);
    expect((await get({ range: "bytes=1-" })).status).toBe(206);
  });
});

describe("HEAD", () => {
  it("answers what the GET would — status and headers — with no body, no body opened and nothing charged", async () => {
    const reader = await makeAccount();
    const mine = await storedFile(reader.id, { content: pattern(SIZE, 9), mime: "image/png", name: "h.png" });
    await updateNode(mine.node.id, { lastAccessedAt: null });
    const cases: Record<string, string>[] = [
      {},
      { range: "bytes=100-199" },
      { range: "bytes=0-" },
      { range: `bytes=${SIZE}-` },
      { range: "bytes=abc" },
      { "if-none-match": "*" },
      { "if-match": '"other"' },
      { range: "bytes=0-9", "if-range": '"stale"' },
    ];
    for (const kind of ["download", "inline"] as const) {
      const mineUrl = await urlFor(kind, mine.node, { user: reader.id });
      const tag = (await ask(mineUrl, { method: "HEAD" })).headers.get("etag")!;
      for (const headers of [...cases, { "if-none-match": tag }, { range: "bytes=5-9", "if-range": tag }]) {
        const spy = spyBucket();
        const head = await ask(mineUrl, { method: "HEAD", headers, env: { FILES: spy.bucket } });
        expect(spy.gets, JSON.stringify(headers)).toEqual([]);
        expect(head.bytes).toHaveLength(0);
        const got = await ask(mineUrl, { headers });
        expect(head.status, JSON.stringify(headers)).toBe(got.status);
        for (const name of [
          "content-type",
          "content-disposition",
          "content-length",
          "content-range",
          "etag",
          "last-modified",
          "accept-ranges",
          "cache-control",
          "content-security-policy",
        ]) {
          // A 304 carries no length; everything else is the GET's.
          if (name === "content-length" && got.status !== 200 && got.status !== 206) continue;
          expect(head.headers.get(name), `${name} ${JSON.stringify(headers)}`).toBe(got.headers.get(name));
        }
      }
    }
    // Only the GETs were charged: the HEADs added nothing. (Each GET above that had a body is
    // counted here, so the total is the GETs' alone.)
    const perKind = SIZE + 100 + SIZE + SIZE + SIZE + 5;
    expect(await ledgerBytes("user", reader.id)).toBe(perKind * 2);
  });

  it("a HEAD alone leaves no ledger row and does not touch `lastAccessedAt`", async () => {
    const reader = await makeAccount();
    const mine = await storedFile(reader.id, { content: pattern(SIZE) });
    const ip = freshIp();
    for (const headers of [{}, { range: "bytes=0-9" }] as Record<string, string>[]) {
      const head = await ask(await urlFor("download", mine.node, { user: reader.id }), {
        method: "HEAD",
        headers,
        ip,
      });
      expect([200, 206]).toContain(head.status);
    }
    expect(await ledgerRow("user", reader.id)).toBeNull();
    expect(await ledgerRow("ip", await ipSubject(ip))).toBeNull();
    expect((await nodeById(mine.node.id))?.lastAccessedAt).toBeNull();
    // The control: the GET does both.
    await ask(await urlFor("download", mine.node, { user: reader.id }), { ip });
    expect(await ledgerBytes("user", reader.id)).toBe(SIZE);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE);
    expect((await nodeById(mine.node.id))?.lastAccessedAt).not.toBeNull();
  });
});
