// Every Data Grid goes through ONE wrapper that hands it the page's CSP nonce (spike S5: the grid
// inserts a <style> of its own outside Emotion). The wrapper is the only importer of `DataGrid`.
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AdminDataGrid } from "../../../../src/client/features/admin/components/AdminDataGrid";

const sources = import.meta.glob("../../../../src/client/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const WRAPPER = "src/client/features/admin/components/AdminDataGrid.tsx";

function withNonce(value: string | null) {
  document.head.querySelectorAll('meta[name="csp-nonce"]').forEach((meta) => meta.remove());
  if (value === null) return;
  const meta = document.createElement("meta");
  meta.setAttribute("name", "csp-nonce");
  meta.setAttribute("content", value);
  document.head.append(meta);
}

afterEach(() => withNonce(null));

/** The grid's own <style> elements (its CSS variables; `href="/<class>"`). */
const gridStyles = () => [...document.querySelectorAll<HTMLStyleElement>("style[href]")];

describe("AdminDataGrid", () => {
  it("every grid's own <style> carries the nonce of the page's meta tag", () => {
    withNonce("n0nce-made-up-for-the-test");
    render(<AdminDataGrid rows={[{ id: 1, name: "a" }]} columns={[{ field: "name" }]} />);
    const styles = gridStyles();
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(style.getAttribute("nonce")).toBe("n0nce-made-up-for-the-test");
  });

  it("control: without the meta tag the grid's style carries no nonce (the attribute comes from the tag)", () => {
    render(<AdminDataGrid rows={[{ id: 1, name: "a" }]} columns={[{ field: "name" }]} />);
    const styles = gridStyles();
    expect(styles.length).toBeGreaterThan(0);
    for (const style of styles) expect(style.getAttribute("nonce")).toBeNull();
  });

  it("no file of the client imports DataGrid from @mui/x-data-grid except the wrapper (source scan)", () => {
    const entries = Object.entries(sources);
    expect(entries.length).toBeGreaterThan(100);
    const importers = entries
      .filter(([, text]) =>
        /import\s*(type\s*)?\{[^}]*\bDataGrid\b[^}]*\}\s*from\s*["']@mui\/x-data-grid|from\s*["']@mui\/x-data-grid\//.test(
          text,
        ),
      )
      .map(([path]) => path.replace(/^(\.\.\/)+/, ""));
    expect(importers).toEqual([WRAPPER]);
  });
});
