// A search is its address: URL ↔ state, and the type menu's values are the contract's.
import { describe, expect, it } from "vitest";
import {
  isSearchable,
  parseSearch,
  Q_MAX,
  SEARCH_CATEGORIES,
  SEARCH_SCOPES,
  searchParamsOf,
} from "../../../../src/client/features/search/url-state";
import { MIME_CATEGORIES } from "../../../../src/shared/constants";
import { SearchQuery } from "../../../../src/shared/schemas/search";

const parse = (query: string) => parseSearch(new URLSearchParams(query));

describe("search URL state", () => {
  it("reads q, category and scope", () => {
    expect(parse("q=tax&category=pdf&scope=mine")).toEqual({ q: "tax", category: "pdf", scope: "mine" });
    expect(parse("q=tax")).toEqual({ q: "tax", category: null, scope: "all" });
    expect(parse("")).toEqual({ q: "", category: null, scope: "all" });
  });

  it("unknown values fall back to the defaults instead of reaching the API", () => {
    expect(parse("q=tax&category=spreadsheet&scope=everyone")).toEqual({
      q: "tax",
      category: null,
      scope: "all",
    });
    expect(parse("q=%20%20tax%20return%20").q).toBe("tax return");
    expect(parse(`q=${"x".repeat(150)}`).q).toHaveLength(Q_MAX);
  });

  it("writes only what differs from the defaults", () => {
    expect(searchParamsOf({ q: "tax", category: null, scope: "all" }).toString()).toBe("q=tax");
    expect(searchParamsOf({ q: "tax return", category: "pdf", scope: "shared" }).toString()).toBe(
      "q=tax+return&category=pdf&scope=shared",
    );
    expect(searchParamsOf({ q: "", category: null, scope: "all" }).toString()).toBe("");
  });

  it("state → URL → state is the identity, for every category and scope", () => {
    for (const category of [null, ...SEARCH_CATEGORIES]) {
      for (const scope of SEARCH_SCOPES) {
        const state = { q: "año & more?", category, scope };
        expect(parseSearch(new URLSearchParams(searchParamsOf(state).toString()))).toEqual(state);
      }
    }
  });

  it("the category values equal MIME_CATEGORIES, and the scopes equal the contract's", () => {
    expect([...SEARCH_CATEGORIES]).toEqual(Object.keys(MIME_CATEGORIES));
    expect([...SEARCH_SCOPES].sort()).toEqual([...SearchQuery.shape.scope.unwrap().options].sort());
    for (const category of SEARCH_CATEGORIES) {
      expect(SearchQuery.safeParse({ q: "tax", category }).success, category).toBe(true);
    }
  });

  it("asks the API only for what the contract accepts: two characters or more", () => {
    expect(isSearchable(parse("q=t"))).toBe(false);
    expect(isSearchable(parse("q=ta"))).toBe(true);
    expect(SearchQuery.safeParse({ q: "t" }).success).toBe(false);
    expect(SearchQuery.safeParse({ q: "ta" }).success).toBe(true);
  });
});
