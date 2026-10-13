// The MIME policy table and the detector. Runs inside workerd, where the detector runs when deployed.
import { fileTypeFromBuffer } from "file-type";
import { describe, expect, it } from "vitest";
import {
  MIME_CATEGORIES,
  PREVIEW_TEXT_MAX_BYTES,
  THUMB_INPUT_MAX_BYTES,
} from "../../../src/shared/constants";
import {
  categoryOf,
  contentDisposition,
  dangerousForPublicLink,
  extOf,
  inlineAllowed,
  inlineKindAllowed,
  INLINE_TYPES,
  isActiveType,
  previewFetchAllowed,
  serveType,
  sniff,
  SNIFF_PREFIX_BYTES,
  thumbEligible,
} from "../../../src/worker/services/mime";
import helloText from "../../fixtures/files/hello.txt?raw";
import pageHtml from "../../fixtures/files/page.html?raw";
import scriptSvg from "../../fixtures/files/script.svg?raw";
import { eicarBytes, pngBytes, RTLO, RTLO_FILE_NAME, zipBytes } from "../../setup/fixture-bytes";

const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);
const BOM = Uint8Array.of(0xef, 0xbb, 0xbf);

function join(...chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** The first `SNIFF_PREFIX_BYTES` of a file padded with zeros to more than that (as the consumer reads it). */
function prefixOf(bytes: Uint8Array, pad = true): Uint8Array {
  const whole = pad ? join(bytes, new Uint8Array(SNIFF_PREFIX_BYTES + 100)) : bytes;
  return whole.subarray(0, SNIFF_PREFIX_BYTES);
}

/** An ISO-BMFF `ftyp` box: the first 12–32 bytes decide the type. */
function ftyp(brand: string, compatible: string[] = []): Uint8Array {
  const body = text(brand + "\0\0\0\0" + compatible.join(""));
  const box = new Uint8Array(8 + body.length);
  new DataView(box.buffer).setUint32(0, box.length);
  box.set(text("ftyp"), 4);
  box.set(body, 8);
  // minor version: four zero bytes (written as NULs above)
  return box;
}

/** A QuickTime file from a writer that puts no `ftyp` box: the first atom is the given one. */
function atom(name: string): Uint8Array {
  const box = new Uint8Array(16);
  new DataView(box.buffer).setUint32(0, 16);
  box.set(text(name), 4);
  return box;
}

const PROLOG_SVG =
  '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" ' +
  '"http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg">' +
  "<script>alert(document.domain)</script></svg>";

const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
function docxBytes(): Uint8Array {
  return zipBytes([
    {
      name: "[Content_Types].xml",
      data: text(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          `<Override PartName="/word/document.xml" ContentType="${DOCX_TYPE}.main+xml"/></Types>`,
      ),
    },
    { name: "word/document.xml", data: text("<w:document/>") },
  ]);
}

const ACTIVE = [
  "image/svg+xml",
  "application/xml",
  "text/xml",
  "text/html",
  "application/xhtml+xml",
  "application/atom+xml",
  "application/vnd.google-earth.kml+xml",
];

describe("inlineAllowed and serveType", () => {
  it("the inline list is exactly the eighteen media types", () => {
    expect([...INLINE_TYPES].sort()).toEqual(
      [
        ...["jpeg", "png", "gif", "webp", "avif", "bmp", "heic", "heif"].map((t) => `image/${t}`),
        ...["mp4", "webm", "quicktime", "x-m4v"].map((t) => `video/${t}`),
        ...["mpeg", "ogg", "wav", "flac", "mp4", "x-m4a"].map((t) => `audio/${t}`),
      ].sort(),
    );
    for (const type of INLINE_TYPES) {
      expect(inlineAllowed(type), type).toBe(true);
      expect(serveType(type, "x"), type).toBe(type);
      expect(contentDisposition("inline", "x", serveType(type, "x")), type).toMatch(/^inline; /);
    }
  });

  it("SVG, HTML and every XML type are refused inline and served as an octet-stream attachment", () => {
    for (const type of ACTIVE) {
      expect(inlineAllowed(type), type).toBe(false);
      expect(isActiveType(type), type).toBe(true);
      expect(serveType(type, "picture.svg"), type).toBe("application/octet-stream");
      expect(contentDisposition("inline", "picture.svg", serveType(type, "picture.svg")), type).toMatch(
        /^attachment; /,
      );
      // Upper case and parameters do not get one through.
      expect(serveType(type.toUpperCase(), "x"), type).toBe("application/octet-stream");
      expect(serveType(`${type}; charset=utf-8`, "x"), type).toBe("application/octet-stream");
      expect(inlineAllowed(`${type}; charset=utf-8`), type).toBe(false);
    }
  });

  it("PDF is never inline; a missing or malformed type is an octet-stream", () => {
    expect(inlineAllowed("application/pdf")).toBe(false);
    expect(serveType("application/pdf", "a.pdf")).toBe("application/pdf");
    expect(contentDisposition("inline", "a.pdf", "application/pdf")).toMatch(/^attachment; /);
    expect(serveType(null, "a.jpg")).toBe("application/octet-stream");
    expect(serveType(undefined, "a.jpg")).toBe("application/octet-stream");
    expect(serveType("", "a.jpg")).toBe("application/octet-stream");
    // The name never decides, and neither does anything that is not a bare type.
    expect(serveType("image/png\r\nSet-Cookie: a=b", "a.png")).toBe("application/octet-stream");
    expect(serveType("[object Promise]", "a.png")).toBe("application/octet-stream");
    expect(serveType("image/png; a=b", "a.png")).toBe("application/octet-stream");
    expect(inlineAllowed(null)).toBe(false);
    expect(inlineAllowed("text/plain")).toBe(false);
    expect(inlineAllowed("application/octet-stream")).toBe(false);
  });

  it("inline is granted only to an inline REQUEST for an inline type", () => {
    for (const kind of ["download", "thumb"] as const) {
      expect(contentDisposition(kind, "a.png", "image/png"), kind).toMatch(/^attachment; /);
    }
    expect(contentDisposition("inline", "a.png", "image/png")).toMatch(/^inline; /);
    expect(contentDisposition("inline", "a.txt", "text/plain")).toMatch(/^attachment; /);
  });
});

describe("contentDisposition", () => {
  it("carries an ASCII fallback and the full name, percent-encoded", () => {
    expect(contentDisposition("download", "report.pdf", "application/pdf")).toBe(
      "attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
    );
    const unicode = contentDisposition("download", "Résumé – 日本語 (final)*.pdf", "application/pdf");
    expect(unicode).toBe(
      "attachment; filename=\"R_sum_ _ ___ (final)*.pdf\"; filename*=UTF-8''" +
        "R%C3%A9sum%C3%A9%20%E2%80%93%20%E6%97%A5%E6%9C%AC%E8%AA%9E%20%28final%29%2A.pdf",
    );
  });

  it("a CRLF injection attempt, quotes and bidi controls never reach the header", () => {
    const attack = 'a.txt"\r\nSet-Cookie: session=stolen\r\n\r\n<script>';
    const header = contentDisposition("download", attack, "text/plain");
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header.startsWith('attachment; filename="a.txt_Set-Cookie: session=stolen<script>"; ')).toBe(true);
    expect(header.split("filename*=UTF-8''")[1]).toBe("a.txt%22Set-Cookie%3A%20session%3Dstolen%3Cscript%3E");

    const bidi = contentDisposition("download", RTLO_FILE_NAME, "application/pdf");
    expect(bidi).toBe("attachment; filename=\"invoiceexe.pdf\"; filename*=UTF-8''invoiceexe.pdf");
    expect(bidi).not.toContain(RTLO);

    // A lone surrogate cannot be percent-encoded: it becomes the replacement character, no throw.
    expect(() => contentDisposition("download", `a${String.fromCharCode(0xd800)}b`, "x/y")).not.toThrow();
    expect(contentDisposition("download", "", "x/y")).toContain('filename="download"');
    expect(contentDisposition("download", "a/b\\c%41.txt", "x/y")).toContain('filename="a_b_c_41.txt"');
  });
});

