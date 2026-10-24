import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import {
  Command as CommandIcon,
  LayoutGrid,
  List as ListIcon,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
} from "lucide-react";
import { useId, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { openPalette } from "../../components/CommandPalette";
import { Kbd } from "../../components/Kbd";
import { PANEL_IDS, TOGGLE_IDS, togglePanel } from "../../components/PanelSplitter";
import type { PanelId } from "../../lib/layout-prefs";
import { SearchSuggestions } from "../../features/search";
import { t } from "../../lib/i18n";
import { stamped } from "../../lib/history-state";
import { useLayout, usePrefs } from "../../lib/prefs";
import { shortcutLabel } from "../../lib/shortcuts";
import { hf, layout } from "../../theme/tokens";
import { useNewActions } from "./new-actions";

export const SEARCH_INPUT_ID = "hf-search";

/** The search box. Submitting goes to the search page; suggestions render in the slot below it. */
export function SearchBox({ compact = false }: { compact?: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  // The box follows the address: the query of /search, empty elsewhere — set again whenever the
  // address's query changes (the search page's own box or filters, back / forward, leaving the
  // page), and left alone while it does not, so what is typed here stays.
  const addressQuery =
    location.pathname === "/search" ? (new URLSearchParams(location.search).get("q") ?? "") : "";
  const [query, setQuery] = useState(addressQuery);
  const [followed, setFollowed] = useState(addressQuery);
  if (followed !== addressQuery) {
    setFollowed(addressQuery);
    setQuery(addressQuery);
  }
  const [focused, setFocused] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const q = query.trim();
    navigate(q ? `/search?q=${encodeURIComponent(q)}` : "/search");
  };
  return (
    <Box
      component="form"
      role="search"
      onSubmit={onSubmit}
      onFocus={() => {
        clearTimeout(blurTimer.current);
        setFocused(true);
      }}
      onBlur={() => {
        // Let a click on a suggestion land before the slot closes.
        blurTimer.current = setTimeout(() => setFocused(false), 150);
      }}
      sx={{ position: "relative", flex: compact ? "1 1 auto" : "0 1 320px", minWidth: compact ? 0 : 160 }}
    >
      <Box
        component="label"
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 2,
          height: compact ? 44 : 32,
          padding: compact ? "0 12px" : "0 10px",
          border: `1px solid ${hf.hairline}`,
          borderRadius: `${compact ? layout.radius.card : layout.radius.control}px`,
          backgroundColor: hf.bg,
          "&:focus-within": { borderColor: hf.text },
        }}
      >
        <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
          <Search size={16} />
        </Box>
        <Box
          component="input"
          id={SEARCH_INPUT_ID}
          type="search"
          name="q"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t(compact ? "header.searchPlaceholderShort" : "header.searchPlaceholder")}
          aria-label={t("header.search")}
          autoComplete="off"
          sx={{
            flex: "1 1 auto",
            minWidth: 0,
            border: 0,
            outline: "none",
            background: "transparent",
            color: hf.text,
            font: "inherit",
            fontSize: compact ? 16 : 13,
            "&::placeholder": { color: hf.textSecondary },
            "&::-webkit-search-cancel-button": { display: "none" },
          }}
        />
        {compact ? null : <Kbd>{shortcutLabel("search")}</Kbd>}
      </Box>
      {focused && query.trim() !== "" ? (
        <Box data-search-suggestions sx={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 3 }}>
          <SearchSuggestions
            query={query.trim()}
            onPick={(nodeId) =>
              navigate(`/preview/${encodeURIComponent(nodeId)}`, {
                state: stamped({ from: location.pathname + location.search }),
              })
            }
          />
        </Box>
      ) : null}
    </Box>
  );
}

