// The MUI theme of the "Signal" direction. Colour semantics are binding:
//   accent    = something is happening (progress, selection, live counts) — nothing else;
//   danger    = blocked or destructive;
//   attention = couldn't scan;
//   everything else is graphite.
// `palette.primary` is therefore GRAPHITE, not the accent: about twenty MUI components default to
// `color="primary"`, and none of them may turn orange by accident.
import { createTheme, type Theme } from "@mui/material/styles";
import { DESKTOP_MIN, TOUCH_QUERY } from "./breakpoints";
import {
  darkTokens,
  fontMono,
  fontSans,
  hf,
  hfAccent,
  layout,
  lightTokens,
  motion,
  shadows,
  tokenDeclarations,
  type TokenSet,
} from "./tokens";

declare module "@mui/material/Button" {
  interface ButtonPropsVariantOverrides {
    /** The one call-to-action of an empty state. Defined here so no component names the colour. */
    cta: true;
  }
}

function paletteOf(t: TokenSet, mode: "light" | "dark") {
  return {
    mode,
    primary: { main: t.primaryButton, contrastText: t.primaryButtonText },
    secondary: { main: t.textSecondary, contrastText: t.surface },
    error: { main: t.danger },
    warning: { main: t.attention },
    info: { main: t.textSecondary },
    success: { main: t.textSecondary },
    text: { primary: t.text, secondary: t.textSecondary, disabled: t.textTertiary },
    background: { default: t.bg, paper: t.surface },
    divider: t.hairline,
    action: {
      hover: t.surface2,
      selected: t.navActive,
      focus: t.surface2,
      active: t.textSecondary,
      disabled: t.textTertiary,
      disabledBackground: t.surface2,
    },
  } as const;
}

const mobile = `@media (max-width:${DESKTOP_MIN - 0.05}px)`;
const touch = `@media ${TOUCH_QUERY}`;
const reducedMotion = "@media (prefers-reduced-motion: reduce)";
const focusRing = { outline: `2px solid ${hfAccent.main}`, outlineOffset: 2 } as const;

