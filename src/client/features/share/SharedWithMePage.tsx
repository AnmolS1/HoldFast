// `/shared` — what other people share with the caller: T08's FileList over `GET /api/shared-with-me`,
// role-aware (each row is the root of the caller's view of it, with its owner's name). Opening a
// folder continues in the explorer (`/folder/:id`); a file opens in the preview.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import type { SharedWithMeDto } from "../../../shared/schemas/share";
import { EmptyState } from "../../components/EmptyState";
import { FileList } from "../../components/FileList";
import type { FileListItem } from "../../components/types";
import { ApiError } from "../../lib/api";
import { stamped } from "../../lib/history-state";
import { usePrefs } from "../../lib/prefs";
import { useSharedWithMe } from "./api";
import { t } from "./strings";

type Row = FileListItem & { item: SharedWithMeDto };

function rowOf(item: SharedWithMeDto): Row {
  const { node } = item;
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    size: node.kind === "file" ? node.size : null,
    mimeCategory: node.mimeCategory,
    scanStatus: node.scanStatus,
    updatedAt: node.updatedAt,
    secondary: item.owner.displayName
      ? t("shared.owner", { name: item.owner.displayName })
      : t("shared.owner.unnamed"),
    item,
  };
}

export function SharedWithMePage() {
  const shared = useSharedWithMe();
  const { viewMode } = usePrefs();
  const navigate = useNavigate();
  const location = useLocation();
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const rows = useMemo(() => (shared.data ?? []).map(rowOf), [shared.data]);
  const open = useCallback(
    (row: Row) => {
      if (row.kind === "folder") {
        void navigate(`/folder/${encodeURIComponent(row.id)}`);
        return;
      }
      const siblingIds = rows.filter((entry) => entry.kind === "file").map((entry) => entry.id);
      const from = location.pathname + location.search;
      void navigate(`/preview/${encodeURIComponent(row.id)}`, { state: stamped({ siblingIds, from }) });
    },
    [navigate, rows, location.pathname, location.search],
  );

  if (shared.isError) {
    const requestId = shared.error instanceof ApiError ? shared.error.requestId : undefined;
    return (
      <Box data-shared-page="with-me" sx={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
        <EmptyState
          type="unavailable"
          title={t("shared.error.title")}
          requestId={requestId}
          actions={<Button onClick={() => void shared.refetch()}>{t("share.retry")}</Button>}
        />
      </Box>
    );
  }
  return (
    <Box
      data-shared-page="with-me"
      sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
    >
      <FileList<Row>
        items={rows}
        view={viewMode}
        columns={["modified", "size"]}
        selectionMode="none"
        selection={selection}
        onSelectionChange={(next) => setSelection(next)}
        onOpen={open}
        hasMore={false}
        onLoadMore={() => {}}
        loading={shared.isPending}
        ariaLabel={t("shared.list")}
        emptyState={
          <EmptyState type="first-use" title={t("shared.empty.title")} body={t("shared.empty.body")} />
        }
      />
    </Box>
  );
}
