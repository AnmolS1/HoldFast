// Video and audio: the element plays from an inline URL that is replaced before it expires and
// once after it failed — at the same position, still playing if it was.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PreviewItem, PublicPreviewSource } from "../../../../src/client/components/slots";
import { PreviewDialog } from "../../../../src/client/features/preview";
import MediaPreview from "../../../../src/client/features/preview/renderers/MediaPreview";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { filesUrl, ID, NODES, nodeOf } from "./fixtures";
import {
  advance,
  dialog,
  envelope,
  installFetch,
  loadedOf,
  ownerApi,
  preloadRenderers,
  renderPreview,
  renderer,
  setupPreview,
  settle,
  state,
  unreadable,
} from "./helpers";

setupPreview();

const noop = () => {};
const REFRESH_MS = 720_000;

/** Put the element in a state a browser would have reached: jsdom plays nothing. */
function setPlayback(
  media: HTMLMediaElement,
  values: { currentTime?: number; paused?: boolean; playbackRate?: number; error?: { code: number } | null },
) {
  for (const [name, value] of Object.entries(values)) {
    Object.defineProperty(media, name, { configurable: true, writable: true, value });
  }
}

function fail(media: HTMLMediaElement, code = 4) {
  setPlayback(media, { error: { code } });
  fireEvent.error(media);
}

function loadMetadata(media: HTMLMediaElement) {
  setPlayback(media, { error: null });
  fireEvent.loadedMetadata(media);
}

describe("MediaPreview — which element", () => {
  it.each([
    [NODES.mp4, "video"],
    [nodeOf({ ...NODES.mp4, name: "clip.m4v", ext: "m4v", mimeSniffed: "video/x-m4v" }), "video"],
    [NODES.m4a, "audio"],
    [nodeOf({ ...NODES.m4a, name: "song.mp3", ext: "mp3", mimeSniffed: "audio/mpeg" }), "audio"],
  ] as Array<[NodeDto, "video" | "audio"]>)(
    "%o → <%s controls preload=metadata> on an inline URL",
    async (node, tag) => {
      await preloadRenderers();
      const api = ownerApi([node]);
      installFetch({ api: api.handler });
      renderPreview(<PreviewDialog open nodeId={node.id} onClose={noop} source="owner" />);
      await screen.findByText(node.name);
      await waitFor(() => expect(renderer()).toBe(tag));
      await settle();
      const media = dialog()!.querySelector<HTMLMediaElement>(tag)!;
      expect(media).not.toBeNull();
      expect(media.controls).toBe(true);
      expect(media.getAttribute("preload")).toBe("metadata");
      expect(media.getAttribute("src")).toBe(api.minted[0]!.url);
      expect(api.minted.map((mint) => mint.kind)).toEqual(["inline"]);
      expect(dialog()!.querySelector(tag === "video" ? "audio" : "video")).toBeNull();
    },
  );
});

