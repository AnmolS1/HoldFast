// The web app manifest parses, and every icon it names exists with the size it claims.
import { describe, expect, it } from "vitest";

const manifestText = import.meta.glob<string>("/public/manifest.webmanifest", { query: "?raw", import: "default", eager: true })["/public/manifest.webmanifest"]!;
const icons = import.meta.glob<string>("/public/icons/*.png", { query: "?inline", import: "default", eager: true });
const svgs = import.meta.glob<string>("/public/icons/*.svg", { query: "?raw", import: "default", eager: true });

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(dataUri: string): { width: number; height: number } {
  const bytes = Uint8Array.from(atob(dataUri.slice(dataUri.indexOf(",") + 1)), (c) => c.charCodeAt(0));
  expect(Array.from(bytes.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe("manifest.webmanifest", () => {
  const manifest = JSON.parse(manifestText) as { name: string; short_name: string; display: string; start_url: string; icons: ManifestIcon[] };

  it("names the app and is standalone", () => {
    expect(manifest.name).toBe("Holdfast");
    expect(manifest.short_name).toBe("Holdfast");
    expect(manifest.display).toBe("standalone");
    expect(manifest.start_url).toBe("/");
  });

  it("has 192, 512 and a maskable icon", () => {
    const summary = manifest.icons.map((icon) => `${icon.sizes}:${icon.purpose ?? "any"}`).sort();
    expect(summary).toEqual(["192x192:any", "512x512:any", "512x512:maskable"]);
  });

  it("every icon file exists and has the pixel size the manifest states", () => {
    expect(manifest.icons.length).toBeGreaterThan(0);
    for (const icon of manifest.icons) {
      const file = icons[`/public${icon.src}`];
      expect(file, `${icon.src} is missing`).toBeTypeOf("string");
      const [width, height] = icon.sizes.split("x").map(Number);
      expect(pngSize(file!)).toEqual({ width, height });
      expect(icon.type).toBe("image/png");
    }
  });

  it("the page's own icons exist too", () => {
    expect(svgs["/public/icons/icon.svg"]).toContain("<svg");
    expect(pngSize(icons["/public/icons/apple-touch-icon.png"]!)).toEqual({ width: 180, height: 180 });
  });

  it("control: a missing icon would be caught", () => {
    expect(icons["/public/icons/icon-1024.png"]).toBeUndefined();
  });
});
