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
import { accountEpoch, sameAccount, useSession } from "../../lib/query";
import { shortcutLabel, useShortcut } from "../../lib/shortcuts";
import { useIsDesktop } from "../../theme/breakpoints";
import { hf } from "../../theme/tokens";
import { ListNotice, ViewError, ViewPage } from "../starred/view-kit";
import { refreshQueries, viewKeys } from "../starred/view-queries";
import {
  hasFailed,
  isWaitingOffline,
  retryNotBefore,
  useBlockedUntil,
  usePagedView,
} from "../starred/view-state";
import { EmptyTrashAction } from "./EmptyTrashAction";
import { setBatchStop, useBatchStop, type BatchStop } from "./batch-stop";
import { usePreConfirmRead } from "./empty-run";
import { announcedByClient, deleteForever, dropFromTrashCache, restoreNode, useTrash } from "./queries";
import { t } from "./strings";

type TrashRow = TrashItemDto & { secondary: string };

const NO_SELECTION: ReadonlySet<string> = new Set<string>();
const COLUMNS = ["size" as const];

interface MenuTarget {
  item: TrashRow;
  /** The button the menu hangs from, or where the pointer was (context menu). */
  anchor: HTMLElement | { x: number; y: number };
}

/**
 * Does this failure say something about the API rather than about the one item? A `429`, a `5xx`
 * or no answer at all: the next item would meet the same — the batch stops there. (A `409` or a
 * `404` is about the item; the batch goes on.)
 */
function stopsBatch(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status === 429 || error.status >= 500 || error.status === 0;
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
  const stopped = useBatchStop();
  // After a `429` the two actions are not offered again before the time the API named — on this
  // visit or a later one (the stop is the account's, batch-stop.ts).
  const batchWait = useBlockedUntil(stopped?.retryAt ?? 0);
  // The read before "Empty the trash?" is out: nothing else destructive starts meanwhile.
  const preConfirm = usePreConfirmRead();
  const blocked = busy || batchWait || preConfirm;

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

  const stop = (action: BatchStop["action"], done: number, left: number, error: unknown) =>
    setBatchStop({
      action,
      done,
      left,
      retryAt: retryNotBefore(error, Date.now()),
      requestId: error instanceof ApiError ? error.requestId : undefined,
      announced: announcedByClient(error),
    });

  // Both batches send ONE request at a time, and stop at the first answer that is about the API
  // (see `stopsBatch`): what is left stays selected, one notice says how far it got, and after
  // a `429` the actions stay off until the time the API named.
  const restore = async (targets: readonly TrashRow[]) => {
    setMenu(null);
    setConflict(false);
    setBatchStop(null);
    setBusy(true);
    let reread = false;
    let done = 0;
    let itemFailure: unknown;
    // Whose rows these are. If the account's state is purged while a request is out (sign-out,
    // another account), what comes back is nobody's: nothing is written, said or sent after it.
    const account = accountEpoch();
    try {
      for (const [index, target] of targets.entries()) {
        if (!sameAccount(account)) return;
        try {
          const restored = await restoreNode(target.id);
          if (!sameAccount(account)) return;
          done += 1;
          forget(new Set([target.id]));
          toast({ message: t("trash.restored", { name: restored.name }), key: "trash-restored" });
          // Where it came back to: its folder, or the top level (`null`).
          emitNodesChanged([restored.parentId]);
        } catch (error) {
          if (!sameAccount(account)) return;
          // One sentence for every refusal: the API gives no reason and none is guessed.
          if (error instanceof ApiError && error.status === 409) setConflict(true);
          else if (stopsBatch(error)) {
            stop("restore", done, targets.length - index, error);
            break;
          } else {
            itemFailure ??= error;
            // The row may no longer be what the server has (purged in another tab, restored
            // elsewhere): read the trash again.
            reread = true;
          }
        }
      }
    } finally {
      setBusy(false);
      if (sameAccount(account)) {
        // One toast for the batch, never one per item.
        if (itemFailure !== undefined) toastApiError(itemFailure);
        if (reread) void refreshQueries(viewKeys.trash);
      }
    }
  };

  const purge = async (targets: readonly TrashRow[]) => {
    setBatchStop(null);
    setBusy(true);
    const gone = new Set<string>();
    let itemFailure: unknown;
    const account = accountEpoch();
    try {
      for (const [index, target] of targets.entries()) {
        if (!sameAccount(account)) break;
        try {
          await deleteForever(target.id);
          gone.add(target.id);
        } catch (error) {
          if (!sameAccount(account)) break;
          if (stopsBatch(error)) {
            stop("delete", gone.size, targets.length - index, error);
            break;
          }
          itemFailure ??= error;
        }
      }
    } finally {
      setBusy(false);
      setDeleting(null);
    }
    if (!sameAccount(account)) return;
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
    if (itemFailure !== undefined) toastApiError(itemFailure);
    // No live listing changed; this feature's own trash and storage numbers did.
    emitNodesChanged([]);
  };

  const askDelete = (targets: readonly TrashRow[]) => {
    setMenu(null);
    if (blocked) return;
    if (targets.length > 0) setDeleting([...targets]);
  };
  // Delete / Backspace asks for the selection — unless something is open above the list. A
  // dialog (this page's confirmation, "Empty the trash?", the mobile sheet, the palette) is the
  // shell's rule: `useShortcut` ignores a page's key under one. The row menu is not a dialog, so
  // that one is this page's to rule out.
  useShortcut(
    "trash",
    () => askDelete(selected),
    selected.length > 0 && deleting === null && menu === null && !blocked,
  );
  const paging = usePagedView(trash, viewKeys.trash, items.length);

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
        <ViewError view="trash" title={t("trash.error.title")} query={trash} onRetry={paging.refresh} />
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
      <MenuItem onClick={() => void restore([menu.item])} disabled={blocked} data-trash-action="restore">
        {t("trash.restore")}
      </MenuItem>
      <MenuItem onClick={() => askDelete([menu.item])} disabled={blocked} data-trash-action="delete">
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
      {stopped ? (
        // One announcement: when the API client has said it already (a `429`, a `503` read-only
        // or paused), this line is not a live region; otherwise it is the alert.
        <Box
          role={stopped.announced ? undefined : "alert"}
          data-trash-stopped={stopped.action}
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
          <Box sx={{ flex: "1 1 auto" }}>
            {t(stopped.action === "restore" ? "trash.batch.restore" : "trash.batch.delete", {
              done: stopped.done,
              left: stopped.left,
            })}
            {batchWait ? ` ${t("trash.batch.wait")}` : ""}
            {stopped.requestId ? (
              <>
                {" "}
                <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
                  {shellT("app.requestId", { id: stopped.requestId })}
                </Box>
              </>
            ) : null}
          </Box>
          <IconButton aria-label={t("trash.dismiss")} onClick={() => setBatchStop(null)} disabled={batchWait}>
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
              disabled={blocked}
            />
            <SelectionBarAction
              label={t("trash.deleteForever")}
              onClick={() => askDelete(selected)}
              shortcut={desktop ? "trash" : undefined}
              disabled={blocked}
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
        hasMore={paging.hasMore}
        onLoadMore={paging.loadMore}
        loading={trash.isPending || trash.isFetchingNextPage}
        emptyState={<EmptyState type="cleared" title={t("trash.empty.title")} body={t("trash.empty.body")} />}
        ariaLabel={t("trash.list")}
      />
      <ListNotice view="trash" problem={paging.problem} />
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
