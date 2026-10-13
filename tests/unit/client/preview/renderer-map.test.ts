// Which renderer a file gets — decided from the detected type and the allow-lists, never from
// the name or from "it is only XML".
import { describe, expect, it } from "vitest";
import {
  IMAGE_PREVIEW_MAX_BYTES,
  PDF_PREVIEW_MAX_BYTES,
  rendererFor,
  type RendererKind,
} from "../../../../src/client/features/preview/renderer-map";
import {
  INLINE_TYPES,
  MIME_CATEGORIES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TEXT_TYPES,
} from "../../../../src/shared/constants";
import type { MimeCategory } from "../../../../src/shared/schemas/common";

const kind = (mimeCategory: MimeCategory, mimeSniffed: string | null | undefined, size = 1000) =>
  rendererFor({ mimeCategory, mimeSniffed, size }).kind;

describe("renderer map", () => {
  // One row per category of the product, with the type the detector gives its usual file.
  const BY_CATEGORY: Array<[MimeCategory, string, RendererKind]> = [
    ["image", "image/png", "image"],
    ["video", "video/mp4", "video"],
    ["audio", "audio/mpeg", "audio"],
    ["pdf", "application/pdf", "pdf"],
    ["document", "text/plain", "text"],
    ["archive", "application/zip", "none"],
    ["code", "text/plain", "text"],
    ["other", "application/octet-stream", "none"],
  ];

  it("covers every category the product has", () => {
    expect(BY_CATEGORY.map(([category]) => category).sort()).toEqual(Object.keys(MIME_CATEGORIES).sort());
  });

  it.each(BY_CATEGORY)("category %s, detected %s → %s", (category, type, expected) => {
    expect(kind(category, type)).toBe(expected);
  });

  // The rows the task names, and the ones that keep active content inert.
  const ROWS: Array<[MimeCategory, string | null | undefined, RendererKind]> = [
    ["image", "image/svg+xml", "none"],
    ["code", "text/html", "none"],
    ["code", "application/xml", "none"],
    ["code", "text/xml", "none"],
    ["code", "application/xhtml+xml", "none"],
    ["other", "application/atom+xml", "none"],
    ["image", "image/jpeg", "image"],
    ["image", "image/gif", "image"],
    ["image", "image/webp", "image"],
    ["image", "image/avif", "image"],
    ["image", "image/bmp", "image"],
    ["image", "image/heic", "heic"],
    ["image", "image/heif", "heic"],
    ["image", "image/tiff", "none"],
    ["image", "image/vnd.adobe.photoshop", "none"],
    ["audio", "audio/x-m4a", "audio"],
    ["audio", "audio/mp4", "audio"],
    ["audio", "audio/ogg", "audio"],
    ["audio", "audio/wav", "audio"],
    ["audio", "audio/flac", "audio"],
    ["audio", "audio/aac", "none"],
    ["video", "video/x-m4v", "video"],
    ["video", "video/webm", "video"],
    ["video", "video/quicktime", "video"],
    ["video", "video/x-matroska", "none"],
    ["document", "text/markdown", "text"],
    ["document", "text/csv", "text"],
    ["document", "application/msword", "none"],
    ["code", "application/json", "text"],
    ["code", "text/javascript", "text"],
    ["code", "text/css", "text"],
    // No detected type: not scanned, or nothing recognisable — never rendered on the name alone.
    ["image", null, "none"],
    ["image", undefined, "none"],
    ["image", "", "none"],
    ["code", "application/octet-stream", "none"],
    // The detector's spelling may arrive in another case.
    ["image", "IMAGE/SVG+XML", "none"],
    ["image", "Image/PNG", "image"],
  ];

  it.each(ROWS)("category %s, detected %s → %s", (category, type, expected) => {
    expect(kind(category, type)).toBe(expected);
  });

  it("a file the list calls an image but the detector calls SVG is not given to the image renderer", () => {
    expect(rendererFor({ mimeCategory: "image", mimeSniffed: "image/svg+xml", size: 10 })).toEqual({
      kind: "none",
      reason: "type",
    });
  });

  it("text above the preview limit has no preview, and says it is too large", () => {
    const at = { mimeCategory: "code" as const, mimeSniffed: "text/plain" };
    expect(rendererFor({ ...at, size: PREVIEW_TEXT_MAX_BYTES })).toEqual({ kind: "text" });
    expect(rendererFor({ ...at, size: PREVIEW_TEXT_MAX_BYTES + 1 })).toEqual({
      kind: "none",
      reason: "tooLarge",
    });
  });

  it("a PDF and an image have their own size limit; video and audio have none", () => {
    expect(PDF_PREVIEW_MAX_BYTES).toBe(50_000_000);
    expect(IMAGE_PREVIEW_MAX_BYTES).toBe(50_000_000);
    expect(rendererFor({ mimeCategory: "pdf", mimeSniffed: "application/pdf", size: 50_000_000 })).toEqual({
      kind: "pdf",
    });
    expect(rendererFor({ mimeCategory: "pdf", mimeSniffed: "application/pdf", size: 50_000_001 })).toEqual({
      kind: "none",
      reason: "tooLarge",
    });
    for (const type of ["image/jpeg", "image/png", "image/avif", "image/bmp", "image/gif", "image/webp"]) {
      expect(kind("image", type, 50_000_000), type).toBe("image");
      expect(rendererFor({ mimeCategory: "image", mimeSniffed: type, size: 50_000_001 }), type).toEqual({
        kind: "none",
        reason: "tooLarge",
      });
    }
    // Played in ranges by the browser's own element: the product's largest file is still a film.
    expect(kind("video", "video/mp4", 2_000_000_000)).toBe("video");
    expect(kind("audio", "audio/flac", 2_000_000_000)).toBe("audio");
    // HEIC is shown through its thumbnail, whose limit is the server's (`thumb`).
    expect(kind("image", "image/heic", 60_000_000)).toBe("heic");
    // A size that is not a number is not "small".
    expect(kind("pdf", "application/pdf", Number.NaN)).toBe("none");
    expect(kind("image", "image/png", Number.POSITIVE_INFINITY)).toBe("none");
  });

  it("the lists are the product's own (src/shared), not a copy", () => {
    for (const type of INLINE_TYPES) {
      expect(kind("other", type), type).not.toBe("none");
    }
    for (const type of PREVIEW_TEXT_TYPES) expect(kind("document", type), type).toBe("text");
  });

  it("every type and extension the product lists maps to a renderer or to none — nothing throws", () => {
    for (const [category, { types }] of Object.entries(MIME_CATEGORIES)) {
      for (const type of types) {
        const choice = rendererFor({ mimeCategory: category as MimeCategory, mimeSniffed: type, size: 1 });
        expect(["image", "heic", "pdf", "text", "video", "audio", "none"], type).toContain(choice.kind);
        // An active type is inert whatever category lists it.
        if (type === "text/html" || type.endsWith("+xml") || type.endsWith("/xml")) {
          expect(choice.kind, type).toBe("none");
        }
      }
    }
  });
});
