// File names (T26 item 6): every rule of `sanitizeName`, at its boundary, with the RTLO fixture;
// `nameKeyOf` / `extOf` unchanged for stored names; the download name of a reserved Windows name.
// Invisible characters are written as escapes, so this file contains none.
import { describe, expect, it } from "vitest";
import { QueryError } from "../../../src/worker/db/errors";
import {
  byteLength,
  downloadName,
  extOf,
  fitName,
  MAX_NAME_BYTES,
  nameKeyOf,
  sanitizeName,
} from "../../../src/worker/services/filename";

const refused = (raw: string): string | null => {
  try {
    sanitizeName(raw);
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(QueryError);
    return (error as QueryError).code;
  }
};

describe("sanitizeName", () => {
  it.each([
    // NFC: e + COMBINING ACUTE ACCENT \u2192 \u00e9
    ["cafe\u0301.txt", "caf\u00e9.txt"],
    // The RTLO fixture: "invoice\u202efdp.exe" displays as "invoiceexe.pdf".
    ["invoice\u202efdp.exe", "invoicefdp.exe"],
    // Each bidi embedding / override / isolate.
    ["a\u202ab\u202bc\u202cd\u202de\u202ef", "abcdef"],
    ["a\u2066b\u2067c\u2068d\u2069e", "abcde"],
    // Zero-width space / non-joiner / joiner, the BOM.
    ["a\u200bb\u200cc\u200dd\ufeffe", "abcde"],
    // C0 (NUL, BEL, ESC, DEL) and C1 (U+0080, U+009F) controls.
    ["a\u0000b\u0007c\u001bd\u007fe\u0080f\u009fg", "abcdefg"],
    // Tab, CR and LF are controls: removed, not turned into spaces.
    ["a\tb\r\nc", "abc"],
    // White space: every run becomes one space; the ends are trimmed.
    ["  a   b  ", "a b"],
    ["a\u00a0\u00a0b\u3000c\u2003d\u2028e\u2029f", "a b c d e f"],
    // The case of the extension, and of the rest, is kept.
    ["Report.PDF", "Report.PDF"],
    ["archive.Tar.GZ", "archive.Tar.GZ"],
    // A reserved Windows name may be stored as it is.
    ["CON", "CON"],
    ["nul.txt", "nul.txt"],
    // Dots are fine anywhere but as the whole name.
    ["...", "..."],
    [".gitignore", ".gitignore"],
  ])("%j \u2192 %j", (raw, stored) => {
    expect(sanitizeName(raw)).toBe(stored);
  });

  it.each([
    ["", "empty"],
    ["   ", "only spaces"],
    ["\u200b\u202e", "only invisible characters"],
    [".", "dot"],
    ["..", "dot dot"],
    [" .. ", "dot dot, padded"],
    [".\u200b.", "dot dot around a zero-width space"],
    ["a/b", "slash"],
    ["a\\b", "backslash"],
    ["/", "slash alone"],
  ])("%j (%s) is refused", (raw) => {
    expect(refused(raw)).toBe("validation");
  });

  it("NFC after stripping: an invisible character between a letter and its accent does not leave the name decomposed", () => {
    // e, ZERO WIDTH SPACE, COMBINING ACUTE ACCENT: stripped first, then composed.
    const stored = sanitizeName("e​́.txt");
    expect(stored).toBe("é.txt");
    expect(stored).toBe(stored.normalize("NFC"));
  });

  it("a lone surrogate is refused (a high or a low one, anywhere); a whole pair is kept", () => {
    for (const raw of ["a\ud800b", "\udfff.txt", "name\ud83d"])
      expect(refused(raw), JSON.stringify(raw)).toBe("validation");
    expect(sanitizeName("😀.txt")).toBe("\u{1f600}.txt");
  });

  it("255 bytes of UTF-8 is the limit, counted in bytes, not characters", () => {
    expect(sanitizeName("x".repeat(255))).toHaveLength(255);
    expect(refused("x".repeat(256))).toBe("validation");
    // \u00e9 is 2 bytes: 127 of them are 254 bytes, 128 are 256.
    expect(byteLength(sanitizeName("\u00e9".repeat(127)))).toBe(254);
    expect(refused("\u00e9".repeat(128))).toBe("validation");
    // \u{1f600} is 4 bytes (2 UTF-16 units): 63 \u2192 252 bytes, 64 \u2192 256.
    expect(sanitizeName("\u{1f600}".repeat(63))).toHaveLength(126);
    expect(refused("\u{1f600}".repeat(64))).toBe("validation");
    // Measured after cleaning: invisible characters and padding do not count.
    expect(sanitizeName(`  ${"x".repeat(255)}\u200b\u200b  `)).toHaveLength(255);
    // NFC first: 255 decomposed "\u00e9" would be 765 bytes; composed they are 510 \u2014 still too long.
    expect(refused("e\u0301".repeat(128))).toBe("validation");
    expect(byteLength(sanitizeName("e\u0301".repeat(127)))).toBe(254);
  });
});

