// Selection as a pure reducer: click, toggle (⌘/Ctrl-click, checkbox), shift-range, select all,
// clear, long-press. The list is controlled — it hands the next set to its owner — and keeps only
// the range anchor.

export interface SelectionState {
  selected: ReadonlySet<string>;
  /** Where a shift-range starts: the last item chosen without shift. */
  anchor: string | null;
}

export type SelectionAction =
  | { type: "click"; id: string }
  | { type: "toggle"; id: string }
  | { type: "longpress"; id: string }
  | { type: "range"; id: string; order: readonly string[] }
  | { type: "all"; order: readonly string[] }
  | { type: "clear" };

export const EMPTY_SELECTION: SelectionState = { selected: new Set<string>(), anchor: null };

export function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case "click":
      return { selected: new Set([action.id]), anchor: action.id };
    case "toggle": {
      const next = new Set(state.selected);
      if (next.has(action.id)) next.delete(action.id);
      else next.add(action.id);
      return { selected: next, anchor: action.id };
    }
    case "longpress": {
      // Enters selection mode on touch: adds, never removes.
      const next = new Set(state.selected);
      next.add(action.id);
      return { selected: next, anchor: action.id };
    }
    case "range": {
      const to = action.order.indexOf(action.id);
      if (to === -1) return state;
      const from = state.anchor === null ? -1 : action.order.indexOf(state.anchor);
      // No usable anchor (none yet, or it left the list): behave like a plain click.
      if (from === -1) return { selected: new Set([action.id]), anchor: action.id };
      const [start, end] = from <= to ? [from, to] : [to, from];
      return { selected: new Set(action.order.slice(start, end + 1)), anchor: state.anchor };
    }
    case "all":
      return { selected: new Set(action.order), anchor: state.anchor ?? action.order[0] ?? null };
    case "clear":
      return state.selected.size === 0 && state.anchor === null ? state : { selected: new Set<string>(), anchor: null };
  }
}
