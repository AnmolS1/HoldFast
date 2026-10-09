import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import ListItemButton from "@mui/material/ListItemButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import { useId, useState } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { Kbd } from "../../components/Kbd";
import { Wordmark } from "../../components/Mark";
import { StorageBar } from "../../components/StorageBar";
import { useUsageSummary } from "../../features/usage";
import { t } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { useSession } from "../../lib/query";
import { hf, layout } from "../../theme/tokens";
import { initialsOf, THEME_OPTIONS, useAccountActions } from "./account-actions";
import { DESTINATIONS } from "./nav";

function Avatar({ size = 26 }: { size?: number }) {
  const user = useSession().data?.user;
  return (
    <Box component="span" aria-hidden="true" sx={{ width: size, height: size, borderRadius: "50%", backgroundColor: hf.primaryButton, color: hf.primaryButtonText, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 600, flex: "none" }}>
      {user ? initialsOf(user.name, user.email) : ""}
    </Box>
  );
}

export { Avatar };

/** The account button at the foot of the sidebar and its menu. Every item shows its shortcut. */
export function UserMenu() {
  const user = useSession().data?.user;
  const actions = useAccountActions();
  const prefs = usePrefs();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const menuId = useId();
  const close = () => setAnchor(null);
  return (
    <>
      <ButtonBase
        aria-label={t("user.menu")}
        aria-haspopup="menu"
        aria-controls={anchor ? menuId : undefined}
        aria-expanded={anchor ? true : undefined}
        onClick={(event) => setAnchor(event.currentTarget)}
        data-user-menu
        sx={{ display: "flex", alignItems: "center", justifyContent: "flex-start", gap: "10px", minHeight: 44, padding: "0 8px", borderRadius: `${layout.radius.control}px`, textAlign: "left", marginTop: 2, font: "inherit", "&:hover": { backgroundColor: hf.surface2 } }}
      >
        <Avatar />
        <Box component="span" sx={{ display: "flex", flexDirection: "column", lineHeight: "16px", minWidth: 0 }}>
          <Box component="span" sx={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {user?.name || user?.email}
          </Box>
          <Box component="span" sx={{ color: hf.textSecondary, fontSize: 12 }}>
            {t("nav.account")}
          </Box>
        </Box>
      </ButtonBase>
      <Menu id={menuId} anchorEl={anchor} open={Boolean(anchor)} onClose={close} anchorOrigin={{ vertical: "top", horizontal: "left" }} transformOrigin={{ vertical: "bottom", horizontal: "left" }} slotProps={{ list: { "aria-label": t("user.menu") } }}>
        {actions.slice(0, actions.findIndex((a) => a.id === "help")).map((action) => (
          <MenuItem key={action.id} {...(action.to ? { component: RouterLink, to: action.to } : {})} onClick={close}>
            <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
              {action.icon}
            </Box>
            {action.label}
          </MenuItem>
        ))}
        <Divider component="li" />
        {THEME_OPTIONS.map((option) => (
          <MenuItem
            key={option.value}
            role="menuitemradio"
            aria-checked={prefs.theme === option.value}
            onClick={() => prefs.setTheme(option.value)}
            data-theme-option={option.value}
            sx={{ fontWeight: prefs.theme === option.value ? 600 : 400 }}
          >
            <Box component="span" aria-hidden="true" sx={{ width: 16, display: "inline-flex", justifyContent: "center" }}>
              {prefs.theme === option.value ? "•" : ""}
            </Box>
            {t("user.theme")}: {t(option.label)}
          </MenuItem>
        ))}
        {actions.slice(actions.findIndex((a) => a.id === "help")).flatMap((action) => [
          action.divider ? <Divider key={`${action.id}-divider`} component="li" /> : null,
          <MenuItem
            key={action.id}
            {...(action.to ? { component: RouterLink, to: action.to } : action.href ? { component: "a", href: action.href, target: "_blank", rel: "noopener" } : {})}
            onClick={() => {
              close();
              action.onSelect?.();
            }}
            data-account-action={action.id}
          >
            <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
              {action.icon}
            </Box>
            <Box component="span" sx={{ flex: "1 1 auto" }}>
              {action.label}
            </Box>
            {action.shortcut ? <Kbd>{action.shortcut}</Kbd> : null}
          </MenuItem>,
        ])}
      </Menu>
    </>
  );
}

/** Desktop sidebar: the six destinations, storage use, the account button. */
export function Sidebar() {
  const { pathname } = useLocation();
  const usage = useUsageSummary();
  return (
    <Box
      component="nav"
      aria-label={t("nav.primary")}
      data-sidebar
      sx={{ width: layout.sidebar, flex: "none", boxSizing: "border-box", padding: "16px 12px", borderRight: `1px solid ${hf.hairline}`, display: "flex", flexDirection: "column", gap: 1, backgroundColor: hf.bg, minHeight: 0, overflowY: "auto" }}
    >
      <Box component={RouterLink} to="/" aria-label={t("nav.home")} sx={{ display: "flex", alignItems: "center", padding: "6px 8px 18px", color: hf.text, textDecoration: "none" }}>
        <Wordmark />
      </Box>
      <Box component="ul" sx={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 1 }}>
        {DESTINATIONS.map((destination) => {
          const active = destination.matches(pathname);
          const Icon = destination.icon;
          return (
            <li key={destination.id}>
              <ListItemButton component={RouterLink} to={destination.path} selected={active} aria-current={active ? "page" : undefined} data-nav={destination.id}>
                <Box component="span" aria-hidden="true" sx={{ display: "inline-flex", color: hf.textSecondary }}>
                  <Icon size={16} />
                </Box>
                {t(destination.label)}
              </ListItemButton>
            </li>
          );
        })}
      </Box>
      <Box sx={{ flex: "1 1 auto" }} />
      <Box sx={{ padding: "8px 10px 4px" }}>
        <StorageBar
          usage={usage}
          footer={
            <Box component={RouterLink} to="/storage" sx={{ fontSize: 12, color: hf.textSecondary, textDecoration: "underline", textUnderlineOffset: "2px", alignSelf: "flex-start", "&:hover": { color: hf.text } }}>
              {t("user.storage")}
            </Box>
          }
        />
      </Box>
      <UserMenu />
    </Box>
  );
}
