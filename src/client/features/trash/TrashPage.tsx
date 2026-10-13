// The trash: trashed roots with when they were deleted and when they are deleted for good.
// Nothing opens from here — restore first. Restore is one click; the two acts that purge
// (delete forever, empty trash) go through a confirmation that states what is lost.
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import MenuList from "@mui/material/MenuList";
import { MoreHorizontal, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { BottomSheet } from "../../components/BottomSheet";
import { EmptyState } from "../../components/EmptyState";
import { FileList } from "../../components/FileList";
import { Kbd } from "../../components/Kbd";
import { SelectionBar, SelectionBarAction } from "../../components/SelectionBar";
import { toast } from "../../components/Toaster";
import type { TrashItemDto } from "../../../shared/schemas/node";
import { ApiError, toastApiError } from "../../lib/api";
import { emitNodesChanged } from "../../lib/contracts";
import { formatDate } from "../../lib/format";
import { t as shellT } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { queryClient, useSession } from "../../lib/query";
import { shortcutLabel, useShortcut } from "../../lib/shortcuts";
import { useIsDesktop } from "../../theme/breakpoints";
import { hf } from "../../theme/tokens";
import { ListNotice, ViewError, ViewPage } from "../starred/view-kit";
import { canLoadMore, hasFailed, isWaitingOffline, useLoadMore } from "../starred/view-state";
import { viewKeys } from "../starred/view-queries";
import { EmptyTrashAction } from "./EmptyTrashAction";
import { deleteForever, dropFromTrashCache, restoreNode, useTrash } from "./queries";
import { t } from "./strings";

type TrashRow = TrashItemDto & { secondary: string };

const NO_SELECTION: ReadonlySet<string> = new Set<string>();
const COLUMNS = ["size" as const];

interface MenuTarget {
  item: TrashRow;
  /** The button the menu hangs from, or where the pointer was (context menu). */
  anchor: HTMLElement | { x: number; y: number };
}

function deleteConsequence(items: readonly TrashRow[]): string {
  const count =
    items.length === 1
      ? t("trash.delete.consequence.one")
      : t("trash.delete.consequence", { count: items.length });
  return items.some((item) => item.kind === "folder") ? `${count} ${t("trash.delete.folders")}` : count;
}

export function TrashPage() {
  const trash = useTrash();
  const desktop = useIsDesktop();
  const { viewMode } = usePrefs();
  const timeZone = useSession().data?.user.timezone;
  const [selection, setSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [deleting, setDeleting] = useState<TrashRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  const items = useMemo<TrashRow[]>(
    () =>
      (trash.data?.pages.flatMap((page) => page.items) ?? []).map((item) => ({
        ...item,
        secondary: t("trash.secondary", {
          deleted: formatDate(item.deletedAt, { timeZone }),
          purge: formatDate(item.purgeAfter, { timeZone }),
        }),
      })),
    [trash.data, timeZone],
  );
  const selected = useMemo(() => items.filter((item) => selection.has(item.id)), [items, selection]);
  const forget = (ids: ReadonlySet<string>) => {
    dropFromTrashCache(ids);
    setSelection((current) => new Set(Array.from(current).filter((id) => !ids.has(id))));
  };

  const restore = async (targets: readonly TrashRow[]) => {
    setMenu(null);
    setConflict(false);
    setBusy(true);
    let reread = false;
    try {
      for (const target of targets) {
        try {
          const restored = await restoreNode(target.id);
          forget(new Set([target.id]));
          toast({ message: t("trash.restored", { name: restored.name }), key: "trash-restored" });
          // Where it came back to: its folder, or the top level (`null`).
          emitNodesChanged([restored.parentId]);
        } catch (error) {
          // One sentence for every refusal: the API gives no reason and none is guessed.
          if (error instanceof ApiError && error.status === 409) setConflict(true);
          else {
            toastApiError(error);
            // Whatever else went wrong, the row may no longer be what the server has (purged
            // in another tab, restored elsewhere): read the trash again.
            reread = true;
          }
        }
      }
    } finally {
      setBusy(false);
      if (reread) void queryClient.invalidateQueries({ queryKey: viewKeys.trash });
    }
  };

  const purge = async (targets: readonly TrashRow[]) => {
    setBusy(true);
    const gone = new Set<string>();
    let failure: unknown;
    try {
      for (const target of targets) {
        try {
          await deleteForever(target.id);
          gone.add(target.id);
        } catch (error) {
          failure ??= error;
        }
      }
    } finally {
      setBusy(false);
      setDeleting(null);
    }
    if (gone.size > 0) {
      forget(gone);
      const only = targets.length === 1 ? targets[0] : undefined;
      toast({
        message: only
          ? t("trash.delete.done.one", { name: only.name })
          : t("trash.delete.done", { count: gone.size }),
        key: "trash-deleted",
      });
    }
    if (failure !== undefined) toastApiError(failure);
    // No live listing changed; this feature's own trash and storage numbers did.
    emitNodesChanged([]);
  };

  const askDelete = (targets: readonly TrashRow[]) => {
    setMenu(null);
    if (targets.length > 0) setDeleting([...targets]);
  };
  // Delete / Backspace asks for the selection — unless something is open above the list: this
  // page's own menu or confirmation (its state), or any dialog at all ("Empty the trash?", the
  // mobile sheet, the palette — whatever is in the document). The key is theirs then.
  useShortcut(
    "trash",
    () => {
      if (document.querySelector('[role="dialog"]')) return;
      askDelete(selected);
    },
    selected.length > 0 && deleting === null && menu === null,
  );
  const loadMore = useLoadMore(trash.fetchNextPage);

  const onOpen = useCallback(() => {
    toast({ message: t("trash.openHint"), key: "trash-open" });
  }, []);
  const rowMenu = useCallback(
    (item: TrashRow) => (
      <IconButton
        aria-label={shellT("list.more", { name: item.name })}
        aria-haspopup={desktop ? "menu" : "dialog"}
        onClick={(event) => setMenu({ item, anchor: event.currentTarget })}
        data-trash-menu={item.id}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </IconButton>
    ),
    [desktop],
  );
  const onContextMenu = useCallback(
    (item: TrashRow, anchor: { x: number; y: number }) => setMenu({ item, anchor }),
    [],
  );

  if (hasFailed(trash) || isWaitingOffline(trash)) {
    return (
      <ViewPage view="trash">
        <ViewError view="trash" title={t("trash.error.title")} query={trash} />
      </ViewPage>
    );
  }

  const count = trash.hasNextPage
    ? items.length === 1
      ? t("trash.count.more.one")
      : t("trash.count.more", { count: items.length })
    : items.length === 1
      ? t("trash.count.one")
      : t("trash.count", { count: items.length });
  const deletingOne = deleting?.length === 1 ? deleting[0] : undefined;
  const menuActions = menu ? (
    <>
      <MenuItem onClick={() => void restore([menu.item])} disabled={busy} data-trash-action="restore">
        {t("trash.restore")}
      </MenuItem>
      <MenuItem onClick={() => askDelete([menu.item])} disabled={busy} data-trash-action="delete">
        <Box component="span" sx={{ flex: "1 1 auto" }}>
          {t("trash.deleteForever")}
        </Box>
        {desktop ? <Kbd>{shortcutLabel("trash")}</Kbd> : null}
      </MenuItem>
    </>
  ) : null;

  return (
    <ViewPage view="trash">
      <Box
        sx={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 3,
          padding: desktop ? "8px 20px" : "4px 16px 8px",
          borderBottom: `1px solid ${hf.hairline}`,
          flex: "none",
        }}
      >
        <Box sx={{ flex: "1 1 240px", minWidth: 0, color: hf.textSecondary }}>
          {items.length > 0 ? (
            <Box component="span" className="num" data-trash-count sx={{ color: hf.text, marginRight: 2 }}>
              {count}
            </Box>
          ) : null}
          {t("trash.note")}
        </Box>
        <EmptyTrashAction />
      </Box>
      {conflict ? (
        <Box
          role="alert"
          data-trash-conflict
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 2,
            padding: desktop ? "4px 8px 4px 20px" : "0 4px 0 16px",
            borderBottom: `1px solid ${hf.hairline}`,
            backgroundColor: hf.surface2,
            flex: "none",
          }}
        >
          <Box sx={{ flex: "1 1 auto" }}>{t("trash.restore.conflict")}</Box>
          <IconButton aria-label={t("trash.dismiss")} onClick={() => setConflict(false)}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </Box>
      ) : null}
      <SelectionBar
        count={selected.length}
        onClear={() => setSelection(NO_SELECTION)}
        actions={
          <>
            <SelectionBarAction
              label={t("trash.restore")}
              onClick={() => void restore(selected)}
              disabled={busy}
            />
            <SelectionBarAction
              label={t("trash.deleteForever")}
              onClick={() => askDelete(selected)}
              shortcut={desktop ? "trash" : undefined}
              disabled={busy}
            />
          </>
        }
      />
      <FileList
        items={items}
        view={viewMode}
        columns={COLUMNS}
        selectionMode="multi"
        selection={selection}
        onSelectionChange={setSelection}
        onOpen={onOpen}
        rowMenu={rowMenu}
        onContextMenu={desktop ? onContextMenu : undefined}
        hasMore={canLoadMore(trash)}
        onLoadMore={loadMore}
        loading={trash.isPending || trash.isFetchingNextPage}
        emptyState={<EmptyState type="cleared" title={t("trash.empty.title")} body={t("trash.empty.body")} />}
        ariaLabel={t("trash.list")}
      />
      <ListNotice view="trash" query={trash} />
      {desktop ? (
        <Menu
          open={menu !== null}
          onClose={() => setMenu(null)}
          {...(menu && !(menu.anchor instanceof HTMLElement)
            ? {
                anchorReference: "anchorPosition" as const,
                anchorPosition: { top: menu.anchor.y, left: menu.anchor.x },
              }
            : { anchorEl: menu?.anchor instanceof HTMLElement ? menu.anchor : null })}
          anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
          transformOrigin={{ vertical: "top", horizontal: "right" }}
        >
          {menuActions}
        </Menu>
      ) : (
        <BottomSheet
          open={menu !== null}
          onClose={() => setMenu(null)}
          title={menu?.item.name ?? ""}
          subtitle={menu?.item.secondary}
        >
          <MenuList aria-label={menu?.item.name}>{menuActions}</MenuList>
        </BottomSheet>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={
          deletingOne
            ? t("trash.delete.title.one", { name: deletingOne.name })
            : t("trash.delete.title", { count: deleting?.length ?? 0 })
        }
        consequence={deleting ? deleteConsequence(deleting) : ""}
        confirmLabel={t("trash.deleteForever")}
        destructive
        busy={busy}
        onConfirm={() => void purge(deleting ?? [])}
        onCancel={() => setDeleting(null)}
      />
    </ViewPage>
  );
}