describe("categories", () => {
  it("has exactly the eight keys, each with types and extensions", () => {
    expect(Object.keys(MIME_CATEGORIES)).toEqual([
      "image",
      "video",
      "audio",
      "pdf",
      "document",
      "archive",
      "code",
      "other",
    ]);
    expect(MIME_CATEGORIES.audio.types).toContain("audio/x-m4a");
    expect(MIME_CATEGORIES.video.types).toEqual(expect.arrayContaining(["video/x-m4v", "video/quicktime"]));
    expect(MIME_CATEGORIES.image.types).toEqual(expect.arrayContaining(["image/heic", "image/heif"]));
    // No type and no extension is claimed by two categories.
    for (const field of ["types", "exts"] as const) {
      const all = Object.values(MIME_CATEGORIES).flatMap((category) => [...category[field]]);
      expect(new Set(all).size, field).toBe(all.length);
    }
    // Every inline type has a category of its own kind.
    for (const type of INLINE_TYPES) expect(categoryOf(type, ""), type).toBe(type.split("/")[0]);
  });

  it("categoryOf: a specific detected type wins, a generic one defers to the extension", () => {
    expect(categoryOf("image/png", "png")).toBe("image");
    expect(categoryOf("audio/x-m4a", "m4a")).toBe("audio");
    expect(categoryOf("application/pdf", "pdf")).toBe("pdf");
    expect(categoryOf("application/zip", "zip")).toBe("archive");
    expect(categoryOf("text/plain", "py")).toBe("code");
    expect(categoryOf("text/plain", "txt")).toBe("document");
    expect(categoryOf("text/plain", "")).toBe("document");
    expect(categoryOf("text/html", "html")).toBe("code");
    expect(categoryOf(null, "JPG")).toBe("image");
    expect(categoryOf(null, ".mov")).toBe("video");
    expect(categoryOf(null, "")).toBe("other");
    expect(categoryOf("application/octet-stream", "docx")).toBe("document");
    // A program called photo.jpg does not show as an image.
    expect(categoryOf("application/x-msdownload", "jpg")).toBe("other");
    expect(categoryOf("application/zip", "jpg")).toBe("archive");
  });
});

