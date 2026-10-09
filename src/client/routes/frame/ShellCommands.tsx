// Registers the shell's own palette commands and binds the global shortcuts. Renders nothing.
import { hasAdminRole } from "../../../shared/roles";
import { Moon, Sun } from "lucide-react";
import { useEffect } from "react";
import { useNavigate } from "react-router";
import {
  COMMAND_IDS,
  registerCommands,
  runCommand,
  togglePalette,
  type Command,
} from "../../components/CommandPalette";
import { requestUpload } from "../../features/upload";
import { t } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { usePublicConfig, useSession } from "../../lib/query";
import { useShortcut } from "../../lib/shortcuts";
import { openShortcuts } from "../help";
import { SEARCH_INPUT_ID } from "./Header";
import { DESTINATIONS } from "./nav";
import { isDarkNow, toggleTheme } from "./theme-toggle";

export function ShellCommands() {
  const navigate = useNavigate();
  const prefs = usePrefs();
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
    return registerCommands("shell", commands);
  }, [navigate, prefs.theme, config?.readOnly, config?.uploadsEnabled, role, config]);

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
