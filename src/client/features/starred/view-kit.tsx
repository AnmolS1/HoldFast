// Building blocks the five view features share: the page container, the page's own error state,
// and the read-only list of nodes that Recent, Starred and Search show.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { useMemo, type ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FileList } from "../../components/FileList";
import type { FileListItem } from "../../components/types";
import { ApiError } from "../../lib/api";
import { usePrefs } from "../../lib/prefs";
import { useOpenNode } from "./open-node";
import { t } from "./strings";

export type ViewName = "trash" | "recent" | "starred" | "search" | "usage";

export function ViewPage({ view, children }: { view: ViewName; children: ReactNode }) {
  return (
    <Box
      data-view-page={view}
      sx={{ display: "flex", flexDirection: "column", flex: "1 1 auto", minHeight: 0 }}
    >
      {children}
    </Box>
  );
}

export interface ViewErrorProps {
  view: ViewName;
  /** What could not be loaded: "Couldn't load the trash". */
  title: string;
  error: unknown;
  onRetry(): void;
}

/** A request of the page failed: say so, show the request id, offer another try. Never thrown. */
export function ViewError({ view, title, error, onRetry }: ViewErrorProps) {
  return (
    <Box data-view-error={view} role="alert" sx={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}>
      <EmptyState
        type="unavailable"
        title={title}
        body={t("view.error.body")}
        requestId={error instanceof ApiError ? error.requestId : undefined}
        actions={
          <Button variant="contained" onClick={onRetry}>
            {t("view.error.retry")}
          </Button>
        }
      />
    </Box>
  );
}

const NO_SELECTION: ReadonlySet<string> = new Set<string>();
const ignoreSelection = () => {};

export interface NodeListProps<T extends FileListItem> {
  items: T[];
  ariaLabel: string;
  emptyState: ReactNode;
  loading: boolean;
  hasMore?: boolean;
  onLoadMore?(): void;
  groupLabel?(item: T): string | null;
}

/** The shared list in its read-only mode: rows open, nothing is selected. */
export function NodeList<T extends FileListItem>({
  items,
  ariaLabel,
  emptyState,
  loading,
  hasMore = false,
  onLoadMore,
  groupLabel,
}: NodeListProps<T>) {
  const { viewMode } = usePrefs();
  const open = useOpenNode(items);
  const loadMore = useMemo(() => onLoadMore ?? (() => {}), [onLoadMore]);
  return (
    <FileList
      items={items}
      view={viewMode}
      selectionMode="none"
      selection={NO_SELECTION}
      onSelectionChange={ignoreSelection}
      onOpen={open}
      onQuickLook={open}
      groupLabel={groupLabel}
      hasMore={hasMore}
      onLoadMore={loadMore}
      loading={loading}
      emptyState={emptyState}
      ariaLabel={ariaLabel}
    />
  );
}
