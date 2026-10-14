// Token freshness: a URL is re-minted at 80 % of its lifetime, once more after it failed, and
// never again after a mint was refused.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PublicPreviewSource } from "../../../../src/client/components/slots";
import { ApiError } from "../../../../src/client/lib/api";
import {
  fetchPreview,
  REFRESH_MIN_MS,
  REFRESH_RETRY_MS,
  refreshDelayMs,
  refreshRetryMs,
  usePreviewUrl,
} from "../../../../src/client/features/preview/usePreviewUrl";
import { ID, NODES, filesUrl } from "./fixtures";
import { advance, envelope, installFetch, ownerApi, setupPreview, unreadable } from "./helpers";

setupPreview();

const INLINE_MS = 900_000;
const REFRESH_MS = INLINE_MS * 0.8;

/** A public source whose every mint answers a new URL with the lifetime of an inline token. */
function publicSource(getUrl?: PublicPreviewSource["getUrl"]) {
  let count = 0;
  const mint = vi.fn<PublicPreviewSource["getUrl"]>(
    getUrl ??
      (async (nodeId, kind) => {
        count += 1;
        return {
          url: filesUrl(kind === "thumb" ? "thumb" : "inline", nodeId, `pub-${count}`),
          expiresAt: new Date(Date.now() + INLINE_MS).toISOString(),
        };
      }),
  );
  const source: PublicPreviewSource = {
    getItem: vi.fn(async () => ({ ...NODES.mp4, mimeSniffed: "video/mp4" })),
    getUrl: mint,
  };
  return { source, mint };
}

describe("usePreviewUrl — proactive refresh", () => {
  it("mints once, then exactly once per period at 80 % of the lifetime", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "pub-1"));

    await advance(REFRESH_MS - 1);
    expect(mint).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "pub-2"));

    // Twenty minutes in: still two (the next is due at 24 minutes).
    await advance(20 * 60_000 - REFRESH_MS);
    expect(mint).toHaveBeenCalledTimes(2);
    await advance(2 * REFRESH_MS - 20 * 60_000);
    expect(mint).toHaveBeenCalledTimes(3);
    // An hour of playback: one mint per 12 minutes, never two for one period.
    await advance(60 * 60_000 - 2 * REFRESH_MS);
    expect(mint).toHaveBeenCalledTimes(1 + Math.floor((60 * 60_000) / REFRESH_MS));
    expect(mint.mock.calls.every(([nodeId, kind]) => nodeId === ID.mp4 && kind === "inline")).toBe(true);
  });

  it("a consumer that holds everything it needs stops the refresh", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    act(() => result.current.settle());
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unmounting leaves no timer behind", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { unmount } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("a source object that is new on every render does not mint again", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { rerender } = renderHook(() => usePreviewUrl({ ...source }, ID.mp4, "inline"));
    await advance(0);
    rerender();
    rerender();
    await advance(1000);
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it("the refresh is never later than 80 % of the kind's own lifetime, whatever the clocks say", () => {
    const now = Date.parse("2026-10-13T12:00:00.000Z");
    const at = (ms: number) => ({ url: "u", expiresAt: new Date(now + ms).toISOString() });
    expect(refreshDelayMs(at(INLINE_MS), "inline", now)).toBe(REFRESH_MS);
    // This device's clock is ten minutes slow: the token looks longer-lived than it is.
    expect(refreshDelayMs(at(INLINE_MS + 600_000), "inline", now)).toBe(REFRESH_MS);
    // A shorter-lived URL is refreshed at 80 % of what it has.
    expect(refreshDelayMs(at(100_000), "inline", now)).toBe(80_000);
    // Never sooner than half a minute: a clock almost one lifetime ahead of the server's makes
    // every URL look seconds from its end, and a film must not reload every few seconds.
    expect(REFRESH_MIN_MS).toBe(30_000);
    expect(refreshDelayMs(at(10_000), "inline", now)).toBe(30_000);
    expect(refreshDelayMs(at(1_000), "inline", now)).toBe(30_000);
    expect(refreshDelayMs(at(1), "thumb", now)).toBe(30_000);
    expect(refreshDelayMs(at(37_500), "inline", now)).toBe(30_000);
    expect(refreshDelayMs(at(37_501), "inline", now)).toBeGreaterThan(30_000);
    // Already past, or unreadable: the kind's lifetime is assumed.
    expect(refreshDelayMs(at(-5_000), "inline", now)).toBe(REFRESH_MS);
    expect(refreshDelayMs({ url: "u", expiresAt: "soon" }, "inline", now)).toBe(REFRESH_MS);
    expect(refreshDelayMs(at(INLINE_MS), "thumb", now)).toBe(600_000 * 0.8);
  });
});

