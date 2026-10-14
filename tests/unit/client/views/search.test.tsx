// The search page and the header's suggestions.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchSuggestions } from "../../../../src/client/features/search";
import { DEBOUNCE_MS } from "../../../../src/client/features/search/queries";
import { redactCrumbOrDrop, redactOrDrop } from "../../../../src/client/lib/sentry";
import { MIME_CATEGORIES } from "../../../../src/shared/constants";
import { SearchResponse } from "../../../../src/shared/schemas/search";
import { viewKeys } from "../../../../src/client/features/starred/view-queries";
import { queryClient, sessionQuery } from "../../../../src/client/lib/query";
import { renderShell, sessionOf, setupShell, shellFetch, type MockHandler } from "../shell/helpers";
import { nodeId, result, SEARCH, SEARCH_NONE, SEARCH_PDF } from "./fixtures";
import {
  answering,
  deferred,
  envelope,
  json,
  openView,
  pathOf,
  queryOf,
  requests,
  rowNames,
} from "./helpers";

// The preview is T18's feature: these tests check what a view WRITES when it opens a file (the
// address and its state), so the route answers with a stand-in. The real one stamps the state
// with the account and loads its renderers, which is T18's to test.
vi.mock("../../../../src/client/features/preview/PreviewRoute", () => ({
  PreviewRoute: () => <div data-preview-stand-in />,
}));

setupShell();
afterEach(() => vi.useRealTimers());

const input = () => document.querySelector<HTMLInputElement>("[data-search-input]")!;
const typeMenu = () => document.querySelector<HTMLSelectElement>("[data-search-type]")!;
const scopeMenu = () => document.querySelector<HTMLSelectElement>("[data-search-scope]")!;
const searches = (calls: Parameters<typeof requests>[0]) =>
  requests(calls, "GET", "/api/search").map((call) => Object.fromEntries(queryOf(call)));
const byCategory = {
  "GET /api/search": (call: Parameters<typeof queryOf>[0]) =>
    json(queryOf(call).get("category") === "pdf" ? SEARCH_PDF : SEARCH),
};