describe("nameKeyOf and extOf: the meaning of every stored value is unchanged", () => {
  it("a stored name keeps its key \u2014 white space is NOT collapsed in the key", () => {
    expect(nameKeyOf("a  b")).toBe("a  b");
    expect(nameKeyOf("Report.PDF")).toBe("report.pdf");
    expect(nameKeyOf("a\u200bB")).toBe("ab");
    expect(nameKeyOf(" Padded ")).toBe("padded");
    expect(extOf("archive.TAR.GZ")).toBe("gz");
    expect(extOf("x.ext with space")).toBe("");
    expect(extOf("README")).toBe("");
    expect(extOf(".gitignore")).toBe("");
  });

  it("the key of a sanitised name is the key of what is stored", () => {
    for (const raw of ["  A   B.TXT ", "invoice\u202efdp.exe", "cafe\u0301"]) {
      expect(nameKeyOf(sanitizeName(raw))).toBe(sanitizeName(raw).toLocaleLowerCase("en"));
    }
  });
});

describe("downloadName: a reserved Windows name is saved with `_` after its stem", () => {
  it.each([
    ["CON", "CON_"],
    ["con.txt", "con_.txt"],
    ["NUL.tar.gz", "NUL_.tar.gz"],
    ["Aux.Md", "Aux_.Md"],
    ["prn", "prn_"],
    ["COM1.log", "COM1_.log"],
    ["lpt9", "lpt9_"],
    ["COM\u00b9", "COM\u00b9_"],
    ["CON .txt", "CON _.txt"],
  ])("%j \u2192 %j", (stored, saved) => {
    expect(downloadName(stored)).toBe(saved);
  });

  it.each(["CONSOLE.txt", "icon.png", "COM10", "LPT", "nul-report.pdf", "my CON.txt", "a.con"])(
    "%j is not reserved",
    (stored) => {
      expect(downloadName(stored)).toBe(stored);
    },
  );
});

describe("fitName: a stem cut to fit before a tail, in bytes, never inside a character", () => {
  it("keeps the tail whole and stays within the limit", () => {
    expect(fitName("x".repeat(300), " (2).pdf")).toBe(`${"x".repeat(MAX_NAME_BYTES - 8)} (2).pdf`);
    const emoji = fitName("\u{1f600}".repeat(100), ".txt");
    expect(byteLength(emoji)).toBeLessThanOrEqual(MAX_NAME_BYTES);
    expect(emoji).toBe(`${"\u{1f600}".repeat(62)}.txt`);
    // No lone surrogate: the string survives a UTF-8 round trip unchanged.
    expect(new TextDecoder().decode(new TextEncoder().encode(emoji))).toBe(emoji);
    expect(fitName("short", ".txt")).toBe("short.txt");
  });
});
