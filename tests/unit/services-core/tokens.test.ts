// Download tokens, link sessions, zip grants and sealed values. Every credential here is made up.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LINK_TOKEN_BYTES, TOKEN_TTL } from "../../../src/shared/constants";
import { TOKEN } from "../../../src/shared/ids";
import { AppError } from "../../../src/worker/services/errors";
import { createKeys, type Keys } from "../../../src/worker/services/keys";
import {
  hashLinkToken,
  LINK_SESSION_TTL_SEC,
  mintDownloadToken,
  mintLinkSession,
  mintZipGrant,
  newLinkToken,
  openIp,
  openLinkToken,
  linkPwv,
  NO_PASSWORD_PWV,
  sealIp,
  sealLinkToken,
  verifyDownloadToken,
  verifyLinkSession,
  verifyZipGrant,
  ZIP_GRANT_TTL_SEC,
  type DownloadClaims,
} from "../../../src/worker/services/tokens";

// Made-up secrets with the shape of the real ones; nothing here is a credential.
const keys = () => createKeys("test-files-token-secret-000000000000000000000000");
const otherKeys = () => createKeys("another-made-up-secret-1111111111111111111111111");
const IP_ENV = { IP_ENC_KEY: btoa("test-ip-enc-key-0000000000000000") };
const OTHER_IP_ENV = { IP_ENC_KEY: btoa("other-ip-enc-key-111111111111111") };

const NODE = "0199d3c2-7a10-7000-8000-0000000000a1";
const OTHER_NODE = "0199d3c2-7a10-7000-8000-0000000000b2";
const VERSION = "0199d3c2-7a10-7000-8000-0000000000c3";
const USER = "u".repeat(32);
const LINK = "0199d3c2-7a10-7000-8000-0000000000d4";
const T0 = Date.UTC(2026, 9, 12, 12, 0, 7);

const encoder = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const unb64url = (value: string) =>
  Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));

