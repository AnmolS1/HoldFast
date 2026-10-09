// The application frame every signed-in page renders in.
//   Desktop (>= 1024): sidebar 232 · content (ribbon, header 56, banners, page) · details 320.
//   Mobile  (<  1024): header · title row · page · FAB · ribbon · three-item bottom nav.
import Box from "@mui/material/Box";
import { useEffect, useState, type ReactElement } from "react";
import { useLocation, useMatches, useOutlet, useRoutes, type RouteObject } from "react-router";
import { CommandPalette } from "../../components/CommandPalette";
import { DetailsPanel, DetailsSheet } from "../../components/DetailsPanel";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import type { RouteHandle } from "../../components/slots";
import { TransferRibbon } from "../../components/TransferRibbon";
import { UploadDropOverlay } from "../../features/upload";
import { t } from "../../lib/i18n";
import { useIsDesktop } from "../../theme/breakpoints";
import { hf } from "../../theme/tokens";
import { ShortcutsDialog } from "../help";
import { FrameBanners } from "./banners";
import { useDeletionCue } from "./deletion-cue";
import { Header } from "./Header";
import { AccountSheet, BOTTOM_NAV_HEIGHT, BottomNav, MobileHeader, MobileTitle, NewFab } from "./Mobile";
import { groupFor } from "./nav";
import { ShellCommands } from "./ShellCommands";
import { Sidebar } from "./Sidebar";

export interface FrameProps {
  /**
   * The frame's non-overlay child routes. Used only for a COLD deep link to an overlay route,
   * where no page was open before: the page named by `location.state.from` (else the root) is
   * rendered from these as the background.
   */
  backgroundRoutes: RouteObject[];
}

interface Background {
  /** `location.key` of the page this element was rendered for. */
  key: string;
  element: ReactElement | null;
  handle: RouteHandle;
}

function ColdBackground({ routes, from }: { routes: RouteObject[]; from: string }) {
  return useRoutes(routes, from);
}

export function Frame({ backgroundRoutes }: FrameProps) {
  const desktop = useIsDesktop();
  const location = useLocation();
  const matches = useMatches();
  const outlet = useOutlet();
  const [accountOpen, setAccountOpen] = useState(false);
  useDeletionCue();

  const handle = (matches[matches.length - 1]?.handle ?? {}) as RouteHandle;
  const overlay = handle.overlay === true;

  // Overlay routes (the preview) render ABOVE the page that was open, which stays mounted: the
  // last non-overlay outlet element is kept and rendered in the same tree position, so React
  // preserves its state, scroll position and route params.
  const [background, setBackground] = useState<Background | null>(null);
  if (!overlay && background?.key !== location.key) setBackground({ key: location.key, element: outlet, handle });
  const from = (location.state as { from?: unknown } | null)?.from;
  const coldFrom = typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : "/";
  const shown = overlay ? background : { element: outlet, handle };
  const pageHandle = shown?.handle ?? {};
  const title = pageHandle.title ?? t("app.name");
  const backgroundPath = overlay && !shown ? coldFrom : location.pathname;

  // The toaster floats above the bottom nav on mobile.
  useEffect(() => {
    const root = document.documentElement;
    if (desktop) root.style.removeProperty("--hf-bottom-inset");
    else root.style.setProperty("--hf-bottom-inset", `${BOTTOM_NAV_HEIGHT}px`);
    return () => {
      root.style.removeProperty("--hf-bottom-inset");
    };
  }, [desktop]);

  const page = (
    <Box sx={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}>
    <Box component="main" id="main" tabIndex={-1} data-main sx={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", overflowY: "auto", outline: "none" }}>
      <ErrorBoundary resetKey={location.key}>
        <Box data-background={overlay ? "kept" : undefined} inert={overlay} sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}>
          {shown ? shown.element : <ColdBackground routes={backgroundRoutes} from={coldFrom} />}
        </Box>
        {overlay ? (
          <Box data-overlay sx={{ position: "absolute", inset: 0, zIndex: 2, display: "flex", flexDirection: "column", backgroundColor: hf.surface }}>
            {outlet}
          </Box>
        ) : null}
      </ErrorBoundary>
    </Box>
    {!desktop && !overlay && groupFor(backgroundPath) === "files" ? <NewFab /> : null}
    </Box>
  );

  return (
    <Box data-frame={desktop ? "desktop" : "mobile"} sx={{ display: "flex", height: "100dvh", overflow: "hidden", backgroundColor: hf.bg, color: hf.text }}>
      <Box
        component="a"
        href="#main"
        sx={{ position: "absolute", left: 8, top: -100, zIndex: 2000, padding: "8px 12px", backgroundColor: hf.primaryButton, color: hf.primaryButtonText, borderRadius: "6px", "&:focus": { top: 8 } }}
      >
        {t("app.skip")}
      </Box>
      <ShellCommands />
      <UploadDropOverlay />
      {desktop ? <Sidebar /> : null}
      <Box sx={{ flex: "1 1 auto", minWidth: 0, display: "flex", flexDirection: "column", backgroundColor: hf.surface }}>
        {desktop ? <TransferRibbon /> : null}
        {desktop ? <Header title={title} /> : <MobileHeader onAccount={() => setAccountOpen(true)} />}
        <FrameBanners />
        {desktop ? null : <MobileTitle title={title} />}
        {page}
        {desktop ? null : (
          <>
            <TransferRibbon />
            <BottomNav onAccount={() => setAccountOpen(true)} />
          </>
        )}
      </Box>
      {desktop && pageHandle.details !== false ? <DetailsPanel /> : null}
      {desktop ? null : <DetailsSheet />}
      {desktop ? null : <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} />}
      <CommandPalette />
      <ShortcutsDialog />
    </Box>
  );
}
