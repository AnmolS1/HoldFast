// In-memory cache of minted thumbnail URLs, keyed (nodeId, versionKey, size). A URL is a bearer
// token: it lives here and in the <img> only — never in storage, logs or error reports.

export type ThumbSize = 160 | 320 | 1280;

export interface ThumbRequest {
  nodeId: string;
  versionKey: string;
  size: ThumbSize;
  getUrl(nodeId: string, size: ThumbSize): Promise<{ url: string; expiresAt: string }>;
}

/** A cached URL is reused until this long before it expires. */
export const EXPIRY_MARGIN_MS = 30_000;

export interface CacheEntry {
  url: string;
  expiresAt: number;
}

export const thumbCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CacheEntry>>();

export const keyOf = (nodeId: string, versionKey: string, size: number) => `${nodeId}|${versionKey}|${size}`;

function usable(entry: CacheEntry | undefined, now: number): entry is CacheEntry {
  return entry !== undefined && entry.expiresAt - EXPIRY_MARGIN_MS > now;
}

export async function resolveUrl(props: ThumbRequest, force: boolean): Promise<CacheEntry> {
  const key = keyOf(props.nodeId, props.versionKey, props.size);
  if (!force) {
    const cached = thumbCache.get(key);
    if (usable(cached, Date.now())) return cached;
    const pending = inFlight.get(key);
    if (pending) return pending;
  }
  const request = props
    .getUrl(props.nodeId, props.size)
    .then((result) => {
      const parsed = Date.parse(result.expiresAt);
      const entry = { url: result.url, expiresAt: Number.isNaN(parsed) ? 0 : parsed };
      thumbCache.set(key, entry);
      return entry;
    })
    .finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key);
    });
  inFlight.set(key, request);
  return request;
}

/** Tests only. */
export function resetThumbCacheForTests(): void {
  thumbCache.clear();
  inFlight.clear();
}
