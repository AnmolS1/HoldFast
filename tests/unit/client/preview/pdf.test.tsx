// PDF: the bytes are fetched with an inline URL and handed to the engine; pages are drawn only
// near the window; a link out of the document asks first. pdf.js itself cannot run in jsdom (no
// canvas, no worker) — the engine module is replaced here and exercised for real in the e2e spec.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicPreviewSource } from "../../../../src/client/components/slots";
import { PreviewDialog } from "../../../../src/client/features/preview";
import PdfPreview from "../../../../src/client/features/preview/renderers/PdfPreview";
import { purgeUserState } from "../../../../src/client/lib/query";
import { safeExternalUrl } from "../../../../src/client/features/preview/renderers/pdf-links";
import type { PdfDocument, PdfLink } from "../../../../src/client/features/preview/renderers/pdf-engine";
import {
  createRenderBudget,
  PDF_LIVE_CANVAS_MAX_PIXELS,
  PDF_MAX_CONCURRENT_RENDERS,
  PDF_MAX_PAGES,
} from "../../../../src/client/features/preview/renderers/pdf-limits";
import { intersect } from "../shell/helpers";
import { filesUrl, ID, NODES } from "./fixtures";
import {
  dialog,
  envelope,
  installFetch,
  loadedOf,
  ownerApi,
  renderPreview,
  renderer,
  setupPreview,
  settle,
  state,
  unreadable,
} from "./helpers";

const engine = vi.hoisted(() => {
  class PdfLockedError extends Error {}
  return {
    PdfLockedError,
    openPdf: vi.fn(),
    opened: [] as Uint8Array[],
    pagesAsked: [] as number[],
    rendered: [] as Array<{ page: number; scale: number }>,
    destroyed: 0,
  };
});

vi.mock("../../../../src/client/features/preview/renderers/pdf-engine", () => ({
  PdfLockedError: engine.PdfLockedError,
  openPdf: engine.openPdf,
}));

setupPreview();

const noop = () => {};

/**
 * Bring a page near the window. Effects are flushed first: the pages' observers are attached in
 * an effect, and a page that is not observed yet cannot be told it is near.
 */
async function see(page: number): Promise<void> {
  await settle();
  intersect((element) => element.getAttribute("data-pdf-page") === String(page));
}
const EXTERNAL = "https://example.com/holdfast-fixture";

function fakeDocument(pageCount: number, links: Record<number, PdfLink[]> = {}): PdfDocument {
  return {
    pageCount,
    page: async (number) => {
      engine.pagesAsked.push(number);
      return {
        width: 612,
        height: 792,
        render: (_canvas, _text, scale) => {
          engine.rendered.push({ page: number, scale });
          return { done: Promise.resolve(), cancel: () => {} };
        },
        links: async () => links[number] ?? [],
        release: () => {},
      };
    },
    pageOfDest: async (dest) => (typeof dest === "number" ? dest : null),
    destroy: () => {
      engine.destroyed += 1;
    },
  };
}

beforeEach(() => {
  engine.opened.length = 0;
  engine.pagesAsked.length = 0;
  engine.rendered.length = 0;
  engine.destroyed = 0;
  engine.openPdf.mockReset();
  engine.openPdf.mockImplementation(async (bytes: Uint8Array) => {
    engine.opened.push(bytes);
    return fakeDocument(3, {
      1: [
        { left: 72, top: 128, width: 228, height: 24, url: EXTERNAL },
        { left: 72, top: 200, width: 100, height: 24, dest: 3 },
      ],
    });
  });
});

const BYTES = new TextEncoder().encode("%PDF-1.4 fixture bytes");

async function openPdfPreview(files: () => Response = () => new Response(BYTES)) {
  const api = ownerApi([NODES.pdf]);
  const network = installFetch({ api: api.handler, files });
  const view = renderPreview(<PreviewDialog open nodeId={ID.pdf} onClose={noop} source="owner" />);
  await screen.findByText("three-pages.pdf");
  return { api, network, view };
}