export function createHoldfastTheme(): Theme {
  return createTheme({
    cssVariables: { colorSchemeSelector: "data", nativeColor: true },
    colorSchemes: {
      light: { palette: paletteOf(lightTokens, "light") },
      dark: { palette: paletteOf(darkTokens, "dark") },
    },
    // md is the one layout breakpoint (1024). The other keys exist for MUI internals only.
    breakpoints: { values: { xs: 0, sm: 600, md: DESKTOP_MIN, lg: 1280, xl: 1536 } },
    spacing: 4,
    shape: { borderRadius: layout.radius.control },
    // Depth comes from lightness and hairlines. The few real shadows are set per component below.
    shadows: Array(25).fill("none") as Theme["shadows"],
    transitions: {
      duration: {
        shortest: motion.fast,
        shorter: motion.fast,
        short: motion.fast,
        standard: motion.fast,
        complex: motion.sheet,
        enteringScreen: motion.fast,
        leavingScreen: motion.fast,
      },
    },
    typography: {
      fontFamily: fontSans,
      fontSize: 13,
      htmlFontSize: 16,
      h1: { fontSize: 20, lineHeight: "26px", fontWeight: 600, letterSpacing: "-0.01em" },
      h2: { fontSize: 15, lineHeight: "22px", fontWeight: 600, letterSpacing: 0 },
      h3: { fontSize: 13, lineHeight: "20px", fontWeight: 600, letterSpacing: 0 },
      h4: { fontSize: 13, lineHeight: "20px", fontWeight: 600 },
      h5: { fontSize: 13, lineHeight: "20px", fontWeight: 600 },
      h6: { fontSize: 13, lineHeight: "20px", fontWeight: 600 },
      body1: { fontSize: 13, lineHeight: "20px", fontWeight: 400, letterSpacing: 0, [mobile]: { fontSize: 14 } },
      body2: { fontSize: 12, lineHeight: "16px", fontWeight: 400, letterSpacing: 0 },
      subtitle1: { fontSize: 13, lineHeight: "20px", fontWeight: 500 },
      subtitle2: { fontSize: 12, lineHeight: "16px", fontWeight: 500 },
      caption: { fontSize: 12, lineHeight: "16px", letterSpacing: 0 },
      overline: { fontSize: 12, lineHeight: "16px", textTransform: "none", letterSpacing: 0 },
      button: { fontSize: 13, lineHeight: "20px", fontWeight: 500, textTransform: "none", letterSpacing: 0 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          ":root": { ...tokenDeclarations(lightTokens), "--hf-row-h": `${layout.rowHeight}px` },
          "[data-light]": tokenDeclarations(lightTokens),
          "[data-dark]": tokenDeclarations(darkTokens),
          '[data-density="comfortable"]': { "--hf-row-h": "40px" },
          [touch]: { ":root, [data-density]": { "--hf-row-h": `${layout.touchRowHeight}px` } },
          html: { WebkitTextSizeAdjust: "100%" },
          body: {
            backgroundColor: hf.bg,
            color: hf.text,
            fontSize: 13,
            lineHeight: "20px",
            WebkitFontSmoothing: "antialiased",
            [mobile]: { fontSize: 14 },
          },
          "#root": { minHeight: "100dvh" },
          ".num, .mono": { fontVariantNumeric: "tabular-nums" },
          ".mono": { fontFamily: fontMono, fontSize: 12, lineHeight: "16px", letterSpacing: 0 },
          // Links are graphite; only links inside prose take the activity text colour.
          a: { color: "inherit" },
          ".prose a": { color: hfAccent.text, textDecoration: "underline", textUnderlineOffset: 2 },
          // One visible focus ring everywhere, instead of the browser default.
          ":focus-visible": focusRing,
          'input[type="checkbox"], input[type="radio"]': { accentColor: hfAccent.main },
          // Selection is theme-owned: any row or tile inside a `data-hf-list` container that
          // carries aria-selected gets the tint and the 2 px inset, without naming a token.
          '[data-hf-list] [aria-selected="true"], [data-hf-list] [aria-selected="true"]:hover': {
            backgroundColor: hfAccent.tint,
            boxShadow: `inset 2px 0 0 ${hfAccent.main}`,
          },
          // Folder-enter shared element.
          "::view-transition-group(*)": { animationDuration: `${motion.folder}ms` },
          [reducedMotion]: {
            "*, *::before, *::after": {
              animationDuration: "0.001ms !important",
              animationIterationCount: "1 !important",
              transitionDuration: "0.001ms !important",
              scrollBehavior: "auto !important",
            },
            "::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*)": {
              animation: "none !important",
            },
          },
        },
      },
      MuiButtonBase: {
        defaultProps: { disableRipple: true },
        styleOverrides: { root: { "&.Mui-focusVisible": focusRing } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true, variant: "outlined", color: "inherit" },
        styleOverrides: {
          root: {
            minHeight: 32,
            padding: "0 12px",
            borderRadius: layout.radius.control,
            fontWeight: 500,
            gap: 8,
            [mobile]: { minHeight: layout.touchTarget, fontSize: 14 },
            variants: [
              { props: { size: "large" }, style: { minHeight: 40, [mobile]: { minHeight: layout.touchTarget } } },
              {
                props: { variant: "contained" },
                style: {
                  backgroundColor: hf.primaryButton,
                  color: hf.primaryButtonText,
                  "&:hover": { backgroundColor: hf.primaryButton, opacity: 0.88 },
                  "&.Mui-disabled": { backgroundColor: hf.surface2, color: hf.textSecondary },
                },
              },
              {
                props: { variant: "outlined" },
                style: {
                  backgroundColor: hf.surface,
                  borderColor: hf.hairline,
                  color: hf.text,
                  "&:hover": { backgroundColor: hf.surface2, borderColor: hf.hairline },
                  "&.Mui-disabled": { color: hf.textSecondary, borderColor: hf.hairline },
                },
              },
              {
                props: { variant: "text" },
                style: {
                  color: hf.textSecondary,
                  "&:hover": { backgroundColor: hf.surface2, color: hf.text },
                },
              },
              {
                props: { variant: "cta" },
                style: {
                  backgroundColor: hfAccent.text,
                  color: "var(--hf-cta-text)",
                  "&:hover": { backgroundColor: hfAccent.text, opacity: 0.9 },
                },
              },
              {
                props: { color: "error", variant: "outlined" },
                style: { color: hf.danger, borderColor: hf.hairline },
              },
              {
                props: { color: "error", variant: "contained" },
                style: { backgroundColor: hf.danger, color: hf.surface },
              },
            ],
          },
        },
      },
      MuiIconButton: {
        styleOverrides: {
          root: {
            width: 28,
            height: 28,
            borderRadius: layout.radius.control,
            color: hf.textSecondary,
            "&:hover": { backgroundColor: hf.navActive },
            [mobile]: { width: layout.touchTarget, height: layout.touchTarget },
          },
        },
      },
      MuiFab: {
        styleOverrides: {
          root: {
            width: 52,
            height: 52,
            backgroundColor: hf.primaryButton,
            color: hf.primaryButtonText,
            boxShadow: shadows.fab,
            "&:hover": { backgroundColor: hf.primaryButton },
            "&:active": { boxShadow: shadows.fab },
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            minHeight: "var(--hf-row-h)",
            paddingTop: 0,
            paddingBottom: 0,
            paddingLeft: 10,
            paddingRight: 10,
            gap: 10,
            borderRadius: layout.radius.control,
            "&:hover": { backgroundColor: hf.surface2 },
            "&.Mui-selected, &.Mui-selected:hover": { backgroundColor: hf.navActive, fontWeight: 500 },
            "&.Mui-focusVisible": { backgroundColor: hf.surface2 },
          },
        },
      },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            minHeight: "var(--hf-row-h)",
            fontSize: 13,
            gap: 10,
            borderRadius: layout.radius.control,
            margin: "0 4px",
            padding: "0 8px",
            "&:hover, &.Mui-focusVisible": { backgroundColor: hf.surface2 },
            [mobile]: { minHeight: layout.touchRowHeight, fontSize: 14 },
          },
        },
      },
      MuiTooltip: {
        defaultProps: { enterDelay: 500, enterNextDelay: 500, arrow: false },
        styleOverrides: {
          tooltip: {
            backgroundColor: hf.primaryButton,
            color: hf.primaryButtonText,
            fontSize: 12,
            lineHeight: "16px",
            fontWeight: 400,
            borderRadius: 4,
          },
        },
      },
      MuiPaper: {
        defaultProps: { elevation: 0 },
        styleOverrides: { root: { backgroundImage: "none", backgroundColor: hf.surface, color: hf.text } },
      },
      MuiMenu: {
        styleOverrides: {
          paper: { border: `1px solid ${hf.hairline}`, borderRadius: layout.radius.card, minWidth: 200 },
          list: { padding: "4px 0" },
        },
      },
      MuiPopover: { styleOverrides: { paper: { border: `1px solid ${hf.hairline}`, borderRadius: layout.radius.card } } },
      MuiBackdrop: {
        styleOverrides: { root: { backgroundColor: hf.scrim, "&.MuiBackdrop-invisible": { backgroundColor: "transparent" } } },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            border: `1px solid ${hf.hairline}`,
            borderRadius: layout.radius.dialog,
            boxShadow: shadows.dialog,
            margin: 16,
          },
        },
      },
      MuiDialogTitle: { styleOverrides: { root: { fontSize: 15, lineHeight: "22px", fontWeight: 600, padding: "20px 20px 8px" } } },
      MuiDialogContent: { styleOverrides: { root: { padding: "0 20px 16px" } } },
      MuiDialogActions: { styleOverrides: { root: { padding: "0 20px 20px", gap: 8 } } },
      MuiSnackbarContent: {
        styleOverrides: {
          root: {
            backgroundColor: hf.primaryButton,
            color: hf.primaryButtonText,
            boxShadow: shadows.toast,
            borderRadius: layout.radius.card,
            fontSize: 13,
            padding: "4px 12px",
          },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: hf.hairline } } },
      MuiInputBase: {
        styleOverrides: {
          root: { fontSize: 14, [mobile]: { fontSize: 16 } },
          input: { "&::placeholder": { color: hf.textSecondary, opacity: 1 } },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            backgroundColor: hf.surface,
            borderRadius: layout.radius.control,
            "& .MuiOutlinedInput-notchedOutline": { borderColor: hf.hairline },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: hf.textTertiary },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": { borderColor: hf.text, borderWidth: 1 },
            "&.Mui-focused": focusRing,
            "&.Mui-error .MuiOutlinedInput-notchedOutline": { borderColor: hf.danger },
          },
          input: { height: 40, boxSizing: "border-box", padding: "0 12px", [mobile]: { height: layout.touchTarget } },
        },
      },
      MuiFormLabel: { styleOverrides: { root: { fontSize: 12, lineHeight: "16px", color: hf.textSecondary, "&.Mui-focused": { color: hf.textSecondary } } } },
      MuiFormHelperText: { styleOverrides: { root: { margin: "6px 0 0", fontSize: 12, lineHeight: "16px", color: hf.textSecondary, "&.Mui-error": { color: hf.danger } } } },
      MuiLink: { defaultProps: { underline: "always", color: "inherit" } },
      MuiSkeleton: { styleOverrides: { root: { backgroundColor: hf.surface2 } } },
      MuiCircularProgress: { defaultProps: { color: "inherit", size: 16, thickness: 5 } },
    },
  });
}

export const theme = createHoldfastTheme();
