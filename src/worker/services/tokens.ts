// Signed tokens and sealed values. Every key comes from services/keys.ts (one HKDF key per
// purpose) or, for client addresses, from `IP_ENC_KEY` — never a raw secret used directly.
//
//   download tokens   files-host URLs (/d, /i, /t). HMAC-SHA256, purpose
//                     `download-token`. NOT stored: revocation is the database re-check the
//                     files host makes on every request.
//   link sessions     proof that a public link's password was entered. Purpose `link-session`.
//   zip grants        proof that a public zip already consumed its one download. Same key as link
//                     sessions; the two are told apart by a type that is part of what is signed.
//   sealed values     AES-256-GCM, a fresh 12-byte IV per value: a link's token (so the owner can
//                     copy the URL again) and an uploader's address (opened only by the lawful
//                     reporting procedure).
//
// A token is checked when a request STARTS; a response that is already streaming is not cut off
// when the token expires.

import { LINK_TOKEN_BYTES, THUMB_SIZES, TOKEN_TTL, type ThumbSize } from "../../shared/constants";
import { UUID } from "../../shared/ids";
import { now } from "./clock";
import { AppError } from "./errors";
import type { Keys } from "./keys";

export { TOKEN_TTL };

export type TokenKind = "download" | "inline" | "thumb";
/**
 * Who a token was minted for: a user or a public link. There is no system subject and no token
 * for the scanner (the Worker streams an object to it): every token there is names someone the
 * files host re-checks.
 */
export type SubjectType = "u" | "l";

export interface DownloadClaims {
  v: 1;
  k: TokenKind;
  /** The node id. */
  n: string;
  /** The version id: a token is for one version of a file. */
  ver: string;
  /** Both mandatory. `u`: `sub` is a user id; `l`: a `share_links.id`. */
  st: SubjectType;
  sub: string;
  /** Unix seconds. */
  exp: number;
  /** Thumb tokens only, and mandatory there. */
  sz?: ThumbSize;
  /**
   * Link tokens (`st: "l"`) only, and mandatory there: the link's password version when the
   * token was minted (`linkPwv`). Verification returns it UNCHANGED — this layer cannot know the
   * link's current value. Comparing it with `linkPwv(link.passwordHash)` is the files host's
   * re-check of the link: a token minted before a password was set or changed must not serve.
   */
  pwv?: string;
}

/** The password version of a link that has no password. Not the shape of any hashed value. */
export const NO_PASSWORD_PWV = "-";
const PWV = /^(?:[0-9a-f]{16}|-)$/;

/** Lifetime of a link session and of a zip grant, in seconds. */
export const LINK_SESSION_TTL_SEC = 3_600;
export const ZIP_GRANT_TTL_SEC = 3_600;

/** The version written beside every sealed value. A row with another version cannot be opened. */
export const LINK_TOKEN_KEY_VERSION = 1;
export const IP_KEY_VERSION = 1;

export type Sealed = { ciphertext: Uint8Array; iv: Uint8Array; keyVersion: number };

const KINDS: readonly TokenKind[] = ["download", "inline", "thumb"];
const SUBJECTS: readonly SubjectType[] = ["u", "l"];
const MAX_TOKEN_CHARS = 2_048;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── encoding ────────────────────────────────────────────────────────────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not canonical unpadded base64url. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
  try {
    const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // One encoding per value: a string with stray trailing bits is not the token that was issued.
    return toBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const unixNow = () => Math.floor(now().getTime() / 1000);

async function sha256(data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(data)));
}

// ── signing: payload "." signature ──────────────────────────────────────────────────────────

/**
 * `base64url(JSON payload) + "." + base64url(HMAC)`. The MAC covers the encoded payload and
 * `bound`: values the verifier must already know (an address hash, a password version), which are
 * therefore never readable from the token.
 */
async function signToken(key: CryptoKey, payload: object, bound = ""): Promise<string> {
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`${body}.${bound}`));
  return `${body}.${toBase64Url(new Uint8Array(mac))}`;
}

