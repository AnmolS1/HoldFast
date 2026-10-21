import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router";
import type { FileListItem } from "../../components/types";
import { stamped } from "../../lib/history-state";

/**
 * Open a row of a view: a folder in the explorer, a file in the preview — with the view's other
 * files as its siblings and this page as the place to come back to. Both are plain addresses.
 */
export function useOpenNode<T extends Pick<FileListItem, "id" | "kind">>(items: readonly T[]) {
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.pathname + location.search;
  return useCallback(
    (item: T) => {
      if (item.kind === "folder") {
        void navigate(`/folder/${encodeURIComponent(item.id)}`);
        return;
      }
      const siblingIds = items.filter((entry) => entry.kind === "file").map((entry) => entry.id);
      void navigate(`/preview/${encodeURIComponent(item.id)}`, { state: stamped({ siblingIds, from }) });
    },
    [navigate, items, from],
  );
}
