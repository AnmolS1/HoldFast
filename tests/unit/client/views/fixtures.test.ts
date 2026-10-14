// The fixtures are the contract's shapes, and the shapes the views must NOT accept are refused.
import { describe, expect, it } from "vitest";
import { UsageDto } from "../../../../src/shared/schemas/account";
import { TrashResponse } from "../../../../src/shared/schemas/node";
import { RecentResponse, SearchResponse, StarredResponse } from "../../../../src/shared/schemas/search";
import { RECENT, SEARCH, STARRED, TRASH, USAGE, node } from "./fixtures";

describe("view fixtures", () => {
  it("parse with the shared schemas", () => {
    expect(TrashResponse.parse(TRASH).items).toHaveLength(3);
    expect(RecentResponse.parse(RECENT).items).toHaveLength(4);
    expect(StarredResponse.parse(STARRED).items).toHaveLength(2);
    expect(SearchResponse.parse(SEARCH).items).toHaveLength(3);
    expect(UsageDto.parse(USAGE).quotaBytes).toBe(5_000_000_000);
  });

  it("a bare array is not an answer for recent or for search", () => {
    expect(RecentResponse.safeParse(RECENT.items).success).toBe(false);
    expect(SearchResponse.safeParse(SEARCH.items).success).toBe(false);
    expect(StarredResponse.safeParse(STARRED.items).success).toBe(false);
    expect(TrashResponse.safeParse(TRASH.items).success).toBe(false);
  });

  it("a trash row needs both dates; a search hit needs a text path hint", () => {
    expect(TrashResponse.safeParse({ items: [node(1)], nextCursor: null }).success).toBe(false);
    expect(SearchResponse.safeParse({ items: [node(1)], nextCursor: null }).success).toBe(false);
    expect(
      SearchResponse.safeParse({ items: [{ ...node(1), pathHint: null }], nextCursor: null }).success,
    ).toBe(false);
  });
});
