// Properties of the source tree that a reviewer would otherwise check by grep.
import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>("/src/client/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});
const initScript = import.meta.glob<string>("/public/color-scheme-init.js", {
  query: "?raw",
  import: "default",
  eager: true,
})["/public/color-scheme-init.js"]!;
const indexHtml = import.meta.glob<string>("/index.html", { query: "?raw", import: "default", eager: true })[
  "/index.html"
]!;

describe("Web Storage", () => {
  it("is touched by exactly one module, and only for UI preferences", () => {
    const users = Object.entries(sources)
      .filter(([, code]) =>
        /\b(localStorage|sessionStorage|indexedDB)\b/.test(
          code.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""),
        ),
      )
      .map(([path]) => path);
    expect(users).toEqual(["/src/client/lib/prefs.ts"]);
  });

  it("writes only the preferences key and the UI library's mode key", () => {
    const prefs = sources["/src/client/lib/prefs.ts"]!;
    const writes = Array.from(prefs.matchAll(/localStorage\.setItem\(\s*([A-Z_]+)/g), (match) => match[1]);
    expect(writes.sort()).toEqual(["MODE_KEY", "PREFS_KEY"]);
    expect(prefs).toContain('PREFS_KEY = "hf.prefs.v1"');
    expect(prefs).toContain('MODE_KEY = "mui-mode"');
    expect(prefs).not.toMatch(/sessionStorage/);
  });

  it("the first-paint script only reads, and reads the UI library's keys", () => {
    expect(initScript).not.toMatch(/setItem|sessionStorage|document\.cookie/);
    const keys = Array.from(initScript.matchAll(/getItem\("([^"]+)"\)/g), (match) => match[1]);
    expect(keys.sort()).toEqual(["mui-color-scheme-dark", "mui-color-scheme-light", "mui-mode"]);
  });

  it("no router scroll restoration (it writes to sessionStorage)", () => {
    expect(Object.values(sources).some((code) => /ScrollRestoration/.test(code))).toBe(false);
  });
});

describe("index.html", () => {
  it("has no inline script and loads the colour-scheme script before the app", () => {
    const scripts = Array.from(indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g));
    expect(scripts.length).toBe(2);
    for (const [, attributes, body] of scripts) {
      expect(attributes).toMatch(/\bsrc=/);
      expect(body!.trim()).toBe("");
    }
    expect(indexHtml.indexOf("/color-scheme-init.js")).toBeLessThan(
      indexHtml.indexOf("/src/client/main.tsx"),
    );
    expect(scripts[0]![1]).not.toMatch(/\b(async|defer|type="module")/);
  });

  it("carries one theme-color per scheme and the manifest link", () => {
    expect(indexHtml).toMatch(
      /<meta name="theme-color" media="\(prefers-color-scheme: light\)" content="#F7F8FA"/,
    );
    expect(indexHtml).toMatch(
      /<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#0F1115"/,
    );
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest"');
  });
});

describe("tokens with restricted use", () => {
  it("textTertiary is used for no text outside the theme (dark is below 3:1 on the content pane)", () => {
    const users = Object.entries(sources)
      .filter(([path]) => !path.startsWith("/src/client/theme/"))
      .filter(([, code]) => /textTertiary/.test(code))
      .map(([path]) => path);
    expect(users).toEqual([]);
  });

  it("no component hard-codes a hex colour (only the vendor's own mark does)", () => {
    const users = Object.entries(sources)
      .filter(([path]) => !path.startsWith("/src/client/theme/"))
      .filter(([, code]) => /#[0-9a-fA-F]{6}\b/.test(code))
      .map(([path]) => path);
    expect(users).toEqual(["/src/client/routes/auth/parts.tsx"]);
  });
});

describe("placeholder modules", () => {
  it("every placeholder module says who takes it over", () => {
    const placeholders = Object.entries(sources).filter(
      ([path]) => path.startsWith("/src/client/features/") && path !== "/src/client/features/index.ts",
    );
    expect(placeholders.length).toBe(27);
    for (const [path, code] of placeholders) expect(code, path).toMatch(/PLACEHOLDER — taken over by/);
    // The auth client is no longer one: it is the real Better Auth client.
    expect(sources["/src/client/lib/auth-client.ts"]).not.toMatch(/PLACEHOLDER/);
  });
});
