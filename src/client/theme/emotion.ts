import createCache, { type EmotionCache } from "@emotion/cache";

/** The CSP nonce the Worker injects into index.html (a later task); `undefined` until it does. */
export function readNonceFromMeta(doc: Document = document): string | undefined {
  const value = doc.querySelector('meta[name="csp-nonce"]')?.getAttribute("content");
  return value ? value : undefined;
}

export function createEmotionCache(doc: Document = document): EmotionCache {
  return createCache({ key: "hf", nonce: readNonceFromMeta(doc) });
}
