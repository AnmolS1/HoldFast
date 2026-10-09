// The mobile frame (< 1024 px): header (mark, search, avatar), a title row that switches between
// the destinations of a group, the FAB, and a bottom nav with exactly three items.
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Fab from "@mui/material/Fab";
import ListItemButton from "@mui/material/ListItemButton";
import { ChevronDown, Folder, Plus, User, Users } from "lucide-react";
import { useState } from "react";
import { Link as RouterLink, useLocation, useNavigate } from "react-router";
import { BottomSheet } from "../../components/BottomSheet";
import { Breadcrumbs, useTrail } from "../../components/Breadcrumbs";
import { Mark } from "../../components/Mark";
import { StorageBar } from "../../components/StorageBar";
import { useUsageSummary } from "../../features/usage";
import { t } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { useSession } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { THEME_OPTIONS, useAccountActions } from "./account-actions";
import { SearchBox, ViewToggle } from "./Header";
import { useNewActions } from "./new-actions";
import { DESTINATIONS, destinationFor, FILES_SWITCHER, groupFor, type NavGroup } from "./nav";
import { Avatar } from "./Sidebar";

export const BOTTOM_NAV_HEIGHT = 56;

const sheetItemSx = { minHeight: layout.touchRowHeight, fontSize: 14 } as const;

export function AccountSheet({ open, onClose }: { open: boolean; onClose(): void }) {
  const user = useSession().data?.user;
  const usage = useUsageSummary();
  const prefs = usePrefs();
  const actions = useAccountActions().filter((action) => !action.desktopOnly);
  return (
    <BottomSheet open={open} onClose={onClose} title={user?.name || t("nav.account")} subtitle={user?.email}>
      <Box sx={{ padding: "8px 12px 12px" }}>
        <StorageBar usage={usage} />
      </Box>
      <Box component="ul" data-account-sheet sx={{ listStyle: "none", margin: 0, padding: 0 }}>
        {actions.map((action) => (
          <Box component="li" key={action.id} sx={action.divider ? { borderTop: `1px solid ${hf.hairline}`, marginTop: 1, paddingTop: 1 } : undefined}>
            <ListItemButton
              {...(action.to ? { component: RouterLink, to: action.to } : action.href ? { component: "a", href: action.href, target: "_blank", rel: "noopener" } : {})}
              onClick={() => {
                onClose();
                action.onSelect?.();
              }}
              data-account-action={action.id}
              sx={sheetItemSx}
            >
              <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
                {action.icon}
              </Box>
              {action.label}
            </ListItemButton>
          </Box>
        ))}
      </Box>
      <Box role="radiogroup" aria-label={t("user.theme")} sx={{ display: "flex", gap: 2, padding: "12px", borderTop: `1px solid ${hf.hairline}`, marginTop: 1 }}>
        {THEME_OPTIONS.map((option) => {
          const checked = prefs.theme === option.value;
          return (
            <ButtonBase
              key={option.value}
              role="radio"
              aria-checked={checked}
              onClick={() => prefs.setTheme(option.value)}
              data-theme-option={option.value}
              sx={{ flex: "1 1 0", minHeight: layout.touchTarget, borderRadius: `${layout.radius.control}px`, border: `1px solid ${hf.hairline}`, backgroundColor: checked ? hf.navActive : hf.surface, fontWeight: checked ? 600 : 400, font: "inherit", fontSize: 13 }}
            >
              {t(option.label)}
            </ButtonBase>
          );
        })}
      </Box>
    </BottomSheet>
  );
}

/** Mobile header: the mark, search, the account avatar. */
export function MobileHeader({ onAccount }: { onAccount(): void }) {
  return (
    <Box component="header" data-header sx={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px 8px 12px", flex: "none" }}>
      <Box component={RouterLink} to="/" aria-label={t("nav.home")} sx={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: layout.touchTarget, height: layout.touchTarget, color: hf.text, flex: "none" }}>
        <Mark size={22} />
      </Box>
      <SearchBox compact />
      <ButtonBase aria-label={t("user.menu")} onClick={onAccount} sx={{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: "50%", flex: "none" }}>
        <Avatar size={28} />
      </ButtonBase>
    </Box>
  );
}

/**
 * The title row. In the Files group the title is a switcher (My files · Recent · Starred · Trash);
 * in the Shared group it carries a two-segment control (With me · By me).
 */
