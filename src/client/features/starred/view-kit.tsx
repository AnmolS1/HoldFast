// Building blocks the five view features share: the page container, the page's own error state,
// the notice under a list that could not be extended or refreshed, and the read-only list of
// nodes that Recent, Starred and Search show.
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import type { ReactNode } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FileList } from "../../components/FileList";
import type { FileListItem } from "../../components/types";
import { ApiError } from "../../lib/api";
import { t as shellT } from "../../lib/i18n";
import { usePrefs } from "../../lib/prefs";
import { MOBILE_QUERY } from "../../theme/breakpoints";
import { hf } from "../../theme/tokens";
import { useOpenNode } from "./open-node";
import { t } from "./strings";
import {
  isWaitingOffline,
  retryNotBefore,
  useBlockedUntil,
  type ListProblem,
  type QueryLike,
} from "./view-state";

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

/**
 * "Try again" — which waits when the failure asked for it: after a `429` with `Retry-After` the
 * button stays off until that time has passed, and says why.
 */
function RetryButton({
  error,
  since,
  onRetry,
  variant,
}: {
  error: unknown;
  since: number;
  /** `hadFocus`: the button had the keyboard focus when it was pressed. */
  onRetry(hadFocus: boolean): void;
  variant?: "contained";
}) {
  const blocked = useBlockedUntil(retryNotBefore(error, since));
  return (
    <Box sx={{ display: "inline-flex", flexWrap: "wrap", alignItems: "center", gap: 3 }}>
      {blocked ? (
        <Box component="span" data-retry-wait sx={{ color: hf.textSecondary }}>
          {t("view.retry.wait")}
        </Box>
      ) : null}
      <Button
        variant={variant}
        onClick={(event) => onRetry(document.activeElement === event.currentTarget)}
        disabled={blocked}
      >
        {t("view.error.retry")}
      </Button>
    </Box>
  );
}

export interface ViewErrorProps {
  view: ViewName;
  /** What could not be loaded: "Couldn't load the trash". */
  title: string;
  query: QueryLike;
  /** Read it again (the page's `refresh`: the focus follows when it works). */
  onRetry(hadFocus: boolean): void;
}

/**
 * The page has nothing to show: its request failed (say so, show the request id, offer another
 * try) or the browser is offline (say that instead of loading for ever). Never thrown.
 */
export function ViewError({ view, title, query, onRetry }: ViewErrorProps) {
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
          <RetryButton
            error={offline ? null : query.error}
            since={query.errorUpdatedAt}
            onRetry={onRetry}
            variant="contained"
          />
        }
      />
    </Box>
  );
}

/**
 * Under a list that is showing what it has: the next page, or a refresh, failed. The rows stay;
 * nothing more is asked until "Try again".
 */
export function ListNotice({ view, problem }: { view: ViewName; problem: ListProblem | null }) {
  if (!problem) return null;
  const requestId = problem.error instanceof ApiError ? problem.error.requestId : undefined;
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
        {t(problem.kind === "more" ? "view.more.failed" : "view.refresh.failed")}
        {requestId ? (
          <>
            {" "}
            <Box component="span" className="mono" sx={{ color: hf.textSecondary }}>
              {shellT("app.requestId", { id: requestId })}
            </Box>
          </>
        ) : null}
      </Box>
      <RetryButton error={problem.error} since={problem.since} onRetry={problem.retry} />
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
