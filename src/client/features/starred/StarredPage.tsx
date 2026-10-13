import { useMemo } from "react";
import { EmptyState } from "../../components/EmptyState";
import { useStarred } from "./queries";
import { t } from "./strings";
import { NodeList, ViewError, ViewPage } from "./view-kit";

export function StarredPage() {
  const starred = useStarred();
  const items = useMemo(() => starred.data?.pages.flatMap((page) => page.items) ?? [], [starred.data]);
  if (starred.isError && !starred.data) {
    return (
      <ViewPage view="starred">
        <ViewError
          view="starred"
          title={t("starred.error.title")}
          error={starred.error}
          onRetry={() => void starred.refetch()}
        />
      </ViewPage>
    );
  }
  return (
    <ViewPage view="starred">
      <NodeList
        items={items}
        ariaLabel={t("starred.list")}
        loading={starred.isPending || starred.isFetchingNextPage}
        hasMore={starred.hasNextPage}
        onLoadMore={() => void starred.fetchNextPage()}
        emptyState={
          <EmptyState type="cleared" title={t("starred.empty.title")} body={t("starred.empty.body")} />
        }
      />
    </ViewPage>
  );
}