export function MobileTitle({ title }: { title: string }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const trail = useTrail();
  const [open, setOpen] = useState(false);
  const group = groupFor(pathname);
  const destination = destinationFor(pathname);
  // Inside a folder the title is the folder (with its parent crumb); the switcher is for the roots.
  const atRoot = destination !== undefined && (trail === null || trail.length <= 1);
  const filesSwitcher = group === "files" && atRoot;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 2, padding: "4px 12px 8px 16px", minHeight: layout.touchTarget, flex: "none" }}>
      <Box sx={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: 1 }}>
        <Breadcrumbs fallbackTitle={title} compact />
        {filesSwitcher ? (
          <ButtonBase aria-label={t("nav.filesSwitcher")} aria-haspopup="dialog" onClick={() => setOpen(true)} data-files-switcher sx={{ width: layout.touchTarget, height: layout.touchTarget, borderRadius: `${layout.radius.control}px`, color: hf.textSecondary, flex: "none" }}>
            <ChevronDown size={20} aria-hidden="true" />
          </ButtonBase>
        ) : null}
      </Box>
      {group === "shared" ? (
        <Box role="group" aria-label={t("nav.sharedSwitcher")} data-shared-switcher sx={{ display: "inline-flex", border: `1px solid ${hf.hairline}`, borderRadius: `${layout.radius.control}px`, overflow: "hidden", flex: "none" }}>
          {DESTINATIONS.filter((d) => d.group === "shared").map((d) => {
            const active = d.matches(pathname);
            return (
              <ButtonBase key={d.id} component={RouterLink} to={d.path} aria-current={active ? "page" : undefined} data-nav={d.id} sx={{ minHeight: layout.touchTarget, padding: "0 14px", backgroundColor: active ? hf.navActive : hf.surface, fontWeight: active ? 600 : 400, font: "inherit", fontSize: 13 }}>
                {t(d.shortLabel ?? d.label)}
              </ButtonBase>
            );
          })}
        </Box>
      ) : group === "files" ? (
        <ViewToggle />
      ) : null}
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t("nav.files")}>
        <Box component="ul" sx={{ listStyle: "none", margin: 0, padding: 0 }}>
          {FILES_SWITCHER.map((id) => {
            const d = DESTINATIONS.find((entry) => entry.id === id)!;
            const active = d.matches(pathname);
            const Icon = d.icon;
            return (
              <li key={d.id}>
                <ListItemButton
                  selected={active}
                  aria-current={active ? "page" : undefined}
                  data-nav={d.id}
                  onClick={() => {
                    setOpen(false);
                    navigate(d.path);
                  }}
                  sx={sheetItemSx}
                >
                  <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
                    <Icon size={20} />
                  </Box>
                  {t(d.shortLabel ?? d.label)}
                </ListItemButton>
              </li>
            );
          })}
        </Box>
      </BottomSheet>
    </Box>
  );
}

const NAV_ITEMS: Array<{ group: NavGroup; label: "nav.files" | "nav.shared" | "nav.account"; icon: typeof Folder; to?: string }> = [
  { group: "files", label: "nav.files", icon: Folder, to: "/" },
  { group: "shared", label: "nav.shared", icon: Users, to: "/shared" },
  { group: "account", label: "nav.account", icon: User },
];

/** Exactly three items: Files · Shared · Account. Every other destination lives inside one. */
export function BottomNav({ onAccount }: { onAccount(): void }) {
  const { pathname } = useLocation();
  const group = groupFor(pathname);
  return (
    <Box
      component="nav"
      aria-label={t("nav.primary")}
      data-bottom-nav
      sx={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", borderTop: `1px solid ${hf.hairline}`, backgroundColor: hf.surface, paddingBottom: "env(safe-area-inset-bottom)", flex: "none" }}
    >
      {NAV_ITEMS.map((item) => {
        const active = item.group === group;
        const Icon = item.icon;
        const sx = { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "2px", minHeight: BOTTOM_NAV_HEIGHT, color: active ? hf.text : hf.textSecondary, fontSize: 11, fontWeight: active ? 600 : 400, font: "inherit", textDecoration: "none", "&.Mui-focusVisible": { outlineOffset: -2 } } as const;
        const content = (
          <>
            <Icon size={22} aria-hidden="true" />
            <Box component="span" sx={{ fontSize: 11, lineHeight: "14px", fontWeight: active ? 600 : 400 }}>
              {t(item.label)}
            </Box>
          </>
        );
        return item.to ? (
          <ButtonBase key={item.group} component={RouterLink} to={item.to} aria-current={active ? "page" : undefined} data-bottom-nav-item={item.group} sx={sx}>
            {content}
          </ButtonBase>
        ) : (
          <ButtonBase key={item.group} onClick={onAccount} aria-haspopup="dialog" aria-current={active ? "page" : undefined} data-bottom-nav-item={item.group} sx={sx}>
            {content}
          </ButtonBase>
        );
      })}
    </Box>
  );
}

/** The mobile "New" button, floating above the bottom nav. */
export function NewFab() {
  const actions = useNewActions();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Fab aria-label={t("header.new")} aria-haspopup="dialog" onClick={() => setOpen(true)} data-new-fab sx={{ position: "absolute", right: 16, bottom: 16, zIndex: 2 }}>
        <Plus size={22} aria-hidden="true" />
      </Fab>
      <BottomSheet open={open} onClose={() => setOpen(false)} title={t("header.new")}>
        <Box component="ul" sx={{ listStyle: "none", margin: 0, padding: 0 }}>
          {actions.map((action) => (
            <li key={action.id}>
              <ListItemButton
                disabled={action.disabled}
                data-new-action={action.id}
                onClick={() => {
                  setOpen(false);
                  action.run();
                }}
                sx={sheetItemSx}
              >
                <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
                  {action.icon}
                </Box>
                <Box component="span" sx={{ display: "flex", flexDirection: "column" }}>
                  {action.label}
                  {action.reason ? (
                    <Box component="span" sx={{ fontSize: 12, color: hf.textSecondary }}>
                      {action.reason}
                    </Box>
                  ) : null}
                </Box>
              </ListItemButton>
            </li>
          ))}
        </Box>
      </BottomSheet>
    </>
  );
}
