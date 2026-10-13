// PDF: the bytes are fetched with an inline URL and handed to the engine; pages are drawn only
// near the window; a link out of the document asks first. pdf.js itself cannot run in jsdom (no
// canvas, no worker) — the engine module is replaced here and exercised for real in the e2e spec.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicPreviewSource } from "../../../../src/client/components/slots";
import { PreviewDialog } from "../../../../src/client/features/preview";
import { safeExternalUrl } from "../../../../src/client/features/preview/renderers/pdf-links";
import type { PdfDocument, PdfLink } from "../../../../src/client/features/preview/renderers/pdf-engine";
import { PDF_MAX_PAGES } from "../../../../src/client/features/preview/renderers/pdf-limits";
import { intersect } from "../shell/helpers";
import { filesUrl, ID, NODES } from "./fixtures";
import {
  dialog,
  envelope,
  installFetch,
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

    intersect((element) => element.getAttribute("data-pdf-page") === "2");
    await settle(10);
    expect(engine.rendered.map((entry) => entry.page)).toEqual([2]);
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
    intersect((element) => element.getAttribute("data-pdf-page") === "1");
    await settle(10);
    const before = engine.rendered.at(-1)!.scale;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await settle(10);
    expect(engine.rendered.at(-1)!.scale).toBeCloseTo(before * 1.25);
    expect(screen.getByRole("button", { name: "Fit width" }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Fit width" }));
    await settle(10);
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
    intersect((element) => element.getAttribute("data-pdf-page") === "1");
    await settle(10);
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
    intersect((element) => element.getAttribute("data-pdf-page") === "1");
    await settle(10);
    fireEvent.click(dialog()!.querySelector<HTMLElement>('[data-pdf-link="internal"]')!);
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
