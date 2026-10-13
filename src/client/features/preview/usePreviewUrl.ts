// Short-lived files-host URLs for the renderers, kept fresh.
//
//   proactive  a new URL is minted at 80 % of the lifetime (never sooner than 30 s after the
//              last) for as long as the consumer has not said it holds everything it needs
//              (`settle`). A refresh that FAILS changes nothing on screen — the URL in use is
//              still good — and is tried again 15 s, 30 s and 60 s later, then given up;
//   reactive   when the URL in use fails (`reportFailure`: a media or image `error` event, a 403
//              from a fetch) ONE more is minted — once per view of the file, whatever happened
//              in between. A second failure is final, and so is a "fresh" URL that is the very
//              one that failed (thumbnail URLs are identical for minutes);
//   final      the first mint, or the one after a failure, being refused is final at once — no
//              further mint, no timer left running.
//
// A URL is a bearer token: it lives in this hook's state and in the element that shows it, and
// is never logged or stored.
import { useCallback, useEffect, useRef, useState } from "react";
import { TOKEN_TTL } from "../../../shared/constants";
import { ApiError } from "../../lib/api";
import { accountEpoch, sameAccount } from "../../lib/query";
import { mintUrl, type MintedUrl, type PreviewSource } from "./source";

/** Why a preview could not be shown. `requestId` only when the app API answered. */
export interface PreviewFailure {
  requestId?: string;
  notFound?: boolean;
  /** The files host refused or failed (it sends plain text: there is no request id). */
  host?: boolean;
}

export function failureOf(error: unknown): PreviewFailure {
  if (error instanceof ApiError) return { requestId: error.requestId, notFound: error.status === 404 };
  return {};
}

const HOST_FAILURE: PreviewFailure = { host: true };

export interface PreviewUrl {
  /** The current URL; null until the first mint answers and after a failure. */
  url: string | null;
  failure: PreviewFailure | null;
  /**
   * The URL in use did not work. Mints once more — once per view of the file — and resolves with
   * the new URL; resolves with null when this was already the second failure, when the mint was
   * refused, or when the "new" URL is the one that failed. Then `failure` is set.
   */
  reportFailure(): Promise<string | null>;
  /** Everything needed is in hand (decoded image, fetched bytes): stop refreshing. */
  settle(): void;
  /** Give up without another mint (a files-host answer no fresh URL would change). */
  fail(): void;
}

interface State {
  key: string;
  url: string | null;
  failure: PreviewFailure | null;
}

interface Controller {
  reportFailure(): Promise<string | null>;
  settle(): void;
  fail(): void;
}

const REFRESH_AT = 0.8;
/** A refresh is never scheduled sooner than this, whatever `expiresAt` and this device's clock say. */
export const REFRESH_MIN_MS = 30_000;
/** A failed proactive refresh is tried again after these waits, then given up. */
export const REFRESH_RETRY_MS: readonly number[] = [15_000, 30_000, 60_000];

/**
 * When to mint again: 80 % of the lifetime — never later than 80 % of the kind's own lifetime,
 * and never sooner than `REFRESH_MIN_MS`.
 */
export function refreshDelayMs(minted: MintedUrl, kind: "inline" | "thumb", now: number): number {
  const ttl = TOKEN_TTL[kind] * 1000;
  const remaining = Date.parse(minted.expiresAt) - now;
  // A clock that disagrees with the server's must not push the refresh past the real expiry —
  // nor make every URL look seconds from it (a mint and a reload every few seconds).
  const lifetime = Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, ttl) : ttl;
  return Math.max(REFRESH_MIN_MS, lifetime * REFRESH_AT);
}

