/** Lines drawn at most (two elements each); the rest is the download's. */
export const TEXT_MAX_LINES = 5_000;
/** Highlighted pieces drawn at most (one element each): a run that passes it stops and the text stays plain. */
export const TEXT_MAX_PIECES = 50_000;
/** Above this many characters the text is shown without highlighting (it would stall the page). */
export const HIGHLIGHT_MAX_CHARS = 200_000;
/** Above this many lines, likewise. */
export const HIGHLIGHT_MAX_LINES = TEXT_MAX_LINES;
/** A file with a line longer than this is shown without highlighting. */
export const HIGHLIGHT_MAX_LINE = 2_000;

/**
 * Whether a text may be highlighted at all — asked before the highlighter is even loaded, on the
 * three things its work grows with.
 */
export function canHighlight(lines: readonly string[], chars: number): boolean {
  if (chars > HIGHLIGHT_MAX_CHARS || lines.length > HIGHLIGHT_MAX_LINES) return false;
  return lines.every((line) => line.length <= HIGHLIGHT_MAX_LINE);
}

/** UTF-8, or — when the bytes are not valid UTF-8 — Latin-1. */
export function decodeText(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}
