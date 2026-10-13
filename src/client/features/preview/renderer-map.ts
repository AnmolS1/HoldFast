// Which renderer a file gets. Decided from the DETECTED type (`mimeSniffed`) and the allow-lists
// below — never from the name, and never because a type "is only XML". Whatever is not listed
// gets no preview: the files host would refuse an inline URL for it anyway.
import { PREVIEW_TEXT_MAX_BYTES } from "../../../shared/constants";
import type { PreviewItem } from "../../components/slots";

export type RendererKind = "image" | "heic" | "pdf" | "text" | "video" | "audio" | "none";

/** Why there is no preview, when the type itself would have one. */
export type NoPreviewReason = "type" | "tooLarge";

export interface RendererChoice {
  kind: RendererKind;
  reason?: NoPreviewReason;
}

// The Worker's inline list (`INLINE_TYPES`, src/worker/services/mime.ts) and its text-viewer
// types, as the detector spells them. A copy, because the SPA cannot import Worker code; the
// renderer-map test proves the two agree for every type and extension the product knows.
const INLINE_IMAGE_TYPES: readonly string[] = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
];
/** Inline types no browser decodes: shown through their thumbnail. */
const THUMB_ONLY_IMAGE_TYPES: readonly string[] = ["image/heic", "image/heif"];
const INLINE_VIDEO_TYPES: readonly string[] = ["video/mp4", "video/webm", "video/quicktime", "video/x-m4v"];
const INLINE_AUDIO_TYPES: readonly string[] = [
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "audio/mp4",
  "audio/x-m4a",
];
const TEXT_TYPES: readonly string[] = ["text/plain", "text/markdown", "text/csv"];
const OCTET_STREAM = "application/octet-stream";

/** HTML, SVG and every XML type: they can run script when a browser opens them. */
function isActiveType(type: string): boolean {
  return type === "text/html" || type.endsWith("+xml") || type.endsWith("/xml");
}

/** The renderer for a file. Pure; table-tested. */
export function rendererFor(
  item: Pick<PreviewItem, "mimeCategory" | "mimeSniffed" | "size">,
): RendererChoice {
  const type = (item.mimeSniffed ?? "").trim().toLowerCase();
  if (type === "" || type === OCTET_STREAM || isActiveType(type)) return { kind: "none", reason: "type" };
  if (INLINE_IMAGE_TYPES.includes(type)) return { kind: "image" };
  if (THUMB_ONLY_IMAGE_TYPES.includes(type)) return { kind: "heic" };
  if (INLINE_VIDEO_TYPES.includes(type)) return { kind: "video" };
  if (INLINE_AUDIO_TYPES.includes(type)) return { kind: "audio" };
  if (type === "application/pdf") return { kind: "pdf" };
  if (TEXT_TYPES.includes(type) || item.mimeCategory === "code") {
    // Above the limit the server refuses the URL; do not ask.
    if (!Number.isFinite(item.size) || item.size > PREVIEW_TEXT_MAX_BYTES) {
      return { kind: "none", reason: "tooLarge" };
    }
    return { kind: "text" };
  }
  return { kind: "none", reason: "type" };
}
