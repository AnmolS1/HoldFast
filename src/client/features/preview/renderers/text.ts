/** Lines drawn at most; the rest is the download's. */
export const TEXT_MAX_LINES = 5_000;
/** Above this many characters the text is shown without highlighting (it would stall the page). */
export const HIGHLIGHT_MAX_CHARS = 200_000;
/** A file with a line longer than this is shown without highlighting. */
export const HIGHLIGHT_MAX_LINE = 2_000;

/** UTF-8, or — when the bytes are not valid UTF-8 — Latin-1. */
export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}
