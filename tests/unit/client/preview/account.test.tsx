// Late work across an account change: after the account's state is purged (sign-out, another
// identity) nothing the preview had under way asks, writes or shows anything.
import { act, fireEvent, renderHook, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getToasts } from "../../../../src/client/components/Toaster";
import { PreviewDialog } from "../../../../src/client/features/preview";
import { SCAN_POLL_MS } from "../../../../src/client/features/preview/useItem";
import { usePreviewUrl } from "../../../../src/client/features/preview/usePreviewUrl";
import { purgeUserState } from "../../../../src/client/lib/query";
import { ID, NODES, nodeOf } from "./fixtures";
import {
  advance,
  dialog,
  envelope,
  installFetch,
  json,
  ownerApi,
  preloadRenderers,
  renderPreview,
  renderer,
  setupPreview,
  settle,
  state,
} from "./helpers";

setupPreview();

const noop = () => {};
const purge = () => act(async () => void (await purgeUserState()));

/** A response the test releases when it chooses. */
function held<T>() {
  let release!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("a purge of the account while the preview has work under way", () => {
  it("a mint still on its way: its URL is never published, and no refresh is ever scheduled", async () => {
    vi.useFakeTimers();
    const gate = held<Response>();
    const api = ownerApi([NODES.mp4]);
    let mints = 0;
    const network = installFetch({
      api: async (call) => {
        if (!call.url.pathname.endsWith("/download-url")) return api.handler(call);
        mints += 1;
        await gate.promise;
        return api.handler(call);
      },
    });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    expect(mints).toBe(1);
    await purge();
    gate.release(new Response());
    await advance(0);
    expect(result.current.url).toBeNull();
    expect(result.current.failure).toBeNull();
    await advance(10 * 900_000);
    expect(mints).toBe(1);
    expect(network.files()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a refresh timer and its retries: after the purge they ask for nothing", async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler });
    const { result } = renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    expect(api.minted.length).toBe(1);
    await purge();
    await advance(10 * 900_000);
    expect(api.minted.length).toBe(1);
    // And a failure reported by an element that is still on the page mints nothing either.
    await act(async () => void (await result.current.reportFailure()));
    expect(api.minted.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: without a purge the same clock does refresh", async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler });
    renderHook(() => usePreviewUrl("owner", ID.mp4, "inline"));
    await advance(0);
    await advance(720_000);
    expect(api.minted.length).toBe(2);
  });

  it("the scan poll: no further read of the node", async () => {
    vi.useFakeTimers();
    const pending = nodeOf({ scanStatus: "pending" });
    const network = installFetch({ api: ownerApi([pending]).handler });
    renderPreview(<PreviewDialog open nodeId={ID.png} onClose={noop} source="owner" />);
    await advance(0);
    expect(state()).toBe("scanning");
    const before = network.api(`/api/nodes/${ID.png}`).length;
    await purge();
    await advance(6 * SCAN_POLL_MS);
    expect(network.api(`/api/nodes/${ID.png}`).length).toBe(before);
  });

  it("a node read still on its way: its answer is not shown", async () => {
    const gate = held<null>();
    const api = ownerApi([NODES.svg]);
    installFetch({
      api: async (call) => {
        if (call.url.pathname === `/api/nodes/${ID.svg}`) await gate.promise;
        return api.handler(call);
      },
    });
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />);
    await waitFor(() => expect(state()).toBe("loading"));
    await purge();
    gate.release(null);
    await settle(20);
    expect(screen.queryByText("sample.svg")).toBeNull();
    expect(renderer()).toBeNull();
  });

  it("text bytes still on their way: they are dropped — nothing of the file is drawn or highlighted", async () => {
    await preloadRenderers();
    const gate = held<Response>();
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => gate.promise });
    renderPreview(<PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />);
    await waitFor(() => expect(api.minted.length).toBe(1));
    await settle(10);
    await purge();
    gate.release(new Response("const secret = 1;\n"));
    await settle(50);
    expect(dialog()!.querySelector("pre")).toBeNull();
    expect(document.body.textContent).not.toContain("secret");
    expect(api.minted.length).toBe(1);
  });

  it("a Download still being minted: no download starts and nothing is said", async () => {
    const gate = held<null>();
    const api = ownerApi([NODES.svg]);
    let refuse = false;
    installFetch({
      api: async (call) => {
        if (!call.url.pathname.endsWith("/download-url")) return api.handler(call);
        await gate.promise;
        return refuse ? envelope("scan_blocked", 403) : api.handler(call);
      },
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const view = renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />);
    await screen.findByText("sample.svg");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await settle(5);
    await purge();
    gate.release(null);
    await settle(20);
    expect(click).not.toHaveBeenCalled();
    view.unmount();

    // The same with a refusal: no toast for the account that is gone.
    refuse = true;
    const second = held<null>();
    installFetch({
      api: async (call) => {
        if (!call.url.pathname.endsWith("/download-url")) return api.handler(call);
        await second.promise;
        return envelope("scan_blocked", 403);
      },
    });
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />);
    await screen.findByText("sample.svg");
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    await settle(5);
    await purge();
    second.release(null);
    await settle(20);
    expect(getToasts()).toEqual([]);
    expect(click).not.toHaveBeenCalled();
  });

  it("the folder listing for prev/next stops at the page it was on", async () => {
    const gate = held<null>();
    const api = ownerApi([NODES.svg]);
    let pages = 0;
    installFetch({
      api: async (call) => {
        if (!call.url.pathname.endsWith("/children")) return api.handler(call);
        pages += 1;
        await gate.promise;
        return json({ items: [], nextCursor: "more" });
      },
    });
    renderPreview(<PreviewDialog open nodeId={ID.svg} onClose={noop} onNavigate={noop} source="owner" />);
    await screen.findByText("sample.svg");
    await waitFor(() => expect(pages).toBe(1));
    await purge();
    gate.release(null);
    await settle(30);
    expect(pages).toBe(1);
  });
});
