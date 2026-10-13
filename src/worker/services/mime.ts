// The MIME policy: what a file is (detection), what it may be served as, and what the SPA may do
// with it. The files host, the previews and search all decide through this file.
//
// THE RULES
//  - Everything is decided from the DETECTED type (`nodes.mimeSniffed`, written by the scan
//    consumer from `sniff` below). The type the browser declared at upload and the file's
//    extension never decide how bytes are served.
//  - `inlineAllowed` is an allow-list of media a browser renders without running anything in it.
//    HTML, SVG and every XML type are never on it, and `serveType` turns them into
//    `application/octet-stream` — an SVG whose root element lies beyond the detected prefix is
//    still "some XML", and that rule is what keeps it inert.
//  - A type on a list is permission to try, never a promise (a thumbnail that fails to render
//    degrades to the type icon in the files host).

import { fileTypeFromBuffer } from "file-type";
import { INLINE_TYPES, PREVIEW_TEXT_TYPES, THUMB_INPUT_MAX_BYTES } from "../../shared/constants";
import { BARE_TYPE, inlineAllowed, OCTET_STREAM } from "../../shared/mime";

// The pure half of the policy — the lists and every predicate that only looks at a type, an
// extension and a size — lives in `src/shared` (the SPA's viewers ask the same code). It is
// re-exported here under the same names.
export { INLINE_TYPES, PREVIEW_TEXT_TYPES };
export {
  categoryOf,
  inlineAllowed,
  inlineKindAllowed,
  isActiveType,
  OCTET_STREAM,
  previewFetchAllowed,
  serveType,
} from "../../shared/mime";

/** How many leading bytes of an object `sniff` is given. A shorter object passes all of it. */
export const SNIFF_PREFIX_BYTES = 8_192;

/**
 * Images the thumbnailer is asked to transform. AVIF and BMP are inline types but not here (the
 * image service does not take them); SVG is never here. Reached only through `thumbEligible`.
 */
const THUMB_TYPES: readonly string[] = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/heic",
  "image/heif",
]);

/** Extensions that get a warning page before a public-link download. */
const DANGEROUS_EXTS: readonly string[] = Object.freeze([
  "exe",
  "msi",
  "dmg",
  "pkg",
  "scr",
  "bat",
  "cmd",
  "com",
  "ps1",
  "sh",
  "jar",
  "apk",
  "ipa",
  "vbs",
  "js",
  "jse",
  "wsf",
  "hta",
  "lnk",
  "reg",
  "iso",
  "img",
]);

/** Detected types that are executables or installers whatever the file is called. */
const DANGEROUS_TYPES: readonly string[] = Object.freeze([
  "application/x-msdownload",
  "application/x-elf",
  "application/x-mach-binary",
  "application/x-apple-diskimage",
  "application/x-iso9660-image",
  "application/vnd.android.package-archive",
  "application/java-archive",
  "application/x-ms-shortcut",
  "application/x-ms-regedit",
  "application/vnd.ms-htmlhelp",
  "application/x-deb",
  "application/x-rpm",
  "application/x-google-chrome-extension",
  "application/x-xpinstall",
]);

// Characters that reorder the text of a file name: the bidi marks, embeddings, overrides and
// isolates. (Not the zero-width joiner: emoji sequences are made of it.)
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

const lower = (value: string | null | undefined): string => (value ?? "").trim().toLowerCase();

/** The last extension of a name, lower-case, without the dot. Trailing dots and spaces are ignored. */
export function extOf(name: string): string {
  const cleaned = name.replace(BIDI, "").replace(/[. ]+$/, "");
  const dot = cleaned.lastIndexOf(".");
  return dot <= 0 ? "" : cleaned.slice(dot + 1).toLowerCase();
}

/** True for a file a public link shows a warning page for before the download starts. */
export function dangerousForPublicLink(name: string, mimeSniffed: string | null | undefined): boolean {
  // A name that carries bidi controls can show one extension and have another.
  if (name.replace(BIDI, "") !== name) return true;
  return DANGEROUS_EXTS.includes(extOf(name)) || DANGEROUS_TYPES.includes(lower(mimeSniffed));
}

export type DispositionKind = "download" | "inline" | "thumb";

/**
 * The `Content-Disposition` value (RFC 6266): `attachment` unless the request is for an inline
 * view AND the served type is on the inline list. Carries an ASCII fallback name and the full
 * name as `filename*`. CR, LF, other control characters, quotes and bidi controls never reach
 * the header.
 */
