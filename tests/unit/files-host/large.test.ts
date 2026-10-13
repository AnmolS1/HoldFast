// Ranged and full reads of an object far larger than a part: 140,000,000 bytes, written into the
// local store in three parts. A range in the middle comes back as exactly the bytes asked for,
// and a full download runs to its end without the object ever being held in memory here.
import { beforeAll, describe, expect, it } from "vitest";
import { SPARSE_FILE_BYTES } from "../../setup/fixture-bytes";
import { ipSubject, freshIp, ledgerBytes, open, urlFor } from "./harness";
import { drain, expected, seedLarge } from "./large";

const SIZE = SPARSE_FILE_BYTES;
let seeded: Awaited<ReturnType<typeof seedLarge>>;
let url: string;

beforeAll(async () => {
  seeded = await seedLarge(SIZE);
  url = await urlFor("download", seeded.node, { user: seeded.owner.id });
}, 120_000);

describe(`a ${SIZE.toLocaleString("en")}-byte object`, () => {
  it("was written in three parts and has the size the row says", () => {
    expect(SIZE).toBe(140_000_000);
    expect(seeded.parts).toBe(3);
    expect(seeded.object.size).toBe(SIZE);
  });

  it.each([
    ["bytes=70000000-70000999", 70_000_000, 1000],
    // Across the boundary of the first two parts.
    ["bytes=67108364-67109363", 67_108_364, 1000],
    ["bytes=-100", SIZE - 100, 100],
    ["bytes=139999000-", SIZE - 1000, 1000],
    ["bytes=0-0", 0, 1],
  ])("%s → 206 with exactly those bytes", async (range, offset, length) => {
    const { response, ctx } = await open(url, { headers: { range } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${offset}-${offset + length - 1}/${SIZE}`);
    expect(response.headers.get("content-length")).toBe(String(length));
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected(offset, length));
    await ctx.settle();
  });

  it("a full download completes: every byte arrives, and the ledger holds the size", async () => {
    const ip = freshIp();
    const before = await ledgerBytes("user", seeded.owner.id);
    const { response, ctx } = await open(url, { ip });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    const read = await drain(response);
    await ctx.settle();
    expect(read.total).toBe(SIZE);
    expect(read.first).toEqual(expected(0, 4096));
    expect(read.last).toEqual(expected(SIZE - 4096, 4096));
    expect((await ledgerBytes("user", seeded.owner.id)) - before).toBe(SIZE);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE);
  }, 120_000);

  it("a download given up after its first chunk is charged for what was read, not for 140 MB", async () => {
    const ip = freshIp();
    const { response, ctx } = await open(url, { ip });
    const reader = response.body!.getReader();
    const first = await reader.read();
    const taken = first.value!.byteLength;
    await reader.cancel();
    await ctx.settle();
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(SIZE);
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(taken);
  }, 120_000);
});
