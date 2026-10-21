// How pdf.js is configured and driven. pdf.js itself is replaced (it needs a canvas and a
// worker): what is checked is what this app asks of it — and what it never asks.
import { beforeEach, describe, expect, it, vi } from "vitest";

const pdfjs = vi.hoisted(() => {
  class PasswordException extends Error {}
  const state = {
    options: [] as Array<Record<string, unknown>>,
    renderCalls: [] as Array<Record<string, unknown>>,
    textLayers: [] as Array<{ source: unknown }>,
    annotations: [] as Array<Record<string, unknown>>,
    textItems: 3,
    textChunks: 0,
    textCancelled: 0,
    textFails: false,
    canvas: null as Promise<void> | null,
    opening: null as Promise<unknown> | null,
    fail: null as Error | null,
    destroyed: 0,
  };
  return { PasswordException, state };
});

vi.mock("pdfjs-dist/build/pdf.worker.min.mjs?url", () => ({ default: "/assets/pdf.worker.min-test.mjs" }));
vi.mock("pdfjs-dist", () => {
  const { state, PasswordException } = pdfjs;
  const page = {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
      convertToViewportPoint: (x: number, y: number) => [x * scale, (792 - y) * scale],
    }),
    render: (params: Record<string, unknown>) => {
      state.renderCalls.push(params);
      return { promise: state.canvas ?? Promise.resolve(), cancel: () => {} };
    },
    getTextContent: async () => {
      throw new Error("the text is read as a stream, so that it can be counted as it arrives");
    },
    // The text arrives in chunks of 1,000 runs.
    streamTextContent: () => {
      let sent = 0;
      return new ReadableStream(
        {
          pull(controller) {
            if (state.textFails) return controller.error(new Error("damaged content stream"));
            if (sent >= state.textItems) return controller.close();
            const size = Math.min(1000, state.textItems - sent);
            sent += size;
            state.textChunks += 1;
            controller.enqueue({
              items: Array.from({ length: size }, () => ({ str: "x" })),
              styles: {},
              lang: "en",
            });
          },
          cancel() {
            state.textCancelled += 1;
          },
        },
        { highWaterMark: 0 },
      );
    },
    getAnnotations: async () => state.annotations,
    cleanup: () => {},
  };
  return {
    AnnotationMode: { DISABLE: 0, ENABLE: 1, ENABLE_FORMS: 2, ENABLE_STORAGE: 3 },
    GlobalWorkerOptions: { workerSrc: "" },
    PasswordException,
    TextLayer: class {
      constructor(params: { textContentSource: unknown }) {
        state.textLayers.push({ source: params.textContentSource });
      }
      render() {
        return Promise.resolve();
      }
      cancel() {}
    },
    getDocument: (options: Record<string, unknown>) => {
      state.options.push(options);
      return {
        promise: state.fail
          ? Promise.reject(state.fail)
          : (state.opening ?? Promise.resolve()).then(() => ({
              numPages: 3,
              getPage: async () => page,
              getDestination: async (name: string) => (name === "chapter-2" ? [{ num: 7, gen: 0 }] : null),
              getPageIndex: async () => 1,
            })),
        destroy: async () => {
          state.destroyed += 1;
        },
      };
    },
  };
});

import { GlobalWorkerOptions } from "pdfjs-dist";
import {
  openPdf,
  PdfAbortedError,
  PdfLockedError,
} from "../../../../src/client/features/preview/renderers/pdf-engine";
import {
  PAGE_MAX_LINKS,
  PDF_MAX_IMAGE_PIXELS,
  TEXT_LAYER_MAX_ITEMS,
} from "../../../../src/client/features/preview/renderers/pdf-limits";

beforeEach(() => {
  const { state } = pdfjs;
  state.options.length = 0;
  state.renderCalls.length = 0;
  state.textLayers.length = 0;
  state.annotations = [];
  state.textItems = 3;
  state.textChunks = 0;
  state.textCancelled = 0;
  state.textFails = false;
  state.canvas = null;
  state.opening = null;
  state.fail = null;
  state.destroyed = 0;
});

const bytes = new Uint8Array([37, 80, 68, 70]);