describe("usePreviewUrl — a proactive refresh that fails", () => {
  /** Mints succeed except the calls whose number (1-based) is in `failing`. */
  function flaky(failing: Set<number>) {
    let count = 0;
    return publicSource(async (nodeId) => {
      count += 1;
      if (failing.has(count)) throw new Error("503");
      return {
        url: filesUrl("inline", nodeId, `pub-${count}`),
        expiresAt: new Date(Date.now() + INLINE_MS).toISOString(),
      };
    });
  }

  it("changes nothing on screen, and is tried again after 15 s", async () => {
    vi.useFakeTimers();
    const { source, mint } = flaky(new Set([2]));
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    await advance(REFRESH_MS);
    expect(mint).toHaveBeenCalledTimes(2);
    // The URL in use is still the first one, and nothing has failed.
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "pub-1"));
    expect(result.current.failure).toBeNull();
    await advance(REFRESH_RETRY_MS[0]! - 1);
    expect(mint).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "pub-3"));
    // Back to the ordinary rhythm: the next refresh is a period after the one that worked.
    await advance(REFRESH_MS - 1);
    expect(mint).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(mint).toHaveBeenCalledTimes(4);
  });

  it("is bounded: 15 s, 30 s and 60 s later, then no more — and still nothing on screen has changed", async () => {
    vi.useFakeTimers();
    expect(REFRESH_RETRY_MS).toEqual([15_000, 30_000, 60_000]);
    const { source, mint } = flaky(new Set([2, 3, 4, 5, 6, 7, 8]));
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    await advance(REFRESH_MS);
    expect(mint).toHaveBeenCalledTimes(2);
    await advance(15_000);
    expect(mint).toHaveBeenCalledTimes(3);
    await advance(30_000);
    expect(mint).toHaveBeenCalledTimes(4);
    await advance(60_000);
    expect(mint).toHaveBeenCalledTimes(5);
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "pub-1"));
    expect(result.current.failure).toBeNull();
  });

  it("only a failure of the URL in use leads to the one re-mint — and that one being refused is final", async () => {
    vi.useFakeTimers();
    const { source, mint } = flaky(new Set([2, 3]));
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    await advance(REFRESH_MS);
    expect(result.current.failure).toBeNull();
    // Now the URL in use fails (it has expired): the re-mint is call 3, which is refused.
    await act(async () => void (await result.current.reportFailure()));
    expect(mint).toHaveBeenCalledTimes(3);
    expect(result.current.failure).toEqual({});
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the signed-in source behaves the same: a 503 at the refresh leaves the URL, the request id is not shown", async () => {
    vi.useFakeTimers();
    let mints = 0;
    const api = ownerApi([NODES.mp4], (call) => {
      if (!call.url.pathname.endsWith("/download-url")) return undefined;
      mints += 1;
      return mints === 2 ? envelope("internal", 503) : undefined;
    });
    installFetch({ api: api.handler });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    await advance(REFRESH_MS);
    expect(mints).toBe(2);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "tok-1"));
    expect(result.current.failure).toBeNull();
    await advance(15_000);
    expect(mints).toBe(3);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "tok-2"));
  });
});

