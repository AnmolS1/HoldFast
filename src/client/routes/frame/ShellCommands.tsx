// Registers the shell's own palette commands and binds the global shortcuts. Renders nothing.
import { hasAdminRole } from "../../../shared/roles";
import { Moon, PanelLeft, PanelRight, Sun } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import {
  COMMAND_IDS,
  registerCommands,
  runCommand,
  togglePalette,
  type Command,
} from "../../components/CommandPalette";
import { togglePanel } from "../../components/PanelSplitter";
import { requestUpload } from "../../features/upload";
import { t } from "../../lib/i18n";
import { useLayout, usePrefs } from "../../lib/prefs";
import { usePublicConfig, useSession } from "../../lib/query";
import { useShortcut } from "../../lib/shortcuts";
import { openShortcuts } from "../help";
import { SEARCH_INPUT_ID } from "./Header";
import { DESTINATIONS } from "./nav";
import { isDarkNow, toggleTheme } from "./theme-toggle";

export interface ShellCommandsProps {
  /** Desktop: the side panels exist, so their commands and shortcuts do (F02). */
  panels?: boolean;
  /** The page has a details panel (routes with `handle.details: false` don't). */
  details?: boolean;
}

export function ShellCommands({ panels = false, details = false }: ShellCommandsProps) {
  const navigate = useNavigate();
  const prefs = usePrefs();
  const layout = useLayout();
  const sidebarShown = !layout.sidebar.collapsed;
  const detailsShown = layout.details.open;
  const config = usePublicConfig().data;
  const role = useSession().data?.user.role;

  useEffect(() => {
    const go = (path: string) => () => navigate(path);
    const commands: Command[] = DESTINATIONS.map((destination) => {
      const Icon = destination.icon;
      return {
        id: `go.${destination.id}`,
        section: "goto",
        label: t(destination.label),
        icon: <Icon size={16} />,
        run: go(destination.path),
      };
    });
    commands.push(
      { id: "go.account", section: "goto", label: t("nav.account"), run: go("/account") },
      { id: "go.storage", section: "goto", label: t("nav.storage"), run: go("/storage") },
      { id: "go.uploads", section: "goto", label: t("nav.uploads"), run: go("/uploads") },
      { id: "go.help", section: "goto", label: t("nav.help"), run: go("/help") },
    );
    if (hasAdminRole(role))
      commands.push({ id: "go.admin", section: "goto", label: t("nav.admin"), run: go("/admin") });
    const dark = prefs.theme === "dark" || (prefs.theme === "system" && isDarkNow());
    commands.push(
      {
        id: COMMAND_IDS.upload,
        section: "actions",
        label: t("header.upload"),
        shortcut: "upload",
        disabled: Boolean(config?.readOnly) || (config ? !config.uploadsEnabled : false),
        run: () => requestUpload(),
      },
      {
        id: "upload.folder",
        section: "actions",
        label: t("header.uploadFolder"),
        shortcut: "uploadFolder",
        keywords: ["folder", "directory"],
        disabled: Boolean(config?.readOnly) || (config ? !config.uploadsEnabled : false),
        run: () => requestUpload({ kind: "folder" }),
      },
      {
        id: "shell.theme",
        section: "actions",
        label: t(dark ? "user.theme.toLight" : "user.theme.toDark"),
        icon: dark ? <Sun size={16} /> : <Moon size={16} />,
        shortcut: "theme",
        keywords: ["theme", "dark", "light", "mode"],
        run: toggleTheme,
      },
      {
        id: "shell.shortcuts",
        section: "actions",
        label: t("user.shortcuts"),
        shortcut: "help",
        run: openShortcuts,
      },
    );
    if (panels)
      commands.push({
        id: "panels.sidebar",
        section: "actions",
        label: t(sidebarShown ? "panels.sidebar.hide" : "panels.sidebar.show"),
        icon: <PanelLeft size={16} />,
        shortcut: "sidebar",
        keywords: ["sidebar", "panel", "rail", "navigation"],
        run: () => togglePanel("sidebar"),
      });
    if (details)
      commands.push({
        id: "panels.details",
        section: "actions",
        label: t(detailsShown ? "panels.details.hide" : "panels.details.show"),
        icon: <PanelRight size={16} />,
        shortcut: "details",
        keywords: ["details", "panel", "info"],
        run: () => togglePanel("details"),
      });
    return registerCommands("shell", commands);
  }, [
    navigate,
    prefs.theme,
    config?.readOnly,
    config?.uploadsEnabled,
    role,
    config,
    panels,
    details,
    sidebarShown,
    detailsShown,
  ]);

  useShortcut("palette", (event) => {
    event.preventDefault();
    togglePalette();
  });
  useShortcut("search", (event) => {
    event.preventDefault();
    document.getElementById(SEARCH_INPUT_ID)?.focus();
  });
  useShortcut("help", (event) => {
    event.preventDefault();
    openShortcuts();
  });
  useShortcut("theme", (event) => {
    event.preventDefault();
    toggleTheme();
  });
  useShortcut("upload", (event) => {
    if (config?.readOnly || (config && !config.uploadsEnabled)) return;
    event.preventDefault();
    requestUpload();
  });
  useShortcut("uploadFolder", (event) => {
    if (config?.readOnly || (config && !config.uploadsEnabled)) return;
    event.preventDefault();
    requestUpload({ kind: "folder" });
  });
  useShortcut(
    "sidebar",
    (event) => {
      event.preventDefault();
      togglePanel("sidebar");
    },
    panels,
  );
  useShortcut(
    "details",
    (event) => {
      event.preventDefault();
      togglePanel("details");
    },
    details,
  );
  // These three belong to the explorer; the shell only routes the key to the registered command.
  useShortcut("newFolder", (event) => {
    if (runCommand(COMMAND_IDS.newFolder)) event.preventDefault();
  });
  useShortcut("rename", (event) => {
    if (runCommand(COMMAND_IDS.rename)) event.preventDefault();
  });
  useShortcut("trash", (event) => {
    if (runCommand(COMMAND_IDS.trash)) event.preventDefault();
  });
  return null;
}