/** List / grid, from the one preference every file view reads. */
export function ViewToggle() {
  const prefs = usePrefs();
  const button = (mode: "list" | "grid") => {
    const active = prefs.viewMode === mode;
    const label = t(mode === "list" ? "header.view.list" : "header.view.grid");
    return (
      <Tooltip title={label}>
        <ButtonBase
          aria-label={label}
          aria-pressed={active}
          onClick={() => prefs.setViewMode(mode)}
          data-view-toggle={mode}
          sx={{
            width: 32,
            height: 32,
            color: active ? hf.text : hf.textSecondary,
            backgroundColor: active ? hf.navActive : hf.surface,
            "&.Mui-focusVisible": { outlineOffset: -2 },
            "@media (max-width:1023.95px)": { width: 44, height: 44 },
          }}
        >
          {mode === "list" ? (
            <ListIcon size={16} aria-hidden="true" />
          ) : (
            <LayoutGrid size={16} aria-hidden="true" />
          )}
        </ButtonBase>
      </Tooltip>
    );
  };
  return (
    <Box
      role="group"
      aria-label={t("header.view")}
      sx={{
        display: "inline-flex",
        border: `1px solid ${hf.hairline}`,
        borderRadius: `${layout.radius.control}px`,
        overflow: "hidden",
        flex: "none",
      }}
    >
      {button("list")}
      {button("grid")}
    </Box>
  );
}

export function NewMenu() {
  const actions = useNewActions();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  return (
    <>
      <Button
        variant="contained"
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? true : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        startIcon={<Plus size={16} aria-hidden="true" />}
        data-new-button
        sx={{ flex: "none" }}
      >
        {t("header.new")}
      </Button>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
      >
        {actions.map((action) => (
          <MenuItem
            key={action.id}
            disabled={action.disabled}
            title={action.reason}
            data-new-action={action.id}
            onClick={() => {
              setAnchor(null);
              action.run();
            }}
          >
            <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
              {action.icon}
            </Box>
            <Box component="span" sx={{ flex: "1 1 auto" }}>
              {action.label}
            </Box>
            <Kbd>{action.shortcut}</Kbd>
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

/**
 * Show / hide a side panel (F02). A toggle button: its name stays the same and `aria-pressed` says
 * whether the panel is shown (the palette's command is the one whose words change).
 */
function PanelToggle({ panel }: { panel: PanelId }) {
  const value = useLayout();
  const shown = panel === "sidebar" ? !value.sidebar.collapsed : value.details.open;
  const label = t(panel === "sidebar" ? "header.sidebar" : "header.details");
  const Icon = panel === "sidebar" ? PanelLeft : PanelRight;
  return (
    <Tooltip title={`${label} ${shortcutLabel(panel)}`}>
      <IconButton
        id={TOGGLE_IDS[panel]}
        aria-label={label}
        aria-pressed={shown}
        aria-controls={PANEL_IDS[panel]}
        onClick={() => togglePanel(panel)}
        data-panel-toggle={panel}
        sx={{ flex: "none", color: shown ? hf.text : hf.textSecondary }}
      >
        <Icon size={16} aria-hidden="true" />
      </IconButton>
    </Tooltip>
  );
}

/**
 * Desktop header, 56 px: the sidebar toggle, title and breadcrumbs, search, palette, view toggle,
 * New, the details toggle (only where the page has a details panel).
 */
export function Header({ title, details = true }: { title: string; details?: boolean }) {
  return (
    <Box
      component="header"
      data-header
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 3,
        minHeight: layout.header,
        boxSizing: "border-box",
        padding: "0 20px",
        borderBottom: `1px solid ${hf.hairline}`,
        flex: "none",
      }}
    >
      <PanelToggle panel="sidebar" />
      <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
        <Breadcrumbs fallbackTitle={title} />
      </Box>
      <SearchBox />
      <Tooltip title={`${t("header.palette")} ${shortcutLabel("palette")}`}>
        <IconButton aria-label={t("header.palette")} onClick={openPalette} data-palette-button>
          <CommandIcon size={16} aria-hidden="true" />
        </IconButton>
      </Tooltip>
      <ViewToggle />
      <NewMenu />
      {details ? <PanelToggle panel="details" /> : null}
    </Box>
  );
}