export function contentDisposition(kind: DispositionKind, name: string, servedType: string): string {
  const disposition = kind === "inline" && inlineAllowed(servedType) ? "inline" : "attachment";
  const clean =
    name
      .replace(LONE_SURROGATE, "\ufffd")
      .replace(CONTROLS, "")
      .replace(BIDI, "")
      .replace(/[/\\]/g, "_")
      .trim() || "download";
  const fallback = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["%]/g, "_");
  // RFC 5987 attr-char: what encodeURIComponent leaves alone, minus ' ( ) *.
  const encoded = encodeURIComponent(clean).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/**
 * True when a thumbnail may be asked for: the file is `clean`, its detected type is on the
 * thumbnail list, and it is not above the image service's input limit. The size is checked HERE
 * because the service's own failure for an oversize input is an untyped connection error.
 */
export function thumbEligible(file: {
  mimeSniffed: string | null | undefined;
  size: number;
  scanStatus: string;
}): boolean {
  return (
    file.scanStatus === "clean" &&
    THUMB_TYPES.includes(lower(file.mimeSniffed)) &&
    Number.isFinite(file.size) &&
    file.size <= THUMB_INPUT_MAX_BYTES
  );
}

// ── detection ───────────────────────────────────────────────────────────────────────────────

type Markup = { doctype: string | null; tag: string | null; truncated: boolean };

/** Index just past a `<!DOCTYPE …>` that starts at `from`, or -1 when it does not end in `text`. */
function endOfDoctype(text: string, from: number): number {
  let depth = 0;
  let quote = "";
  for (let i = from; i < text.length; i++) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[") depth += 1;
    else if (ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === ">" && depth === 0) return i + 1;
  }
  return -1;
}

/**
 * Reads the start of a text document: skips, in any order and repeatedly, a BOM, whitespace,
 * `<?…?>` instructions, comments and a DOCTYPE (remembering its name), then names the first tag.
 */
function readMarkup(text: string): Markup {
  let i = 0;
  let doctype: string | null = null;
  for (;;) {
    while (i < text.length && /[\s\ufeff]/.test(text[i]!)) i += 1;
    const rest = text.slice(i, i + 16).toLowerCase();
    if (rest.startsWith("<?")) {
      const end = text.indexOf("?>", i + 2);
      if (end === -1) return { doctype, tag: null, truncated: true };
      i = end + 2;
    } else if (rest.startsWith("<!--")) {
      const end = text.indexOf("-->", i + 4);
      if (end === -1) return { doctype, tag: null, truncated: true };
      i = end + 3;
    } else if (rest.startsWith("<!doctype")) {
      const name = /^\s+([a-z0-9:_.-]+)/i.exec(text.slice(i + 9, i + 9 + 80));
      doctype ??= name ? name[1]!.toLowerCase() : "";
      const end = endOfDoctype(text, i + 9);
      if (end === -1) return { doctype, tag: null, truncated: true };
      i = end;
    } else break;
  }
  const tag = /^<([a-z][a-z0-9:_.-]*)/i.exec(text.slice(i, i + 80));
  // `<svg:svg …>` is an svg element too.
  const local = tag ? tag[1]!.toLowerCase().split(":").pop()! : null;
  return { doctype, tag: local, truncated: false };
}

/** The prefix as text when it is UTF-8 without control characters; null otherwise. */
function asText(prefix: Uint8Array): string | null {
  if (prefix.length === 0) return null;
  // A prefix may end in the middle of a multi-byte character: allow up to three bytes of that.
  for (let cut = 0; cut <= 3 && cut < prefix.length; cut++) {
    try {
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(
        prefix.subarray(0, prefix.length - cut),
      );
      // eslint-disable-next-line no-control-regex -- binary data is recognised by its control bytes
      return /[\u0000-\u0008\u000e-\u001a\u001c-\u001f\u007f]/.test(text) ? null : text;
    } catch {
      // not UTF-8 at this length
    }
  }
  return null;
}

function textTypeFor(name: string): string {
  const ext = extOf(name);
  if (ext === "md" || ext === "markdown") return "text/markdown";
  if (ext === "csv") return "text/csv";
  return "text/plain";
}

/**
 * Detects what an object is from its first bytes; the result becomes `nodes.mimeSniffed`.
 * Always a bare lower-case `type/subtype`.
 *
 * ASYNC: the detector has no synchronous API. A caller that forgets `await` would store
 * "[object Promise]".
 *
 * The binary detector decides first. When it has no answer, or says only `application/xml`, the
 * prefix is read as text: an SVG that starts with an XML declaration is reported by the detector
 * as plain XML, exactly like any other XML file, so "it is only XML" cannot be trusted.
 * `name` only refines plain text into Markdown or CSV; it never produces an active type.
 *
 * Never classify with the image service's `info()`: locally it reports a HEIC as AVIF.
 */
export async function sniff(prefix: Uint8Array, name: string): Promise<string> {
  let detected: string | undefined;
  try {
    const result = await fileTypeFromBuffer(prefix.subarray(0, SNIFF_PREFIX_BYTES));
    // The detector spells some types with parameters ("audio/ogg; codecs=opus").
    detected = result?.mime.split(";", 1)[0]!.trim().toLowerCase();
  } catch {
    // A throw is "no result".
    detected = undefined;
  }
  if (detected !== undefined && detected !== "application/xml") {
    return BARE_TYPE.test(detected) ? detected : OCTET_STREAM;
  }

  const lossy = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
    prefix.subarray(0, SNIFF_PREFIX_BYTES),
  );
  const markup = readMarkup(lossy);
  if (markup.doctype === "svg" || markup.tag === "svg") return "image/svg+xml";
  if (markup.doctype === "html" || markup.tag === "html" || markup.tag === "script") return "text/html";
  if (detected === "application/xml") return "application/xml";
  return asText(prefix.subarray(0, SNIFF_PREFIX_BYTES)) === null ? OCTET_STREAM : textTypeFor(name);
}
