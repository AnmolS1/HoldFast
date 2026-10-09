import { CacheProvider } from "@emotion/react";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import { useMemo, type ReactNode } from "react";
import { createEmotionCache } from "./emotion";
import { theme } from "./theme";

/**
 * Emotion cache (nonce-ready), the theme and the baseline. `noSsr` makes the provider read the
 * stored mode on its first render, so React never paints a scheme other than the one
 * `public/color-scheme-init.js` already put on <html>.
 */
export function HoldfastThemeProvider({ children }: { children: ReactNode }) {
  const cache = useMemo(() => createEmotionCache(), []);
  return (
    <CacheProvider value={cache}>
      <ThemeProvider theme={theme} defaultMode="system" noSsr disableTransitionOnChange>
        <CssBaseline />
        {children}
      </ThemeProvider>
    </CacheProvider>
  );
}