describe("PdfPreview", () => {
  it("asks for an `inline` URL, never `download`; fetches once; hands the whole file to the engine", async () => {
    const { api, network } = await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await settle(10);
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline"]);
    expect(network.files().map((call) => `${call.method} ${call.url.href}`)).toEqual([
      `GET ${filesUrl("inline", ID.pdf, "tok-1")}`,
    ]);
    expect(engine.opened.length).toBe(1);
    expect(new TextDecoder().decode(engine.opened[0])).toBe("%PDF-1.4 fixture bytes");
    // Never a frame, an object or an embed.
    expect(dialog()!.querySelector("iframe, object, embed")).toBeNull();
  });

  it("pages are drawn only when they come near the window", async () => {
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await settle(10);
    expect(dialog()!.querySelectorAll("[data-pdf-page]").length).toBe(3);
    // Page 1 was read once, for the size of a sheet; nothing is drawn yet.
    expect(engine.rendered).toEqual([]);
    expect(dialog()!.querySelectorAll("canvas").length).toBe(0);

    await see(2);
    await waitFor(() => expect(engine.rendered.map((entry) => entry.page)).toEqual([2]));
    expect(dialog()!.querySelectorAll("canvas").length).toBe(1);
    expect(dialog()!.querySelector('[data-pdf-page="2"] .textLayer')).not.toBeNull();
  });

  it("shows the page count; next / previous page and the page field move through it", async () => {
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    const field = dialog()!.querySelector<HTMLInputElement>("[data-pdf-page-input]")!;
    expect(field.value).toBe("1");
    expect(dialog()!.querySelector("[data-pdf-page-count]")!.textContent).toBe("of 3");
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(field.value).toBe("3");
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: "2" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("2");
    // Out of range is brought back into it; letters are not taken.
    fireEvent.change(field, { target: { value: "99x" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(field.value).toBe("3");
  });

  it("zoom redraws the pages in view at the new scale", async () => {
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await see(1);
    await waitFor(() => expect(engine.rendered.length).toBe(1));
    const before = engine.rendered.at(-1)!.scale;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(engine.rendered.length).toBe(2));
    expect(engine.rendered.at(-1)!.scale).toBeCloseTo(before * 1.25);
    expect(screen.getByRole("button", { name: "Fit width" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    await waitFor(() => expect(engine.rendered.length).toBe(3));
    expect(engine.rendered.at(-1)!.scale).toBeCloseTo(before);
  });

  it(`a document of more than ${PDF_MAX_PAGES} pages shows the first ${PDF_MAX_PAGES} and says so`, async () => {
    engine.openPdf.mockImplementation(async () => fakeDocument(812));
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    expect(dialog()!.querySelectorAll("[data-pdf-page]").length).toBe(PDF_MAX_PAGES);
    expect(
      screen.getByText("Showing the first 500 of 812 pages. Download the file for the rest."),
    ).toBeTruthy();
    expect(dialog()!.querySelector("[data-pdf-page-count]")!.textContent).toBe("of 500");
  });

  it("a link out of the document asks first: Cancel opens nothing, Open link opens it without an opener", async () => {
    const opened = vi.spyOn(window, "open").mockImplementation(() => null);
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await see(1);
    await waitFor(() => expect(dialog()!.querySelector('[data-pdf-link="external"]')).not.toBeNull());
    const link = dialog()!.querySelector<HTMLElement>('[data-pdf-link="external"]')!;
    // Not an anchor with an address: a middle click cannot go around the question.
    expect(link.tagName).toBe("BUTTON");
    expect(dialog()!.querySelector("a[href]")).toBeNull();

    fireEvent.click(link);
    const confirm = await screen.findByRole("dialog", { name: "You're leaving Holdfast" });
    expect(within(confirm).getByText(EXTERNAL)).toBeTruthy();
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "You're leaving Holdfast" })).toBeNull());
    expect(opened).not.toHaveBeenCalled();

    fireEvent.click(link);
    const again = await screen.findByRole("dialog", { name: "You're leaving Holdfast" });
    fireEvent.click(within(again).getByRole("button", { name: "Open link" }));
    expect(opened.mock.calls).toEqual([[EXTERNAL, "_blank", "noopener,noreferrer"]]);
  });

  it("a link inside the document goes to its page, with no question", async () => {
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await see(1);
    await waitFor(() => expect(dialog()!.querySelector('[data-pdf-link="internal"]')).not.toBeNull());
    const internal = dialog()!.querySelector<HTMLElement>('[data-pdf-link="internal"]')!;
    // Named for what it is — not after the page it happens to sit on.
    expect(internal.getAttribute("aria-label")).toBe("Link to another place in this document");
    fireEvent.click(internal);
    await waitFor(() =>
      expect(dialog()!.querySelector<HTMLInputElement>("[data-pdf-page-input]")!.value).toBe("3"),
    );
    expect(screen.queryByRole("dialog", { name: "You're leaving Holdfast" })).toBeNull();
  });

  it("only http(s) and mailto addresses ever leave a document", () => {
    expect(safeExternalUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(safeExternalUrl("mailto:ada@example.com")).toBe("mailto:ada@example.com");
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "blob:https://example.com/1",
      "vbscript:x",
      "/relative",
      "",
      undefined,
      null,
      42,
    ]) {
      expect(safeExternalUrl(bad), String(bad)).toBeUndefined();
    }
  });

  it("a password-protected PDF has no preview, with Download", async () => {
    engine.openPdf.mockImplementation(async () => {
      throw new engine.PdfLockedError();
    });
    await openPdfPreview();
    await screen.findByText("This PDF is password-protected — download to open it");
    expect(renderer()).toBe("none");
    expect(state()).toBeNull();
  });

  it("a file pdf.js cannot read → the error state, nothing thrown", async () => {
    engine.openPdf.mockImplementation(async () => {
      throw new Error("InvalidPDFException");
    });
    await openPdfPreview();
    await waitFor(() => expect(state()).toBe("error"));
    expect(within(dialog()!).queryByText(/^req /)).toBeNull();
  });

  it("closing the preview releases the document", async () => {
    const { view } = await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    view.unmount();
    expect(engine.destroyed).toBe(1);
  });
});