describe("usePreviewUrl — a refresh the API asked to wait for", () => {
  it("the wait is the ladder's rung or the API's Retry-After, whichever is longer — and none past the URL's end", () => {
    const limited = (seconds?: number) =>
      new ApiError({ status: 429, code: "rate_limited", message: "slow down", retryAfter: seconds });
    expect(refreshRetryMs(0, new Error("offline"), 180_000)).toBe(15_000);
    expect(refreshRetryMs(1, limited(), 180_000)).toBe(30_000);
    expect(refreshRetryMs(0, limited(5), 180_000)).toBe(15_000);
    expect(refreshRetryMs(0, limited(120), 180_000)).toBe(120_000);
    // Asked to wait longer than the URL in use will last: there is nothing to refresh for.
    expect(refreshRetryMs(0, limited(600), 180_000)).toBeNull();
    expect(refreshRetryMs(2, new Error("offline"), 50_000)).toBeNull();
    // The ladder is three rungs.
    expect(refreshRetryMs(3, new Error("offline"), 180_000)).toBeNull();
  });

  it("a 429 with Retry-After: 120 at the refresh → nothing is asked for 120 s (not after 15)", async () => {
    vi.useFakeTimers();
    let mints = 0;
    const api = ownerApi([NODES.mp4], (call) => {
      if (!call.url.pathname.endsWith("/download-url")) return undefined;
      mints += 1;
      return mints === 2 ? envelope("rate_limited", 429, undefined, { "retry-after": "120" }) : undefined;
    });
    installFetch({ api: api.handler });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    await advance(REFRESH_MS);
    expect(mints).toBe(2);
    await advance(119_000);
    expect(mints).toBe(2);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "tok-1"));
    await advance(1_000);
    expect(mints).toBe(3);
    expect(result.current.url).toBe(filesUrl("inline", ID.mp4, "tok-2"));
  });

  it("a 429 that asks for longer than the URL has left: no retry at all", async () => {
    vi.useFakeTimers();
    let mints = 0;
    const api = ownerApi([NODES.mp4], (call) => {
      if (!call.url.pathname.endsWith("/download-url")) return undefined;
      mints += 1;
      return mints >= 2 ? envelope("rate_limited", 429, undefined, { "retry-after": "600" }) : undefined;
    });
    installFetch({ api: api.handler });
    renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    await advance(REFRESH_MS);
    await advance(10 * INLINE_MS);
    expect(mints).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("usePreviewUrl — reactive refresh", () => {
  it("a failure mints once more; a second failure is final and nothing is minted after it", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    let next: string | null = "";
    await act(async () => {
      next = await result.current.reportFailure();
    });
    expect(mint).toHaveBeenCalledTimes(2);
    expect(next).toBe(filesUrl("inline", ID.mp4, "pub-2"));
    expect(result.current.failure).toBeNull();

    await act(async () => {
      next = await result.current.reportFailure();
    });
    expect(next).toBeNull();
    expect(mint).toHaveBeenCalledTimes(2);
    // A files-host failure: no request id exists.
    expect(result.current.failure).toEqual({ host: true });
    expect(result.current.url).toBeNull();
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the one retry is per view of the file: nothing that happens in between gives it back", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    await act(async () => void (await result.current.reportFailure()));
    expect(mint).toHaveBeenCalledTimes(2);
    // The fresh URL works for a while (a proactive refresh even replaces it) — and then fails.
    await advance(REFRESH_MS);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(result.current.failure).toBeNull();
    await act(async () => void (await result.current.reportFailure()));
    expect(mint).toHaveBeenCalledTimes(3);
    expect(result.current.failure).toEqual({ host: true });
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a re-mint that answers the very URL that failed is the second failure — nothing waits for a reload", async () => {
    vi.useFakeTimers();
    const same = filesUrl("thumb", ID.heic, "thumb-bucket", 1280);
    const { source, mint } = publicSource(async () => ({
      url: same,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
    const { result } = renderHook(() => usePreviewUrl(source, ID.heic, "thumb", 1280));
    await advance(0);
    expect(result.current.url).toBe(same);
    let next: string | null = "";
    await act(async () => {
      next = await result.current.reportFailure();
    });
    expect(next).toBeNull();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(result.current.failure).toEqual({ host: true });
    expect(result.current.url).toBeNull();
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: a proactive refresh that answers the same URL is fine (nothing failed)", async () => {
    vi.useFakeTimers();
    const same = filesUrl("thumb", ID.heic, "thumb-bucket", 1280);
    const { source, mint } = publicSource(async () => ({
      url: same,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    }));
    const { result } = renderHook(() => usePreviewUrl(source, ID.heic, "thumb", 1280));
    await advance(0);
    await advance(480_000);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(result.current.url).toBe(same);
    expect(result.current.failure).toBeNull();
  });

  it("a refused mint is final at once: no second mint, no retry, no timer", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource(async () => {
      throw new Error("password_required");
    });
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(result.current.failure).toEqual({});
    await act(async () => void (await result.current.reportFailure()));
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the re-mint after a failure being refused is final too — exactly one call after the failure", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const { source, mint } = publicSource(async (nodeId) => {
      calls += 1;
      if (calls > 1) throw new Error("password_required");
      return {
        url: filesUrl("inline", nodeId, "pub-1"),
        expiresAt: new Date(Date.now() + INLINE_MS).toISOString(),
      };
    });
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    let next: string | null = "";
    await act(async () => {
      next = await result.current.reportFailure();
    });
    expect(next).toBeNull();
    expect(mint).toHaveBeenCalledTimes(2);
    expect(result.current.failure).toEqual({});
    await act(async () => void (await result.current.reportFailure()));
    await advance(10 * INLINE_MS);
    expect(mint).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("signed-in source: a refused mint carries the API's request id; the kind asked for is `inline`", async () => {
    const network = installFetch({
      api: (call) =>
        call.url.pathname.endsWith("/download-url") ? envelope("scan_blocked", 403) : undefined,
    });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.png, "inline"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.failure).toEqual({ requestId: "req-1234", notFound: false });
    expect(network.api("/api/nodes/").map((call) => [call.method, call.url.pathname, call.body])).toEqual([
      ["POST", `/api/nodes/${ID.png}/download-url`, { kind: "inline" }],
    ]);
  });

  it("signed-in source: a thumbnail is asked for by size", async () => {
    const api = ownerApi([NODES.heic]);
    const network = installFetch({ api: api.handler });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.heic, "thumb", 1280));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(result.current.url).toBe(filesUrl("thumb", ID.heic, "thumb-bucket", 1280));
    expect(network.api("/api/nodes/").map((call) => call.url.pathname + call.url.search)).toEqual([
      `/api/nodes/${ID.heic}/thumb-url?size=1280`,
    ]);
  });
});

