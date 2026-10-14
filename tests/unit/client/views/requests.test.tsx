// What the views SEND is the contract's too: every query string a hook builds parses with the
// strict query schema of its route, and the local limits are the schemas' own maxima.
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RECENT_LIMIT } from "../../../../src/client/features/recent/queries";
import { SearchSuggestions } from "../../../../src/client/features/search";
import { SUGGESTION_LIMIT } from "../../../../src/client/features/search/queries";
import { Q_MAX, Q_MIN } from "../../../../src/client/features/search/url-state";
import { TRASH_PAGE } from "../../../../src/client/features/trash/queries";
import { TrashQuery } from "../../../../src/shared/schemas/node";
import { RecentQuery, SearchQuery, StarredQuery } from "../../../../src/shared/schemas/search";
import { intersect, renderShell, setupShell, shellFetch } from "../shell/helpers";
import { RECENT, SEARCH, STARRED, TRASH, trashPage } from "./fixtures";
import { answering, json, openView, queryOf, requests, rowNames } from "./helpers";

setupShell();

const sent = (calls: Parameters<typeof requests>[0], api: string) =>
  requests(calls, "GET", api).map((call) => Object.fromEntries(queryOf(call)));

describe("the queries the views send parse with the route's query schema", () => {
  it("GET /api/trash, first page and next", async () => {
    const { calls } = await openView("/trash", {
      "GET /api/trash": (call) =>
        json(queryOf(call).get("cursor") ? trashPage([]) : trashPage(TRASH.items, "c2")),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    act(() => intersect());
    await waitFor(() => expect(sent(calls, "/api/trash")).toHaveLength(2));
    for (const query of sent(calls, "/api/trash")) expect(TrashQuery.safeParse(query).success).toBe(true);
    expect(sent(calls, "/api/trash")[1]).toEqual({ limit: String(TRASH_PAGE), cursor: "c2" });
  });

  it("GET /api/starred, first page and next", async () => {
    const { calls } = await openView("/starred", {
      "GET /api/starred": (call) =>
        json(
          queryOf(call).get("cursor") ? { items: [], nextCursor: null } : { ...STARRED, nextCursor: "c2" },
        ),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(2));
    act(() => intersect());
    await waitFor(() => expect(sent(calls, "/api/starred")).toHaveLength(2));
    for (const query of sent(calls, "/api/starred")) expect(StarredQuery.safeParse(query).success).toBe(true);
  });

  it("GET /api/recent", async () => {
    const { calls } = await openView("/recent", { "GET /api/recent": RECENT });
    await waitFor(() => expect(rowNames()).toHaveLength(4));
    expect(sent(calls, "/api/recent")).toHaveLength(1);
    for (const query of sent(calls, "/api/recent")) expect(RecentQuery.safeParse(query).success).toBe(true);
  });

  it("GET /api/search: the page (every filter, a next page) and the suggestions", async () => {
    const { calls } = await openView("/search?q=report&category=pdf&scope=mine", {
      "GET /api/search": (call) =>
        json(queryOf(call).get("cursor") ? { items: [], nextCursor: null } : { ...SEARCH, nextCursor: "c2" }),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    act(() => intersect());
    await waitFor(() => expect(sent(calls, "/api/search")).toHaveLength(2));
    for (const query of sent(calls, "/api/search")) expect(SearchQuery.safeParse(query).success).toBe(true);

    const suggestionCalls = shellFetch({ extra: answering({ "GET /api/search": SEARCH }) });
    renderShell(<SearchSuggestions query="report" onPick={() => {}} />);
    await waitFor(() => expect(sent(suggestionCalls, "/api/search")).toHaveLength(1));
    expect(SearchQuery.safeParse(sent(suggestionCalls, "/api/search")[0]).success).toBe(true);
  });
});

describe("the local limits are the schemas' own", () => {
  const accepts = (schema: { safeParse(input: unknown): { success: boolean } }, input: unknown) =>
    schema.safeParse(input).success;

  it("TRASH_PAGE and RECENT_LIMIT are the most their routes take", () => {
    expect(accepts(TrashQuery, { limit: TRASH_PAGE })).toBe(true);
    expect(accepts(TrashQuery, { limit: TRASH_PAGE + 1 })).toBe(false);
    expect(accepts(RecentQuery, { limit: RECENT_LIMIT })).toBe(true);
    expect(accepts(RecentQuery, { limit: RECENT_LIMIT + 1 })).toBe(false);
  });

  it("Q_MIN and Q_MAX are the bounds of SearchQuery.q; the suggestion limit is one the route takes", () => {
    expect(accepts(SearchQuery, { q: "x".repeat(Q_MIN) })).toBe(true);
    expect(accepts(SearchQuery, { q: "x".repeat(Q_MIN - 1) })).toBe(false);
    expect(accepts(SearchQuery, { q: "x".repeat(Q_MAX) })).toBe(true);
    expect(accepts(SearchQuery, { q: "x".repeat(Q_MAX + 1) })).toBe(false);
    expect(accepts(SearchQuery, { q: "xx", kind: "file", limit: SUGGESTION_LIMIT })).toBe(true);
  });
});
