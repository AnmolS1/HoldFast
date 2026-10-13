// Which renderer a file gets. Decided from the DETECTED type (`mimeSniffed`) and the product's
// allow-lists — never from the name, and never because a type "is only XML". Whatever is not
// listed gets no preview: the files host would refuse an inline URL for it anyway.
import {
  IMAGE_PREVIEW_MAX_BYTES,
  INLINE_TYPES,
  PDF_PREVIEW_MAX_BYTES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TEXT_TYPES,
} from "../../../shared/constants";
import { isActiveType, OCTET_STREAM } from "../../../shared/mime";
import type { PreviewItem } from "../../components/slots";

export type RendererKind = "image" | "heic" | "pdf" | "text" | "video" | "audio" | "none";

/** Why there is no preview, when the type itself would have one. */
export type NoPreviewReason = "type" | "tooLarge";

export interface RendererChoice {
  kind: RendererKind;
  reason?: NoPreviewReason;
}

/** Inline images no browser decodes: shown through their thumbnail, which has its own limit. */
const THUMB_ONLY_IMAGE_TYPES: readonly string[] = ["image/heic", "image/heif"];

const within = (size: number, limit: number) => Number.isFinite(size) && size <= limit;
const TOO_LARGE: RendererChoice = { kind: "none", reason: "tooLarge" };

/** The renderer for a file. Pure; table-tested. */
export function rendererFor(
  item: Pick<PreviewItem, "mimeCategory" | "mimeSniffed" | "size">,
): RendererChoice {
  const type = (item.mimeSniffed ?? "").trim().toLowerCase();
  if (type === "" || type === OCTET_STREAM || isActiveType(type)) return { kind: "none", reason: "type" };
  if (INLINE_TYPES.includes(type)) {
    if (THUMB_ONLY_IMAGE_TYPES.includes(type)) return { kind: "heic" };
    if (type.startsWith("image/")) {
      return within(item.size, IMAGE_PREVIEW_MAX_BYTES) ? { kind: "image" } : TOO_LARGE;
    }
    // Played by the browser's own element in ranges: the file's size is not memory in the tab.
    if (type.startsWith("video/")) return { kind: "video" };
    if (type.startsWith("audio/")) return { kind: "audio" };
    return { kind: "none", reason: "type" };
  }
  if (type === "application/pdf") {
    return within(item.size, PDF_PREVIEW_MAX_BYTES) ? { kind: "pdf" } : TOO_LARGE;
  }
  if (PREVIEW_TEXT_TYPES.includes(type) || item.mimeCategory === "code") {
    // Above the limit the server refuses the URL; do not ask.
    return within(item.size, PREVIEW_TEXT_MAX_BYTES) ? { kind: "text" } : TOO_LARGE;
  }
  return { kind: "none", reason: "type" };
}

/** The most bytes a viewer that reads a file itself will take from the files host. */
export function fetchLimitFor(kind: "pdf" | "text"): number {
  return kind === "pdf" ? PDF_PREVIEW_MAX_BYTES : PREVIEW_TEXT_MAX_BYTES;
}
