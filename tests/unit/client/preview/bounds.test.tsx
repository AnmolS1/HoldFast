// The bounds of the viewers that read a file themselves: how much they take, what happens to a
// file that is larger than it said, and that a transfer nobody is waiting for is stopped.
import { act, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { describe, expect, it, vi } from "vitest";
import { PreviewDialog } from "../../../../src/client/features/preview";
import { fetchLimitFor } from "../../../../src/client/features/preview/renderer-map";
import {
  MAX_CANVAS_PIXELS,
  PDF_MAX_PAGES,
  pixelRatioFor,
} from "../../../../src/client/features/preview/renderers/pdf-limits";
import { readLimited, TOO_LARGE } from "../../../../src/client/features/preview/usePreviewUrl";
import { PDF_PREVIEW_MAX_BYTES, PREVIEW_TEXT_MAX_BYTES } from "../../../../src/shared/constants";
import { ID, NODES, nodeOf, pageOf } from "./fixtures";
import {
  dialog,
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

const engine = vi.hoisted(() => ({ openPdf: vi.fn() }));
vi.mock("../../../../src/client/features/preview/renderers/pdf-engine", () => ({
  PdfLockedError: class PdfLockedError extends Error {},
  openPdf: engine.openPdf,
}));

setupPreview();

const noop = () => {};

/** A body that hands out the SAME chunk again and again and records what was taken from it. */
function endless(chunkBytes: number, chunks: number) {
  const chunk = new Uint8Array(chunkBytes);
  const taken = { chunks: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (taken.chunks >= chunks) return controller.close();
        taken.chunks += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        taken.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { body, taken };
}

describe("readLimited", () => {
  it("under and exactly at the limit: the bytes, in order", async () => {
    const bytes = Uint8Array.from({ length: 1000 }, (_, index) => index % 251);
    expect(await readLimited(new Response(bytes), 1000)).toEqual(bytes);
    expect(await readLimited(new Response(bytes), 5000)).toEqual(bytes);
    expect(await readLimited(new Response(new Uint8Array(0)), 10)).toEqual(new Uint8Array(0));
  });

  it("a Content-Length above the limit is refused before a byte is read, and the transfer cancelled", async () => {
    const { body, taken } = endless(1000, 50);
    const response = new Response(body, { headers: { "content-length": "50000" } });
    expect(await readLimited(response, 10_000)).toBe(TOO_LARGE);
    expect(taken.chunks).toBe(0);
    expect(taken.cancelled).toBe(true);
  });

  it.each([
    ["no Content-Length", {}],
    ["a Content-Length that lies", { "content-length": "10" }],
    ["a Content-Length that is not a number", { "content-length": "many" }],
  ])(
    "%s: it stops as soon as more than the limit has arrived, and cancels the rest",
    async (_name, headers) => {
      const { body, taken } = endless(1000, 5000);
      expect(await readLimited(new Response(body, { headers }), 10_000)).toBe(TOO_LARGE);
      // Ten chunks fit; the eleventh is the proof — nothing after it is taken.
      expect(taken.chunks).toBe(11);
      expect(taken.cancelled).toBe(true);
    },
  );

  it("control: the same stream within the limit is read to its end", async () => {
    const { body, taken } = endless(1000, 10);
    const all = await readLimited(new Response(body), 10_000);
    expect(all).not.toBe(TOO_LARGE);
    expect((all as Uint8Array).byteLength).toBe(10_000);
    expect(taken.cancelled).toBe(false);
  });

  it("each viewer's limit is the product's", () => {
    expect(fetchLimitFor("text")).toBe(PREVIEW_TEXT_MAX_BYTES);
    expect(fetchLimitFor("pdf")).toBe(PDF_PREVIEW_MAX_BYTES);
  });
});

describe("a file larger than it said", () => {
  it("text: more than the limit arrives → the transfer is cut and it says too large — nothing is shown", async () => {
    await preloadRenderers();
    // The node claims 234 bytes; the files host sends megabytes.
    const { body, taken } = endless(65_536, 10_000);
    const api = ownerApi([NODES.ts]);
    installFetch({ api: api.handler, files: () => new Response(body) });
    renderPreview(<PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />);
    await screen.findByText("Too large to preview — download");
    expect(renderer()).toBe("none");
    expect(taken.chunks).toBe(Math.floor(PREVIEW_TEXT_MAX_BYTES / 65_536) + 1);
    expect(taken.cancelled).toBe(true);
    expect(dialog()!.querySelector("pre")).toBeNull();
    expect(within(dialog()!).getAllByRole("button", { name: "Download" }).length).toBeGreaterThan(0);
    // No re-mint, no retry: a fresh URL would serve the same bytes.
    expect(api.minted.length).toBe(1);
  });

  it("PDF: more than the limit arrives → cut, too large, and pdf.js is never given a byte", async () => {
    const { body, taken } = endless(1_048_576, 10_000);
    const api = ownerApi([NODES.pdf]);
    installFetch({ api: api.handler, files: () => new Response(body) });
    renderPreview(<PreviewDialog open nodeId={ID.pdf} onClose={noop} source="owner" />);
    await screen.findByText("Too large to preview — download", undefined, { timeout: 20_000 });
    expect(taken.chunks).toBe(Math.floor(PDF_PREVIEW_MAX_BYTES / 1_048_576) + 1);
    expect(taken.cancelled).toBe(true);
    expect(engine.openPdf).not.toHaveBeenCalled();
    expect(api.minted.length).toBe(1);
  }, 30_000);

  it("a PDF or an image whose size is above the limit is never asked for at all", async () => {
    await preloadRenderers();
    for (const node of [
      nodeOf({ ...NODES.pdf, size: 50_000_001 }),
      nodeOf({ ...NODES.png, size: 50_000_001, thumb: false }),
    ]) {
      const api = ownerApi([node]);
      const network = installFetch({ api: api.handler });
      const view = renderPreview(<PreviewDialog open nodeId={node.id} onClose={noop} source="owner" />);
      await screen.findByText("Too large to preview — download");
      await settle(10);
      expect(api.minted).toEqual([]);
      expect(network.files()).toEqual([]);
      view.unmount();
    }
  });
});

describe("a transfer nobody is waiting for is stopped", () => {
  it.each([
    ["text", NODES.ts],
    ["PDF", NODES.pdf],
  ])("%s: closing the preview aborts the fetch in flight", async (_name, node) => {
    await preloadRenderers();
    const api = ownerApi([node]);
    const network = installFetch({ api: api.handler, files: () => new Promise<Response>(() => {}) });
    const view = renderPreview(<PreviewDialog open nodeId={node.id} onClose={noop} source="owner" />);
    await waitFor(() => expect(network.files().length).toBe(1));
    const signal = network.files()[0]!.signal!;
    expect(signal.aborted).toBe(false);
    view.unmount();
    expect(signal.aborted).toBe(true);
  });

  it("moving to the next file aborts the fetch of the last one, and shows none of its failure", async () => {
    await preloadRenderers();
    const api = ownerApi([NODES.ts, NODES.svg]);
    const network = installFetch({ api: api.handler, files: () => new Promise<Response>(() => {}) });
    const view = renderPreview(<PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />);
    await waitFor(() => expect(network.files().length).toBe(1));
    const signal = network.files()[0]!.signal!;
    act(() => {
      view.rerender(<PreviewDialog open nodeId={ID.svg} onClose={noop} source="owner" />);
    });
    await screen.findByText("sample.svg");
    expect(signal.aborted).toBe(true);
    expect(state()).toBeNull();
    expect(renderer()).toBe("none");
  });
});

describe("the PDF viewer's page and pixel caps", () => {
  it("a canvas never exceeds the pixel cap, whatever the page's size — there is no floor", () => {
    for (const [width, height, device] of [
      [612, 792, 1],
      [612, 792, 2],
      [612 * 4, 792 * 4, 2],
      [20_000, 20_000, 1],
      [20_000, 20_000, 3],
      [200_000, 200_000, 2],
      [14_400, 100, 2],
    ] as const) {
      const ratio = pixelRatioFor(width, height, device);
      const pixels = Math.floor(width * ratio) * Math.floor(height * ratio);
      expect(pixels, `${width}×${height}@${device}`).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
      expect(ratio).toBeGreaterThan(0);
      expect(ratio).toBeLessThanOrEqual(2);
    }
    // An ordinary page on an ordinary screen is drawn at the screen's own density.
    expect(pixelRatioFor(612, 792, 2)).toBe(2);
    expect(pixelRatioFor(612, 792, 1)).toBe(1);
    expect(pixelRatioFor(612, 792, 0)).toBe(1);
  });

  it("the page cap is 500", () => {
    expect(PDF_MAX_PAGES).toBe(500);
  });
});

describe("one view of a file is one of everything", () => {
  it("under StrictMode's double mount: one node read, one mint, one fetch — and the text shows", async () => {
    await preloadRenderers();
    const api = ownerApi([NODES.ts]);
    const network = installFetch({ api: api.handler, files: () => new Response("const a = 1;\n") });
    renderPreview(
      <StrictMode>
        <PreviewDialog open nodeId={ID.ts} onClose={noop} source="owner" />
      </StrictMode>,
    );
    await waitFor(() => expect(dialog()?.querySelector("pre")?.textContent).toBe("const a = 1;"));
    await settle(20);
    expect(network.api(`/api/nodes/${ID.ts}`).filter((call) => call.method === "GET").length).toBe(1);
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline"]);
    expect(network.files().length).toBe(1);
  });

  it("under StrictMode a cold link lists the folder once", async () => {
    const api = ownerApi([NODES.svg], (call) =>
      call.url.pathname.endsWith("/children") ? json(pageOf([NODES.svg, NODES.html])) : undefined,
    );
    const network = installFetch({ api: api.handler });
    renderPreview(
      <StrictMode>
        <PreviewDialog open nodeId={ID.svg} onClose={noop} onNavigate={noop} source="owner" />
      </StrictMode>,
    );
    await screen.findByRole("button", { name: "Next file" });
    await settle(20);
    expect(network.api().filter((call) => call.url.pathname.endsWith("/children")).length).toBe(1);
    expect(
      network.api(`/api/nodes/${ID.svg}`).filter((call) => call.url.pathname === `/api/nodes/${ID.svg}`)
        .length,
    ).toBe(1);
  });
});