/** The payload of a token whose MAC verifies (in constant time: `subtle.verify`); null otherwise. */
async function openToken(
  key: CryptoKey,
  token: unknown,
  bound = "",
): Promise<Record<string, unknown> | null> {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_CHARS) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts as [string, string];
  const mac = fromBase64Url(signature);
  const raw = fromBase64Url(body);
  if (!mac || !raw) return null;
  const valid = await crypto.subtle.verify("HMAC", key, mac, encoder.encode(`${body}.${bound}`));
  if (!valid) return null;
  try {
    const payload: unknown = JSON.parse(decoder.decode(raw));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return null;
    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const isExp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

// ── download tokens ─────────────────────────────────────────────────────────────────────────

const isPwv = (value: unknown): value is string => typeof value === "string" && PWV.test(value);

function isThumbSize(value: unknown): value is ThumbSize {
  return (THUMB_SIZES as readonly unknown[]).includes(value);
}

/** The claims when every field is present, of the right type and a permitted combination. */
function asClaims(payload: Record<string, unknown>): DownloadClaims | null {
  const { v, k, n, ver, st, sub, exp, sz, pwv } = payload;
  if (v !== 1) return null;
  if (!KINDS.includes(k as TokenKind)) return null;
  if (!isText(n) || !isText(ver)) return null;
  if (!SUBJECTS.includes(st as SubjectType) || !isText(sub)) return null;
  if (!isExp(exp)) return null;
  if (k === "thumb" ? !isThumbSize(sz) : sz !== undefined) return null;
  // A link token names the password version it was minted under; nobody else's token has one.
  if (st === "l" ? !isPwv(pwv) : pwv !== undefined) return null;
  const claims: DownloadClaims = { v: 1, k: k as TokenKind, n, ver, st: st as SubjectType, sub, exp };
  if (k === "thumb") claims.sz = sz as ThumbSize;
  if (st === "l") claims.pwv = pwv as string;
  return claims;
}

/**
 * Mints a files-host token. `opts.ttlSec` replaces the kind's lifetime (the zip endpoints pass
 * `TOKEN_TTL.zip`).
 *
 * A thumb token is DETERMINISTIC within a 600 s bucket — it expires at the end of the current
 * bucket plus 600 s (so it lives 600–1,200 s) and carries no nonce: the same viewer gets the
 * same URL for the same node, version and size until the bucket rolls, which is what lets a
 * browser cache keyed on the URL work.
 *
 * Throws a plain Error for claims that could never verify (a caller's bug, not a client's).
 */
export async function mintDownloadToken(
  keys: Keys,
  claims: Omit<DownloadClaims, "v" | "exp">,
  opts: { ttlSec?: number } = {},
): Promise<{ token: string; expiresAt: number }> {
  const ttl = opts.ttlSec ?? TOKEN_TTL[claims.k];
  if (!Number.isSafeInteger(ttl) || ttl <= 0) throw new Error("download token: invalid lifetime");
  const at = unixNow();
  const exp = claims.k === "thumb" ? (Math.floor(at / ttl) + 2) * ttl : at + ttl;
  // Built field by field, in one order: the token of a thumb must not depend on how the caller
  // happened to write its object.
  const payload: Record<string, unknown> = {
    v: 1,
    k: claims.k,
    n: claims.n,
    ver: claims.ver,
    st: claims.st,
    sub: claims.sub,
    exp,
  };
  if (claims.sz !== undefined) payload.sz = claims.sz;
  if (claims.pwv !== undefined) payload.pwv = claims.pwv;
  if (!asClaims(payload)) throw new Error("download token: invalid claims");
  const token = await signToken(await keys.get("download-token"), payload);
  return { token, expiresAt: exp };
}

/**
 * Verifies a files-host token for the route it arrived on: `expect.kind` is the route's kind,
 * `expect.nodeId` the id in the path, `expect.size` the thumb size in the path.
 *
 * Throws `AppError("invalid_token")` (403) for every failure — malformed, forged, expired, wrong
 * kind, wrong node, wrong size, a missing subject, a kind or subject that does not exist (a token
 * carrying `k: "scan"` or `st: "s"` is one). The files host does not tell these apart, and
 * neither does this function.
 *
 * The caller still re-checks the subject against the database (`st` / `sub`), compares `ver`
 * with the node's current version and — for a link token — `pwv` with the link's current
 * password version: a valid token is not yet access.
 */
export async function verifyDownloadToken(
  keys: Keys,
  token: string,
  expect: { kind: TokenKind; nodeId: string; size?: number },
): Promise<DownloadClaims> {
  const payload = await openToken(await keys.get("download-token"), token);
  const claims = payload && asClaims(payload);
  const ok =
    claims !== null &&
    claims.exp > unixNow() &&
    claims.k === expect.kind &&
    claims.n === expect.nodeId &&
    (claims.k === "thumb" ? claims.sz === expect.size : expect.size === undefined);
  if (!ok) throw new AppError("invalid_token");
  return claims;
}

// ── link sessions and zip grants ────────────────────────────────────────────────────────────

/**
 * The password version (`pwv`) of a link: the first 8 bytes of SHA-256 of its `passwordHash`, as
 * 16 hex characters — so setting, changing or removing the password ends every open session,
 * grant and link download token. A link without a password has the constant `NO_PASSWORD_PWV`.
 * The ONE derivation: sessions, grants, download tokens and the files host all call this.
 */
export async function linkPwv(passwordHash: string | null | undefined): Promise<string> {
  if (passwordHash === null || passwordHash === undefined) return NO_PASSWORD_PWV;
  // An EMPTY hash is not "no password": it is a row that was written wrongly. Refuse to derive.
  if (typeof passwordHash !== "string" || passwordHash === "")
    throw new Error("link pwv: empty password hash");
  return hex((await sha256(passwordHash)).subarray(0, 8));
}

type LinkSessionBinding = { linkId: string; ipHashStable: string; pwv: string };

const sessionBound = (b: LinkSessionBinding) => `ls|${b.linkId}|${b.ipHashStable}|${b.pwv}`;

/**
 * A link session, valid for one hour, for one link, from one client address (the NON-rotating
 * address hash, so a session does not end at 00:00 UTC) and for one password version.
 * The address hash and the password version are bound into the MAC, not written into the token.
 */
export async function mintLinkSession(
  keys: Keys,
  binding: LinkSessionBinding,
): Promise<{ token: string; expiresAt: number }> {
  if (!isText(binding.linkId) || !isText(binding.ipHashStable) || !isPwv(binding.pwv)) {
    throw new Error("link session: invalid binding");
  }
  const exp = unixNow() + LINK_SESSION_TTL_SEC;
  const payload = { v: 1, t: "ls", l: binding.linkId, exp };
  const token = await signToken(await keys.get("link-session"), payload, sessionBound(binding));
  return { token, expiresAt: exp };
}

/**
 * Throws `AppError("password_required")` (403) unless the token is an unexpired session for
 * exactly this link, this address hash and this password version. A missing token is refused the
 * same way.
 */
export async function verifyLinkSession(
  keys: Keys,
  token: string | null | undefined,
  expect: LinkSessionBinding,
): Promise<{ linkId: string; expiresAt: number }> {
  const payload = await openToken(await keys.get("link-session"), token, sessionBound(expect));
  const ok =
    payload !== null &&
    payload.v === 1 &&
    payload.t === "ls" &&
    payload.l === expect.linkId &&
    isExp(payload.exp) &&
    payload.exp > unixNow();
  if (!ok) throw new AppError("password_required");
  return { linkId: expect.linkId, expiresAt: payload.exp as number };
}

type ZipGrantBinding = { linkId: string; n: string; pwv: string; ipHashStable: string };

const grantBound = (g: ZipGrantBinding) => `zg|${g.linkId}|${g.n}|${g.pwv}|${g.ipHashStable}`;

/**
 * A zip grant: issued by the public zip-manifest call after it consumed the link's one download.
 * Valid for one hour, and bound like a link session — so that it is not a pass that anyone who
 * holds it can spend from anywhere:
 *   `n`             the node the manifest was built for (the caller honours the grant only for
 *                   nodes inside that node's subtree);
 *   `pwv`           the link's password version;
 *   `ipHashStable`  the client address, as the same non-rotating hash link sessions use.
 * The password version and the address hash are bound into the MAC, not written into the grant.
 */
export async function mintZipGrant(
  keys: Keys,
  grant: ZipGrantBinding,
): Promise<{ token: string; expiresAt: number }> {
  if (!isText(grant.linkId) || !isText(grant.n) || !isPwv(grant.pwv) || !isText(grant.ipHashStable)) {
    throw new Error("zip grant: invalid claims");
  }
  const exp = unixNow() + ZIP_GRANT_TTL_SEC;
  const payload = { v: 1, t: "zg", l: grant.linkId, n: grant.n, exp };
  const token = await signToken(await keys.get("link-session"), payload, grantBound(grant));
  return { token, expiresAt: exp };
}

/**
 * The grant when it is an unexpired grant for this link, this node, the link's CURRENT password
 * version and THIS client address; null otherwise — presented from another address, for another
 * node or after a password change it does not verify, and the request is counted the ordinary way. Never throws: a grant is optional, and a request without a
 * valid one is simply counted as a download.
 */
export async function verifyZipGrant(
  keys: Keys,
  token: string | null | undefined,
  expect: ZipGrantBinding,
): Promise<{ linkId: string; n: string; expiresAt: number } | null> {
  const payload = await openToken(await keys.get("link-session"), token, grantBound(expect));
  if (!payload || payload.v !== 1 || payload.t !== "zg") return null;
  if (payload.l !== expect.linkId || payload.n !== expect.n) return null;
  if (!isExp(payload.exp) || payload.exp <= unixNow()) return null;
  return { linkId: expect.linkId, n: expect.n, expiresAt: payload.exp };
}

// ── link tokens ─────────────────────────────────────────────────────────────────────────────

/** A new public link token: `LINK_TOKEN_BYTES` random bytes, base64url. */
export function newLinkToken(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(LINK_TOKEN_BYTES)));
}

