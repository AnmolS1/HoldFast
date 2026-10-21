// File and folder names: the stored form, the uniqueness key and the extension.
//
// `sanitizeName` — the stored form (every writer of a name goes through it):
//   - NFC;
//   - removed: Unicode Cc and Cf — C0/C1 controls, bidi embeddings / overrides / isolates
//     (U+202A–E, U+2066–9), zero-width characters (U+200B–D) and the BOM (U+FEFF);
//   - every run of white space becomes one space, and the ends are trimmed;
//   - refused (`validation`): empty, `.`, `..`, a `/` or `\` anywhere, more than 255 bytes of UTF-8;
//   - the case of the extension, like the rest of the name, is kept.
// A reserved Windows device name (CON, NUL, COM1, …) may be stored as it is; only the name a
// download is saved under changes (`downloadName`).
//
// `nameKeyOf` and `extOf` keep their meaning for every value already stored: both clean a name
// exactly as before (NFC, Cc/Cf removed, trimmed) — the white-space rule is applied by
// `sanitizeName` only, so the key of a stored "a  b" is still "a  b".

import { QueryError } from "../db/errors";

// Unicode categories Cc (control characters) and Cf (format characters: zero-width characters,
// bidi embeddings / overrides / isolates, the BOM). Written as categories so that this file
// contains no invisible character.
const STRIP = /[\p{Cc}\p{Cf}]/gu;
// White space that survives STRIP: the space separators (Zs: U+0020, U+00A0, U+2000-200A, U+3000 ...)
// and the line / paragraph separators (U+2028, U+2029).
const SPACES = /[\p{Zs}\u2028\u2029]+/gu;

export const MAX_NAME_BYTES = 255;

const utf8 = new TextEncoder();
/** The length of a name as stored: bytes of UTF-8. */
export const byteLength = (name: string): number => utf8.encode(name).length;

function clean(raw: string): string {
  return raw.normalize("NFC").replace(STRIP, "").trim();
}

/** The name as stored. Throws `validation` for a name that cannot be used. */
export function sanitizeName(raw: string): string {
  const name = clean(raw).replace(SPACES, " ");
  if (name === "" || name === "." || name === "..") throw new QueryError("validation", "invalid name");
  if (name.includes("/") || name.includes("\\")) throw new QueryError("validation", "invalid name");
  if (byteLength(name) > MAX_NAME_BYTES) throw new QueryError("validation", "name too long");
  return name;
}

/** What uniqueness within a folder and ordering by name compare. */
export function nameKeyOf(name: string): string {
  return clean(name).toLocaleLowerCase("en");
}

/** Lower-case extension without the dot; '' when there is none (also for ".gitignore"). */
export function extOf(name: string): string {
  const cleaned = clean(name);
  const dot = cleaned.lastIndexOf(".");
  if (dot <= 0 || dot === cleaned.length - 1) return "";
  const ext = cleaned.slice(dot + 1).toLocaleLowerCase("en");
  return /^[a-z0-9_+-]{1,16}$/.test(ext) ? ext : "";
}

/**
 * `stem` cut so that `stem + tail` is at most `max` bytes of UTF-8 — never inside a code point
 * (a surrogate pair stays whole). For a name that must keep its tail: " (2).pdf", an extension.
 */
export function fitName(stem: string, tail: string, max: number = MAX_NAME_BYTES): string {
  let room = max - byteLength(tail);
  let kept = "";
  for (const char of stem) {
    room -= byteLength(char);
    if (room < 0) break;
    kept += char;
  }
  return kept + tail;
}

// Windows refuses these as a file's name, with or without an extension, in any case: the device
// names, and COM/LPT with a digit (superscript digits included).
const RESERVED = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³])$/i;

/**
 * The name a download is saved under: the stored name, with `_` after the stem of a reserved
 * Windows device name (`CON.txt` → `CON_.txt`, `nul` → `nul_`), so that saving it on Windows
 * neither fails nor opens a device.
 */
export function downloadName(name: string): string {
  const dot = name.indexOf(".");
  const stem = dot === -1 ? name : name.slice(0, dot);
  if (!RESERVED.test(stem.trimEnd())) return name;
  return `${stem}_${dot === -1 ? "" : name.slice(dot)}`;
}