describe("/search", () => {
  it("?q=reprot shows report.pdf — the address is the search", async () => {
    const { calls } = await openView("/search?q=reprot", { "GET /api/search": SEARCH });
    await waitFor(() => expect(rowNames()).toEqual(SEARCH.items.map((item) => item.id)));
    expect(screen.getByRole("grid", { name: "Search results" }).textContent).toContain("report.pdf");
    expect(searches(calls)).toEqual([{ q: "reprot", scope: "all" }]);
    expect(input().value).toBe("reprot");
    expect(document.querySelector("[data-search-count]")!.textContent).toBe("3 results");
  });

  it("the path hint is under the name; an empty hint renders no hint line", async () => {
    await openView("/search?q=report", { "GET /api/search": SEARCH });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    const hinted = document.querySelector(`[data-item-id="${nodeId(31)}"]`)!;
    const bare = document.querySelector(`[data-item-id="${nodeId(32)}"]`)!;
    const cell = (row: Element) => row.querySelectorAll('[role="gridcell"]')[1]!;
    expect(within(hinted as HTMLElement).getByText("Work")).toBeTruthy();
    // The name cell holds the glyph, the name and (only with a hint) the hint.
    expect(cell(hinted).querySelectorAll(":scope > span").length).toBe(
      cell(bare).querySelectorAll(":scope > span").length + 1,
    );
    expect(cell(bare).textContent).toBe("reported-bugs.txt");
  });

  it("the type menu is ONE select whose values equal MIME_CATEGORIES (plus 'any')", async () => {
    await openView("/search?q=report", { "GET /api/search": SEARCH });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(typeMenu().tagName).toBe("SELECT");
    expect(Array.from(typeMenu().options, (option) => option.value)).toEqual([
      "",
      ...Object.keys(MIME_CATEGORIES),
    ]);
    expect(Array.from(scopeMenu().options, (option) => option.textContent)).toEqual([
      "All",
      "My files",
      "Shared with me",
    ]);
    // No chip filter bar.
    expect(
      document.querySelector(".MuiChip-root, [role='radiogroup'], .MuiToggleButtonGroup-root"),
    ).toBeNull();
  });

  it("choosing a type narrows the results, is sent as `category`, and lands in the address", async () => {
    const { calls, router } = await openView("/search?q=report", byCategory);
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    fireEvent.change(typeMenu(), { target: { value: "pdf" } });
    await waitFor(() => expect(rowNames()).toEqual([nodeId(31)]));
    expect(router.state.location.search).toBe("?q=report&category=pdf");
    expect(searches(calls).at(-1)).toEqual({ q: "report", scope: "all", category: "pdf" });
    fireEvent.change(typeMenu(), { target: { value: "" } });
    await waitFor(() => expect(router.state.location.search).toBe("?q=report"));
  });

  it("scope is sent and lands in the address; 'Shared with me' with nothing shared is the no-results state", async () => {
    const { calls, router } = await openView("/search?q=report", {
      "GET /api/search": (call) => json(queryOf(call).get("scope") === "shared" ? SEARCH_NONE : SEARCH),
    });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    fireEvent.change(scopeMenu(), { target: { value: "shared" } });
    await waitFor(() => expect(screen.getByRole("heading", { name: "No files match" })).toBeTruthy());
    expect(router.state.location.search).toBe("?q=report&scope=shared");
    expect(searches(calls).at(-1)).toEqual({ q: "report", scope: "shared" });
    expect(scopeMenu().value).toBe("shared");
  });

  it("URL → state: a bookmarked search restores q, type and scope", async () => {
    const { calls } = await openView("/search?q=tax&category=pdf&scope=mine", byCategory);
    await waitFor(() => expect(rowNames()).toEqual([nodeId(31)]));
    expect(input().value).toBe("tax");
    expect(typeMenu().value).toBe("pdf");
    expect(scopeMenu().value).toBe("mine");
    expect(searches(calls)).toEqual([{ q: "tax", scope: "mine", category: "pdf" }]);
  });

  it("typing is debounced 250 ms: one request for the settled text, and the address follows", async () => {
    expect(DEBOUNCE_MS).toBe(250);
    const { calls, router } = await openView("/search", { "GET /api/search": SEARCH });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Search your files" })).toBeTruthy());
    vi.useFakeTimers();
    fireEvent.change(input(), { target: { value: "re" } });
    await vi.advanceTimersByTimeAsync(200);
    fireEvent.change(input(), { target: { value: "rep" } });
    await vi.advanceTimersByTimeAsync(200);
    fireEvent.change(input(), { target: { value: "repo" } });
    await vi.advanceTimersByTimeAsync(249);
    expect(router.state.location.search).toBe("");
    expect(searches(calls)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await waitFor(() => expect(router.state.location.search).toBe("?q=repo"));
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(searches(calls)).toEqual([{ q: "repo", scope: "all" }]);
    // What is in the box is what was typed.
    expect(input().value).toBe("repo");
  });

  it("keys typed while the address is still catching up are kept (a slow session re-check on the way)", async () => {
    const session = deferred<Response>();
    let hold = false;
    const { calls, router } = await openView("/search", {
      "GET /api/search": SEARCH,
      "GET /api/auth/get-session": () => (hold ? session.promise : undefined),
    });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Search your files" })).toBeTruthy());
    // The frame's guard reads the session again on every address change once it is stale.
    await queryClient.invalidateQueries({ queryKey: sessionQuery.queryKey, refetchType: "none" });
    hold = true;
    fireEvent.change(input(), { target: { value: "rep" } });
    // The pause has passed and the page's write is on its way — not landed.
    await waitFor(() => expect(router.state.navigation.state).toBe("loading"));
    expect(router.state.location.search).toBe("");
    fireEvent.change(input(), { target: { value: "repo" } });
    fireEvent.change(input(), { target: { value: "repor" } });
    session.resolve(json(sessionOf({ timezone: "UTC" })));
    await waitFor(() => expect(router.state.location.search).toBe("?q=repor"));
    expect(input().value).toBe("repor");
    await waitFor(() => expect(searches(calls).at(-1)).toEqual({ q: "repor", scope: "all" }));
    expect(input().value).toBe("repor");
  });

  it("an address somebody else changed still wins over the box: the header's search, back", async () => {
    const { router } = await openView("/search?q=report", { "GET /api/search": SEARCH });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    fireEvent.change(input(), { target: { value: "report 2026" } });
    await waitFor(() => expect(router.state.location.search).toBe("?q=report+2026"));
    // The header submits another search while the box holds text.
    fireEvent.change(input(), { target: { value: "report 2026 draft" } });
    await act(() => router.navigate("/search?q=tax"));
    await waitFor(() => expect(input().value).toBe("tax"));
    expect(router.state.location.search).toBe("?q=tax");
    // Back: the address of that entry, not what the box last held.
    fireEvent.change(input(), { target: { value: "taxes" } });
    await act(() => router.navigate(-1));
    await waitFor(() => expect(input().value).toBe("report 2026"));
  });

  it("one result loaded and more to come is 'More than 1 result'", async () => {
    await openView("/search?q=report", {
      "GET /api/search": { items: [SEARCH.items[0]], nextCursor: "next" },
    });
    await waitFor(() => expect(rowNames()).toHaveLength(1));
    expect(document.querySelector("[data-search-count]")!.textContent).toBe("More than 1 result");
  });

  it("fewer than two characters asks nothing and shows the prompt", async () => {
    const { calls } = await openView("/search?q=t", { "GET /api/search": SEARCH });
    await waitFor(() => expect(screen.getByRole("heading", { name: "Search your files" })).toBeTruthy());
    expect(searches(calls)).toEqual([]);
  });

  it("no match: the no-results state", async () => {
    await openView("/search?q=zzzz", { "GET /api/search": SEARCH_NONE });
    await waitFor(() => expect(screen.getByRole("heading", { name: "No files match" })).toBeTruthy());
    expect(document.querySelector("[data-empty-state]")!.getAttribute("data-empty-state")).toBe("no-results");
  });

  it("a bare array is not an answer: the error state, not a list", async () => {
    await openView("/search?q=report", { "GET /api/search": SEARCH.items });
    await waitFor(() => expect(document.querySelector('[data-view-error="search"]')).not.toBeNull());
  });

  it("keyboard: ↓ in the box moves to the first result, ↓ again to the next, Enter opens", async () => {
    const { router } = await openView("/search?q=report", { "GET /api/search": SEARCH });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    input().focus();
    fireEvent.keyDown(input(), { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-item-id")).toBe(nodeId(31));
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item-id")).toBe(nodeId(32)));
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    await waitFor(() => expect(router.state.location.pathname).toBe(`/preview/${nodeId(32)}`));
    expect(router.state.location.state).toEqual({
      siblingIds: [nodeId(31), nodeId(32)],
      from: "/search?q=report",
    });
  });

  it("q never reaches the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    await openView("/search?q=secretword", { "GET /api/search": SEARCH });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    await openView("/search?q=secretword", { "GET /api/search": () => new Response("{", { status: 500 }) });
    for (const spy of spies)
      for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain("secretword");
  });

  // A pin of the SHELL's redaction, which this page relies on: nothing in this feature can make
  // it fail. It is here so that a change to the redaction that lets a query string through is
  // seen where the query that matters is typed.
  it("the shell's redaction, relied on here: the address and the request lose their query in a breadcrumb or an event", () => {
    // What the SDK records for the page's own navigation and for its request, passed through the
    // same function `beforeBreadcrumb` / `beforeSend` use.
    const crumbs = [
      { category: "navigation", data: { from: "/search?q=se", to: "/search?q=secretword&category=pdf" } },
      {
        category: "fetch",
        data: { method: "GET", url: "/api/search?q=secretword&scope=all", status_code: 200 },
      },
      { category: "xhr", data: { url: "http://localhost:5173/api/search?q=secretword" } },
    ];
    for (const crumb of crumbs) {
      const sent = JSON.stringify(redactCrumbOrDrop(crumb));
      expect(sent, crumb.category).not.toContain("secretword");
      expect(sent, crumb.category).toContain("search");
    }
    const event = redactOrDrop({
      message: "Failed to fetch /api/search?q=secretword",
      request: { url: "http://localhost:5173/search?q=secretword", query_string: "q=secretword" },
    });
    expect(JSON.stringify(event)).not.toContain("secretword");
  });

  it("mobile: the filters are in a sheet", async () => {
    const { router } = await openView("/search?q=report", byCategory, { width: 390 });
    await waitFor(() => expect(rowNames()).toHaveLength(3));
    expect(typeMenu()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    const sheet = await screen.findByRole("dialog", { name: "Filters" });
    fireEvent.change(within(sheet).getByLabelText("Type"), { target: { value: "pdf" } });
    await waitFor(() => expect(router.state.location.search).toBe("?q=report&category=pdf"));
    await waitFor(() => expect(rowNames()).toEqual([nodeId(31)]));
  });
});

describe("SearchSuggestions (the header's slot)", () => {
  const eight = SearchResponse.parse({
    items: Array.from({ length: 8 }, (_, index) => result(40 + index, { name: `tax-${index}.pdf` })),
    nextCursor: null,
  });

  it("shows the top five file matches and picks by node id", async () => {
    const calls = shellFetch({ extra: answering({ "GET /api/search": eight }) });
    const onPick = vi.fn();
    renderShell(<SearchSuggestions query="tax" onPick={onPick} />);
    const list = await screen.findByRole("list", { name: "Suggestions" });
    const buttons = within(list).getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(
      [0, 1, 2, 3, 4].map((index) => `tax-${index}.pdf`),
    );
    expect(searches(calls)).toEqual([{ q: "tax", kind: "file", limit: "5" }]);
    fireEvent.click(buttons[1]!);
    expect(onPick).toHaveBeenCalledWith(nodeId(41));
  });

  it("one character: asks nothing and renders nothing", async () => {
    const calls = shellFetch({ extra: answering({ "GET /api/search": SEARCH }) });
    vi.useFakeTimers();
    const { container } = renderShell(<SearchSuggestions query="t" onPick={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 8));
    expect(requests(calls, "GET", "/api/search")).toEqual([]);
    expect(container.innerHTML).toBe("");
  });

  it("no match: renders nothing once the answer is in", async () => {
    const calls = shellFetch({ extra: answering({ "GET /api/search": SEARCH_NONE }) });
    const { container } = renderShell(<SearchSuggestions query="zzzz" onPick={() => {}} />);
    await waitFor(() =>
      expect(queryClient.getQueryState(viewKeys.suggestions("zzzz"))?.status).toBe("success"),
    );
    expect(requests(calls, "GET", "/api/search")).toHaveLength(1);
    expect(container.innerHTML).toBe("");
  });

  it.each([
    ["404", () => undefined],
    ["429", () => envelope("rate_limited", 429)],
    ["no answer", () => Promise.reject(new TypeError("offline"))],
  ])("the request fails (%s): renders nothing, throws nothing, and is asked ONCE", async (_name, failure) => {
    const calls = shellFetch({
      extra: (call) => (pathOf(call) === "/api/search" ? (failure() as ReturnType<MockHandler>) : undefined),
    });
    const view = renderShell(<SearchSuggestions query="tax" onPick={() => {}} />);
    await waitFor(() => expect(queryClient.getQueryState(viewKeys.suggestions("tax"))?.status).toBe("error"));
    expect(view.container.innerHTML).toBe("");
    // Re-rendering asks nothing again: no scroll trigger, no retry of an answered request.
    view.rerender(<SearchSuggestions query="tax" onPick={() => {}} />);
    view.rerender(<SearchSuggestions query="tax" onPick={() => {}} />);
    expect(requests(calls, "GET", "/api/search")).toHaveLength(1);
  });
});