describe("the PDF engine", () => {
  it("the worker is this app's own file", () => {
    expect(GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.min-test.mjs");
    expect(GlobalWorkerOptions.workerSrc).not.toMatch(/^https?:|^\/\//);
  });

  // T18 review m5 (shell item 6): pdf.js's data files — CMaps, standard fonts, decoders, colour
  // profiles — are this app's own static files under /pdfjs/; nothing else is fetched by pdf.js.
  it("pdf.js gets the bytes whole and fetches only its data files from this app, runs no forms engine, and decodes no giant image", async () => {
    await openPdf(bytes);
    const data = (dir: string) => `${location.origin}/pdfjs/${dir}/`;
    expect(pdfjs.state.options).toEqual([
      {
        data: bytes,
        disableRange: true,
        disableStream: true,
        disableAutoFetch: true,
        enableXfa: false,
        useWorkerFetch: false,
        cMapUrl: data("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: data("standard_fonts"),
        wasmUrl: data("wasm"),
        iccUrl: data("iccs"),
        maxImageSize: PDF_MAX_IMAGE_PIXELS,
      },
    ]);
    const options = pdfjs.state.options[0]!;
    // No address of the document's own, and nothing that switches scripting on.
    for (const key of ["url", "docBaseUrl", "enableScripting"]) {
      expect(key in options, key).toBe(false);
    }
    // Every data URL is on the app's origin.
    for (const key of ["cMapUrl", "standardFontDataUrl", "wasmUrl", "iccUrl"]) {
      expect(new URL(String(options[key])).origin, key).toBe(location.origin);
    }
  });

  it("a page is painted with its annotations as a picture, with a text layer of its runs", async () => {
    const doc = await openPdf(bytes);
    const page = await doc.page(1);
    expect([page.width, page.height]).toEqual([612, 792]);
    const canvas = document.createElement("canvas");
    const layer = document.createElement("div");
    layer.append("stale");
    await page.render(canvas, layer, 1.5, 2).done;
    expect([canvas.width, canvas.height]).toEqual([1836, 2376]);
    expect(layer.textContent).toBe("");
    expect(pdfjs.state.renderCalls[0]).toMatchObject({
      canvas,
      annotationMode: 1,
      transform: [2, 0, 0, 2, 0, 0],
    });
    expect(pdfjs.state.textLayers.length).toBe(1);
  });

  it(`a page with more than ${TEXT_LAYER_MAX_ITEMS} text runs gets no text layer — and the rest of its text is never built`, async () => {
    const doc = await openPdf(bytes);
    pdfjs.state.textItems = 500_000;
    const page = await doc.page(1);
    await page.render(document.createElement("canvas"), document.createElement("div"), 1, 1).done;
    expect(pdfjs.state.textLayers.length).toBe(0);
    // Counted as it arrived: the chunk that passed the limit was the last one taken.
    expect(pdfjs.state.textChunks).toBe(TEXT_LAYER_MAX_ITEMS / 1000 + 1);
    expect(pdfjs.state.textCancelled).toBe(1);
    // A zoom draws again but does not read the text again.
    await page.render(document.createElement("canvas"), document.createElement("div"), 2, 1).done;
    expect(pdfjs.state.textChunks).toBe(TEXT_LAYER_MAX_ITEMS / 1000 + 1);
  });

  it("control: a page with exactly the limit gets its text layer, with every run", async () => {
    const doc = await openPdf(bytes);
    pdfjs.state.textItems = TEXT_LAYER_MAX_ITEMS;
    const page = await doc.page(1);
    await page.render(document.createElement("canvas"), document.createElement("div"), 1, 1).done;
    expect(pdfjs.state.textLayers.length).toBe(1);
    expect((pdfjs.state.textLayers[0]!.source as { items: unknown[] }).items.length).toBe(
      TEXT_LAYER_MAX_ITEMS,
    );
    expect(pdfjs.state.textCancelled).toBe(0);
  });

  it("links are read as data: http(s) and mailto addresses and in-document places; everything else is dropped", async () => {
    pdfjs.state.annotations = [
      { subtype: "Link", rect: [72, 640, 300, 664], url: "https://example.com/a" },
      { subtype: "Link", rect: [0, 0, 10, 10], url: "javascript:alert(1)" },
      { subtype: "Link", rect: [0, 0, 10, 10], unsafeUrl: "javascript:alert(1)" },
      { subtype: "Link", rect: [0, 0, 10, 10], url: "file:///etc/passwd" },
      { subtype: "Link", rect: [10, 10, 20, 20], dest: "chapter-2" },
      { subtype: "Widget", rect: [0, 0, 10, 10], url: "https://example.com/form" },
      { subtype: "Link", url: "https://example.com/no-rect" },
      { subtype: "Link", rect: [0, 0, 5, 5], actions: { Action: ["app.alert(1)"] } },
    ];
    const doc = await openPdf(bytes);
    const links = await (await doc.page(1)).links(2);
    expect(links).toEqual([
      { left: 144, top: 256, width: 456, height: 48, url: "https://example.com/a", dest: undefined },
      { left: 20, top: 1544, width: 20, height: 20, url: undefined, dest: "chapter-2" },
    ]);
    expect(await doc.pageOfDest("chapter-2")).toBe(2);
    expect(await doc.pageOfDest("nowhere")).toBeNull();
    expect(await doc.pageOfDest([4])).toBe(5);
    expect(await doc.pageOfDest(undefined)).toBeNull();
  });

  it(`at most ${PAGE_MAX_LINKS} links of a page become buttons`, async () => {
    pdfjs.state.annotations = Array.from({ length: PAGE_MAX_LINKS + 50 }, (_, index) => ({
      subtype: "Link",
      rect: [0, 0, 1, 1],
      url: `https://example.com/${index}`,
    }));
    const doc = await openPdf(bytes);
    expect((await (await doc.page(1)).links(1)).length).toBe(PAGE_MAX_LINKS);
  });

  it("a password-protected document is its own error; any other failure passes through; both release the task", async () => {
    pdfjs.state.fail = new pdfjs.PasswordException("No password given");
    await expect(openPdf(bytes)).rejects.toBeInstanceOf(PdfLockedError);
    pdfjs.state.fail = new Error("Invalid PDF structure.");
    await expect(openPdf(bytes)).rejects.toThrow("Invalid PDF structure.");
    expect(pdfjs.state.destroyed).toBe(2);
  });

  it("destroy releases the document", async () => {
    const doc = await openPdf(bytes);
    doc.destroy();
    expect(pdfjs.state.destroyed).toBe(1);
  });

  it("a page is drawn until its CANVAS is: a text layer that fails first does not end it early", async () => {
    let paint!: () => void;
    pdfjs.state.canvas = new Promise<void>((resolve) => (paint = resolve));
    pdfjs.state.textFails = true;
    const doc = await openPdf(bytes);
    const page = await doc.page(1);
    let over = false;
    const run = page.render(document.createElement("canvas"), document.createElement("div"), 1, 1);
    void run.done.then(
      () => (over = true),
      () => (over = true),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The text stream has failed by now; the canvas is still being painted.
    expect(over).toBe(false);
    paint();
    await run.done;
    expect(over).toBe(true);
  });

  it("the view's signal aborting while the document is opening destroys the loading task; a document that still comes out is destroyed, not returned", async () => {
    let finish!: () => void;
    pdfjs.state.opening = new Promise<void>((resolve) => (finish = resolve));
    const view = new AbortController();
    const opening = openPdf(bytes, view.signal);
    opening.catch(() => {});
    view.abort();
    expect(pdfjs.state.destroyed).toBe(1);
    finish();
    await expect(opening).rejects.toBeInstanceOf(PdfAbortedError);
    expect(pdfjs.state.destroyed).toBeGreaterThanOrEqual(2);

    // Already aborted before it starts: nothing is waited for.
    await expect(openPdf(bytes, view.signal)).rejects.toBeInstanceOf(PdfAbortedError);

    // And after it opened: the signal destroys the open document too.
    pdfjs.state.opening = null;
    pdfjs.state.destroyed = 0;
    const later = new AbortController();
    await openPdf(bytes, later.signal);
    later.abort();
    expect(pdfjs.state.destroyed).toBe(1);
  });
});
