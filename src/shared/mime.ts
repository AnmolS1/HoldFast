// The pure half of the MIME policy: what a detected type may be served as and what the SPA may
// do with it. The Worker (`src/worker/services/mime.ts`, which re-exports all of this) and the
// SPA's viewers decide through the same functions. Detection itself is the Worker's.
//
// THE RULES
//  - Everything is decided from the DETECTED type (`mimeSniffed`). The type the browser declared
//    at upload and the file's extension never decide how bytes are served.
//  - `inlineAllowed` is an allow-list of media a browser renders without running anything in it.
//    HTML, SVG and every XML type are never on it, and `serveType` turns them into
//    `application/octet-stream`.
//
// Imports nothing outside `src/shared`.

import {
  INLINE_TYPES,
  MIME_CATEGORIES,
  PREVIEW_TEXT_MAX_BYTES,
  PREVIEW_TEXT_TYPES,
  type MimeCategoryName,
} from "./constants";

export const OCTET_STREAM = "application/octet-stream";

// A bare `type/subtype`: no parameters, no spaces, nothing a header could be broken with.
export const BARE_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/;

const lower = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * True for a type that can run script when a browser opens it: HTML, SVG, and every XML type
 * (`application/xml`, `text/xml`, anything ending in `+xml` or `/xml`).
 */
export function isActiveType(type: string | null | undefined): boolean {
  const t = lower(type).split(";", 1)[0]!.trim();
  return t === "text/html" || t.endsWith("+xml") || t.endsWith("/xml");
}

/** True when a response of this type may be rendered in place (`Content-Disposition: inline`). */
export function inlineAllowed(servedType: string | null | undefined): boolean {
  return INLINE_TYPES.includes(lower(servedType));
}

/**
 * The `Content-Type` a file is served with: its detected type, or `application/octet-stream` when
 * there is none, when it is not a bare `type/subtype`, or when it is an active type. The declared
 * type and the name are never used (`name` is part of the signature only).
 */
export function serveType(mimeSniffed: string | null | undefined, name: string): string {
  void name;
  const type = lower(mimeSniffed);
  if (!BARE_TYPE.test(type) || isActiveType(type)) return OCTET_STREAM;
  return type;
}

/** The category a file shows under. A label only — see `MIME_CATEGORIES`. */
export function categoryOf(mimeSniffed: string | null | undefined, ext: string): MimeCategoryName {
  const type = lower(mimeSniffed);
  const extension = lower(ext).replace(/^\./, "");
  const names = Object.keys(MIME_CATEGORIES) as MimeCategoryName[];
  const byType = names.find((name) => (MIME_CATEGORIES[name].types as readonly string[]).includes(type));
  const byExt = names.find((name) => (MIME_CATEGORIES[name].exts as readonly string[]).includes(extension));
  // Not yet scanned, or detected as nothing in particular (plain text, unknown bytes): the
  // extension is the better label. A SPECIFIC detected type is never overruled by the name — a
  // program called photo.jpg does not show as an image.
  const generic = type === "" || type === "text/plain" || type === OCTET_STREAM;
  if (generic) return byExt ?? byType ?? "other";
  return byType ?? "other";
}

/**
 * The types the SPA previews by FETCHING bytes (the PDF viewer, the text viewer) instead of by
 * navigation: PDF, and text or code up to `PREVIEW_TEXT_MAX_BYTES`. Never an active type, and
 * never a file with no detected type. The response is still an attachment.
 */
export function previewFetchAllowed(file: {
  mimeSniffed: string | null | undefined;
  ext: string;
  size: number;
}): boolean {
  const type = lower(file.mimeSniffed);
  if (type === "" || type === OCTET_STREAM || isActiveType(type)) return false;
  if (type === "application/pdf") return true;
  const text = PREVIEW_TEXT_TYPES.includes(type) || categoryOf(type, file.ext) === "code";
  return text && Number.isFinite(file.size) && file.size <= PREVIEW_TEXT_MAX_BYTES;
}

/** The rule for minting and for serving an `inline` token. */
export function inlineKindAllowed(node: {
  mimeSniffed: string | null | undefined;
  name: string;
  ext: string;
  size: number;
}): boolean {
  return inlineAllowed(serveType(node.mimeSniffed, node.name)) || previewFetchAllowed(node);
}