describe("thumbEligible", () => {
  const clean = (mimeSniffed: string, size = 1000) =>
    thumbEligible({ mimeSniffed, size, scanStatus: "clean" });

  it("is true for exactly the six thumbnail types", () => {
    for (const type of ["jpeg", "png", "gif", "webp", "heic", "heif"])
      expect(clean(`image/${type}`)).toBe(true);
    for (const type of ["image/avif", "image/bmp", "image/svg+xml", "video/mp4", "application/pdf", ""]) {
      expect(clean(type), type).toBe(false);
    }
    expect(thumbEligible({ mimeSniffed: null, size: 1, scanStatus: "clean" })).toBe(false);
  });

  it("needs a clean file", () => {
    for (const scanStatus of ["pending", "infected", "under_review", "skipped", "error", "suspected_csam"]) {
      expect(thumbEligible({ mimeSniffed: "image/png", size: 1, scanStatus }), scanStatus).toBe(false);
    }
  });

  it("is true at exactly the input limit and false one byte above it", () => {
    expect(THUMB_INPUT_MAX_BYTES).toBe(20_000_000);
    expect(clean("image/heic", THUMB_INPUT_MAX_BYTES)).toBe(true);
    expect(clean("image/heic", THUMB_INPUT_MAX_BYTES + 1)).toBe(false);
    expect(clean("image/png", Number.NaN)).toBe(false);
  });
});

