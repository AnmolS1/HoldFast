// The bundle budgets of the performance smoke (scripts/lhci/budgets.ts) on made-up manifests.
import { describe, expect, it } from "vitest";
import {
  checkBudgets,
  MAIN_BUNDLE_GZIP_LIMIT,
  staticGraph,
  type Manifest,
} from "../../../scripts/lhci/budgets";

const sizes: Record<string, number> = {
  "assets/index.js": 300_000,
  "assets/react.js": 3_000,
  "assets/shared.js": 40_000,
  "assets/PdfPreview.js": 130_000,
  "assets/pdf.worker.mjs": 300_000,
  "assets/Admin.js": 20_000,
};
const size = (file: string) => sizes[file] ?? 0;

const base = (): Manifest => ({
  "index.html": {
    file: "assets/index.js",
    isEntry: true,
    imports: ["_react.js"],
    dynamicImports: [
      "src/client/features/preview/renderers/PdfPreview.tsx",
      "src/client/features/admin/routes.tsx",
    ],
  },
  "_react.js": { file: "assets/react.js" },
  "src/client/features/preview/renderers/PdfPreview.tsx": {
    file: "assets/PdfPreview.js",
    isDynamicEntry: true,
    imports: ["_react.js"],
  },
  "../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs": { file: "assets/pdf.worker.mjs" },
  "src/client/features/admin/routes.tsx": { file: "assets/Admin.js", isDynamicEntry: true },
});

describe("bundle budgets", () => {
  it("the static graph follows `imports` only, never `dynamicImports`", () => {
    expect([...staticGraph(base(), "index.html")].sort()).toEqual(["_react.js", "index.html"]);
  });

  it("within the budget, pdf.js and the admin console lazy: no problem", () => {
    const report = checkBudgets(base(), size);
    expect(report.problems).toEqual([]);
    expect(report.mainBytes).toBe(303_000);
  });

  it("a shared chunk the entry imports statically counts toward the main bundle — over 350 kB fails", () => {
    const manifest = base();
    manifest["index.html"]!.imports = ["_react.js", "_shared.js"];
    manifest["_shared.js"] = { file: "assets/shared.js" };
    sizes["assets/shared.js"] = MAIN_BUNDLE_GZIP_LIMIT;
    const report = checkBudgets(manifest, size);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatch(/^main bundle 653\.0 kB gzip > 350 kB/);
    sizes["assets/shared.js"] = 40_000;
  });

  it("pdf.js imported statically fails", () => {
    const manifest = base();
    manifest["index.html"]!.imports = ["_react.js", "src/client/features/preview/renderers/PdfPreview.tsx"];
    expect(checkBudgets(manifest, size).problems).toContainEqual(
      "pdf.js: src/client/features/preview/renderers/PdfPreview.tsx is imported statically by the entry",
    );
  });

  it("no admin chunk at all is a failure that says it could not judge — never a pass", () => {
    const manifest = base();
    delete manifest["src/client/features/admin/routes.tsx"];
    expect(checkBudgets(manifest, size).problems).toEqual([
      "admin console: no chunk of its own in this build — it cannot be judged lazy (compiled into another chunk)",
    ]);
  });
});
