// Fixture files on disk, for Playwright (`setInputFiles`) and Node tests. Node only.
//
// Three small files are committed under tests/fixtures/files/. Everything else — the 2 MB PNG, the
// 140,000,000-byte sparse file, the antivirus test file, the nested archive and the file with a
// right-to-left override in its name — is written to tests/fixtures/files/generated/ (ignored) the
// first time a test asks for it.
import {
  closeSync,
  existsSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  eicarBytes,
  nestedEicarZipBytes,
  pngBytes,
  RTLO_FILE_NAME,
  SPARSE_FILE_BYTES,
} from "./fixture-bytes";

const filesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/files");
const generatedDir = join(filesDir, "generated");

export interface FixtureFiles {
  /** 1,024 bytes of ASCII text (committed). */
  text: string;
  /** An SVG that carries a `<script>` (committed). */
  svgWithScript: string;
  /** An HTML page with an inline script (committed). */
  html: string;
  /** A valid PNG of about 2 MB. */
  png: string;
  /** Exactly 140,000,000 zero bytes; sparse, so it takes no disk space. Three 64 MiB parts. */
  sparse140MB: string;
  /** The EICAR antivirus test file. */
  eicar: string;
  /** A zip that holds a zip that holds the EICAR file. */
  nestedEicarZip: string;
  /** A PDF-looking file whose name contains a right-to-left override. */
  rtloName: string;
}

function writeOnce(path: string, bytes: () => Uint8Array): string {
  if (!existsSync(path)) {
    // Write beside the target and rename: a parallel worker never sees a half-written file.
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, bytes());
    renameSync(temp, path);
  }
  return path;
}

function sparseFile(path: string, size: number): string {
  if (!existsSync(path) || statSync(path).size !== size) {
    const temp = `${path}.${process.pid}.tmp`;
    const fd = openSync(temp, "w");
    try {
      ftruncateSync(fd, size);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, path);
  }
  return path;
}

/** Paths of every fixture file, generating the ones that are not committed. Safe to call often. */
export function fixtureFiles(): FixtureFiles {
  mkdirSync(generatedDir, { recursive: true });
  return {
    text: join(filesDir, "hello.txt"),
    svgWithScript: join(filesDir, "script.svg"),
    html: join(filesDir, "page.html"),
    png: writeOnce(join(generatedDir, "noise-2mb.png"), () => pngBytes()),
    sparse140MB: sparseFile(join(generatedDir, "sparse-140000000.bin"), SPARSE_FILE_BYTES),
    eicar: writeOnce(join(generatedDir, "eicar.com.txt"), eicarBytes),
    nestedEicarZip: writeOnce(join(generatedDir, "nested-eicar.zip"), nestedEicarZipBytes),
    rtloName: writeOnce(join(generatedDir, RTLO_FILE_NAME), () =>
      new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
    ),
  };
}
