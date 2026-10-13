// Building blocks the five view features share: the page container, the page's own error state,
// the notice under a list that could not be extended or refreshed, and the read-only list of
// nodes that Recent, Starred and Search show.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import { Fragment, type ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FileList } from "../../components/FileList";
import type { FileListItem } from "../../components/types";
import { ApiError } from "../../lib/api";
import { t as shellT } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { useSession } from "../../lib/query";
import { MOBILE_QUERY } from "../../theme/breakpoints";
import { hf } from "../../theme/tokens";
import { useOpenNode } from "./open-node";
import { t } from "./strings";
import { isWaitingOffline, type PagedQueryLike, type QueryLike } from "./view-state";

export type ViewName = "trash" | "recent" | "starred" | "search" | "usage";

/**
 * A page's own state (an open dialog, a selection, half-typed text) belongs to the account that
 * made it: when the signed-in account changes without a navigation, the page starts again.
 */
export function PerAccount({ children }: { children: ReactNode }) {
  const account = useSession().data?.user.id ?? "";
  return <Fragment key={account}>{children}</Fragment>;
}

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
  query: QueryLike;
}

/**
 * The page has nothing to show: its request failed (say so, show the request id, offer another
 * try) or the browser is offline (say that instead of loading for ever). Never thrown.
 */
export function ViewError({ view, title, query }: ViewErrorProps) {
  const offline = isWaitingOffline(query);
  return (
    <Box
      data-view-error={view}
      data-view-offline={offline ? "" : undefined}
      role="alert"
      sx={{ display: "flex", flex: "1 1 auto", minHeight: 0 }}
    >
      <EmptyState
        type="unavailable"
        title={offline ? t("view.offline.title") : title}
        body={offline ? t("view.offline.body") : t("view.error.body")}
        requestId={!offline && query.error instanceof ApiError ? query.error.requestId : undefined}
        actions={
          <Button variant="contained" onClick={() => void query.refetch()}>
            {t("view.error.retry")}
          </Button>
        }
      />
    </Box>
  );
}

/**
 * Under a list that is showing what it has: the next page, or a refresh, failed. The rows stay;
 * nothing more is asked until "Try again".
 */
export function ListNotice({ view, query }: { view: ViewName; query: QueryLike | PagedQueryLike }) {
  if (!query.isError || query.data === undefined) return null;
  const paged = "isFetchNextPageError" in query && query.isFetchNextPageError ? query : null;
  const requestId = query.error instanceof ApiError ? query.error.requestId : undefined;
  return (
    <Box
      role="alert"
      data-list-notice={view}
      sx={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 3,
        padding: "8px 20px",
        borderTop: `1px solid ${hf.hairline}`,
        backgroundColor: hf.surface2,
        flex: "none",
        // On the phone layout the "New" button floats over the page's bottom right corner
        // (52 px, 16 px in): the retry button must not end up underneath it.
        [`@media ${MOBILE_QUERY}`]: { padding: "8px 84px 8px 16px" },
      }}
    >
      <Box sx={{ flex: "1 1 auto", minWidth: 0 }}>
        {t(paged ? "view.more.failed" : "view.refresh.failed")}
        {requestId ? (
          <>
            {" "}
            <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
              {shellT("app.requestId", { id: requestId })}
            </Box>
          </>
        ) : null}
      </Box>
      <Button onClick={() => void (paged ? paged.fetchNextPage() : query.refetch())}>
        {t("view.error.retry")}
      </Button>
    </Box>
  );
}

const NO_SELECTION: ReadonlySet<string> = new Set<string>();
const ignoreSelection = () => {};
const noMore = () => {};

export interface NodeListProps<T extends FileListItem> {
  items: T[];
  ariaLabel: string;
  emptyState: ReactNode;
  loading: boolean;
  hasMore?: boolean;
  /** Pass a stable function: the list re-arms its scroll trigger when it changes. */
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
  onLoadMore = noMore,
  groupLabel,
}: NodeListProps<T>) {
  const { viewMode } = usePrefs();
  const open = useOpenNode(items);
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
      onLoadMore={onLoadMore}
      loading={loading}
      emptyState={emptyState}
      ariaLabel={ariaLabel}
    />
  );
}
