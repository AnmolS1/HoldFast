// pdf.js behind a small interface: open bytes, draw a page to a canvas with a text layer, list a
// page's links. Safe-rendering rules live here:
//   - the worker is this app's own file (same origin, no CDN);
//   - the bytes are handed over whole — pdf.js makes no request of its own;
//   - no scripting anywhere: nothing here builds pdf.js's annotation or scripting layers, so a
//     document's JavaScript actions and form scripts have nothing to run in. Links are read as
//     DATA (a rectangle and an address) and drawn by the viewer itself.
import {
  AnnotationMode,
  getDocument,
  GlobalWorkerOptions,
  PasswordException,
  TextLayer,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { safeExternalUrl } from "./pdf-links";

GlobalWorkerOptions.workerSrc = workerUrl;

/** Thrown by `openPdf` for a document that needs a password. */
export class PdfLockedError extends Error {}

export interface PdfLink {
  /** Position in CSS pixels at the scale asked for. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** An absolute http(s) or mailto address the document points at. */
  url?: string;
  /** A place inside the document. */
  dest?: unknown;
}

export interface PdfRender {
  done: Promise<void>;
  cancel(): void;
}

export interface PdfPage {
  /** Size in CSS pixels at scale 1. */
  width: number;
  height: number;
  render(canvas: HTMLCanvasElement, textLayer: HTMLElement, scale: number, pixelRatio: number): PdfRender;
  links(scale: number): Promise<PdfLink[]>;
  release(): void;
}

export interface PdfDocument {
  pageCount: number;
  page(number: number): Promise<PdfPage>;
  /** The 1-based page a link's destination is on, or null. */
  pageOfDest(dest: unknown): Promise<number | null>;
  destroy(): void;
}

interface RawAnnotation {
  subtype?: string;
  rect?: number[];
  url?: string;
  dest?: unknown;
}

function wrapPage(page: PDFPageProxy): PdfPage {
  const base = page.getViewport({ scale: 1 });
  return {
    width: base.width,
    height: base.height,
    render(canvas, textLayer, scale, pixelRatio) {
      const viewport = page.getViewport({ scale });
      canvas.width = Math.floor(viewport.width * pixelRatio);
      canvas.height = Math.floor(viewport.height * pixelRatio);
      const task = page.render({
        canvas,
        viewport,
        transform: pixelRatio === 1 ? undefined : [pixelRatio, 0, 0, pixelRatio, 0, 0],
        // Annotations are painted as their static appearance; none becomes a live element.
        annotationMode: AnnotationMode.ENABLE,
      });
      textLayer.replaceChildren();
      const text = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: textLayer,
        viewport,
      });
      const done = Promise.all([task.promise, text.render()]).then(() => undefined);
      return {
        done,
        cancel() {
          task.cancel();
          text.cancel();
        },
      };
    },
    async links(scale) {
      const viewport = page.getViewport({ scale });
      const annotations = (await page.getAnnotations({ intent: "display" })) as RawAnnotation[];
      const links: PdfLink[] = [];
      for (const annotation of annotations) {
        if (annotation.subtype !== "Link" || !annotation.rect) continue;
        const url = safeExternalUrl(annotation.url);
        if (!url && annotation.dest === undefined) continue;
        const [left, bottom, right, top] = annotation.rect as [number, number, number, number];
        const [x1, y1] = viewport.convertToViewportPoint(left, bottom) as [number, number];
        const [x2, y2] = viewport.convertToViewportPoint(right, top) as [number, number];
        links.push({
          left: Math.min(x1, x2),
          top: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          url,
          dest: url ? undefined : annotation.dest,
        });
      }
      return links;
    },
    release() {
      page.cleanup();
    },
  };
}

async function pageOfDest(doc: PDFDocumentProxy, dest: unknown): Promise<number | null> {
  try {
    const explicit = typeof dest === "string" ? await doc.getDestination(dest) : dest;
    if (!Array.isArray(explicit)) return null;
    const target: unknown = explicit[0];
    if (typeof target === "number") return target + 1;
    if (typeof target === "object" && target !== null) {
      return (await doc.getPageIndex(target as Parameters<PDFDocumentProxy["getPageIndex"]>[0])) + 1;
    }
    return null;
  } catch {
    return null;
  }
}

export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const task = getDocument({
    data,
    // One whole file, already fetched: no ranges, no streaming, no fetch by pdf.js.
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    enableXfa: false,
    useWorkerFetch: false,
  });
  let doc: PDFDocumentProxy;
  try {
    doc = await task.promise;
  } catch (error) {
    void task.destroy();
    if (error instanceof PasswordException) throw new PdfLockedError();
    throw error;
  }
  return {
    pageCount: doc.numPages,
    page: async (number) => wrapPage(await doc.getPage(number)),
    pageOfDest: (dest) => pageOfDest(doc, dest),
    destroy: () => void task.destroy(),
  };
}