export function usePreviewUrl(
  source: PreviewSource,
  nodeId: string,
  kind: "inline" | "thumb",
  size?: number,
): PreviewUrl {
  // A public page may hand in a new source object on every render: the object is read when a
  // URL is minted, and only its kind restarts the hook.
  const sourceKind = source === "owner" ? "owner" : "public";
  const key = `${sourceKind}|${nodeId}|${kind}|${size ?? ""}`;
  const [state, setState] = useState<State>({ key, url: null, failure: null });
  const controller = useRef<Controller | null>(null);
  const latestSource = useRef(source);
  useEffect(() => {
    latestSource.current = source;
  });

  useEffect(() => {
    let cancelled = false;
    let dead = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The account this view belongs to. After a purge (sign-out, another identity) nothing here
    // asks, publishes or re-arms a timer: a URL is a bearer token of the account that minted it.
    const account = accountEpoch();
    const live = () => {
      if (cancelled || dead) return false;
      if (sameAccount(account)) return true;
      dead = true;
      clearTimeout(timer);
      return false;
    };
    // The one re-mint after a failure. Spent once per view of this file and never given back:
    // a file that fails at the same place every time must not mint for ever.
    let retried = false;
    let settled = false;
    let inUse: string | null = null;
    // Only the latest mint may publish: an older one answering late is dropped.
    let latest = 0;

    const publish = (url: string | null, failure: PreviewFailure | null) => {
      inUse = url;
      if (!cancelled) setState({ key, url, failure });
    };
    const stop = (failure: PreviewFailure) => {
      dead = true;
      clearTimeout(timer);
      publish(null, failure);
    };
    const adopt = (minted: MintedUrl): string => {
      publish(minted.url, null);
      if (!settled) timer = setTimeout(() => refresh(0), refreshDelayMs(minted, kind, Date.now()));
      return minted.url;
    };
    /** The first URL, and the one after a failure: a refusal is final. */
    const mint = (failed: string | null): Promise<string | null> => {
      clearTimeout(timer);
      if (!live()) return Promise.resolve(null);
      const mine = (latest += 1);
      return mintUrl(latestSource.current, nodeId, kind, size).then(
        (minted) => {
          if (!live() || mine !== latest) return null;
          // The same URL again would load nothing new and report nothing: it IS the second failure.
          if (failed !== null && minted.url === failed) {
            stop(HOST_FAILURE);
            return null;
          }
          return adopt(minted);
        },
        (error: unknown) => {
          if (live() && mine === latest) stop(failureOf(error));
          return null;
        },
      );
    };
    /** The proactive refresh: a failure leaves what is on screen alone and is tried again. */
    const refresh = (attempt: number): void => {
      if (!live()) return;
      const mine = (latest += 1);
      mintUrl(latestSource.current, nodeId, kind, size).then(
        (minted) => {
          if (live() && !settled && mine === latest) adopt(minted);
        },
        () => {
          if (!live() || settled || mine !== latest) return;
          const wait = REFRESH_RETRY_MS[attempt];
          if (wait !== undefined) timer = setTimeout(() => refresh(attempt + 1), wait);
        },
      );
    };

    const own: Controller = {
      reportFailure() {
        if (!live()) return Promise.resolve(null);
        if (retried) {
          stop(HOST_FAILURE);
          return Promise.resolve(null);
        }
        retried = true;
        return mint(inUse);
      },
      settle() {
        settled = true;
        clearTimeout(timer);
      },
      fail() {
        if (live()) stop(HOST_FAILURE);
      },
    };
    controller.current = own;
    // Asked a moment later: a mount that is undone at once (development's double mount) mints
    // nothing, so one view of a file is one URL.
    queueMicrotask(() => {
      if (live()) void mint(null);
    });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (controller.current === own) controller.current = null;
    };
  }, [nodeId, kind, size, key]);

  const reportFailure = useCallback(() => controller.current?.reportFailure() ?? Promise.resolve(null), []);
  const settle = useCallback(() => controller.current?.settle(), []);
  const fail = useCallback(() => controller.current?.fail(), []);

  // State of another file is not this one's.
  const current = state.key === key ? state : null;
  return {
    url: current?.url ?? null,
    failure: current?.failure ?? null,
    reportFailure,
    settle,
    fail,
  };
}

/**
 * Fetch a file's bytes from the files host for a viewer that reads them itself (PDF, text).
 * Any `403` — whatever its body says; it is never read — means "mint once more, retry once".
 * Resolves with the response, or with null once the hook holds the failure.
 */
export async function fetchPreview(
  first: string,
  preview: Pick<PreviewUrl, "reportFailure" | "fail">,
  signal: AbortSignal,
): Promise<Response | null> {
  let url: string | null = first;
  for (let attempt = 0; attempt < 2 && url; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(url, { mode: "cors", credentials: "omit", signal });
    } catch {
      if (!signal.aborted) preview.fail();
      return null;
    }
    if (response.ok) return response;
    if (response.status !== 403) {
      preview.fail();
      return null;
    }
    // First 403: one more URL. Second: `reportFailure` records the failure and answers null.
    url = await preview.reportFailure();
  }
  return null;
}

/** A file turned out larger than its viewer takes. */
export const TOO_LARGE = Symbol("too large");

/**
 * Read a response's body, giving up — and cancelling the transfer — as soon as more than `limit`
 * bytes have arrived. The count is of what actually came: `Content-Length` and the size the API
 * reported are not trusted.
 */
export async function readLimited(response: Response, limit: number): Promise<Uint8Array | typeof TOO_LARGE> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    void response.body?.cancel().catch(() => {});
    return TOO_LARGE;
  }
  if (!response.body) {
    const all = new Uint8Array(await response.arrayBuffer());
    return all.byteLength > limit ? TOO_LARGE : all;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => {});
      return TOO_LARGE;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return all;
}
