// Link passwords: node:crypto scrypt at one parameter set, stored as a self-describing string.
// Every password here is made up.
import { scryptSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hashLinkPassword,
  LINK_PASSWORD_PARAMS,
  scryptInternals,
  verifyLinkPassword,
} from "../../../src/worker/services/link-password";

const PASSWORD = "made-up correct horse";

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const fromB64url = (text: string) =>
  Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

afterEach(() => vi.restoreAllMocks());

describe("link-password: the stored string", () => {
  it("is scrypt$16384$16$1$<16-byte salt>$<64-byte key>", async () => {
    const stored = await hashLinkPassword(PASSWORD);
    const fields = stored.split("$");
    expect(fields).toHaveLength(6);
    expect(fields.slice(0, 4)).toEqual(["scrypt", "16384", "16", "1"]);
    expect(fromB64url(fields[4]!)).toHaveLength(16);
    expect(fromB64url(fields[5]!)).toHaveLength(64);
    expect(LINK_PASSWORD_PARAMS).toEqual({ N: 16384, r: 16, p: 1, keylen: 64 });
  });

  it("matches node:crypto's own scrypt at the same parameters (the key is the real derivation)", async () => {
    const stored = await hashLinkPassword(PASSWORD);
    const [, , , , salt, key] = stored.split("$");
    const expected = scryptSync(PASSWORD, fromB64url(salt!), 64, {
      N: 16384,
      r: 16,
      p: 1,
      maxmem: 128 * 16384 * 16 * 2,
    });
    expect(key).toBe(b64url(new Uint8Array(expected)));
  });

  it("uses a fresh salt each time", async () => {
    const [a, b] = await Promise.all([hashLinkPassword(PASSWORD), hashLinkPassword(PASSWORD)]);
    expect(a).not.toBe(b);
    expect(await verifyLinkPassword(PASSWORD, a)).toBe(true);
    expect(await verifyLinkPassword(PASSWORD, b)).toBe(true);
  });
});

describe("link-password: verification", () => {
  it("the right password verifies, a wrong one does not", async () => {
    const stored = await hashLinkPassword(PASSWORD);
    expect(await verifyLinkPassword(PASSWORD, stored)).toBe(true);
    expect(await verifyLinkPassword(`${PASSWORD}x`, stored)).toBe(false);
    expect(await verifyLinkPassword("", stored)).toBe(false);
  });

  it("a tampered string does not verify, and never throws", async () => {
    const stored = await hashLinkPassword(PASSWORD);
    const fields = stored.split("$");
    const flip = (text: string) => (text[0] === "A" ? `B${text.slice(1)}` : `A${text.slice(1)}`);
    const tampered = [
      [fields[0], fields[1], fields[2], fields[3], fields[4], flip(fields[5]!)].join("$"),
      [fields[0], fields[1], fields[2], fields[3], flip(fields[4]!), fields[5]].join("$"),
      [fields[0], fields[1], fields[2], fields[3], fields[4], fields[5]!.slice(0, -4)].join("$"),
      ["bcrypt", ...fields.slice(1)].join("$"),
      fields.slice(0, 5).join("$"),
      `${stored}$extra`,
      "",
      "scrypt$16384$16$1$$",
      "scrypt$abc$16$1$AAAAAAAAAAAAAAAAAAAAAA$AAAA",
      // Parameters no product hash has: refused before any work, not derived.
      ["scrypt", "1073741824", "16", "1", fields[4], fields[5]].join("$"),
      ["scrypt", "16384", "4096", "1", fields[4], fields[5]].join("$"),
      ["scrypt", "16383", "16", "1", fields[4], fields[5]].join("$"),
    ];
    for (const candidate of tampered) {
      await expect(verifyLinkPassword(PASSWORD, candidate)).resolves.toBe(false);
    }
  });

  it("a stored string asking for more memory or time than this code writes is refused with no hash run", async () => {
    const stored = await hashLinkPassword(PASSWORD);
    const [, , , , salt, key] = stored.split("$");
    const derive = vi.spyOn(scryptInternals, "derive");
    for (const [N, r, p] of [
      [131072, 32, 1], // 1 GiB of maxmem
      [32768, 16, 1], // twice the product's memory
      [16384, 32, 1],
      [16384, 16, 2], // twice the product's time
    ]) {
      expect(
        await verifyLinkPassword(PASSWORD, ["scrypt", N, r, p, salt, key].join("$")),
        `${N}/${r}/${p}`,
      ).toBe(false);
    }
    expect(derive).not.toHaveBeenCalled();
  });

  it("re-derives with the STORED parameters, with maxmem computed from them", async () => {
    const salt = new Uint8Array(16).fill(7);
    const key = scryptSync(PASSWORD, salt, 64, { N: 1024, r: 8, p: 1, maxmem: 128 * 1024 * 8 * 2 });
    const stored = ["scrypt", "1024", "8", "1", b64url(salt), b64url(new Uint8Array(key))].join("$");
    const derive = vi.spyOn(scryptInternals, "derive");
    expect(await verifyLinkPassword(PASSWORD, stored)).toBe(true);
    expect(derive).toHaveBeenCalledTimes(1);
    expect(derive.mock.calls[0]![2]).toBe(64);
    expect(derive.mock.calls[0]![3]).toEqual({ N: 1024, r: 8, p: 1, maxmem: 128 * 1024 * 8 * 2 });
    expect(await verifyLinkPassword("another made-up one", stored)).toBe(false);
  });

  it("every scrypt call passes maxmem = 128·N·r·2 (64 MiB at the product parameters)", async () => {
    const derive = vi.spyOn(scryptInternals, "derive");
    const stored = await hashLinkPassword(PASSWORD);
    await verifyLinkPassword(PASSWORD, stored);
    expect(derive).toHaveBeenCalledTimes(2);
    for (const call of derive.mock.calls) {
      expect(call[3]).toEqual({ N: 16384, r: 16, p: 1, maxmem: 67_108_864 });
    }
  });

  it("control: without maxmem the product parameters fail (what the option guards against)", () => {
    expect(() => scryptSync(PASSWORD, new Uint8Array(16), 64, { N: 16384, r: 16, p: 1 })).toThrow();
  });
});