describe("fetchPreview — a fetch to the files host", () => {
  const BODIES = [
    "You don't have access to this file.",
    "This file is blocked.",
    "This link has expired or is not valid.",
    "",
  ];

  it.each(BODIES)(
    "a 403 saying %j → exactly one re-mint and one retry, then the failure; the body is never read",
    async (text) => {
      const refusals = [unreadable(403), unreadable(403)];
      void text;
      const fetched: string[] = [];
      installFetch({
        files: (call) => {
          fetched.push(call.url.href);
          return refusals[fetched.length - 1]!.response;
        },
      });
      const { source, mint } = publicSource();
      const { result } = renderHook(() => usePreviewUrl(source, ID.ts, "inline"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      let response: Response | null | undefined;
      await act(async () => {
        response = await fetchPreview(result.current.url!, result.current, new AbortController().signal);
      });
      expect(response).toBeNull();
      expect(fetched).toEqual([filesUrl("inline", ID.ts, "pub-1"), filesUrl("inline", ID.ts, "pub-2")]);
      expect(mint).toHaveBeenCalledTimes(2);
      expect(result.current.failure).toEqual({ host: true });
      for (const refusal of refusals) expect(refusal.read).not.toHaveBeenCalled();
    },
  );

  it("a 403 and then a 200 on the fresh URL → the response, no failure", async () => {
    let count = 0;
    installFetch({
      files: () => {
        count += 1;
        return count === 1 ? unreadable(403).response : new Response("hello", { status: 200 });
      },
    });
    const { source, mint } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.ts, "inline"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    let response: Response | null = null;
    await act(async () => {
      response = await fetchPreview(result.current.url!, result.current, new AbortController().signal);
    });
    expect(await response!.text()).toBe("hello");
    expect(mint).toHaveBeenCalledTimes(2);
    expect(count).toBe(2);
    expect(result.current.failure).toBeNull();
  });

  it.each([404, 409, 410, 423, 429, 500])(
    "a %i is final without another mint (no fresh URL would change it)",
    async (status) => {
      const refusal = unreadable(status);
      const network = installFetch({ files: () => refusal.response });
      const { source, mint } = publicSource();
      const { result } = renderHook(() => usePreviewUrl(source, ID.ts, "inline"));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      await act(async () => {
        await fetchPreview(result.current.url!, result.current, new AbortController().signal);
      });
      expect(mint).toHaveBeenCalledTimes(1);
      expect(network.files().length).toBe(1);
      expect(result.current.failure).toEqual({ host: true });
      expect(refusal.read).not.toHaveBeenCalled();
    },
  );

  it("a request that never gets an answer is a failure, not an exception", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    const { source } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.ts, "inline"));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      expect(
        await fetchPreview(result.current.url!, result.current, new AbortController().signal),
      ).toBeNull();
    });
    expect(result.current.failure).toEqual({ host: true });
  });

  it("the request carries no cookie and is a CORS request", async () => {
    const seen: RequestInit[] = [];
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init);
      return new Response("x");
    });
    const preview = { reportFailure: vi.fn(async () => null), fail: vi.fn() };
    await fetchPreview(filesUrl("inline", ID.ts, "t"), preview, new AbortController().signal);
    expect(seen.map((init) => [init.mode, init.credentials, init.method ?? "GET"])).toEqual([
      ["cors", "omit", "GET"],
    ]);
  });
});
