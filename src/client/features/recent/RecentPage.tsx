import { useCallback, useMemo } from "react";
import { EmptyState } from "../../components/EmptyState";
import { useSession } from "../../lib/query";
import { ListNotice, NodeList, ViewError, ViewPage } from "../starred/view-kit";
import { hasFailed, isWaitingOffline, refreshProblem, useRefresh } from "../starred/view-state";
import { recentGroup, type RecentGroup } from "./grouping";
import { useRecent } from "./queries";
import { t } from "./strings";

const GROUP_LABEL = {
  today: "recent.group.today",
  yesterday: "recent.group.yesterday",
  week: "recent.group.week",
  earlier: "recent.group.earlier",
} as const satisfies Record<RecentGroup, string>;

export function RecentPage() {
  const recent = useRecent();
  const timeZone = useSession().data?.user.timezone;
  const data = recent.data;
  // When it was opened; a row that somehow has no such time is placed by its last change.
  const groups = useMemo(() => {
    const byId = new Map<string, RecentGroup>();
    if (!data) return byId;
    const now = new Date(data.fetchedAt);
    for (const item of data.items)
      byId.set(item.id, recentGroup(item.lastAccessedAt ?? item.updatedAt, now, timeZone));
    return byId;
  }, [data, timeZone]);
  const groupLabel = useCallback(
    (item: { id: string }) => t(GROUP_LABEL[groups.get(item.id) ?? "earlier"]),
    [groups],
  );
  const refresh = useRefresh(recent);
  if (hasFailed(recent) || isWaitingOffline(recent)) {
    return (
      <ViewPage view="recent">
        <ViewError view="recent" title={t("recent.error.title")} query={recent} onRetry={refresh} />
      </ViewPage>
    );
  }
  return (
    <ViewPage view="recent">
      <NodeList
        items={data?.items ?? []}
        ariaLabel={t("recent.list")}
        loading={recent.isPending}
        groupLabel={groupLabel}
        emptyState={
          <EmptyState type="cleared" title={t("recent.empty.title")} body={t("recent.empty.body")} />
        }
      />
      <ListNotice view="recent" problem={refreshProblem(recent, refresh)} />
    </ViewPage>
  );
}
