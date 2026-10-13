// The file explorer: `/` (the caller's top level) and `/folder/:id` (any folder they have a role
// on, their own or inside a share). The list, its selection rules, virtualisation and row states
// are the shared FileList's; this page supplies the data and what can be done with it.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  Clock,
  Download,
  Ellipsis,
  FileArchive,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Info,
  Pencil,
  RefreshCw,
  Share2,
  Star,
  StarOff,
  Trash2,
  Upload,
  WifiOff,
} from "lucide-react";
import {
  addTransitionType,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { Link as RouterLink, matchPath, useLocation, useNavigate, useParams } from "react-router";
import type { NodeDto } from "../../../shared/schemas/node";
import { useBreadcrumbs, type Crumb } from "../../components/Breadcrumbs";
import { COMMAND_IDS, registerCommands, type Command } from "../../components/CommandPalette";
import { useDetailsPanel } from "../../components/DetailsPanel";
import { EmptyState } from "../../components/EmptyState";
import { FileBadge, FolderGlyph } from "../../components/FileBadge";
import { FileList } from "../../components/FileList";
import { FrameBanner } from "../../components/FrameBanner";
import { SelectionBar, SelectionBarAction } from "../../components/SelectionBar";
import { StatusDot, statusSentence } from "../../components/StatusDot";
import { ThumbImage } from "../../components/ThumbImage";
import { toast } from "../../components/Toaster";
import { ApiError } from "../../lib/api";
import { t as shellT } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { queryClient } from "../../lib/query";
import { useIsDesktop } from "../../theme/breakpoints";
import { hf, layout } from "../../theme/tokens";
import { ShareDialog } from "../share";
import { requestUpload } from "../upload";
import { ActionMenu, type MenuAnchor, type MenuEntry } from "./ActionMenu";
import {
  announce,
  createFolderIn,
  describe,
  downloadNode,
  getAnnouncement,
  moveNodes,
  recheckNode,
  renameNode,
  setStarred,
  subscribeAnnouncement,
  trashNodes,
  type MoveTarget,
} from "./actions";
import { thumbUrl } from "./api";
import { NodeDetails, SelectionDetails } from "./Details";
import { MoveDialog, NameDialog } from "./dialogs";
import { DRAG_TYPE, DROP_RING, isNodeDrag } from "./dnd";
import {
  actionsFor,
  actionsForSelection,
  buildCrumbs,
  canAddTo,
  folderPath,
  shareRootOf,
  SHARING_READY,
  siblingWindow,
  truncateMiddle,
} from "./model";
import {
  patchInListings,
  reloadListing,
  removeFromListings,
  setSort,
  useFolderDetail,
  useListing,
  useListingChanged,
  useSort,
} from "./queries";
import { useScanPolling } from "./scan-poll";
import { EMPTY_SELECTION, explorerSelectionReducer, idsInRect, rectOf, type Rect } from "./selection";
import { t } from "./strings";
import { Toolbar } from "./Toolbar";
import { cancelZip, startZip, useZipJobs } from "./zip";

const hiddenSx = {
  position: "absolute",
  width: "1px",
  height: "1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

const subscribeOnline = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};
const isOnline = () => navigator.onLine !== false;

type DialogState =
  | { type: "new-folder"; busy: boolean; error: string | null }
  | { type: "rename"; node: NodeDto }
  | { type: "move"; nodes: NodeDto[] }
  | null;

interface MenuState {
  /** Empty = the folder's own menu (right-click on the background). */
  ids: string[];
  anchor: MenuAnchor;
}

/** After two minutes of scanning the row says so; the underline is still the status. */
function StillScanning() {
  const label = t("explorer.status.stillScanning");
  return (
    <Tooltip title={label}>
      <Box
        component="span"
        role="img"
        aria-label={label}
        data-still-scanning
        sx={{ display: "inline-flex", color: hf.textSecondary, flex: "none" }}
      >
        <Clock size={14} aria-hidden="true" />
      </Box>
    </Tooltip>
  );
}

/**
 * Put focus back into the list: on the given row when it is drawn, else on the list's own tab
 * stop. An empty folder has no row: then its first control, else the page itself, so that Tab
 * starts from here and not from the top of the document.
 */
function focusRow(id?: string | null): void {
  setTimeout(() => {
    const list = document.querySelector<HTMLElement>("[data-explorer-list]");
    const row = list
      ? ((id ? list.querySelector<HTMLElement>(`[data-item-id="${CSS.escape(id)}"]`) : null) ??
        list.querySelector<HTMLElement>('[data-item-index][tabindex="0"]') ??
        list.querySelector<HTMLElement>("[data-item-index]") ??
        list.querySelector<HTMLElement>("button, a[href]"))
      : null;
    (row ?? document.getElementById("main"))?.focus();
  }, 0);
}

/**
 * The row above the list has one height, from the layout tokens, whatever is in it. The selection
 * bar is laid OVER that row, not into it — so nothing measured from the shared bar is repeated
 * here, and selecting a row cannot move the row under the pointer.
 */
const barHeight = (desktop: boolean) => (desktop ? layout.touchTarget : layout.header);

// A folder opened from the list: the folder that arrives takes the focus the row had.
let focusOnArrival = false;

const getThumbUrl = (nodeId: string, size: number) => thumbUrl(nodeId, size);

function renderThumb(item: NodeDto) {
  if (item.kind === "folder") return <FolderGlyph size={40} />;
  const badge = <FileBadge name={item.name} mimeCategory={item.mimeCategory} size={48} />;
  // Only a clean image may have a thumbnail; anything else is the type icon and asks for nothing.
  if (!item.thumb || item.scanStatus !== "clean") return badge;
  return (
    <ThumbImage
      nodeId={item.id}
      versionKey={item.etag}
      size={320}
      alt=""
      eligible
      getUrl={getThumbUrl}
      fallback={badge}
      aspectRatio={4 / 3}
    />
  );
}

function Explorer({ folderId }: { folderId: string | null }) {
  const desktop = useIsDesktop();
  const narrow = useMediaQuery("(max-width:1279.95px)", { noSsr: true });
  const prefs = usePrefs();
  const { sort, dir } = useSort();
  const navigate = useNavigate();
  const location = useLocation();
  const online = useSyncExternalStore(subscribeOnline, isOnline, isOnline);
  const announcement = useSyncExternalStore(subscribeAnnouncement, getAnnouncement, getAnnouncement);
  const detail = useFolderDetail(folderId);
  const listing = useListing(folderId, sort, dir);
  const { setContent, open: openDetails, isOpen: detailsSheetOpen } = useDetailsPanel();
  const zipJobs = useZipJobs();
  const listRef = useRef<HTMLDivElement | null>(null);

  // While a preview is open above it this page stays mounted but is not the page in front: its
  // commands and shortcuts must not act on a selection the user cannot see.
  const inFront = Boolean(matchPath(folderId === null ? "/" : "/folder/:id", location.pathname));

  const nodes = useMemo(() => listing.data?.pages.flatMap((page) => page.items) ?? [], [listing.data]);
  const order = useMemo(() => nodes.map((node) => node.id), [nodes]);
  const folder = detail.data ?? null;
  const role = folderId === null ? "owner" : (folder?.node.role ?? "viewer");
  // Adding needs a folder that is known to be there: not while it loads, not when it failed.
  const canAdd = canAddTo(role) && (folderId === null || folder !== null) && listing.isSuccess;
  const shareRootId = shareRootOf(folder);

  const [rawSelection, dispatch] = useReducer(explorerSelectionReducer, EMPTY_SELECTION);
  // Derived, not stored: an item that left the folder is no longer selected.
  const selection = useMemo(
    () => explorerSelectionReducer(rawSelection, { type: "prune", order }).selected,
    [rawSelection, order],
  );
  const selected = useMemo(() => nodes.filter((node) => selection.has(node.id)), [nodes, selection]);

  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [share, setShare] = useState<string | null>(null);
  // Anything of this page's that is open over the list: a dialog, a menu, the share dialog, and on
  // the mobile layout the details sheet.
  const modal = dialog !== null || menu !== null || share !== null || (!desktop && detailsSheetOpen);
  const changedSince = useListingChanged(folderId);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const dragging = useRef<NodeDto[]>([]);
  const [marqueeStart, setMarqueeStart] = useState<{ x: number; y: number } | null>(null);
  const marqueeMoved = useRef(false);

  // ---- focus ---------------------------------------------------------------------------------

  /** What an action applies to: the selection, else the row that has focus. */
  const targets = useCallback((): NodeDto[] => {
    if (selected.length > 0) return selected;
    const id = document.activeElement?.closest("[data-item-id]")?.getAttribute("data-item-id");
    const node = id ? nodes.find((item) => item.id === id) : undefined;
    return node ? [node] : [];
  }, [selected, nodes]);

  // ---- actions -------------------------------------------------------------------------------

  const open = useCallback(
    (node: NodeDto) => {
      if (node.kind === "folder") {
        focusOnArrival = Boolean(document.activeElement?.closest("[data-explorer-list]"));
        // The folder-enter transition: the row's name becomes the breadcrumb's title.
        startTransition(() => {
          addTransitionType("folder");
          void navigate(folderPath(node.id));
        });
        return;
      }
      if (!actionsFor(node, { isShareRoot: false }).has("open")) {
        // Scanning or blocked: say why nothing opened.
        toast({ message: statusSentence(node.scanStatus, node.scanReason) ?? "", key: "open" });
        return;
      }
      void navigate(`/preview/${encodeURIComponent(node.id)}`, {
        state: { siblingIds: siblingWindow(nodes, node.id), from: location.pathname + location.search },
      });
    },
    [navigate, nodes, location.pathname, location.search],
  );

  const trash = useCallback(
    (items: readonly NodeDto[]) => {
      if (items.length === 0) return;
      const next = order[order.indexOf(items[items.length - 1]!.id) + 1];
      dispatch({ type: "clear" });
      void trashNodes(items);
      focusRow(next);
    },
    [order],
  );

  const download = useCallback((items: readonly NodeDto[]) => {
    const only = items.length === 1 ? items[0]! : null;
    if (only && only.kind === "file") {
      void downloadNode(only);
      return;
    }
    const name = only ? only.name : t("explorer.zip.name", { date: new Date().toISOString().slice(0, 10) });
    void startZip(
      items.map((item) => item.id),
      name,
    );
  }, []);

  const move = useCallback((items: readonly NodeDto[], target: MoveTarget) => {
    dispatch({ type: "clear" });
    void moveNodes(items, target).then(() => {
      // The moved rows are gone, and with them the focus if it sat on one: back into the list.
      if (document.activeElement === null || document.activeElement === document.body) focusRow();
    });
  }, []);

  const newFolder = useCallback(() => setDialog({ type: "new-folder", busy: false, error: null }), []);
  const upload = useCallback(() => requestUpload({ parentId: folderId ?? undefined }), [folderId]);

  const closeDialog = useCallback((focusId?: string | null) => {
    setDialog(null);
    focusRow(focusId);
  }, []);

  const entriesFor = useCallback(
    (items: readonly NodeDto[]): MenuEntry[] => {
      const allowed = actionsForSelection(items, shareRootId);
      const only = items.length === 1 ? items[0]! : null;
      const entries: MenuEntry[] = [];
      if (only && allowed.has("open"))
        entries.push({
          id: "open",
          label: t("explorer.action.open"),
          icon: <FolderOpen size={16} />,
          shortcut: "open",
          run: () => open(only),
        });
      if (only?.kind === "file" && allowed.has("download"))
        entries.push({
          id: "download",
          label: t(
            only.scanStatus === "clean" ? "explorer.action.download" : "explorer.action.downloadUnscanned",
          ),
          icon: <Download size={16} />,
          run: () => download([only]),
        });
      else if (allowed.has("zip"))
        entries.push({
          id: "zip",
          label: t("explorer.action.zip"),
          icon: <FileArchive size={16} />,
          run: () => download(items),
        });
      if (only && allowed.has("rename"))
        entries.push({
          id: "rename",
          label: t("explorer.action.rename"),
          icon: <Pencil size={16} />,
          shortcut: "rename",
          run: () => setDialog({ type: "rename", node: only }),
        });
      if (allowed.has("move"))
        entries.push({
          id: "move",
          label: t("explorer.action.move"),
          icon: <FolderInput size={16} />,
          run: () => setDialog({ type: "move", nodes: [...items] }),
        });
      if (allowed.has("star")) {
        const allStarred = items.every((item) => item.starred);
        entries.push({
          id: "star",
          label: t(allStarred ? "explorer.action.unstar" : "explorer.action.star"),
          icon: allStarred ? <StarOff size={16} /> : <Star size={16} />,
          run: () => void setStarred(items, !allStarred),
        });
      }
      if (only && allowed.has("share"))
        entries.push({
          id: "share",
          label: t("explorer.action.share"),
          icon: <Share2 size={16} />,
          disabled: !SHARING_READY,
          hint: SHARING_READY ? undefined : t("explorer.action.shareSoon"),
          run: () => setShare(only.id),
        });
      if (only && !desktop)
        entries.push({
          id: "details",
          label: shellT("details.label"),
          icon: <Info size={16} />,
          run: () => {
            // The sheet shows what is selected: select the item, and show it without waiting.
            dispatch({ type: "set", ids: [only.id] });
            setContent(<NodeDetails node={only} />, { title: only.name });
            openDetails();
          },
        });
      if (only && allowed.has("recheck"))
        entries.push({
          id: "recheck",
          label: t("explorer.action.recheck"),
          icon: <RefreshCw size={16} />,
          run: () => void recheckNode(only),
        });
      if (allowed.has("trash"))
        entries.push({
          id: "trash",
          label: t("explorer.action.trash"),
          icon: <Trash2 size={16} />,
          shortcut: "trash",
          destructive: true,
          separated: entries.length > 0,
          run: () => trash(items),
        });
      return entries;
    },
    [shareRootId, desktop, open, download, trash, setContent, openDetails],
  );

  const folderEntries = useMemo((): MenuEntry[] => {
    if (!canAdd) return [];
    return [
      {
        id: "new-folder",
        label: t("explorer.action.newFolder"),
        icon: <FolderPlus size={16} />,
        shortcut: "newFolder",
        run: newFolder,
      },
      {
        id: "upload",
        label: t("explorer.action.upload"),
        icon: <Upload size={16} />,
        shortcut: "upload",
        run: upload,
      },
    ];
  }, [canAdd, newFolder, upload]);

  // ---- focus that waits for the list ---------------------------------------------------------

  const focusWhenListed = useRef<string | null>(null);
  // Was focus last seen inside the list? A row that is removed takes the focus with it without
  // any event: when the list changes and focus has fallen to the document, it is put back.
  const focusInList = useRef(false);
  useEffect(() => {
    const wanted = focusWhenListed.current;
    if (wanted !== null && order.includes(wanted)) {
      focusWhenListed.current = null;
      focusRow(wanted);
    } else if (focusOnArrival && listing.isSuccess) {
      focusOnArrival = false;
      focusRow();
    } else if (focusInList.current && (document.activeElement ?? document.body) === document.body) {
      focusRow();
    }
  }, [order, listing.isSuccess]);

  // ---- commands: the frame's New menu, FAB and the ⇧N / F2 / Del keys run these by id ----------

  useEffect(() => {
    // Withdrawn while the page is not the one in front, and while a dialog, menu or sheet of its
    // own is open: a key or a palette command must not act on the selection behind it.
    if (!inFront || modal) return;
    const run = (id: string) => () =>
      entriesFor(targets())
        .find((entry) => entry.id === id && !entry.disabled)
        ?.run();
    const chosen = selected.length > 0 ? entriesFor(selected) : [];
    const commands: Command[] = [
      {
        id: COMMAND_IDS.newFolder,
        section: "actions",
        label: t("explorer.action.newFolder"),
        shortcut: "newFolder",
        disabled: !canAdd,
        run: newFolder,
      },
      // Rename and trash act on the selection or, without one, on the focused row: they are found
      // when the key is pressed, so they stay registered whenever the folder can be changed at all.
      {
        id: COMMAND_IDS.rename,
        section: "selection",
        label: t("explorer.action.rename"),
        shortcut: "rename",
        disabled: role === "viewer",
        run: run("rename"),
      },
      {
        id: COMMAND_IDS.trash,
        section: "selection",
        label: t("explorer.action.trash"),
        shortcut: "trash",
        disabled: role === "viewer",
        run: run("trash"),
      },
      ...chosen
        .filter((entry) => !["rename", "trash", "open", "details"].includes(entry.id) && !entry.disabled)
        .map((entry): Command => ({
          id: `explorer.${entry.id}`,
          section: "selection",
          label: entry.label,
          icon: entry.icon,
          run: entry.run,
        })),
    ];
    return registerCommands("explorer", commands);
  }, [inFront, modal, canAdd, role, selected, entriesFor, targets, newFolder]);

  // ---- details -------------------------------------------------------------------------------

  const shown = selected.length === 1 ? selected[0]! : selected.length === 0 ? (folder?.node ?? null) : null;
  useEffect(() => {
    if (selected.length > 1) {
      setContent(<SelectionDetails nodes={selected} />, {
        title: t("explorer.item.count", { count: selected.length }),
      });
    } else if (shown) {
      const mayRecheck = actionsFor(shown, { isShareRoot: shown.id === shareRootId }).has("recheck");
      setContent(
        <NodeDetails node={shown} onRecheck={mayRecheck ? () => void recheckNode(shown) : undefined} />,
        { title: shown.name },
      );
    } else setContent(null);
  }, [selected, shown, shareRootId, setContent]);
  useEffect(() => () => setContent(null), [setContent]);

  // ---- scan polling --------------------------------------------------------------------------

  const pendingIds = useMemo(
    () =>
      nodes.filter((node) => node.kind === "file" && node.scanStatus === "pending").map((node) => node.id),
    [nodes],
  );
  const stillScanning = useScanPolling(
    pendingIds,
    {
      onSettled: (node) => {
        patchInListings(queryClient, folderId, node.id, () => node);
        // A scan that ended is said once: ready, or what the row now says.
        const sentence = statusSentence(node.scanStatus, node.scanReason);
        announce(
          sentence === null
            ? t("explorer.done.scanned", { name: node.name })
            : t("explorer.done.scanEnded", { name: node.name, status: sentence }),
        );
      },
      onGone: (id) => void removeFromListings(queryClient, folderId, [id]),
    },
    // Not while a preview covers the page.
    inFront,
  );

  // ---- drag and drop -------------------------------------------------------------------------

  // A drag ends on the window even when its source row is no longer drawn (a virtualised row
  // scrolled away never delivers its own `dragend`): what was being dragged is forgotten here.
  useEffect(() => {
    const forget = () => {
      dragging.current = [];
      setDropTarget(null);
    };
    // After the drop target's own handler, which reads the ref.
    const later = () => setTimeout(forget, 0);
    window.addEventListener("dragend", later);
    window.addEventListener("drop", later);
    return () => {
      window.removeEventListener("dragend", later);
      window.removeEventListener("drop", later);
    };
  }, []);

  const dropOn = useCallback(
    (target: MoveTarget) => {
      const items = dragging.current.filter((item) => item.id !== target.id);
      dragging.current = [];
      setDropTarget(null);
      if (items.length > 0) move(items, target);
    },
    [move],
  );

  // The trail, whose parent crumbs are drop targets too (the link's own attributes, through the
  // shared component's `dropProps`).
  const crumbs = useMemo(() => {
    const trail = buildCrumbs(folderId, folder);
    if (!trail) return null;
    const droppable = desktop && canAddTo(role);
    return truncateMiddle(trail, narrow ? 4 : 7).map((crumb): Crumb => {
      if (!droppable || crumb.to === undefined) return crumb;
      const target: MoveTarget = { id: crumb.id ?? null, name: crumb.label };
      const key = `crumb:${target.id ?? "top"}`;
      return {
        ...crumb,
        dropProps: {
          onDragOver: (event) => {
            if (!isNodeDrag(event.dataTransfer)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget(key);
          },
          onDragLeave: () => setDropTarget((current) => (current === key ? null : current)),
          onDrop: (event) => {
            if (!isNodeDrag(event.dataTransfer)) return;
            event.preventDefault();
            dropOn(target);
          },
          ...(dropTarget === key
            ? { style: { ...DROP_RING, outlineOffset: 2 }, "data-drop-target": "true" }
            : {}),
        },
      };
    });
  }, [folderId, folder, narrow, desktop, role, dropTarget, dropOn]);
  useBreadcrumbs(crumbs);

  const openMenuFor = useCallback(
    (item: NodeDto, anchor: MenuAnchor) => {
      const inSelection = selection.has(item.id);
      if (!inSelection) dispatch({ type: "set", ids: [item.id] });
      setMenu({ ids: inSelection ? Array.from(selection) : [item.id], anchor });
    },
    [selection],
  );

  const rowProps = useCallback(
    (item: NodeDto): HTMLAttributes<HTMLElement> => {
      const allowed = actionsFor(item, { isShareRoot: item.id === shareRootId });
      const props: HTMLAttributes<HTMLElement> & { "data-scan"?: string; "data-drop-target"?: string } = {
        // The context menu from the keyboard: Shift+F10 or the menu key, on the focused row.
        onKeyDownCapture: (event: KeyboardEvent<HTMLElement>) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
          event.preventDefault();
          event.stopPropagation();
          openMenuFor(item, event.currentTarget);
        },
        "data-scan": item.kind === "file" ? item.scanStatus : undefined,
      };
      if (desktop && allowed.has("move")) {
        props.draggable = true;
        props.onDragStart = (event: DragEvent<HTMLElement>) => {
          // A selected row drags the whole selection — when all of it may move; else the row alone.
          const group = selection.has(item.id) ? selected : [item];
          const movable = actionsForSelection(group, shareRootId).has("move") ? group : [item];
          dragging.current = [...movable];
          event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(movable.map((node) => node.id)));
          event.dataTransfer.effectAllowed = "move";
        };
        props.onDragEnd = () => {
          dragging.current = [];
          setDropTarget(null);
        };
      }
      if (item.kind === "folder" && canAddTo(item.role)) {
        const accepts = (event: DragEvent<HTMLElement>) =>
          isNodeDrag(event.dataTransfer) && !dragging.current.some((node) => node.id === item.id);
        props.onDragOver = (event: DragEvent<HTMLElement>) => {
          if (!accepts(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
          setDropTarget(item.id);
        };
        props.onDragLeave = () => setDropTarget((current) => (current === item.id ? null : current));
        props.onDrop = (event: DragEvent<HTMLElement>) => {
          if (!accepts(event)) return;
          event.preventDefault();
          dropOn({ id: item.id, name: item.name });
        };
        if (dropTarget === item.id) {
          props.style = DROP_RING;
          props["data-drop-target"] = "true";
        }
      }
      return props;
    },
    [shareRootId, desktop, selection, selected, dropTarget, dropOn, openMenuFor],
  );

  // ---- drag-select (grid) and the background --------------------------------------------------

  useEffect(() => {
    const list = listRef.current;
    if (!marqueeStart || !list) return;
    const onMove = (event: globalThis.PointerEvent) => {
      const rect = rectOf(marqueeStart, { x: event.clientX, y: event.clientY });
      if (rect.right - rect.left < 4 && rect.bottom - rect.top < 4) return;
      marqueeMoved.current = true;
      setMarquee(rect);
      const items = Array.from(list.querySelectorAll<HTMLElement>("[data-item-id]")).map((element) => ({
        id: element.getAttribute("data-item-id")!,
        rect: element.getBoundingClientRect(),
      }));
      dispatch({ type: "set", ids: idsInRect(rect, items) });
    };
    const stop = () => {
      setMarqueeStart(null);
      setMarquee(null);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stop);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stop);
    };
  }, [marqueeStart]);
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!desktop || prefs.viewMode !== "grid" || event.button !== 0 || event.pointerType !== "mouse") return;
    if ((event.target as HTMLElement).closest("[data-item-id], button, a, input, [data-empty-state]")) return;
    marqueeMoved.current = false;
    setMarqueeStart({ x: event.clientX, y: event.clientY });
  };
  const onBackgroundClick = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("[data-item-id], button, a, input, [data-empty-state]")) return;
    if (marqueeMoved.current) {
      marqueeMoved.current = false;
      return;
    }
    if (selection.size > 0) dispatch({ type: "clear" });
  };
  const onBackgroundMenu = (event: MouseEvent<HTMLElement>) => {
    if ((event.target as HTMLElement).closest("[data-item-id], button, a, input")) return;
    if (folderEntries.length === 0) return;
    event.preventDefault();
    setMenu({ ids: [], anchor: { x: event.clientX, y: event.clientY } });
  };

  // ---- what is drawn --------------------------------------------------------------------------

  const failure =
    (folderId !== null && detail.isError ? detail.error : null) ?? (listing.isError ? listing.error : null);
  const failed = failure !== null && (detail.isError || nodes.length === 0);
  // "This folder isn't available" is said of a folder; the top level is never missing.
  const missing = folderId !== null && failure instanceof ApiError && failure.status === 404;
  // Rows are shown, but the last attempt to read them again failed: say that they may be old.
  const refreshFailed =
    !failed && nodes.length > 0 && listing.isRefetchError && !listing.isFetchNextPageError;
  const loading = listing.isPending || listing.isFetchingNextPage;
  // A page that failed is asked for again by the user, not by the scroll position.
  const moreFailed = listing.isFetchNextPageError;
  const hasMore = Boolean(listing.hasNextPage) && !moreFailed;
  const menuNodes = menu ? nodes.filter((node) => menu.ids.includes(node.id)) : [];
  const menuEntries = menu ? (menu.ids.length === 0 ? folderEntries : entriesFor(menuNodes)) : [];
  const barEntries = selected.length > 0 ? entriesFor(selected) : [];
  const barEntry = (id: string) => barEntries.find((entry) => entry.id === id);
  const zip = zipJobs[0];

  const emptyState =
    folderId === null ? (
      <EmptyState
        type="first-use"
        title={shellT("empty.first.title")}
        body={t("explorer.empty.first")}
        actions={
          <>
            <Button variant="cta" onClick={upload} data-empty-upload>
              {t("explorer.action.upload")}
            </Button>
            <Button onClick={newFolder}>{t("explorer.action.newFolder")}</Button>
          </>
        }
      />
    ) : (
      <EmptyState
        type="cleared"
        title={t("explorer.empty.folder.title")}
        body={t(canAdd ? "explorer.empty.folder.body" : "explorer.empty.folder.viewer")}
        actions={canAdd ? <Button onClick={newFolder}>{t("explorer.action.newFolder")}</Button> : undefined}
      />
    );

  return (
    <Box
      data-explorer={folderId ?? "top"}
      sx={{ position: "relative", display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
    >
      <Box role="status" aria-live="polite" data-explorer-live sx={hiddenSx}>
        {announcement}
      </Box>
      {online ? null : (
        <FrameBanner name="offline" tone="attention" icon={<WifiOff size={16} />}>
          {t("explorer.offline")}
        </FrameBanner>
      )}
      <Box data-explorer-bar sx={{ position: "relative", flex: "none", minHeight: barHeight(desktop) }}>
        <Box sx={{ position: "absolute", top: 0, left: 0, right: 0, zIndex: 2 }}>
          <SelectionBar
            count={selected.length}
            onClear={() => dispatch({ type: "clear" })}
            actions={
              <>
                {(desktop && !narrow ? ["download", "zip", "move", "star"] : []).map((id) => {
                  const entry = barEntry(id);
                  return entry ? (
                    <SelectionBarAction
                      key={id}
                      label={entry.label}
                      onClick={entry.run}
                      shortcut={entry.shortcut}
                      disabled={entry.disabled}
                    />
                  ) : null;
                })}
                {barEntry("trash") ? (
                  <SelectionBarAction
                    label={t("explorer.action.trash")}
                    onClick={barEntry("trash")!.run}
                    shortcut={desktop ? "trash" : undefined}
                    destructive
                  />
                ) : null}
                {/* Everything else — and, where the bar is narrow, everything but trash — is one step away. */}
                <SelectionBarAction
                  label={shellT("app.more")}
                  onClick={() => {
                    const focused = document.activeElement;
                    const bar = document.querySelector<HTMLElement>("[data-selection-bar]");
                    const anchor = focused instanceof HTMLElement && bar?.contains(focused) ? focused : bar;
                    if (anchor) setMenu({ ids: selected.map((node) => node.id), anchor });
                  }}
                />
                {zip ? (
                  <Box
                    component="span"
                    data-zip-count
                    sx={{ display: "inline-flex", alignItems: "center", gap: 1, color: hf.textSecondary }}
                  >
                    <span className="num">{zip.label}</span>
                    <SelectionBarAction label={t("explorer.zip.stop")} onClick={() => cancelZip(zip.id)} />
                  </Box>
                ) : null}
              </>
            }
          />
        </Box>
        {selected.length === 0 ? (
          <Toolbar
            count={nodes.length}
            more={Boolean(listing.hasNextPage)}
            showCount={!failed && !listing.isPending}
            sort={sort}
            dir={dir}
            onSort={(nextSort, nextDir) => setSort({ sort: nextSort, dir: nextDir })}
            height={barHeight(desktop)}
            desktop={desktop}
            viewMode={prefs.viewMode}
            onViewMode={prefs.setViewMode}
            canAdd={canAdd && !failed}
            onNewFolder={newFolder}
            onUpload={upload}
          />
        ) : null}
      </Box>
      {refreshFailed ? (
        <FrameBanner
          name="refresh-failed"
          tone="attention"
          action={
            <Button onClick={() => void listing.refetch()} data-retry-refresh>
              {shellT("app.retry")}
            </Button>
          }
        >
          {t("explorer.error.refresh")}
        </FrameBanner>
      ) : null}
      {changedSince && !failed ? (
        <FrameBanner
          name="changed"
          action={
            <Button onClick={() => reloadListing(queryClient, folderId)} data-reload>
              {t("explorer.reload")}
            </Button>
          }
        >
          {t("explorer.changed")}
        </FrameBanner>
      ) : null}
      {moreFailed && !failed ? (
        <FrameBanner
          name="more-failed"
          tone="attention"
          action={
            <Button onClick={() => void listing.fetchNextPage()} data-retry-more>
              {shellT("app.retry")}
            </Button>
          }
        >
          {t("explorer.error.more")}
        </FrameBanner>
      ) : null}
      {failed ? (
        <EmptyState
          type="unavailable"
          title={missing ? t("explorer.error.missing.title") : shellT("empty.unavailable.title")}
          body={
            missing
              ? t("explorer.error.missing.body")
              : t(folderId === null ? "explorer.error.top.body" : "explorer.error.load.body")
          }
          requestId={failure instanceof ApiError ? failure.requestId : undefined}
          actions={
            <>
              <Button
                onClick={() => {
                  if (folderId !== null) void detail.refetch();
                  void listing.refetch();
                }}
                data-retry
              >
                {shellT("app.retry")}
              </Button>
              {folderId !== null ? (
                <Button component={RouterLink} to="/">
                  {shellT("app.backToFiles")}
                </Button>
              ) : null}
            </>
          }
        />
      ) : (
        <Box
          ref={listRef}
          data-explorer-list
          onFocusCapture={() => {
            focusInList.current = true;
          }}
          onBlurCapture={(event) => {
            // Only when focus really went elsewhere — not when it fell to the document.
            const list = event.currentTarget;
            setTimeout(() => {
              const now = document.activeElement;
              if (now && now !== document.body && !list.contains(now)) focusInList.current = false;
            }, 0);
          }}
          onPointerDown={onPointerDown}
          onClick={onBackgroundClick}
          onContextMenu={onBackgroundMenu}
          sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
        >
          <FileList<NodeDto>
            items={nodes}
            view={prefs.viewMode}
            selectionMode="multi"
            selection={selection}
            onSelectionChange={(next) => dispatch({ type: "set", ids: order.filter((id) => next.has(id)) })}
            onOpen={open}
            onContextMenu={openMenuFor}
            rowProps={rowProps}
            renderThumb={renderThumb}
            renderStatus={(item) =>
              item.kind === "folder" ? null : item.scanStatus === "pending" ? (
                stillScanning.has(item.id) ? (
                  <StillScanning />
                ) : null
              ) : (
                <StatusDot status={item.scanStatus} reason={item.scanReason} variant="sentence" />
              )
            }
            rowMenu={(item) => (
              <IconButton
                aria-label={shellT("list.more", { name: item.name })}
                aria-haspopup="menu"
                tabIndex={-1}
                data-row-menu
                onClick={(event) => openMenuFor(item, event.currentTarget)}
              >
                <Ellipsis size={16} aria-hidden="true" />
              </IconButton>
            )}
            hasMore={hasMore}
            onLoadMore={() => {
              if (!listing.isFetchingNextPage) void listing.fetchNextPage();
            }}
            loading={loading}
            emptyState={emptyState}
            ariaLabel={folder?.node.name ?? shellT("nav.files")}
          />
        </Box>
      )}
      {marquee ? (
        <Box
          aria-hidden="true"
          data-marquee
          sx={{
            position: "fixed",
            left: marquee.left,
            top: marquee.top,
            width: marquee.right - marquee.left,
            height: marquee.bottom - marquee.top,
            border: `1px dashed ${hf.text}`,
            backgroundColor: hf.surface2,
            opacity: 0.5,
            pointerEvents: "none",
            zIndex: 3,
          }}
        />
      ) : null}
      <ActionMenu
        open={menu !== null && menuEntries.length > 0}
        title={menu && menu.ids.length > 0 ? describe(menuNodes) : (folder?.node.name ?? shellT("nav.files"))}
        entries={menuEntries}
        anchor={menu?.anchor ?? null}
        sheet={!desktop}
        onClose={() => setMenu(null)}
      />
      <NameDialog
        open={dialog?.type === "new-folder"}
        title={t("explorer.newFolder.title")}
        label={t("explorer.name.label")}
        confirmLabel={t("explorer.newFolder.confirm")}
        initial={t("explorer.newFolder.initial")}
        busy={dialog?.type === "new-folder" && dialog.busy}
        error={dialog?.type === "new-folder" ? dialog.error : null}
        onCancel={() => closeDialog()}
        onSubmit={(name) => {
          setDialog({ type: "new-folder", busy: true, error: null });
          void createFolderIn(folderId, name).then((result) => {
            if (result.ok) {
              // Its row is drawn once the listing has been read again; focus goes there then.
              focusWhenListed.current = result.node.id;
              closeDialog();
            } else if (result.conflict)
              setDialog({
                type: "new-folder",
                busy: false,
                error: t("explorer.error.nameTaken", { name }),
              });
            else setDialog({ type: "new-folder", busy: false, error: null });
          });
        }}
      />
      <NameDialog
        open={dialog?.type === "rename"}
        title={t("explorer.rename.title")}
        label={t("explorer.name.label")}
        confirmLabel={t("explorer.action.rename")}
        initial={dialog?.type === "rename" ? dialog.node.name : ""}
        selectStem={dialog?.type === "rename" && dialog.node.kind === "file"}
        onCancel={() => closeDialog(dialog?.type === "rename" ? dialog.node.id : null)}
        onSubmit={(name) => {
          if (dialog?.type !== "rename") return;
          const node = dialog.node;
          closeDialog(node.id);
          if (name !== node.name) void renameNode(node, name);
        }}
      />
      <MoveDialog
        open={dialog?.type === "move"}
        nodes={dialog?.type === "move" ? dialog.nodes : []}
        root={
          shareRootId && folder
            ? {
                id: shareRootId,
                name: folder.breadcrumbs.find((crumb) => crumb.id === shareRootId)?.name ?? folder.node.name,
              }
            : { id: null, name: shellT("nav.myFiles") }
        }
        onCancel={() => closeDialog(dialog?.type === "move" ? dialog.nodes[0]?.id : null)}
        onMove={(target) => {
          if (dialog?.type !== "move") return;
          const items = dialog.nodes;
          closeDialog();
          move(items, target);
        }}
      />
      <ShareDialog open={share !== null} nodeId={share} onClose={() => setShare(null)} />
    </Box>
  );
}

/** The route element of `/` and `/folder/:id`. A different folder is a fresh page. */
export function ExplorerPage() {
  const { id } = useParams();
  const folderId = id ?? null;
  return <Explorer key={folderId ?? "top"} folderId={folderId} />;
}
