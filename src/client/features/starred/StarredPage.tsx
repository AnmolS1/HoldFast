import { useMemo } from "react";
import { EmptyState } from "../../components/EmptyState";
import { useStarred } from "./queries";
import { t } from "./strings";
import { ListNotice, NodeList, ViewError, ViewPage } from "./view-kit";
import { canLoadMore, hasFailed, isWaitingOffline, useLoadMore } from "./view-state";

export function StarredPage() {
  const starred = useStarred();
  const items = useMemo(() => starred.data?.pages.flatMap((page) => page.items) ?? [], [starred.data]);
  const loadMore = useLoadMore(starred.fetchNextPage);
  if (hasFailed(starred) || isWaitingOffline(starred)) {
    return (
      <ViewPage view="starred">
        <ViewError view="starred" title={t("starred.error.title")} query={starred} />
      </ViewPage>
    );
  }
  return (
    <ViewPage view="starred">
      <NodeList
        items={items}
        ariaLabel={t("starred.list")}
        loading={starred.isPending || starred.isFetchingNextPage}
        hasMore={canLoadMore(starred)}
        onLoadMore={loadMore}
        emptyState={
          <EmptyState type="cleared" title={t("starred.empty.title")} body={t("starred.empty.body")} />
        }
      />
      <ListNotice view="starred" query={starred} />
    </ViewPage>
  );
}