describe("PdfPreview — refusals", () => {
  it("two 403s from the files host → one re-mint, one retry, the error state; the engine is never called", async () => {
    const refusals = [unreadable(403), unreadable(403)];
    let count = 0;
    const { api, network } = await openPdfPreview(() => refusals[count++]!.response);
    await waitFor(() => expect(state()).toBe("error"));
    expect(api.minted.map((mint) => mint.kind)).toEqual(["inline", "inline"]);
    expect(network.files().length).toBe(2);
    expect(engine.openPdf).not.toHaveBeenCalled();
    for (const refusal of refusals) expect(refusal.read).not.toHaveBeenCalled();
    expect(within(dialog()!).queryByText(/^req /)).toBeNull();
  });

  it("a refused mint → the error state with the API's request id", async () => {
    const api = ownerApi([NODES.pdf], (call) =>
      call.url.pathname.endsWith("/download-url") ? envelope("forbidden", 403) : undefined,
    );
    const network = installFetch({ api: api.handler });
    renderPreview(<PreviewDialog open nodeId={ID.pdf} onClose={noop} source="owner" />);
    await waitFor(() => expect(state()).toBe("error"));
    expect(within(dialog()!).getByText("req req-1234")).toBeTruthy();
    expect(network.files()).toEqual([]);
  });

  it("a public source: the bytes come through getUrl('inline'); the API is never asked", async () => {
    const network = installFetch({ files: () => new Response(BYTES) });
    const source: PublicPreviewSource = {
      getItem: vi.fn(async () => ({
        id: ID.pdf,
        name: "three-pages.pdf",
        size: 1367,
        mimeCategory: "pdf" as const,
        ext: "pdf",
        mimeSniffed: "application/pdf",
      })),
      getUrl: vi.fn(async (nodeId: string, kind: "inline" | "thumb") => ({
        url: filesUrl(kind, nodeId, "pub-1"),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
      })),
    };
    renderPreview(<PreviewDialog open nodeId={ID.pdf} onClose={noop} source={source} />);
    await waitFor(() => expect(renderer()).toBe("pdf"));
    expect(source.getUrl).toHaveBeenCalledTimes(1);
    expect(source.getUrl).toHaveBeenCalledWith(ID.pdf, "inline", undefined);
    expect(network.api()).toEqual([]);
  });
});

