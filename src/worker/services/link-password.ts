// Link passwords (R2.6, spike P3): node:crypto scrypt at ONE parameter set for the whole product —
// the cost Better Auth uses for account passwords — stored as a self-describing string:
//
//   scrypt$16384$16$1$<salt base64url>$<key base64url>      16-byte salt, 64-byte key
//
// `maxmem` IS REQUIRED. N=16384 with r=16 needs exactly the 32 MiB that is scrypt's default
// limit, and the default rejects it with an opaque `Error: Scrypt failed`. Every call passes
// 128·N·r·2 — computed from the parameters it derives with.
//
// NEVER PBKDF2: deployed workerd caps it at 100,000 iterations (WebCrypto and node:crypto alike),
// and local workerd does not enforce the cap, so no local test would notice.
//
// COST: ≈ 70–100 ms of CPU and 32 MiB per hash on a deployed Worker, and the isolate does nothing
// else meanwhile. The unlock route asks the password throttle BEFORE it verifies: a caller who is
// locked out buys no hash.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const LINK_PASSWORD_PARAMS = { N: 16384, r: 16, p: 1, keylen: 64 } as const;

const SALT_BYTES = 16;
const SCHEME = "scrypt";

// What a stored string may name. Anything outside is not a hash this product wrote, and is
// refused without deriving anything (a row edited to N = 2^30 must not cost a gigabyte): never
// more memory (128·N·r) nor more time (N·r·p) than the product's own parameters cost. A smaller,
// older parameter set still verifies with its own values.
const N_RANGE = { min: 1 << 10, max: LINK_PASSWORD_PARAMS.N };
const R_MAX = LINK_PASSWORD_PARAMS.r;
const P_MAX = LINK_PASSWORD_PARAMS.p;
const COST_MAX = LINK_PASSWORD_PARAMS.N * LINK_PASSWORD_PARAMS.r * LINK_PASSWORD_PARAMS.p;
const KEY_RANGE = { min: 16, max: 128 };

type Params = { N: number; r: number; p: number };

/** The options of one derivation: the parameters, and the memory they need. */
function optionsFor({ N, r, p }: Params): ScryptOptions & Params & { maxmem: number } {
  return { N, r, p, maxmem: 128 * N * r * 2 };
}

/**
 * The one place scrypt is called. An object so that a test can watch the options every call
 * passes (an ESM export of node:crypto cannot be spied on).
 */
export const scryptInternals = {
  derive(password: string, salt: Uint8Array, keylen: number, options: ScryptOptions): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      scrypt(password, salt, keylen, options, (error, key) =>
        error ? reject(error) : resolve(new Uint8Array(key)),
      );
    });
  },
};

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not canonical unpadded base64url. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return null;
  try {
    const bytes = Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0));
    return toBase64Url(bytes) === text ? bytes : null;
  } catch {
    return null;
  }
}

const isPowerOfTwo = (n: number) => (n & (n - 1)) === 0;

/** A decimal field with no sign, no leading zero and no fraction. */
function int(text: string): number | null {
  return /^[1-9][0-9]{0,9}$/.test(text) ? Number(text) : null;
}

type Parsed = Params & { salt: Uint8Array; key: Uint8Array };

function parse(stored: string): Parsed | null {
  if (typeof stored !== "string") return null;
  const fields = stored.split("$");
  if (fields.length !== 6 || fields[0] !== SCHEME) return null;
  const [N, r, p] = [int(fields[1]!), int(fields[2]!), int(fields[3]!)];
  if (N === null || r === null || p === null) return null;
  if (N < N_RANGE.min || N > N_RANGE.max || !isPowerOfTwo(N) || r > R_MAX || p > P_MAX) return null;
  if (N * r * p > COST_MAX) return null;
  const salt = fromBase64Url(fields[4]!);
  const key = fromBase64Url(fields[5]!);
  if (!salt || salt.length < SALT_BYTES || !key || key.length < KEY_RANGE.min || key.length > KEY_RANGE.max) {
    return null;
  }
  return { N, r, p, salt, key };
}

/** A new stored string for `password`, at the product's parameters and a fresh salt. */
export async function hashLinkPassword(password: string): Promise<string> {
  const { N, r, p, keylen } = LINK_PASSWORD_PARAMS;
  const salt = new Uint8Array(randomBytes(SALT_BYTES));
  const key = await scryptInternals.derive(password, salt, keylen, optionsFor({ N, r, p }));
  return [SCHEME, N, r, p, toBase64Url(salt), toBase64Url(key)].join("$");
}

/**
 * Whether `password` is the one `stored` was made from. Derives with the STORED parameters and
 * compares in constant time. False — never a throw — for a string that is not such a hash.
 */
export async function verifyLinkPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parse(stored);
  if (!parsed) return false;
  let derived: Uint8Array;
  try {
    derived = await scryptInternals.derive(password, parsed.salt, parsed.key.length, optionsFor(parsed));
  } catch {
    return false;
  }
  return derived.length === parsed.key.length && timingSafeEqual(derived, parsed.key);
}
