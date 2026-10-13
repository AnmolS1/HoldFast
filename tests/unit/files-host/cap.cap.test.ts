// The largest file there can be — 2,000,000,000 bytes, thirty parts — read through this host:
// a range in the middle, the last hundred bytes, and the whole of it.
//
// Runs only when asked for (HOLDFAST_CAP_TESTS=1, through holdfast-plan/scripts/heavy.sh cap: one
// such run on the whole machine at a time). It needs about 2 GB free in the temp directory.
// What it proves is the code path at the cap. It proves nothing about memory: the local runtime
// does not enforce the deployed isolate's limit.
import { beforeAll, describe, expect, inject, it } from "vitest";
import { MAX_FILE_BYTES_DEFAULT } from "../../../src/shared/constants";
import { freshIp, ipSubject, ledgerBytes, open, urlFor } from "./harness";
import { drain, expected, seedLarge } from "./large";

const SIZE = MAX_FILE_BYTES_DEFAULT;

describe.skipIf(!inject("capTests"))(`a ${SIZE.toLocaleString("en")}-byte object (the cap)`, () => {
  let seeded: Awaited<ReturnType<typeof seedLarge>>;
  let url: string;

  beforeAll(async () => {
    seeded = await seedLarge(SIZE);
    url = await urlFor("download", seeded.node, { user: seeded.owner.id });
  }, 900_000);

  it("was written in thirty parts and has the size the row says", () => {
    expect(SIZE).toBe(2_000_000_000);
    expect(seeded.parts).toBe(30);
    expect(seeded.object.size).toBe(SIZE);
  });

  it("bytes=1000000000-1000000999 → exactly those 1,000 bytes", async () => {
    const { response, ctx } = await open(url, { headers: { range: "bytes=1000000000-1000000999" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes 1000000000-1000000999/${SIZE}`);
    expect(response.headers.get("content-length")).toBe("1000");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected(1_000_000_000, 1000));
    await ctx.settle();
  }, 120_000);

  it("bytes=-100 → the last hundred bytes", async () => {
    const { response, ctx } = await open(url, { headers: { range: "bytes=-100" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe(`bytes ${SIZE - 100}-${SIZE - 1}/${SIZE}`);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected(SIZE - 100, 100));
    await ctx.settle();
  }, 120_000);

  it("a full read returns the whole size", async () => {
    const ip = freshIp();
    const { response, ctx } = await open(url, { ip });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(SIZE));
    const read = await drain(response);
    await ctx.settle();
    expect(read.total).toBe(SIZE);
    expect(read.first).toEqual(expected(0, 4096));
    expect(read.last).toEqual(expected(SIZE - 4096, 4096));
    expect(await ledgerBytes("ip", await ipSubject(ip))).toBe(SIZE);
  }, 900_000);
});
