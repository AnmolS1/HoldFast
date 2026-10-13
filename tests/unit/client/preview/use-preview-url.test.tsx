// Token freshness: a URL is re-minted at 80 % of its lifetime, once more after it failed, and
// never again after a mint was refused.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PublicPreviewSource } from "../../../../src/client/components/slots";
import {
  fetchPreview,
  refreshDelayMs,
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
    // Already past, or unreadable: the kind's lifetime is assumed.
    expect(refreshDelayMs(at(-5_000), "inline", now)).toBe(REFRESH_MS);
    expect(refreshDelayMs({ url: "u", expiresAt: "soon" }, "inline", now)).toBe(REFRESH_MS);
    expect(refreshDelayMs(at(INLINE_MS), "thumb", now)).toBe(600_000 * 0.8);
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

  it("a URL that worked again earns the next failure its own single retry", async () => {
    vi.useFakeTimers();
    const { source, mint } = publicSource();
    const { result } = renderHook(() => usePreviewUrl(source, ID.mp4, "inline"));
    await advance(0);
    await act(async () => void (await result.current.reportFailure()));
    act(() => result.current.loaded());
    await act(async () => void (await result.current.reportFailure()));
    expect(mint).toHaveBeenCalledTimes(3);
    expect(result.current.failure).toBeNull();
    await act(async () => void (await result.current.reportFailure()));
    expect(mint).toHaveBeenCalledTimes(3);
    expect(result.current.failure).toEqual({ host: true });
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
    expect(result.current.url).toBe(filesUrl("thumb", ID.heic, "tok-1", 1280));
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
