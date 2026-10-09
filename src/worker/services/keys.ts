// Purpose keys. `FILES_TOKEN_SECRET` is never used directly: every use derives its own key from
// it with HKDF-SHA256 (WebCrypto), so a key leaked or misused for one purpose says nothing about
// another.
//
// A `Keys` holder is built once per request context (or background run) and derives each key on
// first use. It memoizes promises, which is fine here because the holder lives and dies with one
// invocation — never keep a `Keys` (or anything derived from it) at module scope.

export const KEY_PURPOSES = [
  "download-token",
  "ip-hash",
  "ip-hash-stable",
  "intent-cookie",
  "link-session",
  "link-token-enc",
  "account-action",
  "email-ledger",
] as const;

export type KeyPurpose = (typeof KEY_PURPOSES)[number];

/** The one purpose whose key encrypts (AES-GCM). Every other key signs (HMAC-SHA256). */
export type EncryptionPurpose = "link-token-enc";

export type Keys = {
  /**
   * The key for a purpose. HMAC-SHA256 (`sign`, `verify`) for every purpose except
   * `link-token-enc`, which is AES-GCM-256 (`encrypt`, `decrypt`). Not extractable.
   */
  get(purpose: KeyPurpose): Promise<CryptoKey>;
};

const encoder = new TextEncoder();
// Fixed and public. It only separates this derivation from any other use of the same secret.
const SALT = encoder.encode("holdfast/hkdf/v1");

export function createKeys(secret: string): Keys {
  if (!secret) throw new Error("FILES_TOKEN_SECRET is not set");
  let base: Promise<CryptoKey> | undefined;
  const derived = new Map<KeyPurpose, Promise<CryptoKey>>();

  const derive = async (purpose: KeyPurpose): Promise<CryptoKey> => {
    base ??= crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
    const params = { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(`holdfast/${purpose}`) };
    if (purpose === "link-token-enc") {
      return crypto.subtle.deriveKey(params, await base, { name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
    }
    return crypto.subtle.deriveKey(
      params,
      await base,
      { name: "HMAC", hash: "SHA-256", length: 256 },
      false,
      ["sign", "verify"],
    );
  };

  return {
    get(purpose) {
      if (!KEY_PURPOSES.includes(purpose))
        return Promise.reject(new Error(`unknown key purpose: ${String(purpose)}`));
      let key = derived.get(purpose);
      if (!key) {
        key = derive(purpose);
        derived.set(purpose, key);
      }
      return key;
    },
  };
}

/** HMAC-SHA256 of `data` under a signing purpose key, as lower-case hex. */
export async function hmacHex(
  keys: Keys,
  purpose: Exclude<KeyPurpose, EncryptionPurpose>,
  data: string,
): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await keys.get(purpose), encoder.encode(data));
  return [...new Uint8Array(mac)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
