// The hashing worker's digest function, run directly (jsdom has no Worker).
import { describe, expect, it } from "vitest";
import { digestBlob, HASH_SLICE_BYTES } from "../../../../src/client/workers/sha256.worker";

// Precomputed: `shasum -a 256` of the empty input, of "abc" and of tests/fixtures/files/hello.txt.
const EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
// The committed 1,024-byte ASCII fixture, read as text (the client test project has no Node types).
const helloText = import.meta.glob<string>("/tests/fixtures/files/hello.txt", {
  query: "?raw",
  import: "default",
  eager: true,
})["/tests/fixtures/files/hello.txt"]!;
const helloBlob = () => new Blob([new TextEncoder().encode(helloText)]);

const HELLO = "4f232b8b41cebe20475d2d0495e8b7292568bdf6b6823952f5f4cc92545737b8";

describe("worker digest", () => {
  it("hashes in 8 MiB slices", () => {
    expect(HASH_SLICE_BYTES).toBe(8_388_608);
  });

  it("equals the precomputed SHA-256 of a fixture", async () => {
    expect(await digestBlob(new Blob([]))).toBe(EMPTY);
    expect(await digestBlob(new Blob(["abc"]))).toBe(ABC);
    expect(helloBlob().size).toBe(1024);
    expect(await digestBlob(helloBlob())).toBe(HELLO);
  });

  it("gives the same digest whatever the slice size, and reports progress up to the size", async () => {
    const hello = helloBlob();
    const seen: number[] = [];
    expect(await digestBlob(hello, (hashed) => seen.push(hashed), 100)).toBe(HELLO);
    expect(seen.length).toBe(Math.ceil(hello.size / 100));
    expect(seen.at(-1)).toBe(hello.size);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
