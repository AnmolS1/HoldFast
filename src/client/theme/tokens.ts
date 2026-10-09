// Design tokens of the "Signal" direction, one object per colour scheme. The values are the
// specification's (design direction §2); nothing here is derived at run time, so the contrast unit
// test can read the same numbers the stylesheet uses.

export interface TokenSet {
  bg: string;
  surface: string;
  surface2: string;
  navActive: string;
  hairline: string;
  text: string;
  textSecondary: string;
  textTertiary: string;
  accent: string;
  accentText: string;
  accentTint: string;
  accentWash: string;
  accentTrack: string;
  danger: string;
  attention: string;
  thumbPlaceholder: string;
  primaryButton: string;
  primaryButtonText: string;
  scrim: string;
  /** Strokes of the empty-state drawings and the sheet handle (decorative, never text). */
  illustration: string;
  /** Text on the call-to-action fill. */
  ctaText: string;
}

export const lightTokens: TokenSet = {
  bg: "#F7F8FA",
  surface: "#FFFFFF",
  surface2: "#F1F3F6",
  navActive: "#E9ECF1",
  hairline: "#E3E6EB",
  text: "#16181D",
  textSecondary: "#5C6370",
  textTertiary: "#8A919E",
  accent: "#E8590C",
  accentText: "#B4410F",
  accentTint: "#FFF1E8",
  accentWash: "#FFF7F2",
  accentTrack: "#F0D9CB",
  danger: "#B42318",
  attention: "#8A5A00",
  thumbPlaceholder: "#D9DEE6",
  primaryButton: "#16181D",
  primaryButtonText: "#FFFFFF",
  scrim: "rgba(22,24,29,0.28)",
  illustration: "#C3C9D2",
  ctaText: "#FFFFFF",
};

export const darkTokens: TokenSet = {
  bg: "#0F1115",
  surface: "#15181E",
  surface2: "#1B1F26",
  navActive: "#1B1F26",
  hairline: "#262B34",
  text: "#E9EBEF",
  textSecondary: "#9AA1AC",
  textTertiary: "#5C6370",
  accent: "#FF8A4C",
  accentText: "#FF8A4C",
  accentTint: "#2A1C13",
  accentWash: "#2A1C13",
  accentTrack: "#3A2A20",
  danger: "#F97066",
  attention: "#E3B341",
  thumbPlaceholder: "#3A414C",
  primaryButton: "#E9EBEF",
  primaryButtonText: "#0F1115",
  scrim: "rgba(0,0,0,0.5)",
  illustration: "#3A414C",
  ctaText: "#0F1115",
};

export const tokenSets = { light: lightTokens, dark: darkTokens } as const;
export type SchemeName = keyof typeof tokenSets;

/** `accentTint` → `--hf-accent-tint`. */
export function tokenVarName(key: keyof TokenSet): string {
  return `--hf-${key.replace(/[A-Z0-9]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function ref(key: keyof TokenSet): string {
  return `var(${tokenVarName(key)})`;
}

/** The custom-property block for one scheme, ready to spread into a global style rule. */
export function tokenDeclarations(set: TokenSet): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(set) as Array<keyof TokenSet>) out[tokenVarName(key)] = set[key];
  return out;
}

/**
 * Neutral and status tokens as `var(--hf-…)` references — what components use. The activity
 * colour is deliberately not in this object: it lives in `hfAccent`, which the lint guard lets
 * only the progress, selection and live-count components import.
 */
export const hf = {
  bg: ref("bg"),
  surface: ref("surface"),
  surface2: ref("surface2"),
  navActive: ref("navActive"),
  hairline: ref("hairline"),
  text: ref("text"),
  textSecondary: ref("textSecondary"),
  textTertiary: ref("textTertiary"),
  danger: ref("danger"),
  attention: ref("attention"),
  thumbPlaceholder: ref("thumbPlaceholder"),
  primaryButton: ref("primaryButton"),
  primaryButtonText: ref("primaryButtonText"),
  scrim: ref("scrim"),
  illustration: ref("illustration"),
} as const;

/** The one activity colour and its tints. Importing this outside the allow-list fails lint. */
export const hfAccent = {
  main: ref("accent"),
  text: ref("accentText"),
  tint: ref("accentTint"),
  wash: ref("accentWash"),
  track: ref("accentTrack"),
} as const;

export const fontSans = "'Instrument Sans Variable', system-ui, -apple-system, 'Segoe UI', sans-serif";
export const fontMono = "'Commit Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/** Layout constants (px), design direction §4. */
export const layout = {
  rowHeight: 36,
  touchRowHeight: 48,
  header: 56,
  sidebar: 232,
  details: 320,
  touchTarget: 44,
  radius: { control: 6, card: 8, dialog: 10, sheet: 14 },
} as const;

/** The only shadows in the product: dialogs and the palette, toasts, the FAB, sheets. */
export const shadows = {
  dialog: "0 24px 64px rgba(22,24,29,0.18)",
  toast: "0 8px 24px rgba(22,24,29,0.18)",
  fab: "0 8px 24px rgba(22,24,29,0.24)",
  sheet: "0 -12px 40px rgba(22,24,29,0.18)",
} as const;

/** Motion (ms), design direction §6. */
export const motion = { fast: 120, sheet: 200, folder: 160 } as const;
