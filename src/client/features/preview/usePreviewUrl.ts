// Short-lived files-host URLs for the renderers, kept fresh.
//
//   proactive  a new URL is minted at 80 % of the lifetime for as long as the consumer has not
//              said it holds everything it needs (`settle`);
//   reactive   when the URL fails (`reportFailure`: a media or image `error` event, a 403 from a
//              fetch) ONE more is minted; a second failure is final;
//   final      a mint that is refused is final at once — no further mint, no timer left running.
//
// A URL is a bearer token: it lives in this hook's state and in the element that shows it, and
// is never logged or stored.
import { useCallback, useEffect, useRef, useState } from "react";
import { TOKEN_TTL } from "../../../shared/constants";
import { ApiError } from "../../lib/api";
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
   * The current URL did not work. Mints once more and resolves with the new URL, or with null
   * when this was already the second failure (or the mint was refused) — then `failure` is set.
   */
  reportFailure(): Promise<string | null>;
  /** The URL worked: a later failure gets its own single retry. */
  loaded(): void;
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
  loaded(): void;
  settle(): void;
  fail(): void;
}

const REFRESH_AT = 0.8;

/** When to mint again: 80 % of the lifetime, never later than 80 % of the kind's own lifetime. */
export function refreshDelayMs(minted: MintedUrl, kind: "inline" | "thumb", now: number): number {
  const ttl = TOKEN_TTL[kind] * 1000;
  const remaining = Date.parse(minted.expiresAt) - now;
  // A clock that disagrees with the server's must not push the refresh past the real expiry.
  const lifetime = Number.isFinite(remaining) && remaining > 0 ? Math.min(remaining, ttl) : ttl;
  return lifetime * REFRESH_AT;
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
    let retried = false;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight: Promise<string | null> | null = null;

    const publish = (url: string | null, failure: PreviewFailure | null) => {
      if (!cancelled) setState({ key, url, failure });
    };
    const stop = (failure: PreviewFailure) => {
      dead = true;
      clearTimeout(timer);
      publish(null, failure);
    };
    const mint = (): Promise<string | null> => {
      clearTimeout(timer);
      const request = mintUrl(latestSource.current, nodeId, kind, size).then(
        (minted) => {
          if (cancelled || dead) return null;
          publish(minted.url, null);
          if (!settled) timer = setTimeout(() => void mint(), refreshDelayMs(minted, kind, Date.now()));
          return minted.url;
        },
        (error: unknown) => {
          if (!cancelled && !dead) stop(failureOf(error));
          return null;
        },
      );
      inFlight = request;
      void request.finally(() => {
        if (inFlight === request) inFlight = null;
      });
      return request;
    };

    const own: Controller = {
      reportFailure() {
        if (cancelled || dead) return Promise.resolve(null);
        if (retried) {
          stop(HOST_FAILURE);
          return Promise.resolve(null);
        }
        retried = true;
        // A refresh already under way is the one retry.
        return inFlight ?? mint();
      },
      loaded() {
        retried = false;
      },
      settle() {
        settled = true;
        clearTimeout(timer);
      },
      fail() {
        if (!cancelled && !dead) stop(HOST_FAILURE);
      },
    };
    controller.current = own;
    void mint();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      if (controller.current === own) controller.current = null;
    };
  }, [nodeId, kind, size, key]);

  const reportFailure = useCallback(() => controller.current?.reportFailure() ?? Promise.resolve(null), []);
  const loaded = useCallback(() => controller.current?.loaded(), []);
  const settle = useCallback(() => controller.current?.settle(), []);
  const fail = useCallback(() => controller.current?.fail(), []);

  // State of another file is not this one's.
  const current = state.key === key ? state : null;
  return {
    url: current?.url ?? null,
    failure: current?.failure ?? null,
    reportFailure,
    loaded,
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
