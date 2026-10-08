// The fixture set every upload, scan and preview test draws on.
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, eicarBytes, pngBytes, RTLO, SPARSE_FILE_BYTES } from "../../../setup/fixture-bytes";
import { fixtureFiles } from "../../../setup/fixture-files";

const files = fixtureFiles();

describe("fixture bytes", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("builds the 68-byte EICAR string", () => {
    const eicar = new TextDecoder().decode(eicarBytes());
    expect(eicar).toHaveLength(68);
    expect(eicar.startsWith("X5O!")).toBe(true);
    expect(eicar.endsWith("$H+H*")).toBe(true);
  });

  it("builds a PNG whose pixel data inflates to the declared size", () => {
    const png = pngBytes(16, 8);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    expect(view.getUint32(16)).toBe(16);
    expect(view.getUint32(20)).toBe(8);
    const idatLength = view.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLength));
    expect(raw.length).toBe(8 * (1 + 16 * 4));
  });
});

describe("fixture files", () => {
  it("has a text file of exactly 1 KB", () => {
    expect(statSync(files.text).size).toBe(1024);
  });

  it("generates a PNG of about 2 MB", () => {
    const size = statSync(files.png).size;
    expect(size).toBeGreaterThan(2_000_000);
    expect(size).toBeLessThan(2_200_000);
  });

  it("generates a sparse file of exactly 140,000,000 bytes (three 64 MiB parts)", () => {
    expect(SPARSE_FILE_BYTES).toBe(140_000_000);
    expect(statSync(files.sparse140MB).size).toBe(140_000_000);
    expect(Math.ceil(SPARSE_FILE_BYTES / 67_108_864)).toBe(3);
  });

  it("generates the EICAR file and a zip that nests it", () => {
    expect(readFileSync(files.eicar)).toHaveLength(68);
    const listing = execFileSync("unzip", ["-l", files.nestedEicarZip], { encoding: "utf8" });
    expect(listing).toContain("nested/inner.zip");
    // The inner archive is stored, so the test string is visible in the outer one's bytes.
    expect(readFileSync(files.nestedEicarZip).includes(Buffer.from(eicarBytes()))).toBe(true);
    expect(() => execFileSync("unzip", ["-tq", files.nestedEicarZip], { stdio: "pipe" })).not.toThrow();
  });

  it("has an SVG with a script and an HTML page", () => {
    expect(readFileSync(files.svgWithScript, "utf8")).toContain("<script>");
    expect(readFileSync(files.html, "utf8")).toContain("<!doctype html>");
  });

  it("generates a file with a right-to-left override in its name", () => {
    expect(basename(files.rtloName)).toBe(`invoice${RTLO}exe.pdf`);
    expect(statSync(files.rtloName).isFile()).toBe(true);
  });
});
