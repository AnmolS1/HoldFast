// The bundle budgets of the performance smoke (T28 Scope 6), read from the client build's manifest
// (`vite build --manifest`): the main bundle — the entry chunk and every chunk it imports
// statically — at most 350 kB gzip, and the admin console and pdf.js reached only through a
// dynamic import.
//
//   npx tsx scripts/lhci/budgets.ts [dist/client]
//
// "kB" is 1000 bytes. The admin check needs an admin chunk to judge: while the admin routes are a
// placeholder compiled into the entry (before T25), it says so and fails — it never passes
// without having looked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const MAIN_BUNDLE_GZIP_LIMIT = 350_000;

export interface ManifestChunk {
  file: string;
  src?: string;
  isEntry?: boolean;
  isDynamicEntry?: boolean;
  imports?: string[];
  dynamicImports?: string[];
}
export type Manifest = Record<string, ManifestChunk>;

/** The manifest keys the entry reaches through static imports, the entry included. */
export function staticGraph(manifest: Manifest, entry: string): Set<string> {
  const seen = new Set<string>();
  const walk = (key: string) => {
    if (seen.has(key) || !manifest[key]) return;
    seen.add(key);
    for (const next of manifest[key]!.imports ?? []) walk(next);
  };
  walk(entry);
  return seen;
}

export interface BudgetReport {
  mainBytes: number;
  mainFiles: string[];
  problems: string[];
}

export function checkBudgets(manifest: Manifest, gzipSizeOf: (file: string) => number): BudgetReport {
  const problems: string[] = [];
  const entries = Object.entries(manifest).filter(([, chunk]) => chunk.isEntry);
  if (entries.length !== 1) problems.push(`expected one entry chunk, found ${entries.length}`);
  const [entryKey] = entries[0] ?? [""];
  const graph = staticGraph(manifest, entryKey);
  const mainFiles = [...graph].map((key) => manifest[key]!.file);
  const mainBytes = mainFiles.reduce((sum, file) => sum + gzipSizeOf(file), 0);
  if (mainBytes > MAIN_BUNDLE_GZIP_LIMIT) {
    problems.push(
      `main bundle ${(mainBytes / 1000).toFixed(1)} kB gzip > ${MAIN_BUNDLE_GZIP_LIMIT / 1000} kB (${mainFiles.join(", ")})`,
    );
  }
  const lazy = (label: string, test: (key: string) => boolean) => {
    const keys = Object.keys(manifest).filter(test);
    if (keys.length === 0) {
      problems.push(
        `${label}: no chunk of its own in this build — it cannot be judged lazy (compiled into another chunk)`,
      );
      return;
    }
    for (const key of keys) {
      if (graph.has(key)) problems.push(`${label}: ${key} is imported statically by the entry`);
    }
  };
  lazy("pdf.js", (key) => /pdfjs-dist|features\/preview\/renderers\/PdfPreview/.test(key));
  lazy("admin console", (key) => key.startsWith("src/client/features/admin/"));
  return { mainBytes, mainFiles, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dist = process.argv[2] ?? "dist/client";
  const manifest = JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8")) as Manifest;
  const report = checkBudgets(manifest, (file) => gzipSync(readFileSync(join(dist, file))).length);
  console.log(
    `budgets: main bundle ${(report.mainBytes / 1000).toFixed(1)} kB gzip (${report.mainFiles.length} files)`,
  );
  for (const problem of report.problems) console.error(`budgets: ${problem}`);
  process.exit(report.problems.length > 0 ? 1 : 0);
}
