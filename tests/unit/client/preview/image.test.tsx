// Images: the inline URL in an <img>, the blur-up from the 320 thumbnail, and HEIC through its
// 1280 thumbnail only.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PreviewItem, PublicPreviewSource } from "../../../../src/client/components/slots";
import { PreviewDialog } from "../../../../src/client/features/preview";
import ImagePreview from "../../../../src/client/features/preview/renderers/ImagePreview";
import type { NodeDto } from "../../../../src/shared/schemas/node";
import { intersect } from "../shell/helpers";
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
} from "./helpers";

setupPreview();

const noop = () => {};
const main = () =>
  dialog()!.querySelector<HTMLImageElement>('[data-preview-renderer] img[alt]:not([alt=""])');

async function openOwner(node: NodeDto, extra?: Parameters<typeof ownerApi>[1]) {
  await preloadRenderers();
  const api = ownerApi([node], extra);
  const network = installFetch({ api: api.handler });
  renderPreview(<PreviewDialog open nodeId={node.id} onClose={noop} source="owner" />);
  await screen.findByText(node.name);
  await waitFor(() => expect(renderer()).not.toBeNull());
  await settle();
  return { api, network };
}

describe("ImagePreview", () => {
  it("shows the inline URL in an <img>, with the 320 thumbnail as the blur-up until it has loaded", async () => {
    const { api } = await openOwner(NODES.png);
    intersect();
    await settle();
    expect(renderer()).toBe("image");
    expect(api.minted.map((mint) => [mint.kind, mint.size])).toEqual([
      ["inline", undefined],
      ["thumb", 320],
    ]);
    const img = main()!;
    expect(img.getAttribute("src")).toBe(api.minted[0]!.url);
    expect(img.alt).toBe("sample.png");
    expect(dialog()!.querySelector('[data-preview-blurup="thumb"] img')!.getAttribute("src")).toBe(
      api.minted[1]!.url,
    );
    fireEvent.load(img);
    expect(dialog()!.querySelector("[data-preview-blurup]")).toBeNull();
  });

  it("once the image has loaded nothing is minted again, however long it stays open", async () => {
    vi.useFakeTimers();
    const node = nodeOf({ thumb: false });
    const api = ownerApi([node]);
    installFetch({ api: api.handler });
    const view = renderPreview(<ImagePreview source="owner" item={loadedOf(node)} variant="inline" />);
    await advance(0);
    fireEvent.load(view.container.querySelector("img")!);
    await advance(60 * 60_000);
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("control: an image that never loads keeps its URL fresh (one mint per period)", async () => {
    vi.useFakeTimers();
    const node = nodeOf({ thumb: false });
    const api = ownerApi([node]);
    installFetch({ api: api.handler });
    renderPreview(<ImagePreview source="owner" item={loadedOf(node)} variant="inline" />);
    await advance(0);
    await advance(60 * 60_000);
    expect(api.minted.length).toBe(1 + Math.floor((60 * 60_000) / 720_000));
  });

  it.each([
    ["image/avif", "avif"],
    ["image/bmp", "bmp"],
  ])(
    "%s with thumb: false → the inline URL directly, the skeleton, and no thumbnail request",
    async (type, ext) => {
      const node = nodeOf({ name: `photo.${ext}`, ext, mimeSniffed: type, thumb: false });
      const { api, network } = await openOwner(node);
      intersect();
      await settle();
      expect(renderer()).toBe("image");
      expect(main()!.getAttribute("src")).toBe(api.minted[0]!.url);
      expect(api.minted.map((mint) => mint.kind)).toEqual(["inline"]);
      expect(dialog()!.querySelector('[data-preview-blurup="skeleton"]')).not.toBeNull();
      expect(network.api().some((call) => call.url.pathname.endsWith("/thumb-url"))).toBe(false);
    },
  );

  it("an image that fails to load is re-minted once; a second failure is the error state, with no request id", async () => {
    const { api } = await openOwner(nodeOf({ thumb: false }));
    fireEvent.error(main()!);
    await settle();
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline", "inline"]);
    expect(main()!.getAttribute("src")).toBe(api.minted[1]!.url);
    fireEvent.error(main()!);
    await settle();
    expect(state()).toBe("error");
    expect(api.minted.length).toBe(2);
    expect(within(dialog()!).queryByText(/^req /)).toBeNull();
    // The file itself can still be had.
    expect(within(dialog()!).getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(0);
  });

  it("a refused mint is the error state with the API's request id", async () => {
    await openOwner(nodeOf({ thumb: false }), (call) =>
      call.url.pathname.endsWith("/download-url") ? envelope("forbidden", 403) : undefined,
    );
    await waitFor(() => expect(state()).toBe("error"));
    expect(within(dialog()!).getByText("req req-1234")).toBeTruthy();
  });

  it("Fit is the starting view; 1:1 and the zoom buttons change it", async () => {
    await openOwner(nodeOf({ thumb: false }));
    const fit = screen.getByRole("button", { name: "Fit" });
    const actual = screen.getByRole("button", { name: "1:1" });
    expect((fit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.load(main()!);
    expect(fit.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(actual);
    expect(actual.getAttribute("aria-pressed")).toBe("true");
    expect(fit.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(actual.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(fit);
    expect(fit.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("ImagePreview for HEIC / HEIF", () => {
  it.each(["image/heic", "image/heif"])(
    "%s with thumb: true → the 1280 thumbnail, and NO inline URL",
    async (type) => {
      const { api, network } = await openOwner(nodeOf({ ...NODES.heic, mimeSniffed: type }));
      intersect();
      await settle();
      expect(renderer()).toBe("heic");
      expect(api.minted.filter((mint) => mint.kind !== "thumb")).toEqual([]);
      expect(api.minted.map((mint) => mint.size).sort()).toEqual([1280, 320]);
      expect(main()!.getAttribute("src")).toBe(filesUrl("thumb", ID.heic, "tok-1", 1280));
      expect(screen.getByText("Original is HEIC — download for full quality")).toBeTruthy();
      expect(network.api().some((call) => call.url.pathname.endsWith("/download-url"))).toBe(false);
    },
  );

  it("the skeleton holds for as long as the thumbnail is pending — no client-side timeout", async () => {
    await preloadRenderers();
    vi.useFakeTimers();
    const api = ownerApi([NODES.heic]);
    installFetch({ api: api.handler });
    renderPreview(<PreviewDialog open nodeId={ID.heic} onClose={noop} source="owner" />);
    await advance(0);
    await advance(0);
    await advance(30_000);
    expect(renderer()).toBe("heic");
    expect(dialog()!.querySelector("[data-preview-blurup]")).not.toBeNull();
    expect(state()).toBeNull();
  });

  it("thumb: false (too large for the image service) → NoPreview at once, no thumbnail request", async () => {
    const { api, network } = await openOwner(nodeOf({ ...NODES.heic, size: 20_000_001, thumb: false }));
    intersect();
    await settle();
    expect(renderer()).toBe("none");
    expect(api.minted).toEqual([]);
    expect(network.api().some((call) => /thumb-url|download-url/.test(call.url.pathname))).toBe(false);
    expect(screen.getByText("No preview for this photo — download to see it")).toBeTruthy();
    expect(within(dialog()!).getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(0);
  });

  it("a 404 for the thumbnail → NoPreview (not an error), with Download", async () => {
    const { api } = await openOwner(NODES.heic);
    // The files host answers 404: the <img> reports an error, twice (one fresh URL in between).
    fireEvent.error(main()!);
    await settle();
    fireEvent.error(main()!);
    await settle();
    expect(renderer()).toBe("none");
    expect(state()).toBeNull();
    expect(api.minted.filter((mint) => mint.size === 1280).length).toBe(2);
    expect(api.minted.some((mint) => mint.kind === "inline")).toBe(false);
    expect(screen.getByText("No preview for this photo — download to see it")).toBeTruthy();
  });
});

describe("images from a public source", () => {
  function publicSource(item: PreviewItem) {
    let count = 0;
    return {
      getItem: vi.fn(async () => item),
      getUrl: vi.fn<PublicPreviewSource["getUrl"]>(async (nodeId, kind, size) => {
        count += 1;
        return {
          url: filesUrl(kind, nodeId, `pub-${count}`, size),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
        };
      }),
    };
  }
  const bare = (node: NodeDto): PreviewItem => ({
    id: node.id,
    name: node.name,
    size: node.size,
    mimeCategory: node.mimeCategory,
    ext: node.ext,
    mimeSniffed: node.mimeSniffed,
  });

  async function openPublic(item: PreviewItem) {
    await preloadRenderers();
    const network = installFetch();
    const source = publicSource(item);
    renderPreview(<PreviewDialog open nodeId={item.id} onClose={noop} source={source} />);
    await screen.findByText(item.name);
    await waitFor(() => expect(renderer()).not.toBeNull());
    intersect();
    await settle();
    return { source, network };
  }

  it("a PNG without `thumb` → the inline URL, and no blur-up request", async () => {
    const { source, network } = await openPublic(bare(NODES.png));
    expect(renderer()).toBe("image");
    expect(source.getUrl.mock.calls).toEqual([[ID.png, "inline", undefined]]);
    expect(main()!.getAttribute("src")).toBe(filesUrl("inline", ID.png, "pub-1"));
    expect(network.calls).toEqual([]);
  });

  it("a PNG with `thumb: true` → the blur-up comes through the source too", async () => {
    const { source, network } = await openPublic({ ...bare(NODES.png), thumb: true });
    expect(source.getUrl.mock.calls).toEqual([
      [ID.png, "inline", undefined],
      [ID.png, "thumb", 320],
    ]);
    expect(network.calls).toEqual([]);
  });

  it("a HEIC without `thumb` → NoPreview, no thumbnail request", async () => {
    const { source, network } = await openPublic(bare(NODES.heic));
    expect(renderer()).toBe("none");
    expect(source.getUrl).not.toHaveBeenCalled();
    expect(network.calls).toEqual([]);
  });

  it("a HEIC with `thumb: true` → its 1280 thumbnail through the source, never `inline`", async () => {
    const { source, network } = await openPublic({ ...bare(NODES.heic), thumb: true });
    expect(renderer()).toBe("heic");
    expect(source.getUrl.mock.calls.map(([, kind, size]) => [kind, size]).sort()).toEqual([
      ["thumb", 1280],
      ["thumb", 320],
    ]);
    expect(network.calls).toEqual([]);
  });
});
