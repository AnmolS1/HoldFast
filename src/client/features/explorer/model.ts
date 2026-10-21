// The explorer's rules as pure functions: what may be done to a node (role × scan status × share
// root), how the trail reads, and what a status says in plain English. No React, no requests.
import type { BreadcrumbDto, NodeDetailDto, NodeDto } from "../../../shared/schemas/node";
import type { Crumb } from "../../components/Breadcrumbs";
import { t as shellT } from "../../lib/i18n";
import type { SortDir, SortKey } from "./api";
import { messages, t } from "./strings";

/** Sharing arrives with the sharing task; until then the action is shown disabled. */
export const SHARING_READY = true;

export type ExplorerAction =
  "open" | "rename" | "move" | "star" | "download" | "zip" | "share" | "trash" | "recheck";

export interface ActionContext {
  /**
   * The node is the caller's share root: the folder a share row was made on. Someone it is shared
   * with may work inside it, never rename, move or trash the folder itself.
   */
  isShareRoot: boolean;
}

const NONE: ReadonlySet<ExplorerAction> = new Set();

/** What the scan status leaves available, before the role is looked at. */
function byStatus(node: NodeDto): ExplorerAction[] {
  if (node.kind === "folder") return ["open", "rename", "move", "star", "zip", "share", "trash"];
  switch (node.scanStatus) {
    case "clean":
      return ["open", "rename", "move", "star", "download", "zip", "share", "trash"];
    case "pending":
      return ["rename", "move", "trash"];
    case "infected":
    case "under_review":
      return ["trash"];
    case "skipped":
    case "error":
      // Never shareable, never zipped; the download carries the "unscanned" warning.
      return ["open", "rename", "move", "star", "download", "recheck", "trash"];
  }
}

const EDITOR_ONLY: ReadonlySet<ExplorerAction> = new Set(["rename", "move", "trash"]);
const OWNER_ONLY: ReadonlySet<ExplorerAction> = new Set(["star", "share", "recheck"]);

/** The actions available on one node for the caller's role on it. */
export function actionsFor(node: NodeDto, context: ActionContext): ReadonlySet<ExplorerAction> {
  const allowed = byStatus(node).filter((action) => {
    if (OWNER_ONLY.has(action)) return node.role === "owner";
    if (EDITOR_ONLY.has(action)) {
      if (node.role === "viewer") return false;
      return node.role === "owner" || !context.isShareRoot;
    }
    // An unscanned file is the owner's to download — and to open: nobody else is offered a
    // preview the server would refuse.
    if ((action === "download" || action === "open") && node.kind === "file" && node.scanStatus !== "clean")
      return node.role === "owner";
    return true;
  });
  return new Set(allowed);
}

const NEEDS_ONE: ReadonlySet<ExplorerAction> = new Set(["open", "rename", "recheck", "share"]);

/**
 * The actions available on a selection. Rename, open, Re-check and share take exactly one item;
 * move, star and trash need every item to allow them; a zip needs at least one item it can hold
 * (the manifest names what was left out). One clean file downloads directly.
 */
export function actionsForSelection(
  nodes: readonly NodeDto[],
  shareRootId: string | null,
): ReadonlySet<ExplorerAction> {
  if (nodes.length === 0) return NONE;
  const each = nodes.map((node) => actionsFor(node, { isShareRoot: node.id === shareRootId }));
  if (nodes.length === 1) return each[0]!;
  const out = new Set<ExplorerAction>();
  for (const action of ["move", "star", "trash"] as const) {
    if (each.every((set) => set.has(action))) out.add(action);
  }
  if (each.some((set) => set.has("zip"))) out.add("zip");
  for (const action of NEEDS_ONE) out.delete(action);
  return out;
}

/** May the caller add to this folder (new folder, upload, drop target)? */
export function canAddTo(role: NodeDto["role"]): boolean {
  return role !== "viewer";
}

/**
 * The folder a share was made on, as this caller sees the tree: for anyone but the owner the
 * breadcrumbs start there (the folder itself when it has no ancestors in view).
 */
export function shareRootOf(detail: NodeDetailDto | null): string | null {
  if (!detail || detail.node.role === "owner") return null;
  const ancestors = detail.breadcrumbs.filter((crumb) => crumb.id !== detail.node.id);
  return ancestors[0]?.id ?? detail.node.id;
}

// ---------------------------------------------------------------------------------------------

export const folderPath = (id: string | null) => (id === null ? "/" : `/folder/${encodeURIComponent(id)}`);

/**
 * The header trail. The owner's starts at "Files"; inside a share it starts at the share root,
 * exactly as the API returns it. `null` (still loading, or failed) leaves the route's own title.
 */