/** A token with a VALID signature over an arbitrary payload: what only the key holder can make. */
async function forge(
  holder: Keys,
  payload: unknown,
  purpose: "download-token" | "link-session" = "download-token",
) {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const key = await holder.get(purpose);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${body}.`)));
  return `${body}.${b64url(mac)}`;
}

async function refused(run: Promise<unknown>, code = "invalid_token") {
  const error = await run.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error, "the call must throw").toBeInstanceOf(AppError);
  expect((error as AppError).code).toBe(code);
  expect((error as AppError).status).toBe(403);
}

const userClaims = (k: DownloadClaims["k"] = "download") =>
  ({ k, n: NODE, ver: VERSION, st: "u", sub: USER }) as const;

afterEach(() => void vi.useRealTimers());
const freeze = (at: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at);
};

describe("download tokens", () => {
  it("mint then verify returns the claims, with the lifetime of the kind", async () => {
    freeze(T0);
    const at = Math.floor(T0 / 1000);
    for (const kind of ["download", "inline"] as const) {
      const { token, expiresAt } = await mintDownloadToken(keys(), userClaims(kind));
      expect(expiresAt).toBe(at + TOKEN_TTL[kind]);
      expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
      expect(await verifyDownloadToken(keys(), token, { kind, nodeId: NODE })).toEqual({
        v: 1,
        k: kind,
        n: NODE,
        ver: VERSION,
        st: "u",
        sub: USER,
        exp: expiresAt,
      });
    }
    expect(TOKEN_TTL).toEqual({ download: 300, inline: 900, thumb: 600, scan: 900, zip: 900 });
    const zip = await mintDownloadToken(keys(), userClaims(), { ttlSec: TOKEN_TTL.zip });
    expect(zip.expiresAt).toBe(at + 900);
    const link = await mintDownloadToken(keys(), {
      k: "inline",
      n: NODE,
      ver: VERSION,
      st: "l",
      sub: LINK,
      pwv: NO_PASSWORD_PWV,
    });
    expect(await verifyDownloadToken(keys(), link.token, { kind: "inline", nodeId: NODE })).toMatchObject({
      st: "l",
      sub: LINK,
      pwv: NO_PASSWORD_PWV,
    });
    const scan = await mintDownloadToken(keys(), {
      k: "scan",
      n: NODE,
      ver: VERSION,
      st: "s",
      sub: "scanner",
    });
    expect(scan.expiresAt).toBe(at + 900);
    expect(await verifyDownloadToken(keys(), scan.token, { kind: "scan", nodeId: NODE })).toMatchObject({
      st: "s",
      sub: "scanner",
    });
  });

  it("a token with one byte flipped fails, wherever the byte is", async () => {
    freeze(T0);
    const { token } = await mintDownloadToken(keys(), userClaims());
    // The control: the untouched token verifies.
    await expect(
      verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
    const [body, signature] = token.split(".") as [string, string];
    const flip = (part: string, index: number) => {
      const bytes = unb64url(part);
      bytes[index]! ^= 0x01;
      return b64url(bytes);
    };
    const payloadBytes = unb64url(body).length;
    for (const index of [0, 5, Math.floor(payloadBytes / 2), payloadBytes - 2]) {
      await refused(
        verifyDownloadToken(keys(), `${flip(body, index)}.${signature}`, { kind: "download", nodeId: NODE }),
      );
    }
    for (const index of [0, 15, 31]) {
      await refused(
        verifyDownloadToken(keys(), `${body}.${flip(signature, index)}`, { kind: "download", nodeId: NODE }),
      );
    }
    // A payload rewritten to another node, under the old signature.
    const claims = JSON.parse(new TextDecoder().decode(unb64url(body))) as DownloadClaims;
    const rewritten = b64url(encoder.encode(JSON.stringify({ ...claims, n: OTHER_NODE })));
    await refused(
      verifyDownloadToken(keys(), `${rewritten}.${signature}`, { kind: "download", nodeId: OTHER_NODE }),
    );
  });

  it("a token signed with another secret, or with another purpose key, fails", async () => {
    freeze(T0);
    const foreign = await mintDownloadToken(otherKeys(), userClaims());
    await refused(verifyDownloadToken(keys(), foreign.token, { kind: "download", nodeId: NODE }));
    const exp = Math.floor(T0 / 1000) + 300;
    const wrongPurpose = await forge(keys(), { v: 1, ...userClaims(), exp }, "link-session");
    await refused(verifyDownloadToken(keys(), wrongPurpose, { kind: "download", nodeId: NODE }));
    // The control: the same payload under the right key verifies.
    const rightPurpose = await forge(keys(), { v: 1, ...userClaims(), exp });
    await expect(
      verifyDownloadToken(keys(), rightPurpose, { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
  });

  it("is valid until its last second and refused from the second it expires", async () => {
    freeze(T0);
    const { token, expiresAt } = await mintDownloadToken(keys(), userClaims());
    vi.setSystemTime((expiresAt - 1) * 1000 + 999);
    await expect(
      verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
    vi.setSystemTime(expiresAt * 1000);
    await refused(verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE }));
    vi.setSystemTime((expiresAt + 86_400) * 1000);
    await refused(verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE }));
  });

  it("is refused on a route of another kind, for another node, and with a stray size", async () => {
    freeze(T0);
    const { token } = await mintDownloadToken(keys(), userClaims("download"));
    await expect(
      verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
    for (const kind of ["inline", "thumb", "scan"] as const) {
      await refused(verifyDownloadToken(keys(), token, { kind, nodeId: NODE }));
    }
    await refused(verifyDownloadToken(keys(), token, { kind: "download", nodeId: OTHER_NODE }));
    await refused(verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE, size: 160 }));
    // An inline token does not download, and the other way round.
    const inline = await mintDownloadToken(keys(), userClaims("inline"));
    await refused(verifyDownloadToken(keys(), inline.token, { kind: "download", nodeId: NODE }));
  });

  it("a thumb token is bound to its size", async () => {
    freeze(T0);
    const { token } = await mintDownloadToken(keys(), { ...userClaims("thumb"), sz: 320 });
    expect(
      await verifyDownloadToken(keys(), token, { kind: "thumb", nodeId: NODE, size: 320 }),
    ).toMatchObject({
      sz: 320,
    });
    for (const size of [160, 1280, 640, undefined]) {
      await refused(verifyDownloadToken(keys(), token, { kind: "thumb", nodeId: NODE, size }));
    }
    // Minting needs one of the three sizes for a thumb, and none for anything else.
    await expect(mintDownloadToken(keys(), userClaims("thumb"))).rejects.toThrow("invalid claims");
    await expect(mintDownloadToken(keys(), { ...userClaims("thumb"), sz: 640 as never })).rejects.toThrow();
    await expect(mintDownloadToken(keys(), { ...userClaims("download"), sz: 160 })).rejects.toThrow();
  });

  it("a validly SIGNED token without st or sub is refused", async () => {
    freeze(T0);
    const exp = Math.floor(T0 / 1000) + 300;
    const whole = { v: 1, k: "download", n: NODE, ver: VERSION, st: "u", sub: USER, exp };
    // The control: the whole payload, signed the same way, verifies.
    await expect(
      verifyDownloadToken(keys(), await forge(keys(), whole), { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
    const broken: Record<string, unknown>[] = [
      { ...whole, st: undefined },
      { ...whole, sub: undefined },
      { ...whole, st: undefined, sub: undefined },
      { ...whole, sub: "" },
      { ...whole, sub: 7 },
      { ...whole, st: "x" },
      { ...whole, st: null },
      { ...whole, v: 2 },
      { ...whole, v: undefined },
      { ...whole, k: "zip" },
      { ...whole, ver: undefined },
      { ...whole, n: undefined },
      { ...whole, exp: undefined },
      { ...whole, exp: String(exp) },
      { ...whole, exp: exp + 0.5 },
      { ...whole, k: "thumb" },
      { ...whole, k: "thumb", sz: 640 },
      { ...whole, sz: 160 },
    ];
    for (const payload of broken) {
      const kind = (payload.k === "thumb" ? "thumb" : "download") as "thumb" | "download";
      const size = typeof payload.sz === "number" ? payload.sz : undefined;
      await refused(verifyDownloadToken(keys(), await forge(keys(), payload), { kind, nodeId: NODE, size }));
    }
    // Not an object at all.
    for (const payload of [null, [], "text", 7]) {
      await refused(
        verifyDownloadToken(keys(), await forge(keys(), payload), { kind: "download", nodeId: NODE }),
      );
    }
  });

  it("the system subject holds scan tokens and nothing else; scan tokens belong to it alone", async () => {
    freeze(T0);
    const exp = Math.floor(T0 / 1000) + 300;
    const base = { v: 1, n: NODE, ver: VERSION, exp };
    for (const kind of ["download", "inline"] as const) {
      await expect(
        mintDownloadToken(keys(), { k: kind, n: NODE, ver: VERSION, st: "s", sub: "scanner" }),
      ).rejects.toThrow("invalid claims");
      const signed = await forge(keys(), { ...base, k: kind, st: "s", sub: "scanner" });
      await refused(verifyDownloadToken(keys(), signed, { kind, nodeId: NODE }));
    }
    const thumb = await forge(keys(), { ...base, k: "thumb", st: "s", sub: "scanner", sz: 160 });
    await refused(verifyDownloadToken(keys(), thumb, { kind: "thumb", nodeId: NODE, size: 160 }));
    for (const [st, sub] of [
      ["u", USER],
      ["l", LINK],
      ["s", USER],
      ["s", "Scanner"],
    ] as const) {
      await expect(
        mintDownloadToken(keys(), { k: "scan", n: NODE, ver: VERSION, st, sub }),
      ).rejects.toThrow();
      const signed = await forge(keys(), { ...base, k: "scan", st, sub });
      await refused(verifyDownloadToken(keys(), signed, { kind: "scan", nodeId: NODE }));
    }
    // The control: the one permitted combination, forged the same way, verifies.
    const good = await forge(keys(), { ...base, k: "scan", st: "s", sub: "scanner" });
    await expect(verifyDownloadToken(keys(), good, { kind: "scan", nodeId: NODE })).resolves.toBeTruthy();
  });

  it("malformed input is refused, never thrown as anything else", async () => {
    const { token } = await mintDownloadToken(keys(), userClaims());
    const [body, signature] = token.split(".") as [string, string];
    const inputs: unknown[] = [
      "",
      ".",
      "a",
      "a.b",
      "a.b.c",
      `${token}.`,
      `.${signature}`,
      `${body}.`,
      `${body}=.${signature}`,
      `${body}.${signature}=`,
      `${body} .${signature}`,
      `${body}.${signature}`.replace(".", ".."),
      `${token}${"A".repeat(3000)}`,
      undefined,
      null,
      7,
      { token },
    ];
    for (const input of inputs) {
      await refused(verifyDownloadToken(keys(), input as string, { kind: "download", nodeId: NODE }));
    }
  });

  it("thumb tokens are the same URL within a 600 s bucket and live 600–1,200 s", async () => {
    const bucketStart = Math.floor(T0 / 1000 / 600) * 600;
    const claims = { ...userClaims("thumb"), sz: 160 } as const;
    freeze(bucketStart * 1000);
    const first = await mintDownloadToken(keys(), claims);
    expect(first.expiresAt).toBe(bucketStart + 1200);
    vi.setSystemTime((bucketStart + 599) * 1000 + 999);
    const last = await mintDownloadToken(keys(), claims);
    expect(last.token).toBe(first.token);
    expect(last.expiresAt - (bucketStart + 599)).toBe(601);
    // Key order of the caller's object plays no part.
    const reordered = await mintDownloadToken(keys(), {
      sz: 160,
      sub: USER,
      st: "u",
      ver: VERSION,
      n: NODE,
      k: "thumb",
    });
    expect(reordered.token).toBe(first.token);
    // Another size, version or viewer is another URL.
    expect((await mintDownloadToken(keys(), { ...claims, sz: 320 })).token).not.toBe(first.token);
    expect((await mintDownloadToken(keys(), { ...claims, ver: "v2" })).token).not.toBe(first.token);
    expect((await mintDownloadToken(keys(), { ...claims, sub: "o".repeat(32) })).token).not.toBe(first.token);
    // The bucket rolls: a new URL, and the old one still works until its own expiry.
    vi.setSystemTime((bucketStart + 600) * 1000);
    const next = await mintDownloadToken(keys(), claims);
    expect(next.token).not.toBe(first.token);
    expect(next.expiresAt).toBe(bucketStart + 1800);
    await expect(
      verifyDownloadToken(keys(), first.token, { kind: "thumb", nodeId: NODE, size: 160 }),
    ).resolves.toBeTruthy();
    vi.setSystemTime((bucketStart + 1200) * 1000);
    await refused(verifyDownloadToken(keys(), first.token, { kind: "thumb", nodeId: NODE, size: 160 }));
  });
});

describe("link sessions", () => {
  const binding = { linkId: LINK, ipHashStable: "a".repeat(64), pwv: "0011223344556677" };

  it("verifies for the same link, address and password version, for one hour", async () => {
    freeze(T0);
    const { token, expiresAt } = await mintLinkSession(keys(), binding);
    expect(LINK_SESSION_TTL_SEC).toBe(3600);
    expect(expiresAt).toBe(Math.floor(T0 / 1000) + 3600);
    expect(await verifyLinkSession(keys(), token, binding)).toEqual({ linkId: LINK, expiresAt });
    // Neither bound value can be read from the token.
    const payload = new TextDecoder().decode(unb64url(token.split(".")[0]!));
    expect(payload).not.toContain(binding.ipHashStable);
    expect(payload).not.toContain(binding.pwv);
    vi.setSystemTime((expiresAt - 1) * 1000);
    await expect(verifyLinkSession(keys(), token, binding)).resolves.toBeTruthy();
    vi.setSystemTime(expiresAt * 1000);
    await refused(verifyLinkSession(keys(), token, binding), "password_required");
  });

  it("is refused from another address, after a password change, and for another link", async () => {
    freeze(T0);
    const { token } = await mintLinkSession(keys(), binding);
    await expect(verifyLinkSession(keys(), token, binding)).resolves.toBeTruthy();
    await refused(
      verifyLinkSession(keys(), token, { ...binding, ipHashStable: "b".repeat(64) }),
      "password_required",
    );
    await refused(
      verifyLinkSession(keys(), token, { ...binding, pwv: "ffeeddccbbaa9988" }),
      "password_required",
    );
    await refused(verifyLinkSession(keys(), token, { ...binding, linkId: OTHER_NODE }), "password_required");
    await refused(verifyLinkSession(otherKeys(), token, binding), "password_required");
    for (const missing of [undefined, null, "", "a.b", `${token}x`]) {
      await refused(verifyLinkSession(keys(), missing, binding), "password_required");
    }
    // Field boundaries are part of what is signed: shifting a character between two fields fails.
    const shifted = { linkId: `${LINK}|a`, ipHashStable: "a".repeat(63), pwv: binding.pwv };
    await refused(verifyLinkSession(keys(), token, shifted), "password_required");
  });

  it("linkPwv is 8 bytes of SHA-256 of the hash, changes with it, and is a constant without a password", async () => {
    const one = await linkPwv("scrypt$made-up-hash-one");
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(await linkPwv("scrypt$made-up-hash-one")).toBe(one);
    expect(await linkPwv("scrypt$made-up-hash-two")).not.toBe(one);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode("scrypt$made-up-hash-one")),
    );
    expect(one).toBe([...digest.subarray(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join(""));
    // No password: the constant — which no hashed value can ever equal (it is not 16 hex characters).
    expect(NO_PASSWORD_PWV).toBe("-");
    for (const none of [null, undefined, ""]) expect(await linkPwv(none)).toBe(NO_PASSWORD_PWV);
    expect(NO_PASSWORD_PWV).not.toMatch(/^[0-9a-f]{16}$/);
    // A session is minted only for a well-formed version.
    await expect(mintLinkSession(keys(), { ...binding, pwv: "anything" })).rejects.toThrow("invalid binding");
  });
});

describe("link download tokens and the password version", () => {
  const PWV = "0011223344556677";
  const linkClaims = { k: "download", n: NODE, ver: VERSION, st: "l", sub: LINK } as const;

  it("a link token without pwv cannot be minted and, validly signed, is refused", async () => {
    freeze(T0);
    const exp = Math.floor(T0 / 1000) + 300;
    await expect(mintDownloadToken(keys(), linkClaims)).rejects.toThrow("invalid claims");
    const whole = { v: 1, ...linkClaims, pwv: PWV, exp };
    // The control: with the version, the same forged token verifies.
    await expect(
      verifyDownloadToken(keys(), await forge(keys(), whole), { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
    for (const pwv of [undefined, "", 7, null, "0011", "0011223344556677aa", "ZZ11223344556677", "--"]) {
      const signed = await forge(keys(), { ...whole, pwv });
      await refused(verifyDownloadToken(keys(), signed, { kind: "download", nodeId: NODE }));
    }
  });

  it("verify returns the pwv unchanged — comparing it with the link's current one is the files host's check", async () => {
    freeze(T0);
    for (const pwv of [PWV, NO_PASSWORD_PWV, await linkPwv("scrypt$made-up-hash-one")]) {
      const { token } = await mintDownloadToken(keys(), { ...linkClaims, pwv });
      const claims = await verifyDownloadToken(keys(), token, { kind: "download", nodeId: NODE });
      expect(claims.pwv).toBe(pwv);
      expect(claims).toMatchObject({ st: "l", sub: LINK });
    }
    // Two versions are two tokens: the password change is visible in the token itself.
    const before = await mintDownloadToken(keys(), { ...linkClaims, pwv: NO_PASSWORD_PWV });
    const after = await mintDownloadToken(keys(), { ...linkClaims, pwv: PWV });
    expect(after.token).not.toBe(before.token);
  });

  it("a user or system token with a pwv is refused, and cannot be minted", async () => {
    freeze(T0);
    const exp = Math.floor(T0 / 1000) + 300;
    await expect(mintDownloadToken(keys(), { ...userClaims(), pwv: PWV })).rejects.toThrow("invalid claims");
    await expect(
      mintDownloadToken(keys(), { k: "scan", n: NODE, ver: VERSION, st: "s", sub: "scanner", pwv: PWV }),
    ).rejects.toThrow("invalid claims");
    const user = { v: 1, ...userClaims(), exp };
    const scan = { v: 1, k: "scan", n: NODE, ver: VERSION, st: "s", sub: "scanner", exp };
    // The controls: without it both verify.
    await expect(
      verifyDownloadToken(keys(), await forge(keys(), user), { kind: "download", nodeId: NODE }),
    ).resolves.toBeTruthy();
    await expect(
      verifyDownloadToken(keys(), await forge(keys(), scan), { kind: "scan", nodeId: NODE }),
    ).resolves.toBeTruthy();
    for (const pwv of [PWV, NO_PASSWORD_PWV]) {
      await refused(
        verifyDownloadToken(keys(), await forge(keys(), { ...user, pwv }), {
          kind: "download",
          nodeId: NODE,
        }),
      );
      await refused(
        verifyDownloadToken(keys(), await forge(keys(), { ...scan, pwv }), { kind: "scan", nodeId: NODE }),
      );
    }
  });

  it("a link thumb token stays deterministic within its bucket, and differs across password versions", async () => {
    const bucketStart = Math.floor(T0 / 1000 / 600) * 600;
    const claims = { k: "thumb", n: NODE, ver: VERSION, st: "l", sub: LINK, sz: 160, pwv: PWV } as const;
    freeze(bucketStart * 1000);
    const first = await mintDownloadToken(keys(), claims);
    vi.setSystemTime((bucketStart + 599) * 1000);
    expect((await mintDownloadToken(keys(), claims)).token).toBe(first.token);
    expect((await mintDownloadToken(keys(), { ...claims, pwv: NO_PASSWORD_PWV })).token).not.toBe(
      first.token,
    );
  });
});

describe("zip grants", () => {
  const PWV = "0011223344556677";
  const ADDRESS = "a".repeat(64);
  const grant = { linkId: LINK, n: NODE, pwv: PWV, ipHashStable: ADDRESS };

  it("verify for their link, node and password version, for one hour", async () => {
    freeze(T0);
    const { token, expiresAt } = await mintZipGrant(keys(), grant);
    expect(ZIP_GRANT_TTL_SEC).toBe(3600);
    expect(await verifyZipGrant(keys(), token, grant)).toEqual({ linkId: LINK, n: NODE, expiresAt });
    expect(await verifyZipGrant(keys(), token, { ...grant, linkId: OTHER_NODE })).toBeNull();
    expect(await verifyZipGrant(keys(), token, { ...grant, n: OTHER_NODE })).toBeNull();
    expect(await verifyZipGrant(otherKeys(), token, grant)).toBeNull();
    for (const missing of [undefined, null, "", "x.y", `${token}x`]) {
      expect(await verifyZipGrant(keys(), missing, grant)).toBeNull();
    }
    // Neither the password version nor the address hash is readable from the grant.
    expect(new TextDecoder().decode(unb64url(token.split(".")[0]!))).not.toContain(PWV);
    expect(new TextDecoder().decode(unb64url(token.split(".")[0]!))).not.toContain(ADDRESS);
    vi.setSystemTime((expiresAt - 1) * 1000);
    expect(await verifyZipGrant(keys(), token, grant)).not.toBeNull();
    vi.setSystemTime(expiresAt * 1000);
    expect(await verifyZipGrant(keys(), token, grant)).toBeNull();
  });

  it("a grant minted under the old password does not verify under the new one", async () => {
    freeze(T0);
    const { token } = await mintZipGrant(keys(), grant);
    // The control: under the version it was minted with, it verifies.
    expect(await verifyZipGrant(keys(), token, grant)).not.toBeNull();
    expect(await verifyZipGrant(keys(), token, { ...grant, pwv: "ffeeddccbbaa9988" })).toBeNull();
    // A password added to a link that had none, and a password removed.
    expect(await verifyZipGrant(keys(), token, { ...grant, pwv: NO_PASSWORD_PWV })).toBeNull();
    const open = await mintZipGrant(keys(), { ...grant, pwv: NO_PASSWORD_PWV });
    expect(await verifyZipGrant(keys(), open.token, { ...grant, pwv: NO_PASSWORD_PWV })).not.toBeNull();
    expect(await verifyZipGrant(keys(), open.token, grant)).toBeNull();
    await expect(mintZipGrant(keys(), { ...grant, pwv: "" })).rejects.toThrow("invalid claims");
  });

  it("a grant presented from another address does not verify", async () => {
    freeze(T0);
    const { token } = await mintZipGrant(keys(), grant);
    // The control: from the address it was issued to, it verifies.
    expect(await verifyZipGrant(keys(), token, grant)).not.toBeNull();
    expect(await verifyZipGrant(keys(), token, { ...grant, ipHashStable: "b".repeat(64) })).toBeNull();
    await expect(mintZipGrant(keys(), { ...grant, ipHashStable: "" })).rejects.toThrow("invalid claims");
  });

  it("a link session is not a zip grant and a zip grant is not a link session (one key, two types)", async () => {
    freeze(T0);
    const binding = { linkId: LINK, ipHashStable: ADDRESS, pwv: PWV };
    const session = await mintLinkSession(keys(), binding);
    const issued = await mintZipGrant(keys(), grant);
    expect(await verifyZipGrant(keys(), session.token, grant)).toBeNull();
    await refused(verifyLinkSession(keys(), issued.token, binding), "password_required");
    // Even a session payload signed exactly as a grant is signed is refused for its type.
    const exp = Math.floor(T0 / 1000) + 600;
    const sign = async (payload: object, bound: string) => {
      const body = b64url(encoder.encode(JSON.stringify(payload)));
      const key = await keys().get("link-session");
      const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${body}.${bound}`)));
      return `${body}.${b64url(mac)}`;
    };
    const asGrant = `zg|${LINK}|${NODE}|${PWV}|${ADDRESS}`;
    const asSession = `ls|${LINK}|${binding.ipHashStable}|${PWV}`;
    expect(
      await verifyZipGrant(keys(), await sign({ v: 1, t: "ls", l: LINK, n: NODE, exp }, asGrant), grant),
    ).toBeNull();
    await refused(
      verifyLinkSession(keys(), await sign({ v: 1, t: "zg", l: LINK, exp }, asSession), binding),
      "password_required",
    );
    // The controls: the right type under the same signing verifies.
    expect(
      await verifyZipGrant(keys(), await sign({ v: 1, t: "zg", l: LINK, n: NODE, exp }, asGrant), grant),
    ).not.toBeNull();
    await expect(
      verifyLinkSession(keys(), await sign({ v: 1, t: "ls", l: LINK, exp }, asSession), binding),
    ).resolves.toBeTruthy();
    // And neither is a download token.
    await refused(verifyDownloadToken(keys(), issued.token, { kind: "download", nodeId: NODE }));
  });
});

