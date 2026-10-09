// What the user menu (desktop) and the Account sheet (mobile) both offer.
import { CircleHelp, HardDrive, Keyboard, LogOut, Mail, Scale, Settings, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { authClient } from "../../lib/auth-client";
import { callAuth } from "../../lib/auth-contract";
import { EXTERNAL_LINKS } from "../../lib/contracts";
import { t } from "../../lib/i18n";
import type { ThemePref } from "../../lib/prefs";
import { clearSession, queryClient, useSession } from "../../lib/query";
import { shortcutLabel } from "../../lib/shortcuts";
import { openShortcuts } from "../help";

export interface AccountAction {
  id: string;
  label: string;
  icon: ReactNode;
  /** Internal route. */
  to?: string;
  /** External page (opens in a new tab). */
  href?: string;
  onSelect?: () => void;
  shortcut?: string;
  /** A hairline above this item. */
  divider?: boolean;
  /** Desktop only (keyboard help has no use on a touch screen). */
  desktopOnly?: boolean;
}

export const THEME_OPTIONS: Array<{ value: ThemePref; label: "user.theme.system" | "user.theme.light" | "user.theme.dark" }> = [
  { value: "system", label: "user.theme.system" },
  { value: "light", label: "user.theme.light" },
  { value: "dark", label: "user.theme.dark" },
];

export function useSignOut(): () => Promise<void> {
  const navigate = useNavigate();
  return async () => {
    await callAuth(() => authClient.signOut());
    clearSession();
    // Nothing of the previous account may linger in the cache.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== "public-config" && query.queryKey[0] !== "session" });
    navigate("/login", { replace: true });
  };
}

export function useAccountActions(): AccountAction[] {
  const session = useSession().data;
  const signOut = useSignOut();
  const actions: AccountAction[] = [
    { id: "settings", label: t("user.settings"), icon: <Settings size={16} />, to: "/account" },
    { id: "storage", label: t("user.storage"), icon: <HardDrive size={16} />, to: "/storage" },
  ];
  if (session?.user.role === "admin") actions.push({ id: "admin", label: t("nav.admin"), icon: <ShieldCheck size={16} />, to: "/admin" });
  actions.push(
    { id: "help", label: t("user.help"), icon: <CircleHelp size={16} />, href: EXTERNAL_LINKS.help, divider: true },
    { id: "shortcuts", label: t("user.shortcuts"), icon: <Keyboard size={16} />, onSelect: openShortcuts, shortcut: shortcutLabel("help"), desktopOnly: true },
    { id: "support", label: t("user.support"), icon: <Mail size={16} />, href: EXTERNAL_LINKS.support },
    { id: "terms", label: t("user.terms"), icon: <Scale size={16} />, href: EXTERNAL_LINKS.terms, divider: true },
    { id: "privacy", label: t("user.privacy"), icon: <Scale size={16} />, href: EXTERNAL_LINKS.privacy },
    { id: "dmca", label: t("user.dmca"), icon: <Scale size={16} />, to: "/dmca" },
    { id: "sign-out", label: t("user.signOut"), icon: <LogOut size={16} />, onSelect: () => void signOut(), divider: true },
  );
  return actions;
}

export function initialsOf(name: string, email: string): string {
  const source = name.trim() || email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : source.slice(0, 2);
  return letters.toUpperCase();
}
