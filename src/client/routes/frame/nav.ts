// The destinations of the shell: six in the desktop sidebar; on mobile the same six live inside
// the three bottom-nav items (Files · Shared · Account).
import { Clock, Folder, Share2, Star, Trash2, Users, type LucideIcon } from "lucide-react";
import type { MessageKey } from "../../lib/i18n";

export type NavGroup = "files" | "shared" | "account";

export interface Destination {
  id: string;
  path: string;
  label: MessageKey;
  /** Label inside the mobile switcher, when it differs ("My files", "With me"). */
  shortLabel?: MessageKey;
  icon: LucideIcon;
  group: NavGroup;
  matches(pathname: string): boolean;
}

const at = (prefix: string) => (pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`);

export const DESTINATIONS: readonly Destination[] = [
  {
    id: "files",
    path: "/",
    label: "nav.files",
    shortLabel: "nav.myFiles",
    icon: Folder,
    group: "files",
    matches: (p) => p === "/" || p.startsWith("/folder/"),
  },
  {
    id: "shared",
    path: "/shared",
    label: "nav.sharedWithMe",
    shortLabel: "nav.shared.withMe",
    icon: Users,
    group: "shared",
    matches: at("/shared"),
  },
  {
    id: "shared-by-me",
    path: "/shared-by-me",
    label: "nav.sharedByMe",
    shortLabel: "nav.shared.byMe",
    icon: Share2,
    group: "shared",
    matches: at("/shared-by-me"),
  },
  { id: "recent", path: "/recent", label: "nav.recent", icon: Clock, group: "files", matches: at("/recent") },
  {
    id: "starred",
    path: "/starred",
    label: "nav.starred",
    icon: Star,
    group: "files",
    matches: at("/starred"),
  },
  { id: "trash", path: "/trash", label: "nav.trash", icon: Trash2, group: "files", matches: at("/trash") },
];

/** The four entries of the mobile Files switcher, in its order. */
export const FILES_SWITCHER = ["files", "recent", "starred", "trash"] as const;

const ACCOUNT_PREFIXES = ["/account", "/storage", "/help", "/admin"];

export function destinationFor(pathname: string): Destination | undefined {
  return DESTINATIONS.find((destination) => destination.matches(pathname));
}

/** Which bottom-nav item a path belongs to. Search and uploads count as Files. */
export function groupFor(pathname: string): NavGroup {
  const destination = destinationFor(pathname);
  if (destination) return destination.group;
  return ACCOUNT_PREFIXES.some((prefix) => at(prefix)(pathname)) ? "account" : "files";
}
