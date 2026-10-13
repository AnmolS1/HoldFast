// The bounds of the PDF viewer: how many pages, and how many canvas pixels a page may take.

/** Pages shown at most; the rest is the download's. */
export const PDF_MAX_PAGES = 500;

/** Canvas pixels per page at most: a huge page is drawn less sharply, not refused. */
export const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Canvas pixels per CSS pixel: the screen's, at most 2 — and as little as it takes to keep the
 * canvas under the pixel cap. There is no floor: a 20,000-point page is drawn coarsely, never
 * given a canvas of its own size.
 */
export function pixelRatioFor(width: number, height: number, device: number): number {
  const wanted = Math.min(device > 0 ? device : 1, 2);
  const most = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height));
  return Math.min(wanted, most);
}

/** Text runs per page given a selectable layer; a page with more is drawn without one. */
export const TEXT_LAYER_MAX_ITEMS = 20_000;

/** Links per page turned into buttons. */
export const PAGE_MAX_LINKS = 500;

/** Pixels (width × height) of one embedded image pdf.js will decode; larger ones are left out. */
export const PDF_MAX_IMAGE_PIXELS = 64_000_000;