describe("previewFetchAllowed and inlineKindAllowed", () => {
  const node = (mimeSniffed: string | null, name: string, size = 1000) => ({
    mimeSniffed,
    name,
    ext: extOf(name),
    size,
  });

  it("media is inline", () => {
    for (const type of INLINE_TYPES) {
      expect(inlineKindAllowed(node(type, "a")), type).toBe(true);
      expect(previewFetchAllowed(node(type, "a")), type).toBe(false);
    }
  });

  it("PDF and text up to 2 MB are fetched as attachments", () => {
    const cases: [string, string][] = [
      ["application/pdf", "a.pdf"],
      ["text/plain", "a.txt"],
      ["text/markdown", "a.md"],
      ["text/csv", "a.csv"],
      ["text/plain", "main.py"],
      ["application/json", "package.json"],
    ];
    for (const [type, name] of cases) {
      const file = node(type, name);
      expect(previewFetchAllowed(file), name).toBe(true);
      expect(inlineKindAllowed(file), name).toBe(true);
      // Allowed to be fetched — and still an attachment when a browser navigates to it.
      expect(inlineAllowed(serveType(type, name)), name).toBe(false);
      expect(contentDisposition("inline", name, serveType(type, name)), name).toMatch(/^attachment; /);
    }
    expect(previewFetchAllowed(node("application/pdf", "big.pdf", 1_500_000_000))).toBe(true);
  });

  it("text is refused one byte above the limit", () => {
    expect(PREVIEW_TEXT_MAX_BYTES).toBe(2_000_000);
    expect(inlineKindAllowed(node("text/plain", "a.txt", PREVIEW_TEXT_MAX_BYTES))).toBe(true);
    expect(inlineKindAllowed(node("text/plain", "a.txt", PREVIEW_TEXT_MAX_BYTES + 1))).toBe(false);
    expect(inlineKindAllowed(node("text/plain", "main.py", PREVIEW_TEXT_MAX_BYTES + 1))).toBe(false);
  });

  it("HTML, SVG, XML, unknown bytes and unscanned files are refused", () => {
    for (const type of ACTIVE) {
      for (const name of ["a.html", "a.svg", "a.xml", "a.txt", "a.py"]) {
        expect(inlineKindAllowed(node(type, name)), `${type} ${name}`).toBe(false);
      }
    }
    expect(inlineKindAllowed(node("application/octet-stream", "main.py"))).toBe(false);
    expect(inlineKindAllowed(node(null, "main.py"))).toBe(false);
    expect(inlineKindAllowed(node(null, "a.png"))).toBe(false);
    expect(inlineKindAllowed(node("application/zip", "a.py"))).toBe(false);
    expect(inlineKindAllowed(node("application/x-msdownload", "a.txt"))).toBe(false);
  });
});

describe("dangerousForPublicLink", () => {
  it("flags the listed extensions, whatever the case and trailing dots", () => {
    const exts =
      "exe msi dmg pkg scr bat cmd com ps1 sh jar apk ipa vbs js jse wsf hta lnk reg iso img".split(" ");
    expect(exts).toHaveLength(22);
    for (const ext of exts) {
      expect(dangerousForPublicLink(`setup.${ext}`, null), ext).toBe(true);
      expect(dangerousForPublicLink(`setup.${ext.toUpperCase()}`, "text/plain"), ext).toBe(true);
    }
    expect(dangerousForPublicLink("photo.jpg.exe", "image/jpeg")).toBe(true);
    expect(dangerousForPublicLink("setup.exe.", null)).toBe(true);
    expect(dangerousForPublicLink("setup.exe ", null)).toBe(true);
  });

  it("flags a detected program whatever it is called, and a name with bidi controls", () => {
    expect(dangerousForPublicLink("holiday.jpg", "application/x-msdownload")).toBe(true);
    expect(dangerousForPublicLink("holiday.jpg", "application/x-mach-binary")).toBe(true);
    expect(dangerousForPublicLink(RTLO_FILE_NAME, "application/pdf")).toBe(true);
  });

  it("leaves ordinary files alone", () => {
    for (const [name, type] of [
      ["photo.jpg", "image/jpeg"],
      ["notes.txt", "text/plain"],
      ["exe", null],
      ["archive.zip", "application/zip"],
      ["my.executable.pdf", "application/pdf"],
      ["family 👨‍👩‍👧.png", "image/png"],
    ] as const) {
      expect(dangerousForPublicLink(name, type), name).toBe(false);
    }
  });
});

