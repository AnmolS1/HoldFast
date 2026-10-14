// `/preview/:nodeId` as a page: the dialog over whatever was open, with the signed-in source.
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { getKnownUserId } from "../../lib/query";
import { PreviewDialogView } from "./PreviewDialog";
import type { LoadedItem } from "./source";

interface PreviewRouteState {
  /** The files prev/next walks, in the opener's order. */
  siblingIds?: string[];
  /** The page underneath, and where Close returns to. */
  from?: string;
  /** Set here: `from` was worked out from the file's folder on a cold link, nothing is behind us. */
  cold?: boolean;
  /**
   * Set here: the account this state was written for. History state outlives an account change
   * (no purger reaches it), so another account's ids and folder are never offered.
   */
  account?: string;
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
  if (typeof raw.account === "string") state.account = raw.account;
  return state;
}

export function PreviewRoute() {
  const { nodeId = null } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const account = getKnownUserId() ?? undefined;
  const written = readState(location.state);
  // Written for another account: none of it is ours to use.
  const stale = written.account !== undefined && written.account !== account;
  const state: PreviewRouteState = stale ? {} : written;
  const { siblingIds, from, cold } = state;

  // What an opener wrote has no account yet: it is stamped with the one signed in now. Another
  // account's state is replaced, so its ids are not left in this entry either.
  // ONCE per history entry: the replace re-runs the frame's loader, and until it lands every
  // render still sees the unstamped entry — asking again would cancel the replace under way and
  // start it over, for ever.
  const unstamped = stale || (written.account === undefined && account !== undefined);
  const stampedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!unstamped || stampedKey.current === location.key) return;
    stampedKey.current = location.key;
    void navigate(location.pathname + location.search, { replace: true, state: { ...state, account } });
  });

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
        state: { siblingIds, from: parent, cold: true, account },
      });
    },
    [from, siblingIds, account, navigate, location.pathname, location.search],
  );

  const onNavigate = (id: string) =>
    void navigate(`/preview/${encodeURIComponent(id)}`, { replace: true, state: { ...state, account } });

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
