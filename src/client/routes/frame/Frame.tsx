// The application frame every signed-in page renders in.
//   Desktop (>= 1024): sidebar 232 · content (ribbon, header 56, banners, page) · details 320.
//     The two side panels hide (the sidebar to a 56 px icon rail) and resize by drag or keyboard
//     (F02); the content keeps ≥ 480 px — when it can't, the panels give way, drawn narrower
//     without changing what is stored.
//   Mobile  (<  1024): header · title row · page · FAB · ribbon · three-item bottom nav.
import Box from "@mui/material/Box";
import {
  Fragment,
  useEffect,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { useLocation, useMatches, useOutlet, useRoutes, type RouteObject } from "react-router";
import { CommandPalette } from "../../components/CommandPalette";
import { DetailsPanel, DetailsSheet } from "../../components/DetailsPanel";
import { ErrorBoundary } from "../../components/ErrorBoundary";
import {
  PANEL_IDS,
  PanelSplitter,
  resetPanelWidth,
  setPanelShown,
  setPanelWidth,
  togglePanel,
} from "../../components/PanelSplitter";
import type { RouteHandle } from "../../components/slots";
import { TransferRibbon } from "../../components/TransferRibbon";
import { UploadDropOverlay } from "../../features/upload";
import { t } from "../../lib/i18n";
import { ownHistoryState } from "../../lib/history-state";
import { giveWay, panelBounds } from "../../lib/layout-prefs";
import { useLayout } from "../../lib/prefs";
import { getKnownUserId, useSession } from "../../lib/query";
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

const subscribeResize = (listener: () => void) => {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
};
const windowWidth = () => window.innerWidth;

/** The window's width, re-read on resize: what the panels give way to. */
function useWindowWidth(): number {
  return useSyncExternalStore(subscribeResize, windowWidth, windowWidth);
}

function ColdBackground({ routes, from }: { routes: RouteObject[]; from: string }) {
  return useRoutes(routes, from);
}

/**
 * Everything inside is REMOUNTED when the signed-in account changes. `purgeUserState` empties
 * the caches and stores, but a component's own state (`useState`, refs, a dialog showing a file)
 * outlives it: when a session re-read names another account without a navigation, a page that
 * was open would go on showing the previous account's data under the new one. A new key throws
 * that state away with the component.
 */
export function AccountKeyed({ children }: { children: ReactNode }) {
  // An expired session read as null is NOT another account: the remembered id holds until a real
  // sign-out purges it (or a different account is adopted) — so a re-auth as the same account
  // keeps every page, upload and dialog as it was.
  const userId = useSession().data?.user.id ?? getKnownUserId() ?? "signed-out";
  return <Fragment key={userId}>{children}</Fragment>;
}

export function Frame(props: FrameProps) {
  return (
    <AccountKeyed>
      <FrameBody {...props} />
    </AccountKeyed>
  );
}

function FrameBody({ backgroundRoutes }: FrameProps) {
  const desktop = useIsDesktop();
  const location = useLocation();
  const matches = useMatches();
  const outlet = useOutlet();
  const [accountOpen, setAccountOpen] = useState(false);
  const panels = useLayout();
  const width = useWindowWidth();
  useDeletionCue();

  const handle = (matches[matches.length - 1]?.handle ?? {}) as RouteHandle;
  const overlay = handle.overlay === true;

  // Overlay routes (the preview) render ABOVE the page that was open, which stays mounted: the
  // last non-overlay outlet element is kept and rendered in the same tree position, so React
  // preserves its state, scroll position and route params.
  const [background, setBackground] = useState<Background | null>(null);
  if (!overlay && background?.key !== location.key)
    setBackground({ key: location.key, element: outlet, handle });
  // Another account's history state is not read, not for one render (lib/history-state.ts).
  const from = ownHistoryState(location.state)?.from;
  const coldFrom = typeof from === "string" && from.startsWith("/") && !from.startsWith("//") ? from : "/";
  const shown = overlay ? background : { element: outlet, handle };
  const pageHandle = shown?.handle ?? {};
  const title = pageHandle.title ?? t("app.name");
  const detailsAvailable = pageHandle.details !== false;
  const drawn = giveWay(panels, width, detailsAvailable);
  const sidebarBounds = panelBounds("sidebar", panels, width, detailsAvailable);
  const detailsBounds = panelBounds("details", panels, width, detailsAvailable);
  const panelWidths = {
    "--hf-sidebar-w": `${drawn.sidebar}px`,
    "--hf-details-w": `${drawn.details ?? 0}px`,
  } as CSSProperties;
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
    <Box
      sx={{ position: "relative", flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" }}
    >
      <Box
        component="main"
        id="main"
        tabIndex={-1}
        data-main
        sx={{
          position: "relative",
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          overflowY: "auto",
          outline: "none",
        }}
      >
        <ErrorBoundary resetKey={location.key}>
          <Box
            data-background={overlay ? "kept" : undefined}
            inert={overlay}
            sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
          >
            {shown ? shown.element : <ColdBackground routes={backgroundRoutes} from={coldFrom} />}
          </Box>
          {overlay ? (
            // No background of its own: the preview is D01's dialog OVER the page, on the scrim
            // (D01 §2 "scrim — dialogs"; T18) — the kept list shows through, inert, behind it.
            <Box
              data-overlay
              sx={{
                position: "absolute",
                inset: 0,
                zIndex: 2,
                display: "flex",
                flexDirection: "column",
              }}
            >
              {outlet}
            </Box>
          ) : null}
        </ErrorBoundary>
      </Box>
      {!desktop && !overlay && groupFor(backgroundPath) === "files" ? <NewFab /> : null}
    </Box>
  );

  return (
    <Box
      data-frame={desktop ? "desktop" : "mobile"}
      style={desktop ? panelWidths : undefined}
      sx={{ display: "flex", height: "100dvh", overflow: "hidden", backgroundColor: hf.bg, color: hf.text }}
    >
      <Box
        component="a"
        href="#main"
        sx={{
          position: "absolute",
          left: 8,
          top: -100,
          zIndex: 2000,
          padding: "8px 12px",
          backgroundColor: hf.primaryButton,
          color: hf.primaryButtonText,
          borderRadius: "6px",
          "&:focus": { top: 8 },
        }}
      >
        {t("app.skip")}
      </Box>
      <ShellCommands panels={desktop} details={desktop && detailsAvailable} />
      <UploadDropOverlay />
      {desktop ? <Sidebar id={PANEL_IDS.sidebar} collapsed={panels.sidebar.collapsed} /> : null}
      {desktop ? (
        <PanelSplitter
          panel="sidebar"
          value={drawn.sidebar}
          min={sidebarBounds.min}
          max={sidebarBounds.max}
          collapsed={panels.sidebar.collapsed}
          onResize={(next) => setPanelWidth("sidebar", next)}
          onReset={() => resetPanelWidth("sidebar")}
          onToggle={() => togglePanel("sidebar")}
          onPreview={(next) =>
            giveWay({ ...panels, sidebar: { collapsed: false, width: next } }, width, detailsAvailable)
          }
        />
      ) : null}
      <Box
        sx={{
          flex: "1 1 auto",
          minWidth: 0,
          display: "flex",
          flexDirection: "column",
          backgroundColor: hf.surface,
        }}
      >
        {desktop ? <TransferRibbon /> : null}
        {desktop ? (
          <Header title={title} details={detailsAvailable} />
        ) : (
          <MobileHeader onAccount={() => setAccountOpen(true)} />
        )}
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
      {desktop && detailsAvailable && drawn.details !== null ? (
        <PanelSplitter
          panel="details"
          value={drawn.details}
          min={detailsBounds.min}
          max={detailsBounds.max}
          onResize={(next) => setPanelWidth("details", next)}
          onReset={() => resetPanelWidth("details")}
          onToggle={() => setPanelShown("details", false)}
          onPreview={(next) => giveWay({ ...panels, details: { ...panels.details, width: next } }, width)}
        />
      ) : null}
      {desktop && detailsAvailable ? (
        <DetailsPanel id={PANEL_IDS.details} hidden={drawn.details === null} />
      ) : null}
      {desktop ? null : <DetailsSheet />}
      {desktop ? null : <AccountSheet open={accountOpen} onClose={() => setAccountOpen(false)} />}
      <CommandPalette />
      <ShortcutsDialog />
    </Box>
  );
}