export function buildCrumbs(folderId: string | null, detail: NodeDetailDto | null): Crumb[] | null {
  const home = shellT("nav.files");
  if (folderId === null) return [{ label: home }];
  if (!detail) return null;
  const ancestors: BreadcrumbDto[] = detail.breadcrumbs.filter((crumb) => crumb.id !== detail.node.id);
  const trail: Crumb[] = detail.node.role === "owner" ? [{ label: home, to: "/" }] : [];
  for (const crumb of ancestors) trail.push({ label: crumb.name, to: folderPath(crumb.id), id: crumb.id });
  trail.push({ label: detail.node.name, id: detail.node.id });
  return trail;
}

/** Middle truncation: the first crumb, an ellipsis, and the last `max - 2`. */
export function truncateMiddle(crumbs: Crumb[], max: number): Crumb[] {
  if (max < 3 || crumbs.length <= max) return crumbs;
  return [crumbs[0]!, { label: "…" }, ...crumbs.slice(crumbs.length - (max - 2))];
}

// ---------------------------------------------------------------------------------------------

type Key = keyof typeof messages;

const SCAN_KEY: Record<NodeDto["scanStatus"], Key> = {
  clean: "explorer.scan.clean",
  pending: "explorer.scan.pending",
  infected: "explorer.scan.infected",
  under_review: "explorer.scan.underReview",
  skipped: "explorer.scan.skipped",
  error: "explorer.scan.error",
};

const REASON_KEY: Record<NonNullable<NodeDto["scanReason"]>, Key> = {
  size: "explorer.scan.reason.size",
  encrypted: "explorer.scan.reason.encrypted",
  limits: "explorer.scan.reason.limits",
  timeout: "explorer.scan.reason.timeout",
  engine: "explorer.scan.reason.engine",
  hash_mismatch: "explorer.scan.reason.hashMismatch",
};

/** The scan status as one plain sentence for the details panel. Never a category, never a reporter. */
export function scanSentence(node: Pick<NodeDto, "scanStatus" | "scanReason">): string {
  const base = t(SCAN_KEY[node.scanStatus]);
  const unscanned = node.scanStatus === "skipped" || node.scanStatus === "error";
  return unscanned && node.scanReason ? `${base} ${t(REASON_KEY[node.scanReason])}` : base;
}

const KIND_KEY: Record<NodeDto["mimeCategory"], Key> = {
  image: "explorer.kind.image",
  video: "explorer.kind.video",
  audio: "explorer.kind.audio",
  pdf: "explorer.kind.pdf",
  document: "explorer.kind.document",
  archive: "explorer.kind.archive",
  code: "explorer.kind.code",
  other: "explorer.kind.other",
};

/** "Folder", "Image · png", "File". */
export function kindLabel(node: Pick<NodeDto, "kind" | "mimeCategory" | "ext">): string {
  if (node.kind === "folder") return t("explorer.kind.folder");
  const label = t(KIND_KEY[node.mimeCategory]);
  return node.ext ? `${label} · ${node.ext.toLowerCase()}` : label;
}

/** How a node is shared, from `NodeDto.sharing`. */
export function sharingSentence(sharing: NodeDto["sharing"]): string {
  const people =
    sharing.people === 1
      ? t("explorer.sharing.person")
      : t("explorer.sharing.people", { count: sharing.people });
  const link =
    sharing.link === "active"
      ? t("explorer.sharing.link")
      : sharing.link === "paused"
        ? t("explorer.sharing.linkPaused")
        : sharing.link === "expired"
          ? t("explorer.sharing.linkExpired")
          : null;
  if (sharing.people > 0 && link) return t("explorer.sharing.both", { people, link });
  if (sharing.people > 0) return people;
  return link ?? t("explorer.sharing.none");
}

// ---------------------------------------------------------------------------------------------

export interface SortOption {
  key: SortKey;
  label: string;
}

/** "Modified" is the API's `updated`. */
export function sortOptions(): SortOption[] {
  return [
    { key: "name", label: t("explorer.sort.name") },
    { key: "updated", label: t("explorer.sort.modified") },
    { key: "size", label: t("explorer.sort.size") },
    { key: "kind", label: t("explorer.sort.kind") },
  ];
}

export function sortSentence(sort: SortKey, dir: SortDir): string {
  const label = sortOptions().find((option) => option.key === sort)?.label ?? "";
  return t(dir === "asc" ? "explorer.sort.asc" : "explorer.sort.desc", { by: label });
}

/** The ids a preview may step through: the files around the one opened, in list order. */
export function siblingWindow(nodes: readonly NodeDto[], openedId: string, radius = 250): string[] {
  const files = nodes.filter((node) => node.kind === "file").map((node) => node.id);
  const at = files.indexOf(openedId);
  if (at === -1) return [openedId];
  return files.slice(Math.max(0, at - radius), at + radius + 1);
}
