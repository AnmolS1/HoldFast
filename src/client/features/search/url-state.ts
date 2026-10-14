// A search is its address: `q`, `category` and `scope` live in the URL, so a search can be
// bookmarked, shared and reached with the back button. This module is the only place that reads
// or writes those three parameters.
import { MIME_CATEGORY_NAMES, type MimeCategoryName } from "../../../shared/constants";

export const SEARCH_SCOPES = ["all", "mine", "shared"] as const;
export type SearchScope = (typeof SEARCH_SCOPES)[number];

/** The type menu's values: exactly the category keys of the contract. */
export const SEARCH_CATEGORIES: readonly MimeCategoryName[] = MIME_CATEGORY_NAMES;

/** The contract's bounds on `q`. Below the minimum nothing is asked of the API. */
export const Q_MIN = 2;
export const Q_MAX = 100;

export interface SearchState {
  /** Trimmed, at most `Q_MAX` characters. */
  q: string;
  /** `null` = any type. */
  category: MimeCategoryName | null;
  scope: SearchScope;
}

const isCategory = (value: string | null): value is MimeCategoryName =>
  value !== null && (SEARCH_CATEGORIES as readonly string[]).includes(value);
const isScope = (value: string | null): value is SearchScope =>
  value !== null && (SEARCH_SCOPES as readonly string[]).includes(value);

/** Read the state from a query string. Anything unknown falls back to the default, never throws. */
export function parseSearch(params: URLSearchParams): SearchState {
  const category = params.get("category");
  const scope = params.get("scope");
  return {
    q: (params.get("q") ?? "").trim().slice(0, Q_MAX),
    category: isCategory(category) ? category : null,
    scope: isScope(scope) ? scope : "all",
  };
}

/** Write the state as a query string. Defaults are left out, so `/search?q=tax` stays that. */
export function searchParamsOf(state: SearchState): URLSearchParams {
  const params = new URLSearchParams();
  const q = state.q.trim().slice(0, Q_MAX);
  if (q) params.set("q", q);
  if (state.category) params.set("category", state.category);
  if (state.scope !== "all") params.set("scope", state.scope);
  return params;
}

/** Can this state be sent to the API at all? */
export function isSearchable(state: SearchState): boolean {
  return state.q.length >= Q_MIN;
}