/** SHA-256 of a link token, as hex: the lookup key (`share_links.tokenHash`). */
export async function hashLinkToken(token: string): Promise<string> {
  return hex(await sha256(token));
}

// ── sealed values (AES-256-GCM) ─────────────────────────────────────────────────────────────

/** The link id is part of what is authenticated: a sealed token copied to another row does not open. */
function linkTokenAad(linkId: string): Uint8Array {
  if (typeof linkId !== "string" || !UUID.test(linkId)) throw new Error("sealed link token: invalid link id");
  return encoder.encode(`holdfast/link-token/v1|${linkId}`);
}
const IP_AAD = encoder.encode("holdfast/upload-ip/v1");

async function seal(key: CryptoKey, aad: Uint8Array, plaintext: string, keyVersion: number): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    encoder.encode(plaintext),
  );
  return { ciphertext: new Uint8Array(ciphertext), iv, keyVersion };
}

/** Throws when the value was not sealed by this key, was altered, or names another key version. */
async function open(key: CryptoKey, aad: Uint8Array, sealed: Sealed, keyVersion: number): Promise<string> {
  if (sealed.keyVersion !== keyVersion) throw new Error("sealed value: unknown key version");
  if (sealed.iv.length !== 12) throw new Error("sealed value: invalid IV");
  // Copies: a Buffer from the database driver is a view into a pooled ArrayBuffer.
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: new Uint8Array(sealed.iv), additionalData: aad },
    key,
    new Uint8Array(sealed.ciphertext),
  );
  return decoder.decode(plaintext);
}