describe("PdfPreview across a purge of the account — at each stage", () => {
  const purge = () => act(async () => void (await purgeUserState()));
  /** In the dialog the purge is another account's: it reads again for that one. */
  const switchAccount = () => act(async () => void (await purgeUserState({ keepSession: true })));
  const item = loadedOf(NODES.pdf);
  /** The renderer alone: no dialog remounts it, so what stops the work is its own scope. */
  async function alone(files: () => Response | Promise<Response> = () => new Response(BYTES)) {
    const api = ownerApi([NODES.pdf]);
    const network = installFetch({ api: api.handler, files });
    const view = renderPreview(<PdfPreview source="owner" item={item} />);
    return { api, network, view };
  }
  const shown = (view: { container: HTMLElement }) =>
    view.container.querySelector('[data-preview-renderer="pdf"]');

  it("while the bytes are on their way: the transfer is aborted and pdf.js is never called", async () => {
    let release!: (response: Response) => void;
    const { network, view } = await alone(() => new Promise<Response>((resolve) => (release = resolve)));
    await waitFor(() => expect(network.files().length).toBe(1));
    const signal = network.files()[0]!.signal!;
    await purge();
    expect(signal.aborted).toBe(true);
    release(new Response(BYTES));
    await settle(20);
    expect(engine.openPdf).not.toHaveBeenCalled();
    expect(shown(view)).toBeNull();
  });

  it("while pdf.js is opening the bytes: the document that comes out is destroyed — no page asked, nothing drawn", async () => {
    let finish!: (doc: PdfDocument) => void;
    engine.openPdf.mockImplementation(() => new Promise<PdfDocument>((resolve) => (finish = resolve)));
    const { view } = await alone();
    await waitFor(() => expect(engine.openPdf).toHaveBeenCalledTimes(1));
    // The engine is handed the view's signal, which the purge aborts (the real engine destroys
    // its loading task on it — `pdf-engine.test.ts`).
    const signal = engine.openPdf.mock.calls[0]![1] as AbortSignal;
    expect(signal.aborted).toBe(false);
    await purge();
    expect(signal.aborted).toBe(true);
    finish(fakeDocument(3));
    await settle(20);
    expect(engine.destroyed).toBe(1);
    expect(engine.pagesAsked).toEqual([]);
    expect(engine.rendered).toEqual([]);
    expect(shown(view)).toBeNull();
  });

  it("between pages: the document is destroyed, its pages leave the screen, and no further page is drawn", async () => {
    const { view } = await alone();
    await waitFor(() => expect(shown(view)).not.toBeNull());
    await see(1);
    await waitFor(() => expect(engine.rendered.map((entry) => entry.page)).toEqual([1]));
    await purge();
    await settle(10);
    expect(engine.destroyed).toBe(1);
    expect(shown(view)).toBeNull();
    expect(view.container.querySelector("canvas")).toBeNull();
    intersect();
    await settle(20);
    expect(engine.rendered.map((entry) => entry.page)).toEqual([1]);
    expect(engine.pagesAsked.filter((page) => page > 1)).toEqual([]);
  });

  it("a page that arrives after the purge is released, not shown; a link list that arrives late is dropped", async () => {
    let givePage!: () => void;
    let giveLinks!: (links: PdfLink[]) => void;
    const released: number[] = [];
    engine.openPdf.mockImplementation(async () => ({
      ...fakeDocument(3),
      page: async (number: number) => {
        // Page 1 is read at once for the sheet's size; page 2 is held until the test lets it go.
        if (number === 2) await new Promise<void>((resolve) => (givePage = resolve));
        engine.pagesAsked.push(number);
        return {
          width: 612,
          height: 792,
          render: (_canvas: HTMLCanvasElement, _text: HTMLElement, scale: number) => {
            engine.rendered.push({ page: number, scale });
            return { done: Promise.resolve(), cancel: () => {} };
          },
          links: () => new Promise<PdfLink[]>((resolve) => (giveLinks = resolve)),
          release: () => released.push(number),
        };
      },
    }));
    const { view } = await alone();
    await waitFor(() => expect(shown(view)).not.toBeNull());
    await see(1);
    await waitFor(() => expect(engine.rendered.length).toBe(1));
    await see(2);
    await settle(5);
    await purge();
    givePage();
    giveLinks([{ left: 0, top: 0, width: 10, height: 10, url: EXTERNAL }]);
    await settle(20);
    expect(released).toContain(2);
    expect(engine.rendered.map((entry) => entry.page)).toEqual([1]);
    expect(view.container.querySelector("[data-pdf-link]")).toBeNull();
  });

  it("mid-render: the drawing under way is cancelled", async () => {
    const cancelled: number[] = [];
    engine.openPdf.mockImplementation(async () => ({
      ...fakeDocument(3),
      page: async (number: number) => ({
        width: 612,
        height: 792,
        render: () => {
          engine.rendered.push({ page: number, scale: 1 });
          return { done: new Promise<void>(() => {}), cancel: () => cancelled.push(number) };
        },
        links: async () => [],
        release: () => {},
      }),
    }));
    const { view } = await alone();
    await waitFor(() => expect(shown(view)).not.toBeNull());
    await see(1);
    await waitFor(() => expect(engine.rendered.length).toBe(1));
    await purge();
    expect(cancelled).toContain(1);
    expect(engine.destroyed).toBe(1);
  });

  it("a jump inside the document that resolves after the purge moves nothing", async () => {
    let answer!: (page: number) => void;
    engine.openPdf.mockImplementation(async () => ({
      ...fakeDocument(3, { 1: [{ left: 0, top: 0, width: 10, height: 10, dest: "later" }] }),
      pageOfDest: () => new Promise<number>((resolve) => (answer = resolve)),
    }));
    // In the dialog, so that the page field can be read before the purge.
    const a = { gone: false };
    const api = ownerApi([NODES.pdf]);
    installFetch({
      api: (call) => (a.gone ? envelope("not_found", 404) : api.handler(call)),
      files: () => new Response(BYTES),
    });
    renderPreview(<PreviewDialog open nodeId={ID.pdf} onClose={noop} source="owner" />);
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await see(1);
    await waitFor(() => expect(dialog()!.querySelector('[data-pdf-link="internal"]')).not.toBeNull());
    fireEvent.click(dialog()!.querySelector<HTMLElement>('[data-pdf-link="internal"]')!);
    a.gone = true;
    await switchAccount();
    answer(3);
    await waitFor(() => expect(state()).toBe("error"));
    expect(renderer()).toBeNull();
    expect(screen.queryByText("three-pages.pdf")).toBeNull();
    expect(engine.destroyed).toBe(1);
  });

  it("in the dialog: an open PDF is gone after the purge — title, pages, Download — and the dialog reads again", async () => {
    const a = { gone: false };
    const api = ownerApi([NODES.pdf]);
    installFetch({
      api: (call) => (a.gone ? envelope("not_found", 404) : api.handler(call)),
      files: () => new Response(BYTES),
    });
    renderPreview(<PreviewDialog open nodeId={ID.pdf} onClose={noop} source="owner" />);
    await waitFor(() => expect(renderer()).toBe("pdf"));
    a.gone = true;
    await switchAccount();
    await waitFor(() => expect(state()).toBe("error"));
    expect(dialog()!.querySelectorAll("[data-pdf-page]").length).toBe(0);
    expect(screen.queryByText("three-pages.pdf")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
    expect(engine.destroyed).toBe(1);
    intersect();
    await settle(20);
    expect(engine.rendered).toEqual([]);
  });
});

describe("PdfPreview — how much is drawn at once", () => {
  /** An IntersectionObserver the test drives both ways: pages come near (and into view), and leave. */
  type Report = (entries: Array<{ isIntersecting: boolean; target: Element }>) => void;
  const observed = new Map<Element, Set<Report>>();
  const near = (page: number, isIntersecting: boolean) => {
    const element = document.querySelector(`[data-pdf-page="${page}"]`)!;
    for (const report of Array.from(observed.get(element) ?? []))
      report([{ isIntersecting, target: element }]);
  };

  beforeEach(() => {
    observed.clear();
    class DrivenObserver {
      private readonly targets = new Set<Element>();
      constructor(private readonly callback: Report) {}
      observe(element: Element) {
        this.targets.add(element);
        if (!observed.has(element)) observed.set(element, new Set());
        observed.get(element)!.add(this.callback);
      }
      unobserve(element: Element) {
        this.targets.delete(element);
        observed.get(element)?.delete(this.callback);
      }
      disconnect() {
        for (const element of this.targets) observed.get(element)?.delete(this.callback);
        this.targets.clear();
      }
      takeRecords() {
        return [];
      }
    }
    vi.stubGlobal("IntersectionObserver", DrivenObserver);
  });

  it("a 500-page document scrolled end to end: never more than two pages drawing, live canvases under the cap", async () => {
    // Big pages: each canvas is 12 megapixels, so five fit under the 64-megapixel cap.
    const drawing = new Set<number>();
    const canvases = new Set<HTMLCanvasElement>();
    const finish = new Map<number, () => void>();
    let mostDrawing = 0;
    let mostPixels = 0;
    let drawn = 0;
    const livePixels = () =>
      Array.from(canvases).reduce(
        (sum, canvas) => sum + (canvas.isConnected ? canvas.width * canvas.height : 0),
        0,
      );
    engine.openPdf.mockImplementation(async () => ({
      pageCount: 500,
      page: async (number: number) => ({
        width: 3000,
        height: 4000,
        render: (canvas: HTMLCanvasElement, _text: HTMLElement, scale: number, ratio: number) => {
          canvas.width = Math.floor(3000 * scale * ratio);
          canvas.height = Math.floor(4000 * scale * ratio);
          canvases.add(canvas);
          drawing.add(number);
          drawn += 1;
          mostDrawing = Math.max(mostDrawing, drawing.size);
          mostPixels = Math.max(mostPixels, livePixels());
          return {
            done: new Promise<void>((resolve) => {
              finish.set(number, () => {
                drawing.delete(number);
                resolve();
              });
            }),
            cancel: () => {
              drawing.delete(number);
              finish.get(number)?.();
            },
          };
        },
        links: async () => [],
        release: () => {},
      }),
      pageOfDest: async () => null,
      destroy: () => {},
    }));
    await openPdfPreview();
    await waitFor(() => expect(renderer()).toBe("pdf"));
    await settle(5);
    expect(dialog()!.querySelectorAll("[data-pdf-page]").length).toBe(PDF_MAX_PAGES);

    // A window of fifty pages moves down the document, fifty at a time; whatever is drawing finishes
    // between steps (and the pages behind leave).
    const WINDOW = 50;
    for (let top = 1; top <= PDF_MAX_PAGES; top += WINDOW) {
      for (let page = top; page < top + WINDOW; page += 1) near(page, true);
      for (let round = 0; round < 5; round += 1) {
        await settle();
        expect(drawing.size).toBeLessThanOrEqual(PDF_MAX_CONCURRENT_RENDERS);
        expect(livePixels()).toBeLessThanOrEqual(PDF_LIVE_CANVAS_MAX_PIXELS);
        for (const done of Array.from(finish.values())) done();
        finish.clear();
      }
      for (let page = top; page < top + WINDOW; page += 1) near(page, false);
      await settle();
      // What scrolled out gave its pixels back.
      expect(livePixels()).toBe(0);
    }
    expect(mostDrawing).toBe(PDF_MAX_CONCURRENT_RENDERS);
    expect(mostPixels).toBeLessThanOrEqual(PDF_LIVE_CANVAS_MAX_PIXELS);
    expect(mostPixels).toBe(5 * 12_000_000);
    // And it did draw: five pages of every window (the cap), all the way down.
    expect(drawn).toBeGreaterThanOrEqual((PDF_MAX_PAGES / WINDOW) * 5);
  });
});

describe("the render budget", () => {
  it("grants two at a time, in order, and the third when one finishes", async () => {
    const budget = createRenderBudget(2, 100);
    const order: number[] = [];
    const slots = [10, 10, 10, 10].map((pixels, index) => {
      const slot = budget.request(pixels);
      void slot.granted.then((ok) => ok && order.push(index));
      return slot;
    });
    await Promise.resolve();
    expect(order).toEqual([0, 1]);
    expect(budget.stats()).toEqual({ rendering: 2, pixels: 20, waiting: 2 });
    slots[0]!.finished();
    await Promise.resolve();
    expect(order).toEqual([0, 1, 2]);
    // Finished is not gone: its canvas still counts.
    expect(budget.stats()).toEqual({ rendering: 2, pixels: 30, waiting: 1 });
  });

  it("holds a page back while the live canvases leave no room, and lets it in when one is released", async () => {
    const budget = createRenderBudget(2, 100);
    const first = budget.request(60);
    first.finished();
    const second = budget.request(60);
    let granted: boolean | null = null;
    void second.granted.then((ok) => {
      granted = ok;
    });
    await Promise.resolve();
    expect(granted).toBeNull();
    expect(budget.stats()).toEqual({ rendering: 0, pixels: 60, waiting: 1 });
    first.release();
    await Promise.resolve();
    expect(granted).toBe(true);
    expect(budget.stats()).toEqual({ rendering: 1, pixels: 60, waiting: 0 });
  });

  it("one page is always allowed, even one larger than the whole budget; a waiter that leaves is told no", async () => {
    const budget = createRenderBudget(2, 100);
    const huge = budget.request(500);
    expect(await huge.granted).toBe(true);
    const waiting = budget.request(1);
    waiting.release();
    expect(await waiting.granted).toBe(false);
    expect(budget.stats()).toEqual({ rendering: 1, pixels: 500, waiting: 0 });
    huge.release();
    huge.release();
    expect(budget.stats()).toEqual({ rendering: 0, pixels: 0, waiting: 0 });
  });

  it("a page on screen goes before pages that are only near, whoever asked first", async () => {
    const budget = createRenderBudget(1, 1000);
    const order: string[] = [];
    const first = budget.request(10);
    for (const [name, visible] of [
      ["near-1", false],
      ["near-2", false],
      ["visible", true],
    ] as const) {
      void budget.request(10, { visible }).granted.then((ok) => ok && order.push(name));
    }
    first.finished();
    await Promise.resolve();
    expect(order).toEqual(["visible"]);
  });

  it("a page that comes into view while waiting is served next", async () => {
    const budget = createRenderBudget(1, 1000);
    const order: string[] = [];
    const first = budget.request(10);
    void budget.request(10).granted.then((ok) => ok && order.push("a"));
    const b = budget.request(10);
    void b.granted.then((ok) => ok && order.push("b"));
    b.setVisible(true);
    first.finished();
    await Promise.resolve();
    expect(order).toEqual(["b"]);
  });

  it("finished pages nobody sees give their pixels back to a page on screen; visible and drawing ones are never taken", async () => {
    const budget = createRenderBudget(2, 100);
    const evicted: string[] = [];
    const hidden = budget.request(40, { onEvict: () => evicted.push("hidden") });
    hidden.finished();
    const seen = budget.request(40, { visible: true, onEvict: () => evicted.push("seen") });
    seen.finished();
    const drawing = budget.request(20, { onEvict: () => evicted.push("drawing") });
    let granted: boolean | null = null;
    void budget.request(40, { visible: true }).granted.then((ok) => {
      granted = ok;
    });
    await Promise.resolve();
    expect(evicted).toEqual(["hidden"]);
    expect(granted).toBe(true);
    expect(budget.stats().pixels).toBe(100);
    // Control: a page that is only near takes nothing from anybody — it waits.
    const waits = budget.request(40);
    let late: boolean | null = null;
    void waits.granted.then((ok) => {
      late = ok;
    });
    await Promise.resolve();
    expect(late).toBeNull();
    expect(evicted).toEqual(["hidden"]);
    drawing.release();
    waits.release();
  });

  it("the product's numbers", () => {
    expect(PDF_MAX_CONCURRENT_RENDERS).toBe(2);
    expect(PDF_LIVE_CANVAS_MAX_PIXELS).toBe(64_000_000);
  });
});
