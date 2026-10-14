// The explorer's selection as a pure reducer. Click, toggle, range, select-all, clear and
// long-press are the shared list's rules (one implementation); the explorer adds what only it
// needs: a marquee that sets the selection outright, and pruning when items leave the folder.
import {
  EMPTY_SELECTION,
  selectionReducer,
  type SelectionAction,
  type SelectionState,
} from "../../components/FileList";

export type ExplorerSelectionAction =
  | SelectionAction
  /** Drag-select: exactly these, in list order; the first becomes the range anchor. */
  | { type: "set"; ids: readonly string[] }
  /** Keep only ids that are still listed (after a trash, a move or a refetch). */
  | { type: "prune"; order: readonly string[] };

export { EMPTY_SELECTION };
export type { SelectionState };

export function explorerSelectionReducer(
  state: SelectionState,
  action: ExplorerSelectionAction,
): SelectionState {
  switch (action.type) {
    case "set": {
      if (action.ids.length === 0) return selectionReducer(state, { type: "clear" });
      return { selected: new Set(action.ids), anchor: action.ids[0] ?? null };
    }
    case "prune": {
      const listed = new Set(action.order);
      const kept = Array.from(state.selected).filter((id) => listed.has(id));
      const anchor = state.anchor !== null && listed.has(state.anchor) ? state.anchor : null;
      if (kept.length === state.selected.size && anchor === state.anchor) return state;
      return { selected: new Set(kept), anchor };
    }
    default:
      return selectionReducer(state, action);
  }
}

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The rectangle spanned by two corners, whichever way the pointer was dragged. */
export function rectOf(a: { x: number; y: number }, b: { x: number; y: number }): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Ids of the items the marquee touches, in the order given. */
export function idsInRect(marquee: Rect, items: ReadonlyArray<{ id: string; rect: Rect }>): string[] {
  return items
    .filter(
      ({ rect }) =>
        rect.left < marquee.right &&
        rect.right > marquee.left &&
        rect.top < marquee.bottom &&
        rect.bottom > marquee.top,
    )
    .map(({ id }) => id);
}
