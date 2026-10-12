// Contrast of every token pair the design direction states, for BOTH schemes, plus `attention`.
// Dark mode is asserted here (not with axe in a browser): a dark-mode axe scan can hang the
// Playwright worker. The numbers are read from the same token objects the stylesheet is built from.
import { describe, expect, it } from "vitest";
import { darkTokens, lightTokens, tokenSets, type TokenSet } from "../../../../src/client/theme/tokens";
import { composite, contrast, deltaE, parseColor } from "./color";

type Pair = { fg: keyof TokenSet; bg: keyof TokenSet; min: number; why: string };

const AA = 4.5;
const UI = 3; // non-text and large text

// Text sits on the page, the content pane, hover rows, the active nav item, selected rows and
// the selection bar / ribbon strip — so each text colour is checked on every one it can meet.
const PAIRS: Pair[] = [
  { fg: "text", bg: "bg", min: AA, why: "body text on the page" },
  { fg: "text", bg: "surface", min: AA, why: "body text on the content pane" },
  { fg: "text", bg: "surface2", min: AA, why: "body text on a hovered row" },
  { fg: "text", bg: "navActive", min: AA, why: "active nav item" },
  { fg: "text", bg: "accentTint", min: AA, why: "name in a selected row" },
  { fg: "text", bg: "accentWash", min: AA, why: "selection bar and ribbon sentence" },
  { fg: "textSecondary", bg: "bg", min: AA, why: "secondary text on the page (sidebar, details)" },
  { fg: "textSecondary", bg: "surface", min: AA, why: "secondary text on the content pane" },
  { fg: "textSecondary", bg: "surface2", min: AA, why: "secondary text on a hovered row or banner" },
  { fg: "textSecondary", bg: "accentTint", min: AA, why: "meta text in a selected row" },
  { fg: "textSecondary", bg: "accentWash", min: AA, why: "Clear / Show details on the wash" },
  { fg: "textTertiary", bg: "bg", min: UI, why: "disabled control, hovered field outline on the page" },
  { fg: "textTertiary", bg: "surface", min: UI, why: "disabled control, hovered field outline on a pane" },
  { fg: "textTertiary", bg: "surface2", min: UI, why: "disabled control on its disabled fill" },
  { fg: "accent", bg: "surface", min: UI, why: "bars, dots, rings (UI, not text, in light)" },
  { fg: "accent", bg: "accentTrack", min: 1.5, why: "progress fill against its track" },
  { fg: "accentText", bg: "surface", min: AA, why: "prose links, Scanning" },
  { fg: "accentText", bg: "bg", min: AA, why: "prose links on the page" },
  { fg: "accentText", bg: "accentWash", min: AA, why: "activity text on the wash" },
  { fg: "danger", bg: "surface", min: AA, why: "blocked sentence" },
  { fg: "danger", bg: "surface2", min: AA, why: "blocked sentence on a hovered row, form error on a notice" },
  { fg: "danger", bg: "bg", min: AA, why: "form error on the page" },
  { fg: "attention", bg: "surface", min: AA, why: "couldn't scan" },
  { fg: "attention", bg: "surface2", min: AA, why: "couldn't scan on a hovered row" },
  { fg: "attention", bg: "bg", min: AA, why: "almost full, in the sidebar" },
  { fg: "primaryButtonText", bg: "primaryButton", min: AA, why: "primary button, toast, tooltip" },
  { fg: "ctaText", bg: "accentText", min: AA, why: "the one call-to-action" },
  { fg: "surface", bg: "danger", min: AA, why: "destructive confirm button" },
];

describe.each(Object.entries(tokenSets))("%s scheme", (scheme, tokens) => {
  it.each(PAIRS)("$fg on $bg ≥ $min ($why)", ({ fg, bg, min }) => {
    const ratio = contrast(tokens[fg], tokens[bg], tokens.bg);
    expect(
      ratio,
      `${scheme}: ${fg} ${tokens[fg]} on ${bg} ${tokens[bg]} = ${ratio.toFixed(2)}:1`,
    ).toBeGreaterThanOrEqual(min);
  });

  it("dark accent is text-capable; light accent is UI-only by design", () => {
    const ratio = contrast(tokens.accent, tokens.surface);
    if (scheme === "dark") expect(ratio).toBeGreaterThanOrEqual(AA);
    else expect(ratio).toBeLessThan(AA); // which is why light text uses accentText
  });

  it("attention reads as its own colour, apart from the accent and from danger", () => {
    // CIE76 ΔE. 20 is far past "noticeably different"; the two pairs are reported in the task report.
    expect(deltaE(tokens.attention, tokens.accent)).toBeGreaterThanOrEqual(20);
    expect(deltaE(tokens.attention, tokens.accentText)).toBeGreaterThanOrEqual(20);
    expect(deltaE(tokens.attention, tokens.danger)).toBeGreaterThanOrEqual(20);
  });

  it("the scrim is the only translucent token and composites to a darker page", () => {
    const translucent = (Object.keys(tokens) as Array<keyof TokenSet>).filter(
      (key) => parseColor(tokens[key]).a < 1,
    );
    expect(translucent).toEqual(["scrim"]);
    const dimmed = composite(parseColor(tokens.scrim), parseColor(tokens.surface));
    const surface = parseColor(tokens.surface);
    expect(dimmed.r + dimmed.g + dimmed.b).toBeLessThan(surface.r + surface.g + surface.b);
  });
});

describe("textTertiary (disabled controls and the hovered field outline — never body text)", () => {
  it.each(Object.entries(tokenSets))("%s: sits between the surface and textSecondary", (_scheme, tokens) => {
    // The third level stays the faintest of the three text colours: below AA on purpose, and
    // clearly apart from the second level.
    expect(contrast(tokens.textTertiary, tokens.surface)).toBeLessThan(AA);
    expect(contrast(tokens.textSecondary, tokens.surface)).toBeGreaterThan(
      contrast(tokens.textTertiary, tokens.surface) + 1,
    );
  });
});

describe("the contrast maths", () => {
  it("matches known values", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 5);
    expect(contrast("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrast("#777777", "#FFFFFF")).toBeLessThan(4.5);
  });

  it("composites a translucent foreground before measuring", () => {
    // 50 % black on white is mid grey, far below black's 21:1.
    expect(contrast("rgba(0,0,0,0.5)", "#FFFFFF")).toBeLessThan(6);
  });

  it("control: a pair that is known to fail is reported as failing", () => {
    // Light accent as body text is the specification's own example of a non-compliant use.
    expect(contrast(lightTokens.accent, lightTokens.surface)).toBeLessThan(AA);
    expect(contrast(darkTokens.textTertiary, darkTokens.surface)).toBeLessThan(AA);
  });
});
