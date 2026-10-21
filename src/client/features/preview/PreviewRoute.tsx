// `/preview/:nodeId` as a page: the dialog over whatever was open, with the signed-in source.
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { UNSAFE_DataRouterContext, useLocation, useNavigate, useParams } from "react-router";
import { isStamped, ownHistoryState, stamped } from "../../lib/history-state";
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
  // The router's LIVE state (React's copy lags behind it). A write held back below is tried again on
  // the next render: a navigation that ends commits a location (a new one, or this entry's again),
  // which renders this route if it is still here — the router never ends one without that.
  const router = useContext(UNSAFE_DataRouterContext)?.router;
  // A replace written later — by the effect below, or when the file arrives — goes to whatever entry
  // is CURRENT when it is applied. After a Back or a link that the router took before React drew it,
  // that is another page's entry, and the replace would put the preview back in its place
  // (EXECUTION 2026-10-21 12:10). So it is written only while the router is on THIS entry and is not
  // on its way to another address; a navigation to this same address (our own replace re-running
  // the frame's loader) is ours and does not hold it back. Accepted (review D4): a POP to ANOTHER
  // history entry with the same URL would pass as well — our own replace gets a fresh key, so the
  // pending key cannot tell the two apart; such a POP is rare and only lets a write land there.
  const here = location.pathname + location.search;
  const onEntry = useCallback(() => {
    if (router === undefined) return true;
    if (router.state.location.key !== location.key) return false;
    const pending = router.state.navigation.location;
    return pending === undefined || pending.pathname + pending.search === here;
  }, [router, location.key, here]);
  const account = getKnownUserId() ?? undefined;
  // Written for another account, or for nobody (no account was known then): none of it is ours to
  // use, and it is never stamped as this account's (lib/history-state.ts).
  const own = ownHistoryState(location.state);
  const written = readState(own);
  const stale = isStamped(location.state) && own === null;
  const state: PreviewRouteState = stale ? {} : written;
  const { siblingIds, from, cold } = state;

  // What an opener wrote has no account yet: it is stamped with the one signed in now. Another
  // account's state is replaced, so its ids are not left in this entry either.
  // ONCE per history entry: the replace re-runs the frame's loader, and until it lands every
  // render still sees the unstamped entry — asking again would cancel the replace under way and
  // start it over, for ever.
  // With no account known there is nothing to stamp it as: the entry is left as it is (a stamp of
  // nobody's would read as stale again on the next entry, and replace for ever).
  const unstamped = account !== undefined && (stale || written.account === undefined);
  const stampedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!unstamped || stampedKey.current === location.key || !onEntry()) return;
    stampedKey.current = location.key;
    void navigate(location.pathname + location.search, { replace: true, state: stamped({ ...state }) });
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

  // The file's folder on a cold link, as soon as the file is known — before the replace that
  // records it in the entry has landed (that replace re-runs the frame's loader, which can take a
  // while): Close pressed in between still goes to the folder.
  const coldParent = useRef<string | null>(null);
  // The cold folder's write, when the file was known at a moment it could not be written (above).
  // `onItem` is called once per file, so a write held back is kept here and written by the effect
  // below as soon as the router is on this entry again — for the account it was learnt under only:
  // a write held across an account change is dropped (the folder is the other account's; review D3).
  const coldWrite = useRef<{ key: string; parent: string; account: string | null } | null>(null);
  const writeCold = useCallback(
    (parent: string) => {
      coldWrite.current = null;
      void navigate(location.pathname + location.search, {
        replace: true,
        state: stamped({ siblingIds, from: parent, cold: true }),
      });
    },
    [siblingIds, navigate, location.pathname, location.search],
  );
  const onItem = useCallback(
    (item: LoadedItem) => {
      // A cold link has no page underneath: once the file is known, its folder becomes that page.
      if (from !== undefined || !item.node) return;
      const parent = item.node.parentId === null ? "/" : `/folder/${item.node.parentId}`;
      // Close goes there from now on, whether or not the entry can record it yet.
      coldParent.current = parent;
      if (onEntry()) writeCold(parent);
      else coldWrite.current = { key: location.key, parent, account: getKnownUserId() };
    },
    [from, onEntry, writeCold, location.key],
  );
  useEffect(() => {
    const held = coldWrite.current;
    if (held && held.account !== getKnownUserId()) {
      coldWrite.current = null;
      return;
    }
    if (held && held.key === location.key && from === undefined && onEntry()) writeCold(held.parent);
  });

  const onNavigate = (id: string) =>
    void navigate(`/preview/${encodeURIComponent(id)}`, { replace: true, state: stamped({ ...state }) });

  const onClose = () => {
    // Opened from a page of the app: that page is the entry behind this one.
    if (from !== undefined && !cold && location.key !== "default") void navigate(-1);
    else void navigate(from ?? coldParent.current ?? "/", { replace: true });
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