/**
 * Seals a link token for `share_links.tokenEnc` / `tokenIv` / `tokenKeyVersion`, BOUND TO ITS ROW:
 * `bind.linkId` is the id of the `share_links` row the value is stored in (generate the id before
 * sealing). The same id opens it; any other does not.
 */
export async function sealLinkToken(keys: Keys, token: string, bind: { linkId: string }): Promise<Sealed> {
  return seal(await keys.get("link-token-enc"), linkTokenAad(bind?.linkId), token, LINK_TOKEN_KEY_VERSION);
}

/** Opens a sealed link token read from the row `bind.linkId`. Throws for any other row's value. */
export async function openLinkToken(keys: Keys, sealed: Sealed, bind: { linkId: string }): Promise<string> {
  return open(await keys.get("link-token-enc"), linkTokenAad(bind?.linkId), sealed, LINK_TOKEN_KEY_VERSION);
}

// The imported address key and the value it was imported from. A resolved key, never a promise
// (a promise created inside one request must not be awaited by another).
let ipKey: { source: string; key: CryptoKey } | null = null;

async function ipEncryptionKey(env: Pick<Env, "IP_ENC_KEY">): Promise<CryptoKey> {
  const source = env.IP_ENC_KEY;
  if (ipKey && ipKey.source === source) return ipKey.key;
  let raw: Uint8Array | null = null;
  try {
    const binary = atob(source ?? "");
    raw = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
  } catch {
    raw = null;
  }
  // Never the value, and never its length, in the message.
  if (!raw || raw.length !== 32) throw new Error("IP_ENC_KEY is not a base64-encoded 32-byte key");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  ipKey = { source, key };
  return key;
}

/** Seals a client address for `upload_ips` (`ipEncrypted`, `iv`, `keyVersion`). */
export async function sealIp(env: Pick<Env, "IP_ENC_KEY">, ip: string): Promise<Sealed> {
  return seal(await ipEncryptionKey(env), IP_AAD, ip, IP_KEY_VERSION);
}

/** Opens a sealed address. Only the lawful-reporting procedure calls this. */
export async function openIp(env: Pick<Env, "IP_ENC_KEY">, sealed: Sealed): Promise<string> {
  return open(await ipEncryptionKey(env), IP_AAD, sealed, IP_KEY_VERSION);
}
