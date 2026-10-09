// The theme object: tokens reach the stylesheet, defaults are graphite, and the design numbers hold.
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import Link from "@mui/material/Link";
import TextField from "@mui/material/TextField";
import Tooltip from "@mui/material/Tooltip";
import { describe, expect, it } from "vitest";
import { createEmotionCache, readNonceFromMeta } from "../../../../src/client/theme/emotion";
import { theme } from "../../../../src/client/theme/theme";
import { darkTokens, layout, lightTokens, motion, tokenDeclarations, tokenVarName, type TokenSet } from "../../../../src/client/theme/tokens";
import { renderShell, resolveVar, setupShell } from "./helpers";

setupShell();

const css = () => Array.from(document.querySelectorAll("style"), (style) => style.textContent ?? "").join("\n");

describe("tokens", () => {
  it("are exactly the design direction's values", () => {
    expect(lightTokens).toMatchObject({ bg: "#F7F8FA", surface: "#FFFFFF", surface2: "#F1F3F6", navActive: "#E9ECF1", hairline: "#E3E6EB", text: "#16181D", textSecondary: "#5C6370", textTertiary: "#8A919E", accent: "#E8590C", accentText: "#B4410F", accentTint: "#FFF1E8", accentWash: "#FFF7F2", accentTrack: "#F0D9CB", danger: "#B42318", attention: "#8A5A00", thumbPlaceholder: "#D9DEE6", primaryButton: "#16181D", primaryButtonText: "#FFFFFF", scrim: "rgba(22,24,29,0.28)" });
    expect(darkTokens).toMatchObject({ bg: "#0F1115", surface: "#15181E", surface2: "#1B1F26", navActive: "#1B1F26", hairline: "#262B34", text: "#E9EBEF", textSecondary: "#9AA1AC", textTertiary: "#5C6370", accent: "#FF8A4C", accentText: "#FF8A4C", accentTint: "#2A1C13", accentWash: "#2A1C13", accentTrack: "#3A2A20", danger: "#F97066", attention: "#E3B341", thumbPlaceholder: "#3A414C", primaryButton: "#E9EBEF", primaryButtonText: "#0F1115", scrim: "rgba(0,0,0,0.5)" });
  });

  it("every token becomes a custom property in both schemes", () => {
    renderShell(<div />);
    const sheet = css();
    for (const key of Object.keys(lightTokens) as Array<keyof TokenSet>) {
      expect(sheet, key).toContain(`${tokenVarName(key)}:${lightTokens[key]}`);
      expect(sheet, key).toContain(`${tokenVarName(key)}:${darkTokens[key]}`);
    }
    expect(sheet).toMatch(/\[data-dark\]\{[^}]*--hf-bg:#0F1115/);
    expect(Object.keys(tokenDeclarations(lightTokens)).length).toBe(Object.keys(lightTokens).length);
  });

  it("layout and motion constants", () => {
    expect(layout).toMatchObject({ rowHeight: 36, touchRowHeight: 48, header: 56, sidebar: 232, details: 320, touchTarget: 44, radius: { control: 6, card: 8, dialog: 10, sheet: 14 } });
    expect(motion.fast).toBeLessThanOrEqual(120);
    expect(motion.sheet).toBe(200);
    expect(motion.folder).toBe(160);
  });
});

describe("theme", () => {
  it("uses CSS variables with the data selector and the 1024 breakpoint", () => {
    expect(theme.vars).toBeDefined();
    expect((theme as unknown as { getColorSchemeSelector(scheme: string): string }).getColorSchemeSelector("dark")).toContain("[data-dark]");
    expect(theme.breakpoints.values.md).toBe(1024);
    expect(theme.spacing(1)).toMatch(/4px/);
  });

  it("type scale: title 20/26 600, heading 15/22 600, body 13/20, secondary 12/16; no uppercase buttons", () => {
    expect(theme.typography.h1).toMatchObject({ fontSize: 20, lineHeight: "26px", fontWeight: 600 });
    expect(theme.typography.h2).toMatchObject({ fontSize: 15, lineHeight: "22px", fontWeight: 600 });
    expect(theme.typography.body1).toMatchObject({ fontSize: 13, lineHeight: "20px" });
    expect(theme.typography.body2).toMatchObject({ fontSize: 12, lineHeight: "16px" });
    expect(theme.typography.button.textTransform).toBe("none");
    expect(theme.typography.fontFamily).toContain("Instrument Sans Variable");
  });

  it("palette.primary is graphite — the components that default to it can never turn orange", () => {
    for (const [scheme, tokens] of [["light", lightTokens], ["dark", darkTokens]] as const) {
      const palette = (theme as unknown as { colorSchemes: Record<string, { palette: typeof theme.palette }> }).colorSchemes[scheme]!.palette;
      expect(palette.primary.main).toBe(tokens.primaryButton);
      expect(palette.primary.main).not.toBe(tokens.accent);
      expect(palette.primary.main).not.toBe(tokens.accentText);
      expect(palette.error.main).toBe(tokens.danger);
      expect(palette.warning.main).toBe(tokens.attention);
      for (const colour of [palette.primary, palette.secondary, palette.info, palette.success]) {
        expect([tokens.accent, tokens.accentText]).not.toContain(colour.main);
      }
    }
  });

  it("no library colour variable resolves to the activity colour", () => {
    renderShell(<div />);
    const declared = Array.from(css().matchAll(/--mui-palette-[\w-]+:\s*([^;}]+)/g), (match) => match[1]!.trim().toUpperCase());
    expect(declared.length).toBeGreaterThan(50);
    for (const value of declared) {
      expect(value).not.toContain("#E8590C");
      expect(value).not.toContain("#FF8A4C");
      expect(value).not.toContain("#B4410F");
    }
  });

  it("default-coloured controls render graphite", () => {
    const { container } = renderShell(
      <>
        <Button variant="contained">Go</Button>
        <Link href="#x">link</Link>
        <TextField label="Name" />
        <Checkbox slotProps={{ input: { "aria-label": "c" } }} />
      </>,
    );
    const button = container.querySelector("button")!;
    expect(resolveVar(getComputedStyle(button).backgroundColor)).toBe(lightTokens.primaryButton);
    expect(resolveVar(getComputedStyle(button).color)).toBe(lightTokens.primaryButtonText);
    expect(getComputedStyle(button).textTransform).toBe("none");
    expect(getComputedStyle(button).boxShadow).toBe("none");
  });

  it("the call-to-action variant exists and is the only button that takes the activity text colour", () => {
    const { container } = renderShell(
      <>
        <Button variant="cta">Upload files</Button>
        <Button>Plain</Button>
      </>,
    );
    const [cta, plain] = Array.from(container.querySelectorAll("button"));
    expect(resolveVar(getComputedStyle(cta!).backgroundColor)).toBe(lightTokens.accentText);
    expect(resolveVar(getComputedStyle(cta!).color)).toBe(lightTokens.ctaText);
    expect(resolveVar(getComputedStyle(plain!).backgroundColor)).toBe(lightTokens.surface);
  });

  it("the focus ring is 2 px of the activity colour, offset 2 px; checkboxes take it as accent-color", () => {
    renderShell(<div />);
    const sheet = css();
    expect(sheet).toMatch(/:focus-visible\{outline:2px solid var\(--hf-accent\);outline-offset:2px;\}/);
    expect(sheet).toMatch(/input\[type="checkbox"\][^{]*\{accent-color:var\(--hf-accent\);\}/);
    expect(sheet).toContain(".num,.mono{font-variant-numeric:tabular-nums;}");
  });

  it("reduced motion switches every transition and the view transitions off", () => {
    renderShell(<div />);
    const sheet = css();
    const start = sheet.indexOf("@media (prefers-reduced-motion: reduce){*,");
    expect(start).toBeGreaterThan(-1);
    const block = sheet.slice(start, start + 900);
    expect(block).toMatch(/transition-duration:0\.001ms\s?!important/);
    expect(block).toMatch(/animation-duration:0\.001ms\s?!important/);
    expect(block).toMatch(/::view-transition-group\(\*\),::view-transition-old\(\*\),::view-transition-new\(\*\)\{[^}]*animation:none\s?!important/);
  });

  it("rows are 36 px, 48 px on touch; tooltips wait 500 ms; shadows are off by default", () => {
    renderShell(<div />);
    const sheet = css();
    expect(sheet).toContain("--hf-row-h:36px");
    expect(sheet).toMatch(/\(pointer: coarse\)\{[^}]*\{--hf-row-h:48px/);
    expect(theme.components?.MuiTooltip?.defaultProps?.enterDelay).toBe(500);
    expect(new Set(theme.shadows)).toEqual(new Set(["none"]));
    expect(Tooltip).toBeDefined();
  });

  it("inputs are 16 px below the breakpoint (no iOS zoom)", () => {
    renderShell(<TextField label="Email" />);
    expect(css()).toMatch(/@media \(max-width:1023\.95px\)\{\.[\w-]*MuiInputBase-root[\w-]*\{font-size:16px;\}\}/);
  });
});

describe("emotion cache", () => {
  it("has the hf key and no nonce until the meta tag exists", () => {
    expect(readNonceFromMeta()).toBeUndefined();
    const cache = createEmotionCache();
    expect(cache.key).toBe("hf");
    expect(cache.nonce).toBeUndefined();
  });

  it("reads the nonce from <meta name=\"csp-nonce\">", () => {
    const meta = document.createElement("meta");
    meta.name = "csp-nonce";
    meta.content = "abc123";
    document.head.appendChild(meta);
    try {
      expect(readNonceFromMeta()).toBe("abc123");
      expect(createEmotionCache().nonce).toBe("abc123");
    } finally {
      meta.remove();
    }
  });
});
