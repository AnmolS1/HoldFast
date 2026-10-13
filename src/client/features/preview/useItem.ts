// The file a preview is about, from either source, re-read every 5 s while its scan is pending.
import { useCallback, useEffect, useRef, useState } from "react";
import { openScope } from "./scope";
import { listSiblingIds, loadItem, type LoadedItem, type PreviewSource } from "./source";
import { failureOf, type PreviewFailure } from "./usePreviewUrl";

export const SCAN_POLL_MS = 5_000;

export type ItemState =
  | { status: "loading" }
  | { status: "ready"; item: LoadedItem }
  | { status: "error"; failure: PreviewFailure };

interface Held {
  key: string;
  state: ItemState;
}

export function useItem(source: PreviewSource, nodeId: string): { state: ItemState; retry(): void } {
  const sourceKind = source === "owner" ? "owner" : "public";
  const [attempt, setAttempt] = useState(0);
  const key = `${sourceKind}|${nodeId}|${attempt}`;
  const [held, setHeld] = useState<Held>({ key, state: { status: "loading" } });
  const latestSource = useRef(source);
  useEffect(() => {
    latestSource.current = source;
  });

  useEffect(() => {
    // Ends with the view and with the account: the poll then asks nothing more, a read on its
    // way is aborted and its answer dropped.
    const scope = openScope();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      if (!scope.alive()) return;
      loadItem(latestSource.current, nodeId, scope.signal).then(
        (item) => {
          if (!scope.alive()) return;
          setHeld({ key, state: { status: "ready", item } });
          // The preview opens by itself once the status leaves `pending`.
          if (item.scanStatus === "pending") timer = setTimeout(read, SCAN_POLL_MS);
        },
        (error: unknown) => {
          if (!scope.alive()) return;
          setHeld({ key, state: { status: "error", failure: failureOf(error) } });
        },
      );
    };
    // A mount that is undone at once (development's double mount) asks for nothing.
    queueMicrotask(read);
    return () => {
      scope.close();
      clearTimeout(timer);
    };
  }, [nodeId, key]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  return { state: held.key === key ? held.state : { status: "loading" }, retry };
}

interface Listed {
  parentKey: string;
  ids: string[];
}

const parentKeyOf = (parentId: string | null) => parentId ?? "\u0000root";

/**
 * The ids prev/next walks: the caller's list, or — for the signed-in source on a cold link — the
 * files of the node's own folder, listed once per folder.
 */
export function useSiblingIds(
  source: PreviewSource,
  given: string[] | undefined,
  item: LoadedItem | null,
): string[] {
  const [listed, setListed] = useState<Listed | null>(null);
  const node = source === "owner" && given === undefined ? (item?.node ?? null) : null;
  const wanted = node ? parentKeyOf(node.parentId) : null;
  const have = listed?.parentKey ?? null;
  const parentId = node?.parentId ?? null;

  useEffect(() => {
    if (wanted === null || wanted === have) return;
    const scope = openScope();
    queueMicrotask(() => {
      if (!scope.alive()) return;
      listSiblingIds(parentId, scope.signal).then(
        (ids) => {
          if (scope.alive()) setListed({ parentKey: wanted, ids });
        },
        () => {
          // No list: the preview still works, without prev/next.
          if (scope.alive()) setListed({ parentKey: wanted, ids: [] });
        },
      );
    });
    return () => scope.close();
  }, [wanted, have, parentId]);

  if (given !== undefined) return given;
  // While the next file is still loading its folder is not known yet: the last list stays.
  if (listed === null || (wanted !== null && listed.parentKey !== wanted)) return [];
  return listed.ids;
}
