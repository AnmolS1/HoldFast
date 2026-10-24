import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import ListItemButton from "@mui/material/ListItemButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Tooltip from "@mui/material/Tooltip";
import { useId, useState } from "react";
import { Link as RouterLink, useLocation } from "react-router";
import { Kbd } from "../../components/Kbd";
import { Mark, Wordmark } from "../../components/Mark";
import type { UsageSlotValue } from "../../components/slots";
import { StorageBar } from "../../components/StorageBar";
import { useUsageSummary } from "../../features/usage";
import { t } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { useSession } from "../../lib/query";
import { hf, layout, motion } from "../../theme/tokens";
import { initialsOf, THEME_OPTIONS, useAccountActions } from "./account-actions";
import { DESTINATIONS } from "./nav";

function Avatar({ size = 26 }: { size?: number }) {
  const user = useSession().data?.user;
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        width: size,
        height: size,
        borderRadius: "50%",
        backgroundColor: hf.primaryButton,
        color: hf.primaryButtonText,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 11,
        fontWeight: 600,
        flex: "none",
      }}
    >
      {user ? initialsOf(user.name, user.email) : ""}
    </Box>
  );
}

export { Avatar };

/**
 * The account button at the foot of the sidebar and its menu. Every item shows its shortcut. On the
 * rail (`compact`) the button is the avatar alone; its accessible name is the same.
 */
export function UserMenu({ compact = false }: { compact?: boolean }) {
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
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: compact ? "center" : "flex-start",
          gap: "10px",
          minHeight: 44,
          padding: compact ? 0 : "0 8px",
          borderRadius: `${layout.radius.control}px`,
          textAlign: "left",
          marginTop: 2,
          font: "inherit",
          "&:hover": { backgroundColor: hf.surface2 },
        }}
      >
        <Avatar />
        <Box
          component="span"
          sx={{
            display: compact ? "none" : "flex",
            flexDirection: "column",
            lineHeight: "16px",
            minWidth: 0,
          }}
        >
          <Box
            component="span"
            sx={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {user?.name || user?.email}
          </Box>
          <Box component="span" sx={{ color: hf.textSecondary, fontSize: 12 }}>
            {t("nav.account")}
          </Box>
        </Box>
      </ButtonBase>
      <Menu
        id={menuId}
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={close}
        anchorOrigin={{ vertical: "top", horizontal: "left" }}
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{ list: { "aria-label": t("user.menu") } }}
      >
        {actions
          .slice(
            0,
            actions.findIndex((a) => a.id === "help"),
          )
          .map((action) => (
            <MenuItem
              key={action.id}
              {...(action.to ? { component: RouterLink, to: action.to } : {})}
              onClick={close}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{ display: "inline-flex", color: hf.textSecondary }}
              >
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
            <Box
              component="span"
              aria-hidden="true"
              sx={{ width: 16, display: "inline-flex", justifyContent: "center" }}
            >
              {prefs.theme === option.value ? "•" : ""}
            </Box>
            {t("user.theme")}: {t(option.label)}
          </MenuItem>
        ))}
        {actions.slice(actions.findIndex((a) => a.id === "help")).flatMap((action) => [
          action.divider ? <Divider key={`${action.id}-divider`} component="li" /> : null,
          <MenuItem
            key={action.id}
            {...(action.to
              ? { component: RouterLink, to: action.to }
              : action.href
                ? { component: "a", href: action.href, target: "_blank", rel: "noopener" }
                : {})}
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

/** The rail's storage use: a 2 px sliver; the percentage is its accessible name and its tooltip. */
function UsageSliver({ usage }: { usage: UsageSlotValue }) {
  if (!usage || usage === "unavailable") return null;
  const ratio = usage.quotaBytes > 0 ? Math.min(1, Math.max(0, usage.usedBytes / usage.quotaBytes)) : 0;
  const label = t("panels.storage", { percent: String(Math.round(ratio * 100)) });
  return (
    <Tooltip title={label} placement="right">
      <Box
        role="img"
        aria-label={label}
        data-storage-sliver
        sx={{
          height: "2px",
          margin: "8px 6px",
          backgroundColor: hf.hairline,
          borderRadius: "1px",
          overflow: "hidden",
        }}
      >
        <Box sx={{ width: `${ratio * 100}%`, height: "100%", backgroundColor: hf.textSecondary }} />
      </Box>
    </Tooltip>
  );
}

/**
 * Desktop sidebar: the six destinations, storage use, the account button. Collapsed (F02) it is an
 * icon rail: the same landmark and links, each named by its label (and a tooltip); storage use is a
 * sliver. Its width is the frame's `--hf-sidebar-w`.
 */
export function Sidebar({ id, collapsed = false }: { id?: string; collapsed?: boolean }) {
  const { pathname } = useLocation();
  const usage = useUsageSummary();
  return (
    <Box
      component="nav"
      id={id}
      aria-label={t("nav.primary")}
      data-sidebar
      data-rail={collapsed || undefined}
      sx={{
        width: `var(--hf-sidebar-w, ${layout.sidebar}px)`,
        transition: `width ${motion.folder}ms ease-out`,
        "body[data-panel-drag] &": { transition: "none" },
        flex: "none",
        boxSizing: "border-box",
        padding: collapsed ? "16px 8px" : "16px 12px",
        borderRight: `1px solid ${hf.hairline}`,
        display: "flex",
        flexDirection: "column",
        gap: 1,
        backgroundColor: hf.bg,
        minHeight: 0,
        overflowY: "auto",
        overflowX: "hidden",
      }}
    >
      <Box
        component={RouterLink}
        to="/"
        aria-label={t("nav.home")}
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: collapsed ? "center" : "flex-start",
          padding: collapsed ? "6px 0 18px" : "6px 8px 18px",
          color: hf.text,
          textDecoration: "none",
        }}
      >
        {collapsed ? <Mark /> : <Wordmark />}
      </Box>
      <Box
        component="ul"
        sx={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 1 }}
      >
        {DESTINATIONS.map((destination) => {
          const active = destination.matches(pathname);
          const Icon = destination.icon;
          const label = t(destination.label);
          const link = (
            <ListItemButton
              component={RouterLink}
              to={destination.path}
              selected={active}
              aria-current={active ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              data-nav={destination.id}
              sx={collapsed ? { justifyContent: "center", paddingLeft: 0, paddingRight: 0 } : undefined}
            >
              <Box
                component="span"
                aria-hidden="true"
                sx={{ display: "inline-flex", color: hf.textSecondary }}
              >
                <Icon size={16} />
              </Box>
              {collapsed ? null : label}
            </ListItemButton>
          );
          return (
            <li key={destination.id}>
              {collapsed ? (
                <Tooltip title={label} placement="right">
                  {link}
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </Box>
      <Box sx={{ flex: "1 1 auto" }} />
      {collapsed ? (
        <UsageSliver usage={usage} />
      ) : (
        <Box sx={{ padding: "8px 10px 4px" }}>
          <StorageBar
            usage={usage}
            footer={
              <Box
                component={RouterLink}
                to="/storage"
                sx={{
                  fontSize: 12,
                  color: hf.textSecondary,
                  textDecoration: "underline",
                  textUnderlineOffset: "2px",
                  alignSelf: "flex-start",
                  "&:hover": { color: hf.text },
                }}
              >
                {t("user.storage")}
              </Box>
            }
          />
        </Box>
      )}
      <UserMenu compact={collapsed} />
    </Box>
  );
}
