import { QueryClientProvider } from "@tanstack/react-query";
import { useColorScheme } from "@mui/material/styles";
import { useEffect, useMemo } from "react";
import { RouterProvider } from "react-router";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Toaster } from "./components/Toaster";
import { usePrefs } from "./lib/prefs";
import { queryClient } from "./lib/query";
import { createAppRouter } from "./router";
import { ReauthDialog } from "./routes/auth";
import { HoldfastThemeProvider } from "./theme";

/** Keeps the theme provider's mode in step with the theme preference (one source: the prefs). */
function PrefsEffects() {
  const { theme } = usePrefs();
  const { mode, setMode } = useColorScheme();
  useEffect(() => {
    if (mode !== theme) setMode(theme);
  }, [theme, mode, setMode]);
  return null;
}

export function App() {
  const router = useMemo(() => createAppRouter(), []);
  return (
    <HoldfastThemeProvider>
      <PrefsEffects />
      <QueryClientProvider client={queryClient}>
        <ErrorBoundary>
          <RouterProvider router={router} />
        </ErrorBoundary>
        {/* Above the router on purpose: the re-auth modal and toasts outlive any route change. */}
        <ReauthDialog />
        <Toaster />
      </QueryClientProvider>
    </HoldfastThemeProvider>
  );
}