describe("MediaPreview — proactive refresh", () => {
  it("a twenty-minute film: one mint per period, and the swap keeps position, rate and playing", async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await advance(0);
    const video = view.container.querySelector("video")!;
    expect(video.getAttribute("src")).toBe(filesUrl("inline", ID.mp4, "tok-1"));
    loadMetadata(video);

    // Twelve minutes in, playing at 1.5×.
    await advance(REFRESH_MS - 1);
    expect(api.minted.length).toBe(1);
    setPlayback(video, { currentTime: 719.5, paused: false, playbackRate: 1.5 });
    await advance(1);
    expect(api.minted.length).toBe(2);
    expect(video.getAttribute("src")).toBe(filesUrl("inline", ID.mp4, "tok-2"));

    // The new source starts at zero and paused, as an element does.
    setPlayback(video, { currentTime: 0, paused: true, playbackRate: 1 });
    loadMetadata(video);
    expect(video.currentTime).toBe(719.5);
    expect(video.playbackRate).toBe(1.5);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);

    // Minute 20: no further mint yet (the next is due at minute 24).
    await advance(20 * 60_000 - REFRESH_MS);
    expect(api.minted.length).toBe(2);
    expect(api.minted.every((mint) => mint.kind === "inline")).toBe(true);
  });

  it("a paused film stays paused across the swap", async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await advance(0);
    const video = view.container.querySelector("video")!;
    loadMetadata(video);
    setPlayback(video, { currentTime: 42, paused: true });
    await advance(REFRESH_MS);
    setPlayback(video, { currentTime: 0 });
    loadMetadata(video);
    expect(video.currentTime).toBe(42);
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it("leaving stops the element and the refresh", async () => {
    vi.useFakeTimers();
    const api = ownerApi([NODES.mp4]);
    installFetch({ api: api.handler });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await advance(0);
    const video = view.container.querySelector("video")!;
    view.unmount();
    expect(HTMLMediaElement.prototype.pause).toHaveBeenCalled();
    expect(video.hasAttribute("src")).toBe(false);
    await advance(10 * REFRESH_MS);
    expect(api.minted.length).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("MediaPreview — reactive refresh", () => {
  async function playing() {
    const api = ownerApi([NODES.mp4]);
    const probes: string[] = [];
    let probe = () => unreadable(403).response;
    const network = installFetch({
      api: api.handler,
      files: (call) => {
        probes.push(`${call.method} ${call.url.pathname}`);
        return probe();
      },
    });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await settle();
    const video = view.container.querySelector("video")!;
    loadMetadata(video);
    setPlayback(video, { currentTime: 300, paused: false, playbackRate: 1 });
    fireEvent.timeUpdate(video);
    return {
      api,
      network,
      probes,
      video,
      view,
      setProbe: (next: () => Response) => {
        probe = next;
      },
    };
  }

  it("an error mints once more and resumes where it was", async () => {
    const { api, video } = await playing();
    fail(video);
    await settle();
    expect(api.minted.length).toBe(2);
    expect(video.getAttribute("src")).toBe(api.minted[1]!.url);
    setPlayback(video, { currentTime: 0, paused: true });
    loadMetadata(video);
    expect(video.currentTime).toBe(300);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
  });

  it("a second error on a URL the files host refuses → the error state, no third mint, no request id", async () => {
    const { api, video, view, probes } = await playing();
    fail(video);
    await settle();
    fail(video);
    await settle();
    expect(view.container.querySelector('[data-preview-state="error"]')).not.toBeNull();
    expect(api.minted.length).toBe(2);
    // One question to the files host about the fresh URL, by status alone.
    expect(probes).toEqual([`HEAD /i/${ID.mp4}/tok-2`]);
    expect(within(view.container).queryByText(/^req /)).toBeNull();
  });

  it("a second error on a URL the files host serves → the browser cannot play it: say so, offer Download", async () => {
    const { api, video, view, setProbe } = await playing();
    setProbe(() => new Response(null, { status: 200 }));
    fail(video);
    await settle();
    fail(video);
    await settle();
    expect(within(view.container).getByText("Your browser can't play this — download")).toBeTruthy();
    expect(view.container.querySelector('[data-preview-state="error"]')).toBeNull();
    expect(view.container.querySelector("video")).toBeNull();
    expect(api.minted.length).toBe(2);
  });

  it("a file that fails at the same place every time: 25 errors after metadata → exactly 2 mints, then it ends", async () => {
    const { api, video, view, probes } = await playing();
    // Each fresh URL loads its metadata, is sent back to where playback was, and fails there again.
    for (let round = 0; round < 25; round += 1) {
      if (!video.isConnected) break;
      setPlayback(video, { error: { code: 3 } });
      fireEvent.error(video);
      await settle();
      if (video.isConnected) loadMetadata(video);
    }
    await settle(20);
    expect(api.minted.length).toBe(2);
    expect(view.container.querySelector("video")).toBeNull();
    expect(view.container.querySelector('[data-preview-state="error"]')).not.toBeNull();
    // One question to the files host, not one per error.
    expect(probes.length).toBe(1);
  });

  it('the same with a host that serves the bytes: 2 mints, then "can\'t play" — never a third', async () => {
    const { api, video, view, setProbe } = await playing();
    setProbe(() => new Response(null, { status: 200 }));
    for (let round = 0; round < 25; round += 1) {
      if (!video.isConnected) break;
      setPlayback(video, { error: { code: 3 } });
      fireEvent.error(video);
      await settle();
      if (video.isConnected) loadMetadata(video);
    }
    expect(api.minted.length).toBe(2);
    expect(within(view.container).getByText("Your browser can't play this — download")).toBeTruthy();
  });

  it("errors arriving while the files host is being asked do not ask it again", async () => {
    const { api, video, probes, setProbe } = await playing();
    setProbe(() => new Promise<Response>(() => {}) as unknown as Response);
    fail(video);
    await settle();
    fail(video);
    fail(video);
    fail(video);
    await settle();
    expect(probes.length).toBe(1);
    expect(api.minted.length).toBe(2);
  });
});

describe("MediaPreview — a proactive refresh that fails mid-play", () => {
  it("the film keeps playing on the URL it has; the refresh is tried again and then swapped in", async () => {
    vi.useFakeTimers();
    let mints = 0;
    const api = ownerApi([NODES.mp4], (call) => {
      if (!call.url.pathname.endsWith("/download-url")) return undefined;
      mints += 1;
      return mints === 2 ? envelope("internal", 503) : undefined;
    });
    installFetch({ api: api.handler });
    const view = renderPreview(<MediaPreview source="owner" item={loadedOf(NODES.mp4)} kind="video" />);
    await advance(0);
    const video = view.container.querySelector("video")!;
    loadMetadata(video);
    setPlayback(video, { currentTime: 700, paused: false });
    await advance(REFRESH_MS);
    expect(mints).toBe(2);
    // Nothing on screen changed: the same element, the same URL, no error state.
    expect(view.container.querySelector("video")).toBe(video);
    expect(video.getAttribute("src")).toBe(filesUrl("inline", ID.mp4, "tok-1"));
    expect(view.container.querySelector('[data-preview-state="error"]')).toBeNull();
    expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled();

    setPlayback(video, { currentTime: 715 });
    await advance(15_000);
    expect(mints).toBe(3);
    expect(video.getAttribute("src")).toBe(filesUrl("inline", ID.mp4, "tok-2"));
    setPlayback(video, { currentTime: 0, paused: true });
    loadMetadata(video);
    expect(video.currentTime).toBe(715);
  });
});

describe("MediaPreview — a public source whose password changed mid-view", () => {
  const item: PreviewItem = {
    id: ID.mp4,
    name: "sample.mp4",
    size: 56221,
    mimeCategory: "video",
    ext: "mp4",
    mimeSniffed: "video/mp4",
  };

  function publicSource(refuseAfter: number) {
    let count = 0;
    const getUrl = vi.fn<PublicPreviewSource["getUrl"]>(async (nodeId) => {
      count += 1;
      // The page's API answers `403 password_required`; the page rejects.
      if (count > refuseAfter) throw new Error("password_required");
      return {
        url: filesUrl("inline", nodeId, `pub-${count}`),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      };
    });
    const source: PublicPreviewSource = { getItem: vi.fn(async () => item), getUrl };
    return { source, getUrl };
  }

  it("the URL starts answering 403 and getUrl rejects → exactly one getUrl call after it, none later, the error state", async () => {
    vi.useFakeTimers();
    const network = installFetch();
    const { source, getUrl } = publicSource(1);
    const view = renderPreview(
      <MediaPreview source={source} item={loadedOf(nodeOf(NODES.mp4))} kind="video" />,
    );
    await advance(0);
    const video = view.container.querySelector("video")!;
    loadMetadata(video);
    setPlayback(video, { currentTime: 120, paused: false });
    fireEvent.timeUpdate(video);
    expect(getUrl).toHaveBeenCalledTimes(1);

    // The files host refuses the next Range request: the element reports an error.
    fail(video);
    await advance(0);
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-preview-state="error"]')).not.toBeNull();
    expect(view.container.querySelector("video")).toBeNull();
    // No retry loop, no proactive timer left running, no password field of its own.
    await advance(10 * 900_000);
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
    expect(network.calls).toEqual([]);
  });

  it("control: the same 403 with a getUrl that resolves resumes playback at the saved position", async () => {
    vi.useFakeTimers();
    installFetch();
    const { source, getUrl } = publicSource(Infinity);
    const view = renderPreview(
      <MediaPreview source={source} item={loadedOf(nodeOf(NODES.mp4))} kind="video" />,
    );
    await advance(0);
    const video = view.container.querySelector("video")!;
    loadMetadata(video);
    setPlayback(video, { currentTime: 120, paused: false });
    fireEvent.timeUpdate(video);

    fail(video);
    await advance(0);
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(video.getAttribute("src")).toBe(filesUrl("inline", ID.mp4, "pub-2"));
    setPlayback(video, { currentTime: 0, paused: true });
    loadMetadata(video);
    expect(video.currentTime).toBe(120);
    expect(HTMLMediaElement.prototype.play).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector('[data-preview-state="error"]')).toBeNull();
  });

  it("in the dialog: the same refusal shows the dialog's error state and asks the API nothing", async () => {
    await preloadRenderers();
    const network = installFetch();
    const { source, getUrl } = publicSource(1);
    renderPreview(<PreviewDialog open nodeId={ID.mp4} onClose={noop} source={source} />);
    await screen.findByText("sample.mp4");
    await waitFor(() => expect(renderer()).toBe("video"));
    await settle();
    const video = dialog()!.querySelector("video")!;
    act(() => loadMetadata(video));
    fail(video);
    await settle();
    expect(state()).toBe("error");
    expect(getUrl).toHaveBeenCalledTimes(2);
    expect(network.calls).toEqual([]);
  });
});