describe("link tokens", () => {
  it("are 16 random bytes of base64url, hashed with SHA-256 for lookup", async () => {
    expect(LINK_TOKEN_BYTES).toBe(16);
    const token = newLinkToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(TOKEN.test(token)).toBe(true);
    expect(newLinkToken()).not.toBe(token);
    // The published SHA-256 test vector for "abc".
    expect(await hashLinkToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("sealed values", () => {
  it("a link token round-trips, with a fresh IV each time", async () => {
    const token = newLinkToken();
    const sealed = await sealLinkToken(keys(), token);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.ciphertext).toHaveLength(token.length + 16);
    expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain(token);
    expect(await openLinkToken(keys(), sealed)).toBe(token);
    const again = await sealLinkToken(keys(), token);
    expect(b64url(again.iv)).not.toBe(b64url(sealed.iv));
    expect(b64url(again.ciphertext)).not.toBe(b64url(sealed.ciphertext));
  });

  it("an address round-trips under IP_ENC_KEY", async () => {
    for (const ip of ["203.0.113.7", "2001:db8::1"]) {
      const sealed = await sealIp(IP_ENV, ip);
      expect(sealed.iv).toHaveLength(12);
      expect(sealed.keyVersion).toBe(1);
      expect(new TextDecoder().decode(sealed.ciphertext)).not.toContain(ip);
      expect(await openIp(IP_ENV, sealed)).toBe(ip);
      // As the database driver hands it back: Buffers.
      const stored = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext), iv: Buffer.from(sealed.iv) };
      expect(await openIp(IP_ENV, stored)).toBe(ip);
    }
  });

  it("a tampered ciphertext, IV or key version does not open — for both sealed values", async () => {
    const cases = [
      {
        sealed: await sealLinkToken(keys(), "made-up-link-token-0001"),
        open: (s: Parameters<typeof openLinkToken>[1]) => openLinkToken(keys(), s),
      },
      {
        sealed: await sealIp(IP_ENV, "203.0.113.7"),
        open: (s: Parameters<typeof openIp>[1]) => openIp(IP_ENV, s),
      },
    ];
    for (const { sealed, open } of cases) {
      // The control: untouched, it opens.
      await expect(open(sealed)).resolves.toBeTruthy();
      for (const index of [0, sealed.ciphertext.length - 1]) {
        const ciphertext = new Uint8Array(sealed.ciphertext);
        ciphertext[index]! ^= 0x01;
        await expect(open({ ...sealed, ciphertext })).rejects.toThrow();
      }
      const iv = new Uint8Array(sealed.iv);
      iv[0]! ^= 0x01;
      await expect(open({ ...sealed, iv })).rejects.toThrow();
      await expect(open({ ...sealed, iv: sealed.iv.subarray(0, 8) })).rejects.toThrow("invalid IV");
      await expect(open({ ...sealed, ciphertext: sealed.ciphertext.subarray(0, 10) })).rejects.toThrow();
      await expect(open({ ...sealed, keyVersion: 2 })).rejects.toThrow("unknown key version");
    }
  });

  it("a value sealed for one purpose or key does not open under another", async () => {
    const link = await sealLinkToken(keys(), "made-up-link-token-0002");
    await expect(openLinkToken(otherKeys(), link)).rejects.toThrow();
    await expect(openIp(IP_ENV, link)).rejects.toThrow();
    const ip = await sealIp(IP_ENV, "203.0.113.9");
    await expect(openIp(OTHER_IP_ENV, ip)).rejects.toThrow();
    await expect(openLinkToken(keys(), ip)).rejects.toThrow();
    // The key cache follows the value: after another key was used, the first still opens its own.
    expect(await openIp(IP_ENV, ip)).toBe("203.0.113.9");
  });

  it("a malformed IP_ENC_KEY is a clear error that does not show the value", async () => {
    for (const bad of ["", "not base64 !!", btoa("too-short"), btoa("x".repeat(33))]) {
      const error = await sealIp({ IP_ENC_KEY: bad }, "203.0.113.7").then(
        () => null,
        (thrown: Error) => thrown,
      );
      expect(error?.message).toBe("IP_ENC_KEY is not a base64-encoded 32-byte key");
    }
  });
});