describe("sniff", () => {
  it("resolves to a string (a missing await would store a Promise)", async () => {
    const pending = sniff(text("hello"), "a.txt");
    expect(pending).toBeInstanceOf(Promise);
    expect(await pending).toBe("text/plain");
  });

  it("an SVG that starts with <svg is image/svg+xml", async () => {
    expect(await fileTypeFromBuffer(prefixOf(text(scriptSvg), false))).toBeUndefined();
    expect(await sniff(prefixOf(text(scriptSvg), false), "script.svg")).toBe("image/svg+xml");
    expect(await sniff(text("  \n<SVG xmlns='x'/>"), "a.txt")).toBe("image/svg+xml");
    expect(await sniff(text("<svg:svg xmlns:svg='http://www.w3.org/2000/svg'/>"), "a")).toBe("image/svg+xml");
  });

  it("the prolog SVG is image/svg+xml although the detector alone says application/xml", async () => {
    const prefix = prefixOf(text(PROLOG_SVG), false);
    // The control: without the text detection this file is "just XML".
    expect(await fileTypeFromBuffer(prefix)).toMatchObject({ mime: "application/xml" });
    expect(await sniff(prefix, "drawing.svg")).toBe("image/svg+xml");
    // The name plays no part.
    expect(await sniff(prefix, "notes.txt")).toBe("image/svg+xml");
    // With comments and instructions before the root element.
    const noisy = `<?xml version="1.0"?>\n<!-- a > comment -->\n<?xml-stylesheet href="a.css"?>\n<svg/>`;
    expect(await sniff(text(noisy), "a.xml")).toBe("image/svg+xml");
    // With a DOCTYPE that has an internal subset.
    const subset = `<?xml version="1.0"?><!DOCTYPE svg [ <!ENTITY a "]>"> ]><svg>&a;</svg>`;
    expect(await sniff(text(subset), "a.xml")).toBe("image/svg+xml");
  });

  it("HTML with and without a BOM is text/html", async () => {
    expect(await fileTypeFromBuffer(text(pageHtml))).toBeUndefined();
    expect(await sniff(text(pageHtml), "page.html")).toBe("text/html");
    expect(await sniff(join(BOM, text(pageHtml)), "page.html")).toBe("text/html");
    expect(await sniff(join(BOM, text("<html><body>x</body></html>")), "a.txt")).toBe("text/html");
    expect(await sniff(text("<!-- c --><script>alert(1)</script>"), "a.txt")).toBe("text/html");
    expect(await sniff(text('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"/>'), "a")).toBe(
      "text/html",
    );
    expect(await sniff(text("<!DOCTYPE HTML PUBLIC '-//W3C//DTD HTML 4.01//EN'><p>x"), "a")).toBe(
      "text/html",
    );
  });

  it("a plain XML document stays application/xml, also when a skipped construct runs off the prefix", async () => {
    expect(await sniff(text('<?xml version="1.0"?>\n<catalog><item/></catalog>'), "a.xml")).toBe(
      "application/xml",
    );
    const late = `<?xml version="1.0"?><!--${"x".repeat(SNIFF_PREFIX_BYTES)}--><svg><script/></svg>`;
    const answer = await sniff(prefixOf(text(late), false), "late.svg");
    // The root element is beyond the prefix: this stays "some XML" — and XML is never served live.
    expect(answer).toBe("application/xml");
    expect(inlineAllowed(answer)).toBe(false);
    expect(serveType(answer, "late.svg")).toBe("application/octet-stream");
    expect(inlineKindAllowed({ mimeSniffed: answer, name: "late.svg", ext: "svg", size: 10 })).toBe(false);
  });

  it("plain text is text/plain, refined by the name to Markdown or CSV and to nothing else", async () => {
    expect(await sniff(prefixOf(text(helloText), false), "hello.txt")).toBe("text/plain");
    expect(await sniff(text("# Title\n\ntext"), "README.md")).toBe("text/markdown");
    expect(await sniff(text("a,b\n1,2\n"), "data.CSV")).toBe("text/csv");
    expect(await sniff(text("print('hi')\n"), "main.py")).toBe("text/plain");
    // A name never makes text into an active type.
    expect(await sniff(text("just words"), "page.html")).toBe("text/plain");
    expect(await sniff(text("just words"), "drawing.svg")).toBe("text/plain");
    expect(await sniff(eicarBytes(), "eicar.com.txt")).toBe("text/plain");
    // A multi-byte character cut by the end of the prefix is still text.
    const cut = text("é".repeat(SNIFF_PREFIX_BYTES)).subarray(0, SNIFF_PREFIX_BYTES - 1);
    expect(await sniff(cut, "a.txt")).toBe("text/plain");
  });

  it("unknown bytes and an empty file are application/octet-stream", async () => {
    expect(await sniff(Uint8Array.of(0, 1, 2, 3, 0xff, 0xfe, 0x00, 0x10), "a.txt")).toBe(
      "application/octet-stream",
    );
    expect(await sniff(new Uint8Array(0), "a.txt")).toBe("application/octet-stream");
    expect(await sniff(new Uint8Array(SNIFF_PREFIX_BYTES), "zeros.bin")).toBe("application/octet-stream");
  });

  it("ISO-BMFF types are decided by the ftyp box", async () => {
    const cases: [string, Uint8Array, string][] = [
      ["mp4", ftyp("isom", ["isom", "iso2", "avc1", "mp41"]), "video/mp4"],
      ["m4v", ftyp("M4V ", ["M4V ", "M4A ", "mp42", "isom"]), "video/x-m4v"],
      ["m4a", ftyp("M4A ", ["M4A ", "mp42", "isom"]), "audio/x-m4a"],
      ["heic", ftyp("heic", ["mif1", "heic"]), "image/heic"],
      ["mov", ftyp("qt  ", ["qt  "]), "video/quicktime"],
    ];
    for (const [ext, header, expected] of cases) {
      expect(await sniff(prefixOf(header), `clip.${ext}`), ext).toBe(expected);
      // The first 12 bytes are enough, and the name is irrelevant.
      expect(await sniff(header.subarray(0, 12), "renamed.txt"), `${ext} 12 bytes`).toBe(expected);
    }
  });

  it("a QuickTime file without an ftyp box is video/quicktime (first atom wide, moov, mdat)", async () => {
    for (const first of ["wide", "moov", "mdat"]) {
      expect(await sniff(prefixOf(atom(first)), "old.mov"), first).toBe("video/quicktime");
    }
  });

  it("PNG, PDF and zip are their types; a .docx is its office type from 512 bytes", async () => {
    const png = pngBytes(64, 32);
    expect(await sniff(prefixOf(png), "a.png")).toBe("image/png");
    expect(await sniff(prefixOf(text("%PDF-1.4\n%%EOF\n")), "a.pdf")).toBe("application/pdf");
    const zip = zipBytes([{ name: "readme.txt", data: text("hello") }]);
    expect(await sniff(prefixOf(zip, false), "a.zip")).toBe("application/zip");

    const docx = docxBytes();
    expect(docx.length).toBeGreaterThan(300);
    expect(await sniff(docx.subarray(0, 12), "a.docx")).toBe("application/zip");
    expect(await sniff(prefixOf(docx, false), "a.docx")).toBe(DOCX_TYPE);
    expect(await sniff(join(docx, new Uint8Array(1000)).subarray(0, 512), "a.docx")).toBe(DOCX_TYPE);
  });

  it("a truncated zip prefix does not throw", async () => {
    const zip = zipBytes([{ name: "a/very/long/entry/name.bin", data: new Uint8Array(4000) }]);
    for (const length of [4, 12, 30, 40, 100, 2000]) {
      expect(await sniff(zip.subarray(0, length), "a.zip"), String(length)).toBe("application/zip");
    }
  });

  it("the eight types the spike observed are emitted exactly and are all inline types", async () => {
    const jpeg = join(Uint8Array.of(0xff, 0xd8, 0xff, 0xe0, 0, 16), text("JFIF\0"), new Uint8Array(32));
    // EBML header with DocType "webm".
    const webm = join(
      Uint8Array.of(0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01),
      Uint8Array.of(0x42, 0xf2, 0x81, 0x04, 0x42, 0xf3, 0x81, 0x08, 0x42, 0x82, 0x84),
      text("webm"),
      Uint8Array.of(0x42, 0x87, 0x81, 0x04, 0x42, 0x85, 0x81, 0x02),
      new Uint8Array(600),
    );
    const observed: Record<string, Uint8Array> = {
      "video/mp4": ftyp("isom", ["isom", "mp41"]),
      "video/quicktime": ftyp("qt  ", ["qt  "]),
      "video/webm": webm,
      "video/x-m4v": ftyp("M4V ", ["M4V ", "mp42"]),
      "audio/x-m4a": ftyp("M4A ", ["M4A ", "mp42"]),
      "image/heic": ftyp("heic", ["mif1", "heic"]),
      "image/jpeg": jpeg,
      "image/png": pngBytes(8, 8),
    };
    expect(Object.keys(observed)).toHaveLength(8);
    for (const [expected, bytes] of Object.entries(observed)) {
      const answer = await sniff(prefixOf(bytes), "file.bin");
      expect(answer, expected).toBe(expected);
      expect(inlineAllowed(answer), expected).toBe(true);
    }
  });

  it("records what the detector emits for the other inline entries (a table for the report, never a failure)", async () => {
    const riff = (form: string) =>
      join(text("RIFF"), Uint8Array.of(36, 0, 0, 0), text(form), new Uint8Array(64));
    const headers: Record<string, Uint8Array> = {
      "image/gif": join(text("GIF89a"), new Uint8Array(32)),
      "image/webp": riff("WEBP"),
      "image/avif": ftyp("avif", ["avif", "mif1", "miaf"]),
      "image/bmp": join(text("BM"), new Uint8Array(64)),
      "image/heif": ftyp("mif1", ["mif1", "heif"]),
      "audio/mpeg": join(
        text("ID3"),
        Uint8Array.of(3, 0, 0, 0, 0, 0, 0),
        Uint8Array.of(0xff, 0xfb, 0x90, 0x64),
      ),
      "audio/ogg": join(
        text("OggS"),
        new Uint8Array(24),
        Uint8Array.of(1),
        text("vorbis"),
        new Uint8Array(64),
      ),
      "audio/wav": riff("WAVE"),
      "audio/flac": join(text("fLaC"), new Uint8Array(64)),
      "audio/mp4": ftyp("M4B ", ["M4B ", "mp42", "isom"]),
    };
    expect(Object.keys(headers).sort()).toEqual(
      INLINE_TYPES.filter(
        (type) =>
          ![
            "video/mp4",
            "video/quicktime",
            "video/webm",
            "video/x-m4v",
            "audio/x-m4a",
            "image/heic",
            "image/jpeg",
            "image/png",
          ].includes(type),
      ).sort(),
    );
    const rows: string[] = [];
    for (const [entry, bytes] of Object.entries(headers)) {
      const emitted = await sniff(prefixOf(bytes), "file.bin");
      expect(typeof emitted).toBe("string");
      rows.push(`${entry}\t${emitted}\t${emitted === entry ? "same" : "DIFFERENT"}`);
    }
    console.log(`SNIFF-TABLE entry\temitted\tverdict\n${rows.map((row) => `SNIFF-TABLE ${row}`).join("\n")}`);
  });
});
