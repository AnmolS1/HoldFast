import { useMemo } from "react";
import { EmptyState } from "../../components/EmptyState";
import { useStarred } from "./queries";
import { t } from "./strings";
import { ListNotice, NodeList, ViewError, ViewPage } from "./view-kit";
import { viewKeys } from "./view-queries";
import { hasFailed, isWaitingOffline, usePagedView } from "./view-state";

export function StarredPage() {
  const starred = useStarred();
  const items = useMemo(() => starred.data?.pages.flatMap((page) => page.items) ?? [], [starred.data]);
  const paging = usePagedView(starred, viewKeys.starred, items.length);
  if (hasFailed(starred) || isWaitingOffline(starred)) {
    return (
      <ViewPage view="starred">
        <ViewError view="starred" title={t("starred.error.title")} query={starred} onRetry={paging.refresh} />
      </ViewPage>
    );
  }
  return (
    <ViewPage view="starred">
      <NodeList
        items={items}
        ariaLabel={t("starred.list")}
        loading={starred.isPending || starred.isFetchingNextPage}
        hasMore={paging.hasMore}
        onLoadMore={paging.loadMore}
        emptyState={
          <EmptyState type="cleared" title={t("starred.empty.title")} body={t("starred.empty.body")} />
        }
      />
      <ListNotice view="starred" problem={paging.problem} />
    </ViewPage>
  );
}
