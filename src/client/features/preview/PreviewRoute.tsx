// `/preview/:nodeId` as a page: the dialog over whatever was open, with the signed-in source.
import { useCallback, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { PreviewDialogView } from "./PreviewDialog";
import type { LoadedItem } from "./source";

interface PreviewRouteState {
  /** The files prev/next walks, in the opener's order. */
  siblingIds?: string[];
  /** The page underneath, and where Close returns to. */
  from?: string;
  /** Set here: `from` was worked out from the file's folder on a cold link, nothing is behind us. */
  cold?: boolean;
}

function readState(value: unknown): PreviewRouteState {
  if (typeof value !== "object" || value === null) return {};
  const raw = value as Record<string, unknown>;
  const state: PreviewRouteState = {};
  if (Array.isArray(raw.siblingIds) && raw.siblingIds.every((id) => typeof id === "string")) {
    state.siblingIds = raw.siblingIds as string[];
  }
  // An in-app path only, as the frame itself requires.
  if (typeof raw.from === "string" && raw.from.startsWith("/") && !raw.from.startsWith("//")) {
    state.from = raw.from;
  }
  if (raw.cold === true) state.cold = true;
  return state;
}

export function PreviewRoute() {
  const { nodeId = null } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const state = readState(location.state);
  const { siblingIds, from, cold } = state;

  // Focus goes back to whatever opened the preview (a row of the list underneath).
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus();
    },
    [opener],
  );

  const onItem = useCallback(
    (item: LoadedItem) => {
      // A cold link has no page underneath: once the file is known, its folder becomes that page.
      if (from !== undefined || !item.node) return;
      const parent = item.node.parentId === null ? "/" : `/folder/${item.node.parentId}`;
      void navigate(location.pathname + location.search, {
        replace: true,
        state: { siblingIds, from: parent, cold: true },
      });
    },
    [from, siblingIds, navigate, location.pathname, location.search],
  );

  const onNavigate = (id: string) =>
    void navigate(`/preview/${encodeURIComponent(id)}`, { replace: true, state });

  const onClose = () => {
    // Opened from a page of the app: that page is the entry behind this one.
    if (from !== undefined && !cold && location.key !== "default") void navigate(-1);
    else void navigate(from ?? "/", { replace: true });
  };

  return (
    <PreviewDialogView
      open
      nodeId={nodeId}
      siblingIds={siblingIds}
      onNavigate={onNavigate}
      onClose={onClose}
      onItem={onItem}
      source="owner"
    />
  );
}
